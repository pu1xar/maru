// The split view's tabs and layouts for this browser (DESIGN.md 6k): one value for the page, kept in
// localStorage so it survives a reload and a trip to the single view. Every change goes through
// lib/paneTabs.ts (the tab list) and lib/paneLayout.ts (one tab's layout); this module stores the
// result, tells the views, and carries the requests the views make of each other (move DOM focus
// into a pane, open a pane's sheet).
//
// The layout hooks and `paneActions` below act on the shown tab, so a pane never needs to know it
// is in a tab. Each browser tab reads the stored value when the page loads and writes it on every
// change; tabs do not follow each other's changes while open (the last one written wins on the
// next load).
import { useSyncExternalStore } from "react";

import {
  EMPTY_LAYOUT,
  closePane,
  closedPaneOf,
  reopenClosedPane,
  newPaneId,
  cycleFocus,
  dropPane,
  focusPane,
  focusedPane,
  moveFocus,
  openSession,
  setRatio,
  equalizeLine,
  splitPane,
  type Direction,
  type DropZone,
  type ClosedPane,
  type Edge,
  type PaneContent,
  type ReopenOutcome,
  type PaneLayout,
} from "~/lib/paneLayout";
import {
  activeLayout,
  activeTab,
  addTab,
  closeShellInTabs,
  closeTab,
  cycleTab,
  dropSessionInTabs,
  dropShellInTabs,
  loadTabs,
  moveTab,
  openSessionInTabs,
  openShellInTabs,
  reconcileShellTabs,
  reconcileTabs,
  renameTab,
  selectTab,
  selectTabAt,
  serializeTabs,
  tabsOf,
  updateActiveLayout,
  type PaneTabs,
} from "~/lib/paneTabs";

const STORAGE_KEY = "maru_pane_tabs";
/** The key a browser from before tabs wrote: one layout, which becomes the first tab. */
const LEGACY_LAYOUT_KEY = "maru_pane_layout";

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Storage blocked: the tabs last for this page.
    return null;
  }
}

function storedTabs(): PaneTabs | null {
  return loadTabs(readStorage(STORAGE_KEY), readStorage(LEGACY_LAYOUT_KEY));
}

/** No stored tabs, or ones that do not parse: start from the single view's session (`?s=`), if any. */
function initial(): PaneTabs {
  const stored = storedTabs();
  if (stored) return stored;
  let selected: string | null = null;
  try {
    selected = new URLSearchParams(window.location.search).get("s");
  } catch {
    selected = null;
  }
  // The address now carries a bare id (lib/sessionUrl.ts) that only the page can resolve; start empty then.
  return tabsOf(selected && selected.includes(":") ? openSession(EMPTY_LAYOUT, selected) : EMPTY_LAYOUT);
}

let tabs: PaneTabs | null = null;
const listeners = new Set<() => void>();

function current(): PaneTabs {
  tabs ??= initial();
  return tabs;
}

function save(value: PaneTabs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeTabs(value));
  } catch {
    // Storage blocked or full: the tabs last for this page.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function currentLayout(): PaneLayout {
  return activeLayout(current());
}

/** The shown tab's layout. */
export function getPaneLayout(): PaneLayout {
  return currentLayout();
}

/** Every tab, for the strip. A layout change inside a tab makes a new value too, so the strip reads only what it needs. */
export function getPaneTabs(): PaneTabs {
  return current();
}

export function usePaneTabs(): PaneTabs {
  return useSyncExternalStore(subscribe, current);
}

/** The shown tab's layout; it keeps its identity while another tab changes or is renamed. */
export function usePaneLayout(): PaneLayout {
  return useSyncExternalStore(subscribe, currentLayout);
}

/**
 * The focused pane's session (of the shown tab), for the sidebar's selected row and the toasts,
 * while the split view is the base (`active`). Its own value, so a divider drag (a layout change
 * every frame) does not re-render the page around the split view. Inactive, it leaves the tabs
 * unread, so a first layout starts from the single view's session of the moment the split view
 * opens.
 */
export function useFocusedSessionKey(active: boolean): string | null {
  return useSyncExternalStore(subscribe, () => (active ? (focusedPane(currentLayout())?.sessionKey ?? null) : null));
}

/**
 * The focused pane's shell (of the shown tab) while the split view shows (`active`), for the
 * sidebar's selected shell row. Like `useFocusedSessionKey`, inactive it leaves the tabs unread.
 */
export function useFocusedShellId(active: boolean): string | null {
  return useSyncExternalStore(subscribe, () => (active ? (focusedPane(currentLayout())?.shellId ?? null) : null));
}

/**
 * Applies a change to the tabs. `persist: false` skips the write (a divider drag writes once at
 * the end, not on every frame); `persistPaneLayout` writes the value as it is then.
 */
export function updatePaneTabs(change: (prev: PaneTabs) => PaneTabs, opts: { persist?: boolean } = {}): void {
  const prev = current();
  const next = change(prev);
  if (next === prev) return;
  tabs = next;
  if (opts.persist !== false) save(next);
  for (const l of [...listeners]) l();
}

/** Applies a change to the shown tab's layout. */
export function updatePaneLayout(change: (prev: PaneLayout) => PaneLayout, opts: { persist?: boolean } = {}): void {
  updatePaneTabs((t) => updateActiveLayout(t, change), opts);
}

export function persistPaneLayout(): void {
  save(current());
}

/**
 * Panes the user closed by hand, per tab (the tab's id), newest last. In memory only: a reload
 * starts empty. A closed tab's stack goes with it.
 */
const closedStacks = new Map<string, ClosedPane[]>();

/** The layout moves the views and the keys use; each is one update. */
export const paneActions = {
  /** A session picked in the sidebar: the tab that shows it comes up, else the shown tab's focused pane takes it. */
  open: (sessionKey: string) => updatePaneTabs((t) => openSessionInTabs(t, sessionKey)),
  focus: (paneId: string) => updatePaneLayout((l) => focusPane(l, paneId)),
  split: (paneId: string, edge: Edge) => updatePaneLayout((l) => splitPane(l, paneId, edge)),
  /** Closes a pane without remembering it (a pane that moved out to a lean window, DESIGN.md 6k). */
  close: (paneId: string) => updatePaneLayout((l) => closePane(l, paneId)),
  /** The user closed a pane (its button, the close key): the shown tab remembers it for `reopenClosed`. */
  closeByUser: (paneId: string) => {
    const t = current();
    const rec = closedPaneOf(activeLayout(t), paneId);
    if (rec) {
      const id = activeTab(t).id;
      closedStacks.set(id, [...(closedStacks.get(id) ?? []), rec]);
    }
    updatePaneLayout((l) => closePane(l, paneId));
  },
  /** Whether the shown tab has a closed pane to bring back, and what the newest ones show. */
  closedContents: (): PaneContent[] => (closedStacks.get(activeTab(current()).id) ?? []).map((r) => r.content),
  /** Brings back the shown tab's most recent closed pane (see `reopenClosedPane`). */
  reopenClosed: (
    exists: (content: PaneContent) => boolean,
    fits: (layout: PaneLayout, targetId: string, edge: Edge) => boolean,
  ): ReopenOutcome => {
    const t = current();
    const id = activeTab(t).id;
    const layout = activeLayout(t);
    const res = reopenClosedPane(layout, closedStacks.get(id) ?? [], exists, fits, newPaneId);
    closedStacks.set(id, res.stack);
    if (res.layout !== layout) updatePaneLayout(() => res.layout);
    return res.outcome;
  },
  ratio: (splitId: string, ratio: number, persist = true) => updatePaneLayout((l) => setRatio(l, splitId, ratio), { persist }),
  /** A divider double click: every cell of the divider's line gets an equal share. */
  equalize: (splitId: string) => updatePaneLayout((l) => equalizeLine(l, splitId)),
  moveFocus: (dir: Direction) => updatePaneLayout((l) => moveFocus(l, dir)),
  cycleFocus: (delta: 1 | -1) => updatePaneLayout((l) => cycleFocus(l, delta)),
  dropSession: (sessionKey: string, paneId: string | null, zone: DropZone) =>
    updatePaneTabs((t) => dropSessionInTabs(t, sessionKey, paneId, zone)),
  /** A shell opened in a pane of its own (the terminal screen's menu): the tab that shows it comes up, else the shown tab gets a new pane. */
  openShell: (shellId: string) => updatePaneTabs((t) => openShellInTabs(t, shellId)),
  /** A shell dropped on pane `paneId` of the shown tab (a new shell from the sidebar's terminal row, once made). */
  dropShell: (shellId: string, paneId: string | null, zone: DropZone) =>
    updatePaneTabs((t) => dropShellInTabs(t, shellId, paneId, zone)),
  /** The shell ended: its pane closes in every tab. */
  shellEnded: (shellId: string) => updatePaneTabs((t) => closeShellInTabs(t, shellId)),
  /** Shells the server no longer lists lose their panes, in every tab. */
  reconcileShells: (alive: ReadonlySet<string>) => updatePaneTabs((t) => reconcileShellTabs(t, alive)),
  dropPane: (paneId: string, targetId: string, zone: DropZone) => updatePaneLayout((l) => dropPane(l, paneId, targetId, zone)),
  /** Follows moved sessions and drops gone ones in every tab. */
  reconcile: (resolve: (key: string) => string | null | undefined) => updatePaneTabs((t) => reconcileTabs(t, resolve)),
  /**
   * A session's new key (an account move), whether the split view is shown or not. Tabs neither
   * read nor stored yet stay unread: they hold no key to rename, and their first reading starts
   * from `?s=` as it is then.
   */
  rekey: (from: string, to: string) => {
    if (tabs === null && storedTabs() === null) return;
    updatePaneTabs((t) => reconcileTabs(t, (key) => (key === from ? to : key)));
  },
  // The tab strip
  addTab: () => updatePaneTabs((t) => addTab(t)),
  closeTab: (tabId: string) => {
    closedStacks.delete(tabId);
    updatePaneTabs((t) => closeTab(t, tabId));
  },
  selectTab: (tabId: string) => updatePaneTabs((t) => selectTab(t, tabId)),
  selectTabAt: (index: number) => updatePaneTabs((t) => selectTabAt(t, index)),
  cycleTab: (delta: 1 | -1) => updatePaneTabs((t) => cycleTab(t, delta)),
  renameTab: (tabId: string, name: string) => updatePaneTabs((t) => renameTab(t, tabId, name)),
  moveTab: (tabId: string, toIndex: number) => updatePaneTabs((t) => moveTab(t, tabId, toIndex)),
};

// ---- Requests between views ----

type PaneRequest = { paneId: string; kind: "domFocus" } | { paneId: string; kind: "togglePanel" };
const requestListeners = new Set<(r: PaneRequest) => void>();

/** Asks pane `paneId` for something its own component does (focus its input, open its sheet). */
export function requestPane(request: PaneRequest): void {
  for (const l of [...requestListeners]) l(request);
}

export function onPaneRequest(listener: (r: PaneRequest) => void): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}
