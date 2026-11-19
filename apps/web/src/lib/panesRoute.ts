// The split view's place in the address: `?view=panes`, next to the single view's `?s=` and in the
// same way settingsRoute.ts keeps `?view=settings`. Entering pushes a history entry, so the browser's
// back button returns to the single view; `?s=` stays, so the single view's session is still there.
// The layout itself lives in localStorage (components/split/paneStore.ts), so it survives both ways.
//
// Settings and the dashboard take the place of whichever view is the base: the single view or the
// split view. The base is remembered here, so closing either of them returns to the split view when
// it was the one they covered (settingsRoute.ts closeSettings, dashboardRoute.ts closeDashboard).
// Every history entry these routes write carries the base (`historyState`), so the back and forward
// buttons bring back the base of the entry they land on.
import { useSyncExternalStore } from "react";

export const PANES_VIEW = "panes";

export function isPanesView(search: string): boolean {
  return new URLSearchParams(search).get("view") === PANES_VIEW;
}

/** The query string with the split view on or off, keeping every other parameter (`s` among them). */
export function writePanesView(search: string, on: boolean): string {
  const q = new URLSearchParams(search);
  // Settings' own parameters belong to its view; switching views leaves them behind.
  q.delete("view");
  q.delete("tab");
  q.delete("focus");
  if (on) q.set("view", PANES_VIEW);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * The base an address says: the split view for `?view=panes`, the single view for no `view`, and
 * for another view (settings, the dashboard) whatever it was before (`prev`).
 */
export function baseOf(search: string, prev: boolean): boolean {
  const view = new URLSearchParams(search).get("view");
  return view === PANES_VIEW ? true : view === null ? false : prev;
}

/**
 * The base after moving to a history entry: the one the entry was written with, or for an entry
 * without one (the page's first) what its address says (`baseOf`).
 */
export function baseFromHistory(state: unknown, search: string, prev: boolean): boolean {
  const saved = state && typeof state === "object" ? (state as { panesBase?: unknown }).panesBase : undefined;
  return typeof saved === "boolean" ? saved : baseOf(search, prev);
}

const listeners = new Set<() => void>();
/**
 * Whether the split view is the base; read on first use from the history entry's own base (a reload
 * keeps it, so a reload into settings or the dashboard returns to the view it covered), else from the address.
 */
let base: boolean | null = null;

function readBase(): boolean {
  base ??= baseFromHistory(window.history.state, window.location.search, false);
  return base;
}

function notify(): void {
  for (const l of [...listeners]) l();
}

function onPopState(): void {
  base = baseFromHistory(window.history.state, window.location.search, readBase());
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("popstate", onPopState);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("popstate", onPopState);
  };
}

function read(): boolean {
  return isPanesView(window.location.search);
}

/** The split view is showing. */
export function usePanesView(): boolean {
  return useSyncExternalStore(subscribe, read);
}

/** The split view is the base: showing, or under settings or the dashboard. */
export function usePanesBase(): boolean {
  return useSyncExternalStore(subscribe, readBase);
}

export function isPanesBase(): boolean {
  return readBase();
}

/** The state for a history entry written now: the base it shows or covers. */
export function historyState(): { panesBase: boolean } {
  return { panesBase: readBase() };
}

function go(on: boolean, mode: "push" | "replace"): void {
  const url = new URL(window.location.href);
  url.search = writePanesView(url.search, on);
  if (mode === "push") window.history.pushState(historyState(), "", url);
  else window.history.replaceState(historyState(), "", url);
}

/** Shows the split view; from settings or the dashboard it takes their place. */
export function openPanesView(): void {
  base = true;
  if (!read()) go(true, "push");
  notify();
}

/** The single view becomes the base; the split view, if showing, gives way to it. */
export function closePanesView(): void {
  base = false;
  if (read()) go(false, "replace");
  notify();
}
