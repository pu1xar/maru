// The app's color theme (Settings, Appearance, 전체: 테마), as T3 Code applies its appearance mode
// (hooks/useTheme.ts and the boot script in its index.html): the root carries the `dark` class or
// not, and index.css keeps two sets of tokens, `:root` for light and `@variant dark` for dark,
// with `color-scheme` following them. "시스템" follows the OS setting and changes with it.
//
// The value is this browser's, in localStorage like the other display preferences
// (displayPrefs.ts). The first paint takes it from the inline script in index.html, which reads
// the same key before the stylesheet and the app load; main.tsx then starts this module, which
// owns the theme from there: Settings, the OS setting and other tabs of this browser change it.
// index.html's script and resolveTheme must agree; theme.test.ts runs the script against it.
import { useSyncExternalStore } from "react";

import { DEFAULT_THEME, normalizeTheme, resolveTheme, THEME_KEY, type ResolvedTheme, type ThemePref } from "./theme.logic.ts";

export * from "./theme.logic.ts";

export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export function readThemePref(): ThemePref {
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    return normalizeTheme(raw === null ? null : JSON.parse(raw));
  } catch {
    // Storage blocked or a value that is not JSON: the default applies.
    return DEFAULT_THEME;
  }
}

function systemMedia(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(SYSTEM_DARK_QUERY) : null;
}

/** The OS asks for dark; a browser that cannot tell counts as dark, as index.html's script does. */
export function systemPrefersDark(media: MediaQueryList | null = systemMedia()): boolean {
  return media?.matches ?? true;
}

/**
 * Puts the theme on the root. A change after the first paint switches with transitions off for
 * one frame (index.css .no-transitions), as T3 does, so colors do not fade one by one. The
 * browser's toolbar color (meta theme-color) takes the page background the stylesheet now gives.
 */
export function applyTheme(resolved: ResolvedTheme, opts: { suppressTransitions?: boolean } = {}): void {
  const root = document.documentElement;
  if (opts.suppressTransitions) root.classList.add("no-transitions");
  root.classList.toggle("dark", resolved === "dark");
  // index.html paints the root before the stylesheet loads; from here the stylesheet's
  // --app-chrome-background owns it.
  root.style.removeProperty("background-color");
  const background = getComputedStyle(root).backgroundColor;
  if (background) {
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.setAttribute("content", background);
  }
  if (opts.suppressTransitions) {
    // Reflow so the class takes effect before it comes off.
    void root.offsetHeight;
    requestAnimationFrame(() => root.classList.remove("no-transitions"));
  }
}

interface ThemeSnapshot {
  pref: ThemePref;
  resolved: ResolvedTheme;
}

let current: ThemeSnapshot | null = null;
/** The choice made on this page while storage refused it. */
let pagePref: ThemePref | null = null;
const listeners = new Set<() => void>();

function compute(): ThemeSnapshot {
  const pref = pagePref ?? readThemePref();
  return { pref, resolved: resolveTheme(pref, systemPrefersDark()) };
}

/** Applies a new snapshot when it differs and tells the subscribers; the same values keep the old one. */
function update(next: ThemeSnapshot): void {
  const prev = current;
  if (prev && prev.pref === next.pref && prev.resolved === next.resolved) return;
  current = next;
  if (prev?.resolved !== next.resolved) applyTheme(next.resolved, { suppressTransitions: prev !== null });
  for (const l of [...listeners]) l();
}

/**
 * main.tsx calls this once before the first render. It applies the stored theme and listens for
 * the OS setting (it matters while the theme is "시스템") and for other tabs of this browser.
 */
export function startTheme(): void {
  current = null;
  update(compute());
  systemMedia()?.addEventListener("change", () => update(compute()));
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === THEME_KEY) update(compute());
  });
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === DEFAULT_THEME) window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, JSON.stringify(pref));
    pagePref = null;
  } catch {
    // Storage blocked: the change holds for this page only.
    pagePref = pref;
  }
  update(compute());
}

function snapshot(): ThemeSnapshot {
  current ??= compute();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useTheme(): ThemeSnapshot {
  return useSyncExternalStore(subscribe, snapshot);
}
