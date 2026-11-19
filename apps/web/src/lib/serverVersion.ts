// The version part of the server's last /ws hello (pageVersion.ts). Null until the first hello; a
// reconnect after a server restart brings a new one.
import { useSyncExternalStore } from "react";

import type { HelloVersion } from "./pageVersion";
import { socketHub } from "./socket";

let hello: HelloVersion | null = null;
const listeners = new Set<() => void>();
let started = false;

function start(): void {
  if (started) return;
  started = true;
  socketHub().onMessage((msg) => {
    if (msg.type !== "hello") return;
    hello = "version" in msg ? { version: msg.version ?? null } : {};
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

export function useServerVersion(): HelloVersion | null {
  return useSyncExternalStore(subscribe, () => hello);
}
