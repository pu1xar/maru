// Account usage gauges (DESIGN.md 6a): the server's snapshot, first from GET /api/usage and then
// from every /ws `usage` message, kept for the page.
import type { UsageSnapshot } from "@maru/shared";
import { useSyncExternalStore } from "react";

import { socketHub } from "./socket";

let snapshot: UsageSnapshot | null = null;
const listeners = new Set<() => void>();
let started = false;

function set(next: UsageSnapshot): void {
  if (snapshot && next.generatedAt < snapshot.generatedAt) return;
  snapshot = next;
  for (const l of [...listeners]) l();
}

function start(): void {
  if (started) return;
  started = true;
  socketHub().onMessage((msg) => {
    if (msg.type === "usage") set(msg.snapshot);
  });
  fetch("/api/usage")
    .then((r) => (r.ok ? (r.json() as Promise<UsageSnapshot>) : null))
    .then((s) => {
      if (s) set(s);
    })
    .catch(() => {
      // The /ws message brings it after connect anyway.
    });
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUsage(): UsageSnapshot | null {
  return useSyncExternalStore(subscribe, () => snapshot);
}
