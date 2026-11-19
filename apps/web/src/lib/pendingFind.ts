// A find a search over every session hands to the conversation it opens (DESIGN.md 6u): the
// session's view takes it once it shows the session's own thread, and opens its find on the query
// at the hit.
import type { FindHint } from "@maru/shared";

export interface PendingFind {
  query: string;
  hint: FindHint;
}

const pending = new Map<string, PendingFind>();
const listeners = new Set<(sessionKey: string) => void>();

/** Leaves a find for the session's view; a view that shows it already takes it at once. */
export function requestFind(sessionKey: string, find: PendingFind): void {
  pending.set(sessionKey, find);
  for (const l of [...listeners]) l(sessionKey);
}

/**
 * Called by the view of `sessionKey` while it shows `threadId`: takes the session's waiting find
 * (now and whenever one comes) when that thread is the session's own. A view that shows a subagent
 * thread of the session is asked to go back to the session's own (`toSession`) and takes it there.
 * Returns the stop.
 */
export function takePendingFind(
  sessionKey: string,
  threadId: string,
  open: (find: PendingFind) => void,
  toSession: () => void = () => {},
): () => void {
  const take = () => {
    const find = pending.get(sessionKey);
    if (!find) return;
    if (threadId !== sessionKey) {
      toSession();
      return;
    }
    pending.delete(sessionKey);
    open(find);
  };
  take();
  const listener = (key: string) => {
    if (key === sessionKey) take();
  };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
