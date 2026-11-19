// Opening another session from inside a conversation (the thread a Codex /fork made). The page's
// session selection registers with onOpenSession; without a registration the address carries
// the key (`?s=`), which the page reads when it loads.

import { sessionUrlValue } from "./sessionUrl.ts";

const listeners = new Set<(key: string) => void>();

/** Called by whoever owns the selected session; returns the unregister function. */
export function onOpenSession(listener: (key: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openSession(key: string): void {
  if (listeners.size > 0) {
    for (const l of [...listeners]) l(key);
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("s", sessionUrlValue(key));
  window.location.assign(url.toString());
}
