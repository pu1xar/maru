// Display preferences of this browser (Settings, Appearance): the interface font and scale, the
// conversation's font and text size, the inline code's text size, and the chat code font, text size
// and background. Each device keeps its own values in localStorage, and main.tsx applies them
// before the first render.
//
// The two text sizes are absolute sizes in pt. 1pt is 1 CSS px, as macOS's point is a logical
// unit, so 15pt here, in iTerm2 and in the terminal mode (viewMode.ts) is the same size. A size is
// the size at UI scale 100% and area zoom 100%: the UI scale and an area's zoom multiply it.
//
// UI scale sets the root font size, as T3 Code's interface font size does (appearanceFonts.ts):
// every rem-based size grows with it while layout, pointer coordinates and popup positions stay
// native. The values that are not rem (the sidebar and panel widths the user drags, 1px borders)
// keep their pixels. Media queries read the browser's initial font size, so breakpoints stay put.
//
// The conversation text size becomes a factor over CHAT_TEXT_BASE_PT (the conversation's text-sm
// size before the setting was in pt): the conversation container (`[data-chat-text]`, index.css)
// applies it to the theme's text sizes and to chat markdown's own sizes. The root font size
// (UI scale) multiplies the rem sizes the factor scales, so 15pt at UI scale 110% is 16.5px.
//
// The interface font (uiFonts.ts) becomes the root's `--font-sans`, which the page's text reads
// (index.css). The conversation's font is the interface's until it is set; set, the root carries it
// as `--font-chat-text-setting` with `data-chat-font`, and index.css gives the conversation
// (`[data-chat-text]`) that font as its `--font-sans`. A font that needs a web stylesheet gets it
// added to the page when it is chosen (uiFonts.ts ensureStylesheets), and no other font loads.
//
// Inline code in the conversation draws in the conversation's font (a proportional font in a box,
// index.css). Its size follows the conversation text size until it is set; set, it is a size in pt
// of its own, which the root's `--chat-inline-code-scale-setting` carries as a factor over
// CHAT_TEXT_BASE_PT and index.css turns into the inline code's size over the text around it
// (`--chat-inline-code-ratio`).
//
// The chat code font is one of the terminal's font list (viewMode.ts TERMINAL_FONTS) and becomes
// the root's `--font-chat-code`, which the conversation's monospace text reads (index.css: code
// blocks, tool output, diffs, file previews, the composer's inline code). The
// chat code background is a preset, whose light and dark values are index.css tokens
// (`--chat-code-preset-<id>`, picked by the root's `data-chat-code-background`), or a custom color
// written to the root as `--chat-code-background`, with the color scheme its text needs as the
// root's `data-chat-code-scheme`.
// The border and the bubble's code color derive from the background in index.css.
//
// The user's bubble is the theme's own surface, or blue (the accent with white text) so the user's
// turns stand apart from the replies; blue is the root's `data-message-bubble`, which index.css reads.
//
// The chat code text size follows the conversation text size until it is set; set, it is a size in
// pt of its own, which the root's `--chat-code-scale-setting` carries as a factor over
// CHAT_TEXT_BASE_PT and index.css turns into the code's size over the text around it
// (`--chat-code-ratio`).
//
// A browser that stored the sizes as percents (`maru_chat_text_scale`, `maru_chat_code_text_scale`)
// reads them as the nearest pt step (legacyPercentToPt), and the next write removes the old keys.
import { useSyncExternalStore } from "react";

import { ensureStylesheets } from "./uiFonts.ts";
import {
  DEFAULT_DISPLAY_PREFS,
  KEYS,
  LEGACY_DISPLAY_KEYS,
  displayCss,
  displayPrefEntries,
  normalizeDisplayPrefs,
  readDisplayPrefsFrom,
  type DisplayPrefs,
} from "./displayPrefs.logic.ts";

export * from "./displayPrefs.logic.ts";

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Storage blocked: the default applies.
    return null;
  }
}

export function readDisplayPrefs(): DisplayPrefs {
  return readDisplayPrefsFrom(readRaw);
}

function setRootProperty(root: HTMLElement, name: string, value: string | null): void {
  if (value === null) root.style.removeProperty(name);
  else root.style.setProperty(name, value);
}

function setRootAttribute(root: HTMLElement, name: string, value: string | null): void {
  if (value === null) root.removeAttribute(name);
  else root.setAttribute(name, value);
}

export function applyDisplayPrefs(prefs: DisplayPrefs, root: HTMLElement = document.documentElement): void {
  const css = displayCss(prefs);
  setRootProperty(root, "--font-sans", css.uiFont);
  setRootProperty(root, "--font-chat-text-setting", css.chatFont);
  setRootAttribute(root, "data-chat-font", css.chatFontAttribute);
  ensureStylesheets(css.fontSheets);
  setRootProperty(root, "font-size", css.rootFontSize);
  setRootProperty(root, "--chat-text-scale-setting", css.chatTextScale);
  setRootProperty(root, "--font-chat-code", css.monoFont);
  setRootProperty(root, "--chat-code-background", css.chatCodeBackground);
  setRootAttribute(root, "data-chat-code-background", css.chatCodePreset);
  setRootAttribute(root, "data-chat-code-scheme", css.chatCodeScheme);
  setRootProperty(root, "--chat-code-scale-setting", css.chatCodeTextScale);
  setRootProperty(root, "--chat-inline-code-scale-setting", css.chatInlineCodeTextScale);
  setRootAttribute(root, "data-message-bubble", css.messageBubble);
}

let current: DisplayPrefs | null = null;
const listeners = new Set<() => void>();

function snapshot(): DisplayPrefs {
  current ??= readDisplayPrefs();
  return current;
}

function onStorage(event: StorageEvent): void {
  // Another tab of this browser changed them.
  if (event.key !== null && !KEYS.includes(event.key)) return;
  current = readDisplayPrefs();
  applyDisplayPrefs(current);
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function useDisplayPrefs(): DisplayPrefs {
  return useSyncExternalStore(subscribe, snapshot);
}

/** The values as the page has them now (outside React: the area zoom's wheel, lib/areaZoom.ts). */
export function currentDisplayPrefs(): DisplayPrefs {
  return snapshot();
}

/** Stores the values that differ from the defaults and removes the rest, and the old percent keys. */
function writePrefs(prefs: DisplayPrefs): void {
  try {
    for (const [key, value] of displayPrefEntries(prefs)) {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    }
    for (const key of LEGACY_DISPLAY_KEYS) window.localStorage.removeItem(key);
  } catch {
    // Storage blocked: the change holds for this page only.
  }
}

export function setDisplayPrefs(change: Partial<DisplayPrefs>): void {
  const merged = { ...snapshot(), ...change };
  const next = normalizeDisplayPrefs(merged);
  current = next;
  writePrefs(next);
  applyDisplayPrefs(next);
  for (const l of [...listeners]) l();
}
