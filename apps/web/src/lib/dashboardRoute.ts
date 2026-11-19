// Whether the main area shows the dashboard (DESIGN.md 6j). It lives in the address as
// `?view=dashboard` next to the selected session's `?s=`, the way the settings screen keeps
// `?view=settings` (lib/settingsRoute.ts). Opening it pushes a history entry, so the browser's back
// button returns to where it was; opening settings or a session replaces `view`. Closing returns to
// the base view it covered: the single view, or the split view (panesRoute.ts).
import { useSyncExternalStore } from "react";

import { historyState, isPanesBase, writePanesView } from "./panesRoute.ts";

export const DASHBOARD_VIEW = "dashboard";

export function isDashboardSearch(search: string): boolean {
  return new URLSearchParams(search).get("view") === DASHBOARD_VIEW;
}

/** The query string with the dashboard opened or closed, keeping every other parameter (`s` among them). */
export function writeDashboardSearch(search: string, open: boolean): string {
  const q = new URLSearchParams(search);
  if (open) {
    // The settings route's own parameters belong to the screen the dashboard replaces.
    q.delete("tab");
    q.delete("focus");
    q.set("view", DASHBOARD_VIEW);
  } else if (q.get("view") === DASHBOARD_VIEW) {
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

/** True while the address says `?view=dashboard`. Read on every render, so a change of `view` by the settings route shows too. */
export function useDashboardOpen(): boolean {
  return useSyncExternalStore(subscribe, () => isDashboardSearch(window.location.search), () => false);
}

function go(open: boolean, mode: "push" | "replace"): void {
  const url = new URL(window.location.href);
  let next = writeDashboardSearch(url.search, open);
  if (!open && isDashboardSearch(url.search) && isPanesBase()) next = writePanesView(next, true);
  if (next === url.search) return;
  url.search = next;
  if (mode === "push") window.history.pushState(historyState(), "", url);
  else window.history.replaceState(historyState(), "", url);
  notify();
}

export function openDashboard(): void {
  go(true, isDashboardSearch(window.location.search) ? "replace" : "push");
}

export function closeDashboard(): void {
  go(false, "replace");
}
