// The split view's tabs (DESIGN.md 6k), like tmux windows: each tab is one whole split layout
// (lib/paneLayout.ts) with its own panes, sessions and focused pane. Switching tabs changes which
// layout the split view draws and leaves every other tab as it was. Everything here is pure; the
// store (components/split/paneStore.ts) keeps the value and the strip (SplitTabs.tsx) draws it.
//
// A session shows in at most one pane of the whole view, across tabs too (the rule of paneLayout.ts
// widened): opening a session that another tab shows goes to that tab, and dropping it somewhere
// takes it out of the tab it was in.
import {
  EMPTY_LAYOUT,
  closePane,
  dropSession,
  dropShell,
  findPane,
  focusPane,
  openSession,
  openShellPane,
  paneKind,
  panesOf,
  parseLayout,
  parseLayoutBody,
  reconcileSessions,
  reconcileShells,
  closeShellPane,
  type DropZone,
  type NewId,
  type PaneLayout,
  type PaneLeaf,
} from "./paneLayout.ts";

export interface PaneTab {
  id: string;
  /** The name the user gave; null shows the default (`tabLabel`). */
  name: string | null;
  layout: PaneLayout;
}

export interface PaneTabs {
  /** In strip order; never empty. */
  tabs: PaneTab[];
  /** The id of the tab the split view shows. */
  active: string;
}

export function newTabId(): string {
  return `t${Math.random().toString(36).slice(2, 10)}`;
}

/** A single tab holding `layout`. */
export function tabsOf(layout: PaneLayout, newId: NewId = newTabId): PaneTabs {
  const id = newId();
  return { tabs: [{ id, name: null, layout }], active: id };
}

export function activeTab(t: PaneTabs): PaneTab {
  return t.tabs.find((x) => x.id === t.active) ?? t.tabs[0]!;
}

export function activeLayout(t: PaneTabs): PaneLayout {
  return activeTab(t).layout;
}

export function indexOfTab(t: PaneTabs, id: string): number {
  return t.tabs.findIndex((x) => x.id === id);
}

/** Every pane of every tab, tab by tab. */
export function allPanes(t: PaneTabs): PaneLeaf[] {
  return t.tabs.flatMap((x) => panesOf(x.layout.root));
}

/** The tab that shows `sessionKey`, with its pane. */
export function tabOfSession(t: PaneTabs, sessionKey: string): { tab: PaneTab; pane: PaneLeaf } | null {
  for (const tab of t.tabs) {
    const pane = panesOf(tab.layout.root).find((p) => p.sessionKey === sessionKey);
    if (pane) return { tab, pane };
  }
  return null;
}

/** The tab that shows shell `shellId`, with its pane. */
export function tabOfShell(t: PaneTabs, shellId: string): { tab: PaneTab; pane: PaneLeaf } | null {
  for (const tab of t.tabs) {
    const pane = panesOf(tab.layout.root).find((p) => p.shellId === shellId);
    if (pane) return { tab, pane };
  }
  return null;
}

/** Appends an empty tab and shows it (iTerm and tmux put a new tab last). */
export function addTab(t: PaneTabs, newId: NewId = newTabId): PaneTabs {
  const id = newId();
  return { tabs: [...t.tabs, { id, name: null, layout: EMPTY_LAYOUT }], active: id };
}

/**
 * Closes tab `id`. The tab to its right takes over when it was the shown one, else the one to its
 * left. The last tab stays, so the view always has a tab.
 */
export function closeTab(t: PaneTabs, id: string): PaneTabs {
  const i = indexOfTab(t, id);
  if (i < 0 || t.tabs.length < 2) return t;
  const tabs = t.tabs.filter((x) => x.id !== id);
  if (t.active !== id) return { tabs, active: t.active };
  return { tabs, active: tabs[Math.min(i, tabs.length - 1)]!.id };
}

export function selectTab(t: PaneTabs, id: string): PaneTabs {
  return t.active === id || indexOfTab(t, id) < 0 ? t : { ...t, active: id };
}

/** Shows the tab at `index` (0-based); nothing happens past the last tab. */
export function selectTabAt(t: PaneTabs, index: number): PaneTabs {
  const tab = t.tabs[index];
  return tab ? selectTab(t, tab.id) : t;
}

/** The next (+1) or previous (-1) tab, wrapping around. */
export function cycleTab(t: PaneTabs, delta: 1 | -1): PaneTabs {
  if (t.tabs.length < 2) return t;
  const i = Math.max(0, indexOfTab(t, t.active));
  return selectTab(t, t.tabs[(i + delta + t.tabs.length) % t.tabs.length]!.id);
}

/** Names tab `id`; blank text goes back to the default name. */
export function renameTab(t: PaneTabs, id: string, name: string): PaneTabs {
  const next = name.trim() === "" ? null : name.trim();
  if (!t.tabs.some((x) => x.id === id && x.name !== next)) return t;
  return { ...t, tabs: t.tabs.map((x) => (x.id === id ? { ...x, name: next } : x)) };
}

/** Moves tab `id` so it ends at `toIndex` of the new order (dragging it onto the tab that sits there). */
export function moveTab(t: PaneTabs, id: string, toIndex: number): PaneTabs {
  const from = indexOfTab(t, id);
  if (from < 0 || !Number.isInteger(toIndex)) return t;
  const to = Math.min(t.tabs.length - 1, Math.max(0, toIndex));
  if (to === from) return t;
  const tabs = [...t.tabs];
  const [tab] = tabs.splice(from, 1);
  tabs.splice(to, 0, tab!);
  return { ...t, tabs };
}

/** Applies a layout change to the shown tab. */
export function updateActiveLayout(t: PaneTabs, change: (layout: PaneLayout) => PaneLayout): PaneTabs {
  const tab = activeTab(t);
  const next = change(tab.layout);
  if (next === tab.layout) return t;
  return { ...t, tabs: t.tabs.map((x) => (x === tab ? { ...x, layout: next } : x)) };
}

function updateTab(t: PaneTabs, id: string, change: (layout: PaneLayout) => PaneLayout): PaneTabs {
  let changed = false;
  const tabs = t.tabs.map((x) => {
    if (x.id !== id) return x;
    const layout = change(x.layout);
    if (layout === x.layout) return x;
    changed = true;
    return { ...x, layout };
  });
  return changed ? { ...t, tabs } : t;
}

/**
 * Opens a session the way a click in the sidebar does: the tab that already shows it comes up with
 * that pane focused, else the shown tab's focused pane takes it (paneLayout.ts openSession).
 */
export function openSessionInTabs(t: PaneTabs, sessionKey: string, newId?: NewId): PaneTabs {
  const at = tabOfSession(t, sessionKey);
  if (!at) return updateActiveLayout(t, (l) => openSession(l, sessionKey, newId));
  return selectTab(updateTab(t, at.tab.id, (l) => focusPane(l, at.pane.id)), at.tab.id);
}

/**
 * Opens a shell in a pane of the shown tab (paneLayout.ts openShellPane), or brings up the tab that
 * already shows it with that pane focused (a shell shows in one pane of the whole view).
 */
export function openShellInTabs(t: PaneTabs, shellId: string, newId?: NewId): PaneTabs {
  const at = tabOfShell(t, shellId);
  if (!at) return updateActiveLayout(t, (l) => openShellPane(l, shellId, newId));
  return selectTab(updateTab(t, at.tab.id, (l) => focusPane(l, at.pane.id)), at.tab.id);
}

/**
 * A shell dropped on pane `paneId` of the shown tab (a shell dragged from the sidebar's terminal row
 * is a new one, made before this). A shell another tab shows leaves that tab's pane first.
 */
export function dropShellInTabs(t: PaneTabs, shellId: string, paneId: string | null, zone: DropZone, newId?: NewId): PaneTabs {
  const active = activeTab(t);
  // The target went while the shell was being made: the shell opens as a pane of its own instead.
  const targetHere = paneId === null ? active.layout.root === null : findPane(active.layout, paneId) !== null;
  if (!targetHere) return openShellInTabs(t, shellId, newId);
  const at = tabOfShell(t, shellId);
  const base = at && at.tab.id !== active.id ? updateTab(t, at.tab.id, (l) => closePane(l, at.pane.id)) : t;
  return updateActiveLayout(base, (l) => dropShell(l, shellId, paneId, zone, newId));
}

/** Closes the panes of shells that are no longer listed, in every tab. */
export function reconcileShellTabs(t: PaneTabs, alive: ReadonlySet<string>): PaneTabs {
  let changed = false;
  const tabs = t.tabs.map((x) => {
    const layout = reconcileShells(x.layout, alive);
    if (layout === x.layout) return x;
    changed = true;
    return { ...x, layout };
  });
  return changed ? { ...t, tabs } : t;
}

/** Closes the pane of shell `shellId` in every tab (the shell ended). */
export function closeShellInTabs(t: PaneTabs, shellId: string): PaneTabs {
  let changed = false;
  const tabs = t.tabs.map((x) => {
    const layout = closeShellPane(x.layout, shellId);
    if (layout === x.layout) return x;
    changed = true;
    return { ...x, layout };
  });
  return changed ? { ...t, tabs } : t;
}

/**
 * A session dragged from the sidebar and dropped on pane `paneId` of the shown tab. A session
 * another tab shows leaves that tab's pane first (its place closes, as a pane dragged away does).
 */
export function dropSessionInTabs(t: PaneTabs, sessionKey: string, paneId: string | null, zone: DropZone, newId?: NewId): PaneTabs {
  const active = activeTab(t);
  const at = tabOfSession(t, sessionKey);
  const base = at && at.tab.id !== active.id ? updateTab(t, at.tab.id, (l) => closePane(l, at.pane.id)) : t;
  return updateActiveLayout(base, (l) => dropSession(l, sessionKey, paneId, zone, newId));
}

/** Follows sessions that changed keys and drops panes whose session is gone, in every tab (paneLayout.ts reconcileSessions). */
export function reconcileTabs(t: PaneTabs, resolve: (key: string) => string | null | undefined): PaneTabs {
  let changed = false;
  const tabs = t.tabs.map((x) => {
    const layout = reconcileSessions(x.layout, resolve);
    if (layout === x.layout) return x;
    changed = true;
    return { ...x, layout };
  });
  return changed ? { ...t, tabs } : t;
}

/** What a tab with no name and no session shows (the strip puts the tab's number in front of every name). */
export const EMPTY_TAB_LABEL = "New tab";

/** What a tab with no name and no session shows when it has a shell pane. */
export const SHELL_TAB_LABEL = "Terminal";

/**
 * What the strip shows for a tab: its name, else the first session in reading order (`firstSession`
 * is that session's display name), else `SHELL_TAB_LABEL` for a tab that has a shell pane, else
 * `EMPTY_TAB_LABEL`.
 */
export function tabLabel(tab: PaneTab, firstSession: string | null): string {
  if (tab.name ?? firstSession) return (tab.name ?? firstSession)!;
  return panesOf(tab.layout.root).some((p) => paneKind(p) === "shell") ? SHELL_TAB_LABEL : EMPTY_TAB_LABEL;
}

/** The key of the first pane of `tab` (reading order) that shows a session, for `tabLabel`. */
export function firstSessionKey(tab: PaneTab): string | null {
  return panesOf(tab.layout.root).find((p) => p.sessionKey !== null)?.sessionKey ?? null;
}

// ---- Storage ----

export const TABS_VERSION = 1;

export function serializeTabs(t: PaneTabs): string {
  return JSON.stringify({
    v: TABS_VERSION,
    active: t.active,
    tabs: t.tabs.map((x) => ({ id: x.id, name: x.name, root: x.layout.root, focused: x.layout.focused })),
  });
}

/** Closes the panes that show a session or a shell an earlier tab shows (a stored duplicate keeps the first). */
function dedupeAcross(tabs: PaneTab[]): PaneTab[] {
  const seen = new Set<string>();
  return tabs.map((tab) => {
    let layout = tab.layout;
    for (const pane of panesOf(layout.root)) {
      const id = pane.sessionKey !== null ? `s:${pane.sessionKey}` : pane.shellId !== null ? `h:${pane.shellId}` : null;
      if (id === null) continue;
      if (seen.has(id)) layout = closePane(layout, pane.id);
      else seen.add(id);
    }
    return layout === tab.layout ? tab : { ...tab, layout };
  });
}

/**
 * Stored tabs, or null when the value is missing, from another version, or has no tab left. A tab
 * whose layout is broken stays as an empty tab with its name; a tab without an id is skipped.
 */
export function parseTabs(text: string | null): PaneTabs | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (v.v !== TABS_VERSION || !Array.isArray(v.tabs)) return null;
  const ids = new Set<string>();
  const tabs: PaneTab[] = [];
  for (const entry of v.tabs as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id === "" || ids.has(e.id)) continue;
    ids.add(e.id);
    const name = typeof e.name === "string" && e.name.trim() !== "" ? e.name : null;
    tabs.push({ id: e.id, name, layout: parseLayoutBody(e) ?? EMPTY_LAYOUT });
  }
  if (tabs.length === 0) return null;
  const deduped = dedupeAcross(tabs);
  const active = typeof v.active === "string" && ids.has(v.active) ? v.active : deduped[0]!.id;
  return { tabs: deduped, active };
}

/**
 * The tabs a page starts with. A stored tab list wins; without one (a browser from before tabs)
 * the single layout of `maru_pane_layout` becomes the first tab. A tab list that exists but does
 * not parse gives null (the caller starts fresh), and the old layout is left alone.
 */
export function loadTabs(tabsText: string | null, legacyLayoutText: string | null, newId: NewId = newTabId): PaneTabs | null {
  if (tabsText !== null) return parseTabs(tabsText);
  const legacy = parseLayout(legacyLayoutText);
  return legacy ? tabsOf(legacy, newId) : null;
}

/** A compact text form for logs and measurements: `*1:[a:key]|2:empty` (`*` marks the shown tab). */
export function describeTabs(t: PaneTabs, describe: (layout: PaneLayout) => string): string {
  return t.tabs.map((x, i) => `${x.id === t.active ? "*" : ""}${i + 1}${x.name ? `(${x.name})` : ""}:${describe(x.layout)}`).join("|");
}
