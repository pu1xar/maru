// The app's display settings (Settings, Appearance), the web's own rules read from web/src/lib: the same
// preferences under the same keys and value forms (displayPrefs.logic.ts, theme.logic.ts,
// areaZoom.logic.ts), what a stored value normalizes to, and how the sizes and fonts reach a Text
// (resolveTextStyle). React Native-free; the store is appearanceStore.ts and the components that
// apply the rules are appearance.tsx and components/ui/Text.tsx.
import {
  DEFAULT_DISPLAY_PREFS,
  KEYS as DISPLAY_KEYS,
  LEGACY_DISPLAY_KEYS,
  displayPrefEntries,
  normalizeDisplayPrefs,
  normalizeStep,
  readDisplayPrefsFrom,
  type DisplayPrefs,
} from "../../../web/src/lib/displayPrefs.logic.ts";
import { DEFAULT_THEME, THEME_KEY, normalizeTheme, type ThemePref } from "../../../web/src/lib/theme.logic.ts";
import { AREA_ZOOM_STEPS, AREA_ZOOM_STORAGE_KEY } from "../../../web/src/lib/areaZoom.logic.ts";
import { resolveChatFont } from "../../../web/src/lib/uiFonts.logic.ts";
import {
  DEFAULT_MODE_KEY,
  DEFAULT_TERMINAL_PREFS,
  FONT_SIZE_KEY,
  normalizeTerminalPrefs,
  readTerminalPrefsFrom,
  terminalPrefEntries,
  type ViewMode,
} from "../../../web/src/lib/viewMode.logic.ts";
import { COLORSET_KEY, DEFAULT_TERMINAL_THEME, normalizeTerminalTheme } from "../../../web/src/lib/terminalTheme.logic.ts";
import { CODE_FACES, SANS_FACES, loadedFamily, weightNumber } from "./appFonts.logic.ts";

/** The preferences the app has: the web's display preferences, the color theme, the sidebar's zoom and the terminal mode's settings. */
export interface AppearancePrefs extends DisplayPrefs {
  theme: ThemePref;
  /** Percent, the web's area zoom of the sidebar (here the drawer's text). */
  sidebarZoom: number;
  /** The view a session opens in until it has its own choice (web "Default view mode", DESIGN.md 6i). */
  defaultViewMode: ViewMode;
  /** The terminal mode's text size in pt (web "Terminal text size"). */
  terminalFontSize: number;
  /** The terminal mode's color set id (web "Terminal color set"). */
  terminalColorset: string;
}

/**
 * The drawer's text is drawn at 14sp (the web's sidebar text-sm before its zoom), so its zoom
 * starts at 100%. The web's sidebar starts at 90% on a desktop (areaZoom.logic.ts AREA_ZOOM_DEFAULTS),
 * which would make a phone's drawer text 12.6sp.
 */
export const APP_SIDEBAR_ZOOM_DEFAULT = 100;

export const DEFAULT_APPEARANCE: AppearancePrefs = {
  ...DEFAULT_DISPLAY_PREFS,
  theme: DEFAULT_THEME,
  sidebarZoom: APP_SIDEBAR_ZOOM_DEFAULT,
  defaultViewMode: DEFAULT_TERMINAL_PREFS.defaultMode,
  terminalFontSize: DEFAULT_TERMINAL_PREFS.fontSize,
  terminalColorset: DEFAULT_TERMINAL_THEME.colorset,
};

export const SIDEBAR_ZOOM_STEPS = AREA_ZOOM_STEPS;
const SIDEBAR_ZOOM_KEY = AREA_ZOOM_STORAGE_KEY.sidebar;

/** Every key the settings read, with the old percent keys a write removes. */
export const APPEARANCE_KEYS: readonly string[] = [...DISPLAY_KEYS, THEME_KEY, SIDEBAR_ZOOM_KEY, DEFAULT_MODE_KEY, FONT_SIZE_KEY, COLORSET_KEY];

function parseStored(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function readAppearanceFrom(raw: (key: string) => string | null): AppearancePrefs {
  const terminal = readTerminalPrefsFrom(raw);
  return {
    ...readDisplayPrefsFrom(raw),
    theme: normalizeTheme(parseStored(raw(THEME_KEY))),
    sidebarZoom: normalizeStep(parseStored(raw(SIDEBAR_ZOOM_KEY)), SIDEBAR_ZOOM_STEPS, APP_SIDEBAR_ZOOM_DEFAULT),
    defaultViewMode: terminal.defaultMode,
    terminalFontSize: terminal.fontSize,
    terminalColorset: normalizeTerminalTheme({ colorset: parseStored(raw(COLORSET_KEY)) }).colorset,
  };
}

/** What a change merged over the current values becomes. */
export function normalizeAppearance(merged: AppearancePrefs): AppearancePrefs {
  const terminal = normalizeTerminalPrefs({ defaultMode: merged.defaultViewMode, fontSize: merged.terminalFontSize });
  return {
    ...normalizeDisplayPrefs(merged),
    theme: normalizeTheme(merged.theme),
    sidebarZoom: normalizeStep(merged.sidebarZoom, SIDEBAR_ZOOM_STEPS, APP_SIDEBAR_ZOOM_DEFAULT),
    defaultViewMode: terminal.defaultMode,
    terminalFontSize: terminal.fontSize,
    terminalColorset: normalizeTerminalTheme({ colorset: merged.terminalColorset }).colorset,
  };
}

/** What a write stores: each key with its JSON text, or null to remove it (a value equal to its default is not stored). */
export function appearanceEntries(prefs: AppearancePrefs): Array<[string, string | null]> {
  return [
    ...displayPrefEntries(prefs),
    [THEME_KEY, prefs.theme === DEFAULT_THEME ? null : JSON.stringify(prefs.theme)],
    [SIDEBAR_ZOOM_KEY, prefs.sidebarZoom === APP_SIDEBAR_ZOOM_DEFAULT ? null : JSON.stringify(prefs.sidebarZoom)],
    ...terminalPrefEntries({ defaultMode: prefs.defaultViewMode, fontSize: prefs.terminalFontSize }),
    [COLORSET_KEY, prefs.terminalColorset === DEFAULT_TERMINAL_THEME.colorset ? null : JSON.stringify(prefs.terminalColorset)],
    ...LEGACY_DISPLAY_KEYS.map((key): [string, null] => [key, null]),
  ];
}

// ---- Sizes and fonts ----

/** Where a Text sits: the interface, the conversation (and its composer) or the drawer. */
export type TextScope = "ui" | "chat" | "sidebar";

/**
 * The family name styles use for the monospace font (theme.ts `fonts.mono`). It is not a font
 * file's name: resolveTextStyle replaces it with the chosen font's loaded face, or the phone's
 * monospace while there is none. A style that names `monospace` itself (paths, the pairing code)
 * keeps the phone's font.
 */
export const CODE_FAMILY = "maru-code";
/**
 * The family name inline code uses: the same monospace font as CODE_FAMILY, but sized with the
 * conversation text (the inline code size is its own ratio over it) instead of the code block size.
 */
export const INLINE_CODE_FAMILY = "maru-inline-code";
/**
 * The family name the terminal mode uses (DESIGN.md 6i): the same monospace font, drawn at exactly
 * the size the style gives. The UI scale and the code block factor do not reach it, because the
 * terminal's size is its own setting and its cell grid is computed from that size.
 */
export const TERMINAL_FAMILY = "maru-terminal";

/** The conversation text size the app's sizes are drawn at (the web's default, 15pt) and its chat code size (13pt). */
export const CHAT_BASE_PT = DEFAULT_DISPLAY_PREFS.chatText;
export const CODE_BASE_PT = DEFAULT_DISPLAY_PREFS.chatCodeText ?? CHAT_BASE_PT;
/** React Native's text size with none given. */
const DEFAULT_TEXT_SIZE = 14;

/** What Text reads: the size factors and the faces already loaded. */
export interface TextEnv {
  /** The UI scale; every Text takes it, as the web's root font size reaches every rem size. */
  ui: number;
  /** The conversation text size over the size the app draws at. */
  chat: number;
  /** The drawer's zoom. */
  sidebar: number;
  /** The chat code text size over the size the app draws at. */
  code: number;
  /** The inline code's size over the conversation text around it (the web's `--chat-inline-code-ratio`). */
  inlineCode: number;
  sansFamily(scope: TextScope, weight: number): string | null;
  codeFamily(weight: number): string | null;
}

export function textEnv(prefs: AppearancePrefs, loaded: ReadonlySet<string>, codeSet = CODE_FACES): TextEnv {
  const uiFaces = SANS_FACES[prefs.uiFont];
  const chatFaces = SANS_FACES[resolveChatFont(prefs.chatFont, prefs.uiFont)];
  const codeFaces = codeSet[prefs.monoFont];
  const codePt = prefs.chatCodeText ?? prefs.chatText;
  const inlinePt = prefs.chatInlineCodeText ?? prefs.chatText;
  return {
    ui: prefs.uiScale / 100,
    chat: prefs.chatText / CHAT_BASE_PT,
    sidebar: prefs.sidebarZoom / 100,
    code: codePt / CODE_BASE_PT,
    inlineCode: inlinePt / prefs.chatText,
    sansFamily: (scope, weight) => loadedFamily(scope === "chat" ? chatFaces : uiFaces, loaded, weight),
    codeFamily: (weight) => loadedFamily(codeFaces, loaded, weight),
  };
}

/** The settings at their defaults with no font loaded: every factor 1, every family the phone's own. */
export const NEUTRAL_ENV: TextEnv = textEnv(DEFAULT_APPEARANCE, new Set());

type Flat = Record<string, unknown>;

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * The style a Text draws with: the size and line height scaled by the UI scale and its scope's
 * factor (a nested Text with no size inherits its parent's, already scaled), and the face of the
 * chosen font for its weight in place of fontFamily and fontWeight. Without a setting that changes
 * it, the style comes back as it is.
 */
export function resolveTextStyle(style: Flat | undefined, o: { nested: boolean; scope: TextScope }, env: TextEnv): Flat | undefined {
  const s = style ?? {};
  const block = s.fontFamily === CODE_FAMILY;
  const terminal = s.fontFamily === TERMINAL_FAMILY;
  const code = block || terminal || s.fontFamily === INLINE_CODE_FAMILY;
  const k = terminal ? 1 : env.ui * (block ? env.code : o.scope === "chat" ? env.chat : o.scope === "sidebar" ? env.sidebar : 1);
  const weight = weightNumber(s.fontWeight);
  // undefined: the style's own family stays. null: the phone's font stands in.
  const face = code ? env.codeFamily(weight) : s.fontFamily === undefined ? env.sansFamily(o.scope, weight) : undefined;
  if (k === 1 && !code && !face) return style;
  const out: Flat = { ...s };
  if (k !== 1) {
    if (typeof s.fontSize === "number") out.fontSize = round(s.fontSize * k);
    else if (!o.nested) out.fontSize = round(DEFAULT_TEXT_SIZE * k);
    if (typeof s.lineHeight === "number") out.lineHeight = round(s.lineHeight * k);
  }
  if (code) out.fontFamily = face ?? "monospace";
  if (face) {
    out.fontFamily = face;
    delete out.fontWeight;
  }
  return out;
}
