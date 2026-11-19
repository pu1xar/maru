// Whether the main area shows the terminal screen (DESIGN.md 6s). It lives in the address as
// `?view=terminal` next to the selected session's `?s=`, the way the dashboard keeps
// `?view=dashboard` (lib/dashboardRoute.ts). Opening it pushes a history entry, so the browser's back
// button returns to where it was; opening settings, the dashboard or a session replaces `view`.
// Closing returns to the base view it covered: the single view, or the split view (panesRoute.ts).
import { useSyncExternalStore } from "react";

import { historyState, isPanesBase, writePanesView } from "./panesRoute.ts";

export const TERMINAL_VIEW = "terminal";

export function isTerminalSearch(search: string): boolean {
  return new URLSearchParams(search).get("view") === TERMINAL_VIEW;
}

/** The query string with the terminal screen opened or closed, keeping every other parameter (`s` among them). */
export function writeTerminalSearch(search: string, open: boolean): string {
  const q = new URLSearchParams(search);
  if (open) {
    // The settings route's own parameters belong to the screen the terminal replaces.
    q.delete("tab");
    q.delete("focus");
    q.set("view", TERMINAL_VIEW);
  } else if (q.get("view") === TERMINAL_VIEW) {
    q.delete("view");
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("popstate", notify);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("popstate", notify);
  };
}

/** True while the address says `?view=terminal`. Read on every render, so a change of `view` by another route shows too. */
export function useTerminalOpen(): boolean {
  return useSyncExternalStore(subscribe, () => isTerminalSearch(window.location.search), () => false);
}

function go(open: boolean, mode: "push" | "replace"): void {
  const url = new URL(window.location.href);
  let next = writeTerminalSearch(url.search, open);
  if (!open && isTerminalSearch(url.search) && isPanesBase()) next = writePanesView(next, true);
  if (next === url.search) return;
  url.search = next;
  if (mode === "push") window.history.pushState(historyState(), "", url);
  else window.history.replaceState(historyState(), "", url);
  notify();
}

export function openTerminal(): void {
  go(true, isTerminalSearch(window.location.search) ? "replace" : "push");
}

export function closeTerminal(): void {
  go(false, "replace");
}

// A "new shell" asked for while the screen may not be mounted yet (the key opens the screen and
// asks in one step). The screen takes the request once its shell list is read.
let requested = 0;
let taken = 0;
const requestListeners = new Set<() => void>();

export function requestNewShell(): void {
  requested++;
  for (const l of [...requestListeners]) l();
}

/**
 * Opens the terminal screen (when it is not open) and asks it for a new shell: the new-shell key
 * and the sidebar's "+" on the terminal group. With the screen open it is just the new shell.
 */
export function openTerminalWithNewShell(): void {
  requestNewShell();
  openTerminal();
}

/** True once for the requests made since the last take (any number of them is one new shell). */
export function takeNewShellRequest(): boolean {
  const had = requested > taken;
  taken = requested;
  return had;
}

/** The number of requests made so far: it changes with each, so a mounted screen reacts to a key pressed while it shows. */
export function useNewShellRequests(): number {
  return useSyncExternalStore(
    (l) => {
      requestListeners.add(l);
      return () => requestListeners.delete(l);
    },
    () => requested,
    () => 0,
  );
}
