// The terminal mode's color theme storage and hooks (Settings, Appearance, Terminal color set; DESIGN.md 6i,
// "터미널 테마 선택"). The colorsets and the token rules are terminalTheme.logic.ts (re-exported here, so
// importers of this file are unchanged); this file keeps the choice in the browser's localStorage and
// applies it to the page.
import { useSyncExternalStore } from "react";

import {
  COLORSET_KEY,
  DEFAULT_TERMINAL_THEME,
  ITERM_TOKENS,
  RETIRED_SURFACE_KEY,
  colorsetById,
  luminance,
  normalizeTerminalTheme,
  resolveTerminalTokens,
  terminalThemeStyle,
  type TerminalThemePrefs,
} from "./terminalTheme.logic.ts";

export * from "./terminalTheme.logic.ts";

function read(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    // Storage blocked or a value that is not JSON: the default applies.
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the change holds for this page only.
  }
}

const listeners = new Set<() => void>();
let prefs: TerminalThemePrefs | null = null;

function readPrefs(): TerminalThemePrefs {
  return normalizeTerminalTheme({ colorset: read(COLORSET_KEY) });
}

function snapshot(): TerminalThemePrefs {
  prefs ??= readPrefs();
  return prefs;
}

function notify(): void {
  applyTerminalThemeToRoot();
  for (const l of [...listeners]) l();
}

function onStorage(event: StorageEvent): void {
  if (event.key === null || event.key === COLORSET_KEY) {
    prefs = readPrefs();
    notify();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function useTerminalTheme(): TerminalThemePrefs {
  return useSyncExternalStore(subscribe, snapshot);
}

export function setTerminalTheme(change: Partial<TerminalThemePrefs>): void {
  const next = normalizeTerminalTheme({ ...snapshot(), ...change });
  prefs = next;
  write(COLORSET_KEY, next.colorset === DEFAULT_TERMINAL_THEME.colorset ? null : next.colorset);
  write(RETIRED_SURFACE_KEY, null);
  notify();
}

/** The style for the terminal root under the choice made now. */
export function useTerminalThemeStyle(): Record<string, string> {
  const { colorset } = useTerminalTheme();
  return terminalThemeStyle(colorset);
}

/**
 * The chat code background preset "Terminal background" follows the colorset's background (index.css
 * --chat-code-preset-terminal). It keeps the app's own scheme (the preset's text is the app's), so
 * a dark terminal background reaches the dark app's preset and a light one the light app's.
 */
export function applyTerminalThemeToRoot(root: HTMLElement = document.documentElement): void {
  const set = colorsetById(snapshot().colorset);
  const tokens = resolveTerminalTokens(set.id);
  const own = tokens.bg === ITERM_TOKENS.bg && set.scheme === "dark";
  // The preset's syntax colors were tuned for dark surfaces at relative luminance 0.025 or below
  // and light ones at 0.82 or above (index.css chat code); a background outside keeps the default.
  const lum = luminance(tokens.bg);
  const dark = set.scheme === "dark" && !own && lum <= 0.025 ? tokens.bg : null;
  const light = set.scheme === "light" && lum >= 0.82 ? tokens.bg : null;
  for (const [name, value] of [
    ["--chat-code-term-dark", dark],
    ["--chat-code-term-light", light],
  ] as const) {
    if (value === null) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
}

/** main.tsx calls it once: the chat code preset takes the saved choice from the first paint on. */
export function startTerminalTheme(): void {
  applyTerminalThemeToRoot();
}
