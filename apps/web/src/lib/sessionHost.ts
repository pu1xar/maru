// The Claude session host's state (DESIGN.md 2b) from the server's `sessionHost` message, sent
// after hello and on every change. Null until the first one (or with a server that has no host).
import type { SessionHostStatus } from "@maru/shared";
import { useSyncExternalStore } from "react";

import { socketHub } from "./socket";

let status: SessionHostStatus | null = null;
const listeners = new Set<() => void>();
let started = false;

function start(): void {
  if (started) return;
  started = true;
  socketHub().onMessage((msg) => {
    if (msg.type === "hello") status = null;
    else if (msg.type === "sessionHost") status = msg.status;
    else return;
    for (const l of [...listeners]) l();
  });
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSessionHost(): SessionHostStatus | null {
  return useSyncExternalStore(subscribe, () => status);
}
