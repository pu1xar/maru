// How a session's conversation is drawn (DESIGN.md 6i): the chat timeline or the terminal mode
// that redraws the same thread as Claude Code's TUI. The default for every session lives in
// Settings (화면); a session's own choice is kept per session. Both stay in this browser's
// localStorage, like the other display preferences (displayPrefs.ts). The terminal mode's text
// size lives here too (its font is the monospace font, displayPrefs.ts).
import { useSyncExternalStore } from "react";

import {
  DEFAULT_MODE_KEY,
  DEFAULT_TERMINAL_PREFS,
  FONT_SIZE_KEY,
  SESSION_MODE_PREFIX,
  isViewMode,
  normalizeTerminalPrefs,
  resolveViewMode,
  type TerminalPrefs,
  type ViewMode,
} from "./viewMode.logic.ts";

export * from "./viewMode.logic.ts";

function read(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    // Storage blocked or a value that is not JSON: the default applies.
    return null;
  }
}

function write(key: string, value: unknown | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the change holds for this page only.
  }
}

const listeners = new Set<() => void>();
let prefs: TerminalPrefs | null = null;
/** Session modes read so far; `null` means "no own choice". */
const sessionModes = new Map<string, ViewMode | null>();

function notify(): void {
  for (const l of [...listeners]) l();
}

function readPrefs(): TerminalPrefs {
  return normalizeTerminalPrefs({ defaultMode: read(DEFAULT_MODE_KEY), fontSize: read(FONT_SIZE_KEY) });
}

function onStorage(event: StorageEvent): void {
  // Another tab of this browser changed a mode or a terminal setting.
  if (event.key === null || event.key === DEFAULT_MODE_KEY || event.key === FONT_SIZE_KEY) prefs = readPrefs();
  if (event.key === null) sessionModes.clear();
  else if (event.key.startsWith(SESSION_MODE_PREFIX)) sessionModes.delete(event.key.slice(SESSION_MODE_PREFIX.length));
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

function prefsSnapshot(): TerminalPrefs {
  prefs ??= readPrefs();
  return prefs;
}

function sessionSnapshot(sessionKey: string): ViewMode | null {
  if (!sessionModes.has(sessionKey)) {
    const stored = read(SESSION_MODE_PREFIX + sessionKey);
    sessionModes.set(sessionKey, isViewMode(stored) ? stored : null);
  }
  return sessionModes.get(sessionKey) ?? null;
}

export function useTerminalPrefs(): TerminalPrefs {
  return useSyncExternalStore(subscribe, prefsSnapshot);
}

/** The terminal settings as the page has them now (outside React: the area zoom's wheel, lib/areaZoom.ts). */
export function currentTerminalPrefs(): TerminalPrefs {
  return prefsSnapshot();
}

export function setTerminalPrefs(change: Partial<TerminalPrefs>): void {
  const next = { ...prefsSnapshot(), ...change };
  prefs = next;
  write(DEFAULT_MODE_KEY, next.defaultMode === DEFAULT_TERMINAL_PREFS.defaultMode ? null : next.defaultMode);
  write(FONT_SIZE_KEY, next.fontSize === DEFAULT_TERMINAL_PREFS.fontSize ? null : next.fontSize);
  notify();
}

/** The mode this session shows, and a setter that keeps it as the session's own choice. */
export function useViewMode(sessionKey: string): [ViewMode, (mode: ViewMode) => void] {
  const own = useSyncExternalStore(subscribe, () => sessionSnapshot(sessionKey));
  const { defaultMode } = useTerminalPrefs();
  const mode = resolveViewMode(own, defaultMode);
  const setMode = (next: ViewMode) => {
    sessionModes.set(sessionKey, next);
    write(SESSION_MODE_PREFIX + sessionKey, next);
    notify();
  };
  return [mode, setMode];
}

/**
 * A session moved to another account (its key carries the account): its own mode goes to the new
 * key, unless that key has one already.
 */
export function moveSessionViewMode(from: string, to: string): void {
  const own = sessionSnapshot(from);
  if (own === null) return;
  sessionModes.set(from, null);
  write(SESSION_MODE_PREFIX + from, null);
  if (sessionSnapshot(to) === null) {
    sessionModes.set(to, own);
    write(SESSION_MODE_PREFIX + to, own);
  }
  notify();
}
