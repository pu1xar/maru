// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/lib/tickTextContent.ts and the `secondTick` store of
// packages/client-runtime/src/clock.ts.
// Local changes: the shared second tick lives here as a plain interval store.

type Listener = () => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;

/** One wall-clock second tick shared by every live label. */
export const secondTick = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    timer ??= setInterval(() => {
      for (const current of listeners) current();
    }, 1000);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
  },
};

/**
 * Ref callback that writes `format(Date.now())` into a node and, while `live`,
 * rewrites it on the shared second tick. Running timers update through the DOM
 * so a ticking label never re-renders the timeline around it.
 */
export function tickTextContent(format: (nowMs: number) => string, live: boolean) {
  return (node: HTMLElement | null) => {
    if (!node) return;
    const write = () => {
      const text = format(Date.now());
      if (node.textContent !== text) node.textContent = text;
    };
    write();
    return live ? secondTick.subscribe(write) : undefined;
  };
}
