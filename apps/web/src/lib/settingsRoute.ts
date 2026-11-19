// Which main view the page shows: the conversation, or the settings screen with one of its tabs.
// It lives in the address (`?view=settings&tab=<tab>`, `&focus=` for a tab's preselected item)
// next to the selected session's `?s=`, so a reload or a shared link opens the same screen.
// Entering settings pushes a history entry, so the browser's back button returns to the chat.
// Closing returns to the base view it covered: the single view, or the split view (panesRoute.ts).
import { useSyncExternalStore } from "react";

import { historyState, isPanesBase, writePanesView } from "./panesRoute.ts";

export const SETTINGS_TABS = ["sessions", "accounts", "display", "devices"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export const DEFAULT_SETTINGS_TAB: SettingsTab = "sessions";

/**
 * Tabs of an earlier layout. Subagents, orphans and the trash had pages of their own, and usage was
 * a page beside the session management; they all live on the `sessions` tab now (usage above the
 * session table), so an old link, a stored last screen or a bookmark opens that.
 */
const MOVED_TABS: Record<string, SettingsTab> = { units: "sessions", orphans: "sessions", trash: "sessions", usage: "sessions" };

/** A tab name from an address or storage as the tab it opens now: a current tab, an earlier tab's successor, or the default. */
export function settingsTabOf(raw: string | null | undefined): SettingsTab {
  const tab = raw ?? "";
  return (SETTINGS_TABS as readonly string[]).includes(tab) ? (tab as SettingsTab) : (MOVED_TABS[tab] ?? DEFAULT_SETTINGS_TAB);
}

export interface MainRoute {
  view: "chat" | "settings";
  tab: SettingsTab;
  /** A tab's preselected item: the session (`account:id`) whose subagents the session management opens with. */
  focus: string | null;
}

/** Reads the route from a query string; unknown tabs fall back to the default. */
export function parseMainRoute(search: string): MainRoute {
  const q = new URLSearchParams(search);
  return {
    view: q.get("view") === "settings" ? "settings" : "chat",
    tab: settingsTabOf(q.get("tab")),
    focus: q.get("focus") || null,
  };
}

/** The query string for a route, keeping every other parameter (`s` among them). */
export function writeMainRoute(search: string, route: MainRoute): string {
  const q = new URLSearchParams(search);
  q.delete("view");
  q.delete("tab");
  q.delete("focus");
  if (route.view === "settings") {
    q.set("view", "settings");
    q.set("tab", route.tab);
    if (route.focus) q.set("focus", route.focus);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

const listeners = new Set<() => void>();
let current: MainRoute | null = null;
let currentSearch = "";

function read(): MainRoute {
  const search = window.location.search;
  if (current === null || search !== currentSearch) {
    current = parseMainRoute(search);
    currentSearch = search;
  }
  return current;
}

function notify(): void {
  for (const l of [...listeners]) l();
}

function go(route: MainRoute, mode: "push" | "replace", toPanes = false): void {
  const url = new URL(window.location.href);
  url.search = writeMainRoute(url.search, route);
  if (toPanes) url.search = writePanesView(url.search, true);
  if (mode === "push") window.history.pushState(historyState(), "", url);
  else window.history.replaceState(historyState(), "", url);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("popstate", notify);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("popstate", notify);
  };
}

export function useMainRoute(): MainRoute {
  return useSyncExternalStore(subscribe, read);
}

export function openSettings(tab: SettingsTab = read().tab, focus: string | null = null): void {
  const was = read();
  go({ view: "settings", tab, focus }, was.view === "settings" ? "replace" : "push");
}

/**
 * Back to the conversation: the base view settings covered (the split view, if it was that). A
 * no-op while settings does not show, so callers that close it on any session pick (the sidebar)
 * leave `?view=panes` and `?view=dashboard` alone.
 */
export function closeSettings(): void {
  const was = read();
  if (was.view !== "settings") return;
  go({ ...was, view: "chat", focus: null }, "replace", isPanesBase());
}
