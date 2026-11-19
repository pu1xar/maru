import { useSyncExternalStore } from "react";

import { socketHub, type Connection } from "./socket.ts";

/**
 * Whether the server counts as unreachable after this connection state. The hub alternates
 * "closed" (waiting out the backoff) and "connecting" (the next attempt) while the server is gone,
 * so "connecting" keeps the previous answer: the first attempt of the page is not a failure yet,
 * and a retry is not a recovery yet.
 */
export function serverDownAfter(previous: boolean, connection: Connection): boolean {
  if (connection === "open") return false;
  if (connection === "closed") return true;
  return previous;
}

/**
 * The connection state a status display shows (the sidebar's dot): down from the first failure
 * until a socket opens, so the retries do not flip it; before that, connecting until it opens.
 */
export function shownConnection(down: boolean, connection: Connection): Connection {
  if (down) return "closed";
  return connection === "open" ? "open" : "connecting";
}

let down = false;
let watching = false;
const listeners = new Set<() => void>();

function watch(): void {
  if (watching) return;
  watching = true;
  const hub = socketHub();
  const update = () => {
    const next = serverDownAfter(down, hub.getConnection());
    if (next === down) return;
    down = next;
    for (const listener of [...listeners]) listener();
  };
  // Subscribing starts the hub, which moves it from its initial "closed" to "connecting" first.
  hub.subscribeConnection(update);
  update();
}

function subscribe(listener: () => void): () => void {
  watch();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getDown(): boolean {
  return down;
}

/** True from the first failed connection until the socket opens again, steady across retries. */
export function useServerDown(): boolean {
  return useSyncExternalStore(subscribe, getDown, () => false);
}
