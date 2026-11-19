// The screen this browser (or desktop app) showed last, kept in localStorage so a reload, a reopened
// tab or a relaunch of the desktop app (which opens the server's bare address) comes back to it
// (DESIGN.md 6v). It is per device on purpose: the split layout and the open session are what this
// device was looking at, and a phone's last screen is not a reason to move the desktop's.
//
// What is kept is what the address cannot say by itself:
//   selected   the single view's session (its id), which the address drops while settings, the
//              dashboard or the terminal covers it
//   view       the screen: the single view, the split view, or one of the three covers
//   tab        the settings tab, when settings was open
//   panesBase  the base a cover returns to (the split view, or the single view)
//
// An address that names a screen wins: `?s=` or `?view=` in the address is a link or a reload, and
// is left alone. Only an address with neither (the bare one) takes the stored screen. The session
// is the one thing an address with a `view` but no `s` still takes from here, because covers and
// the split view keep the single view's choice outside the address.

import { settingsTabOf } from "./settingsRoute.ts";

export const LAST_VIEW_KEY = "maru_last_view";

export type LastViewKind = "single" | "panes" | "settings" | "dashboard" | "terminal";

export interface LastView {
  selected: string | null;
  view: LastViewKind;
  tab: string | null;
  panesBase: boolean;
}

const KINDS: readonly LastViewKind[] = ["single", "panes", "settings", "dashboard", "terminal"];

export function parseLastView(raw: string | null): LastView | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.view !== "string" || !(KINDS as readonly string[]).includes(o.view)) return null;
    return {
      selected: typeof o.selected === "string" && o.selected ? o.selected : null,
      view: o.view as LastViewKind,
      // A tab an earlier layout stored (the usage page) is the tab that holds its content now.
      tab: typeof o.tab === "string" && o.tab ? settingsTabOf(o.tab) : null,
      panesBase: o.panesBase === true,
    };
  } catch {
    return null;
  }
}

/** What the page shows now, as the stored form. `selected` is any session value; the address form (the id) is kept. */
export function lastViewOf(now: {
  selected: string | null;
  panesView: boolean;
  settings: boolean;
  settingsTab: string;
  dashboard: boolean;
  terminal: boolean;
  panesBase: boolean;
}): LastView {
  const view: LastViewKind = now.settings
    ? "settings"
    : now.dashboard
      ? "dashboard"
      : now.terminal
        ? "terminal"
        : now.panesView
          ? "panes"
          : "single";
  const at = now.selected === null ? -1 : now.selected.lastIndexOf(":");
  return {
    selected: now.selected === null ? null : at === -1 ? now.selected : now.selected.slice(at + 1),
    view,
    tab: view === "settings" ? now.settingsTab : null,
    panesBase: now.panesBase,
  };
}

export function sameLastView(a: LastView | null, b: LastView): boolean {
  return a !== null && a.selected === b.selected && a.view === b.view && a.tab === b.tab && a.panesBase === b.panesBase;
}

export interface Restored {
  /** The query string to put in the address (replacing it). */
  search: string;
  /** The base a cover returns to, for an entry that carries none. */
  panesBase: boolean;
}

/**
 * The address to open with, given the one the page was opened at and the stored screen: null when
 * the address stays as it is.
 *
 * - `?s=` or `?view=` present: the address names the screen. Only a missing `s` is filled from the
 *   stored session (the covers and the split view keep it outside the address)
 * - neither present: the stored screen (its view, tab and session)
 */
export function restoredAddress(search: string, last: LastView | null): Restored | null {
  if (last === null) return null;
  const q = new URLSearchParams(search);
  const named = q.has("s") || q.has("view");
  if (!named) {
    if (last.view === "settings") {
      q.set("view", "settings");
      if (last.tab) q.set("tab", last.tab);
    } else if (last.view !== "single") {
      q.set("view", last.view);
    }
    // The covers leave `s` out of the address; the page keeps the session in state and the address
    // takes it from here when the page reads it.
    if (last.selected) q.set("s", last.selected);
  } else if (!q.has("s") && last.selected) {
    q.set("s", last.selected);
  } else {
    return null;
  }
  const s = q.toString();
  return { search: s ? `?${s}` : "", panesBase: last.panesBase };
}

/**
 * The tab's own last screen (sessionStorage, which a reload keeps), else the device's (localStorage,
 * which a new tab or a relaunch of the desktop app reads). A reload of one tab among several so
 * returns to that tab's screen, not to whichever tab changed screen last.
 */
export function readLastView(
  tab: Pick<Storage, "getItem"> | null = safeStorage("sessionStorage"),
  device: Pick<Storage, "getItem"> | null = safeStorage("localStorage"),
): LastView | null {
  for (const storage of [tab, device]) {
    try {
      const v = storage ? parseLastView(storage.getItem(LAST_VIEW_KEY)) : null;
      if (v) return v;
    } catch {
      // Blocked storage: the next one answers.
    }
  }
  return null;
}

export function writeLastView(
  view: LastView,
  tab: Pick<Storage, "setItem"> | null = safeStorage("sessionStorage"),
  device: Pick<Storage, "setItem"> | null = safeStorage("localStorage"),
): void {
  const raw = JSON.stringify(view);
  for (const storage of [tab, device]) {
    try {
      storage?.setItem(LAST_VIEW_KEY, raw);
    } catch {
      // Storage blocked or full: the next launch opens the address as it is.
    }
  }
}

function safeStorage(name: "sessionStorage" | "localStorage"): Storage | null {
  try {
    return window[name];
  } catch {
    return null;
  }
}

/**
 * Before the first render: puts the stored screen in the address. An entry that carries no base
 * (a fresh one) gets the stored base, so a cover opened from the restored screen returns to it.
 */
export function restoreLastView(): void {
  try {
    const restored = restoredAddress(window.location.search, readLastView());
    if (!restored) return;
    const url = new URL(window.location.href);
    url.search = restored.search;
    const state: unknown = window.history.state;
    const hasBase = typeof state === "object" && state !== null && typeof (state as { panesBase?: unknown }).panesBase === "boolean";
    window.history.replaceState(hasBase ? state : { ...(typeof state === "object" && state !== null ? state : {}), panesBase: restored.panesBase }, "", url);
  } catch {
    // The address stays as it is.
  }
}
