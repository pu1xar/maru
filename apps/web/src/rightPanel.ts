// Right panel state for one session (DESIGN.md 6e): which file tabs are open, which tab shows (the
// file explorer by default), and whether the panel is open. Kept per session in localStorage, like
// T3's per-thread tabs (web/rightPanelStore.ts), so coming back to a session brings its files back.
import type { FileLookup } from "@maru/shared";
import { createContext, use, useState } from "react";

import { normalizeFilePath } from "./components/files/fileTree.ts";

export interface FileTarget {
  /** Absolute path (or `~/...`); a folder path has no trailing slash. */
  path: string;
  line?: number;
  endLine?: number;
  /** For a relative link: where to look when `path` is missing. */
  lookup?: FileLookup;
  /** What the path turned out to be once read; the tab's icon follows it. */
  kind?: FileTargetKind;
}

export type FileTargetKind = "file" | "directory";

export interface PanelState {
  open: boolean;
  tabs: FileTarget[];
  /** The path of the file tab that shows, EXPLORER_TAB or AGENTS_TAB; null shows the explorer. */
  active: string | null;
  /** The file tab shown last. The explorer marks its row while the explorer itself shows. */
  lastFile?: string | null;
}

/** The fixed first tab: the session folder's file tree. It shows when nothing else was chosen. */
export const EXPLORER_TAB = "@files";

/** The fixed second tab: the session's subagents and workflows. */
export const AGENTS_TAB = "@agents";

const EMPTY: PanelState = { open: false, tabs: [], active: null };

function storageKey(sessionKey: string): string {
  return `maru_right_panel:${sessionKey}`;
}

function isPanelState(v: unknown): v is PanelState {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<PanelState>;
  return (
    typeof s.open === "boolean" &&
    Array.isArray(s.tabs) &&
    s.tabs.every((t) => t && typeof t === "object" && typeof (t as FileTarget).path === "string") &&
    (s.active === null || typeof s.active === "string") &&
    (s.lastFile === undefined || s.lastFile === null || typeof s.lastFile === "string")
  );
}

function load(sessionKey: string): PanelState {
  try {
    const raw = window.localStorage.getItem(storageKey(sessionKey));
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    return isPanelState(parsed) ? parsed : EMPTY;
  } catch {
    return EMPTY;
  }
}

function save(sessionKey: string, state: PanelState): void {
  try {
    if (state.tabs.length === 0 && !state.open) window.localStorage.removeItem(storageKey(sessionKey));
    else window.localStorage.setItem(storageKey(sessionKey), JSON.stringify(state));
  } catch {
    // Private windows and full storage keep the panel for this page only.
  }
}

/**
 * A session moved to another account (its key carries the account): its tabs and open state go to
 * the new key, unless that key has its own. Read when the new key's view mounts.
 */
export function moveRightPanel(from: string, to: string): void {
  try {
    const raw = window.localStorage.getItem(storageKey(from));
    if (raw === null) return;
    window.localStorage.removeItem(storageKey(from));
    if (window.localStorage.getItem(storageKey(to)) === null) window.localStorage.setItem(storageKey(to), raw);
  } catch {
    // Storage blocked: the panel state lived in the old view only.
  }
}

/**
 * Opening a path that is already a tab shows it and moves its highlighted lines. The tab keeps
 * the kind it was read as unless the new target says otherwise. Paths are normalized first, so a
 * chat link's `/proj/./a.ts` and the explorer's `/proj/a.ts` are one tab.
 */
export function openTab(state: PanelState, opened: FileTarget): PanelState {
  const target = { ...opened, path: normalizeFilePath(opened.path) };
  const exists = state.tabs.some((t) => t.path === target.path);
  const tabs = exists
    ? state.tabs.map((t) => (t.path !== target.path ? t : target.kind || !t.kind ? target : { ...target, kind: t.kind }))
    : [...state.tabs, target];
  return { open: true, tabs, active: target.path, lastFile: target.path };
}

/** Shows a tab: a file tab's path, EXPLORER_TAB or AGENTS_TAB. A file tab becomes the last file. */
export function activateTab(state: PanelState, active: string): PanelState {
  const isFile = state.tabs.some((t) => t.path === active);
  if (state.active === active && (!isFile || state.lastFile === active)) return state;
  return isFile ? { ...state, active, lastFile: active } : { ...state, active };
}

/** What the panel shows: the explorer, the agents tab, or a file tab. */
export function shownPanelTab(state: PanelState): "explorer" | "agents" | FileTarget {
  if (state.active === AGENTS_TAB) return "agents";
  return state.tabs.find((t) => t.path === state.active) ?? "explorer";
}

/** Whether the panel is open on the explorer (the Files tab), the state the header's Files button shows as pressed. */
export function filesShown(state: PanelState): boolean {
  return state.open && shownPanelTab(state) === "explorer";
}

/** The header's Files button: closes the panel while the Files tab shows, otherwise opens it on that tab. */
export function toggleFilesTab(state: PanelState): PanelState {
  return filesShown(state) ? { ...state, open: false } : { ...state, open: true, active: EXPLORER_TAB };
}

/** The file tab the explorer marks: the shown one, else the one shown last. */
export function currentFileTab(state: PanelState): FileTarget | null {
  return (
    state.tabs.find((t) => t.path === state.active) ??
    (state.lastFile ? state.tabs.find((t) => t.path === state.lastFile) : undefined) ??
    null
  );
}

/** Records what a tab's path is, once read. Unchanged state when it already says so. */
export function setTabKind(state: PanelState, path: string, kind: FileTargetKind): PanelState {
  if (!state.tabs.some((t) => t.path === path && t.kind !== kind)) return state;
  return { ...state, tabs: state.tabs.map((t) => (t.path === path ? { ...t, kind } : t)) };
}

/**
 * Closing the shown tab shows its right neighbor, else its left one, else the agents tab: T3's
 * closeSurface over the whole strip, where the agents tab sits left of the file tabs.
 */
export function closeTab(state: PanelState, path: string): PanelState {
  const i = state.tabs.findIndex((t) => t.path === path);
  if (i < 0) return state;
  const tabs = state.tabs.filter((t) => t.path !== path);
  const active =
    state.active !== path ? state.active : (tabs[i]?.path ?? tabs[i - 1]?.path ?? AGENTS_TAB);
  const lastFile =
    state.lastFile !== path ? (state.lastFile ?? null) : tabs.some((t) => t.path === active) ? active : null;
  return { open: state.open, tabs, active, lastFile };
}

export function useRightPanel(sessionKey: string) {
  const [state, setState] = useState(() => load(sessionKey));
  const update = (next: (prev: PanelState) => PanelState) =>
    setState((prev) => {
      const s = next(prev);
      if (s !== prev) save(sessionKey, s);
      return s;
    });
  return {
    state,
    openFile: (target: FileTarget) => update((prev) => openTab(prev, target)),
    closeFile: (path: string) => update((prev) => closeTab(prev, path)),
    activate: (path: string) => update((prev) => activateTab(prev, path)),
    showAgents: () =>
      update((prev) => (prev.open && prev.active === AGENTS_TAB ? prev : { ...prev, open: true, active: AGENTS_TAB })),
    toggleFiles: () => update(toggleFilesTab),
    setOpen: (open: boolean) => update((prev) => (prev.open === open ? prev : { ...prev, open })),
    setKind: (path: string, kind: FileTargetKind) => update((prev) => setTabKind(prev, path, kind)),
  };
}

// Inline layout (DESIGN.md 6e), after T3's hooks/usePreviewPanelInlineSize.ts: the panel is
// 360px up to 70% of the viewport, and the conversation beside it keeps 360px.
export const PANEL_MIN_WIDTH = 360;
export const PANEL_DEFAULT_WIDTH = 540;
const PANEL_MAX_VIEWPORT_FRACTION = 0.7;
export const CONVERSATION_MIN_WIDTH = 360;
/** T3's RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY: from this viewport width the panel can sit inline. */
export const INLINE_MIN_VIEWPORT = 981;

/**
 * The widest the inline panel may be. `rowWidth` is the row the panel shares with the
 * conversation, null before it is measured. Never below the panel's minimum.
 */
export function panelMaxWidth(viewportWidth: number, rowWidth: number | null): number {
  const fractionCap = Math.floor(viewportWidth * PANEL_MAX_VIEWPORT_FRACTION);
  const rowCap = rowWidth === null ? Infinity : Math.floor(rowWidth) - CONVERSATION_MIN_WIDTH;
  return Math.max(PANEL_MIN_WIDTH, Math.min(fractionCap, rowCap));
}

/** Inline when the viewport is wide enough and the row holds both minimums; a sheet otherwise. */
export function panelFitsInline(viewportWidth: number, rowWidth: number | null): boolean {
  return (
    viewportWidth >= INLINE_MIN_VIEWPORT &&
    (rowWidth === null || Math.floor(rowWidth) >= PANEL_MIN_WIDTH + CONVERSATION_MIN_WIDTH)
  );
}

/** The width the panel shows: the chosen width, within the minimum and the current cap. */
export function panelShownWidth(chosen: number, maxWidth: number): number {
  return Math.min(Math.max(chosen, PANEL_MIN_WIDTH), maxWidth);
}

/** How a file chip in the conversation opens its file. null outside a session view. */
export const FileOpenContext = createContext<((target: FileTarget) => void) | null>(null);

export function useFileOpen(): ((target: FileTarget) => void) | null {
  return use(FileOpenContext);
}
