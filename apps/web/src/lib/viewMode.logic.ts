// The pure side of the terminal mode's settings and of the monospace font list (viewMode.ts keeps
// the browser's storage and the hooks): the view modes, the fonts the terminal and the chat code
// offer, the terminal cell's metrics and the preference rules. The Android app reads the font list
// and the chat code rules from here.
import { inIntRange, rangeOfSteps } from "./settingControl.logic.ts";

export type ViewMode = "chat" | "terminal";

export const VIEW_MODES: readonly ViewMode[] = ["chat", "terminal"];

/**
 * Monospace fonts offered in Settings, for the terminal font and the chat code font
 * (displayPrefs.ts). `stack` is the CSS font-family list.
 */
export const TERMINAL_FONTS = [
  {
    id: "bon",
    label: "Bon Google Sans Code",
    // The user's iTerm font (installed on this Mac), then the same font from the web for devices
    // without it (index.css), then the tmux web app's fallbacks.
    stack: '"Bon Google Sans Code", "Maru Bon Google Sans Code", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  },
  {
    id: "bon-web",
    label: "Bon Google Sans Code (web font)",
    stack: '"Maru Bon Google Sans Code", SFMono-Regular, Menlo, Consolas, monospace',
  },
  { id: "d2coding", label: "D2Coding", stack: '"D2Coding", "D2Coding ligature", SFMono-Regular, Menlo, monospace' },
  { id: "sf-mono", label: "SF Mono", stack: 'SFMono-Regular, "SF Mono", Menlo, Monaco, monospace' },
  {
    id: "system",
    label: "System monospace",
    // index.css --font-mono, the chat code font's default: SF Mono on Apple devices, then each
    // platform's own monospace font.
    stack: 'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
  },
] as const;

export type TerminalFontId = (typeof TERMINAL_FONTS)[number]["id"];

/**
 * Terminal text sizes in whole pt (iTerm sizes its font in whole points, and 1pt is 1 CSS px
 * here, as it is in the conversation's text sizes, displayPrefs.ts). Both lists are 11 to 22.
 */
export const TERMINAL_FONT_SIZES = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] as const;
/** The sizes a typed terminal text size may take (whole pt, the iTerm cell formula's integers). */
export const TERMINAL_FONT_RANGE = rangeOfSteps(TERMINAL_FONT_SIZES);

/**
 * Vertical metrics of Bon Google Sans Code in font units (head, hhea; the installed files and the
 * web font have the same values): units per em, ascender, descender, line gap, and the advance
 * of "W" (every Latin glyph of this monospace font).
 */
const BON_METRICS = { unitsPerEm: 2000, ascender: 1932, descender: 572, lineGap: 0, advance: 1200 } as const;
/** The user's iTerm profile spacing (Horizontal 100%, Vertical 101%), as percents. */
const ITERM_SPACING = { horizontal: 100, vertical: 101 } as const;

export interface TerminalCell {
  /** One cell's width (px): the grid gutters and the column count use it. */
  width: number;
  /** One row's height (px). */
  height: number;
  /** Extra space after each glyph so a glyph advance fills a cell (px; 0 when they match). */
  letterSpacing: number;
}

/**
 * The cell iTerm2 (3.7.7, FontSizeEstimator.m and PTYTextView.m) lays a font out in, for the Bon
 * fonts: width round(W advance) then ceil(x horizontal spacing); height ceil(ascender + descender
 * + leading), then ceil(x vertical spacing). At 15px that is 9 x 20 (DESIGN.md 6i). Other fonts
 * have no measured metrics here: their cell is the glyph advance (1ch) and 1.2 x 1.01 rows.
 */
export function terminalCell(font: TerminalFontId, fontSize: number): TerminalCell {
  if (font === "bon" || font === "bon-web") {
    const m = BON_METRICS;
    const advance = (m.advance * fontSize) / m.unitsPerEm;
    const width = Math.ceil((Math.ceil(Math.round(advance)) * ITERM_SPACING.horizontal) / 100);
    const bare = Math.ceil(((m.ascender + m.descender + m.lineGap) * fontSize) / m.unitsPerEm);
    const height = Math.ceil((bare * ITERM_SPACING.vertical) / 100);
    return { width, height, letterSpacing: Number((width - advance).toFixed(4)) };
  }
  return { width: 0, height: Math.ceil(fontSize * 1.2 * 1.01), letterSpacing: 0 };
}

/** The CSS variables the terminal's root (and the settings preview) take for these preferences. */
export function terminalRootStyle(prefs: { font: TerminalFontId; fontSize: number }): Record<string, string> {
  const cell = terminalCell(prefs.font, prefs.fontSize);
  return {
    "--term-font": terminalFontStack(prefs.font),
    "--term-font-size": `${prefs.fontSize}px`,
    "--term-line-height": `${cell.height}px`,
    ...(cell.width > 0 ? { "--term-cell": `${cell.width}px`, "--term-letter-spacing": `${cell.letterSpacing}px` } : {}),
  };
}

export interface TerminalPrefs {
  /** View mode a session opens in until it gets its own choice. */
  defaultMode: ViewMode;
  /** pt (1pt is 1 CSS px). 15 is the user's iTerm profile (BonGoogleSansCode-Regular 15). */
  fontSize: number;
}

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = { defaultMode: "chat", fontSize: 13 };

export function isViewMode(value: unknown): value is ViewMode {
  return value === "chat" || value === "terminal";
}

export function normalizeTerminalPrefs(raw: { defaultMode?: unknown; fontSize?: unknown }): TerminalPrefs {
  return {
    defaultMode: isViewMode(raw.defaultMode) ? raw.defaultMode : DEFAULT_TERMINAL_PREFS.defaultMode,
    fontSize:
      inIntRange(raw.fontSize, TERMINAL_FONT_RANGE)
        ? raw.fontSize
        : DEFAULT_TERMINAL_PREFS.fontSize,
  };
}

/** Storage keys of the view settings (web localStorage; the app's secure store uses the same names, see SESSION_MODE_PREFIX). */
export const DEFAULT_MODE_KEY = "maru_default_view_mode";
export const FONT_SIZE_KEY = "maru_terminal_font_size";
/** A session's own mode is stored under this prefix plus the session key. */
export const SESSION_MODE_PREFIX = "maru_view_mode:";

/** The terminal prefs a device stored: `raw` gives the JSON text of a key, or null when none is stored. */
export function readTerminalPrefsFrom(raw: (key: string) => string | null): TerminalPrefs {
  const parse = (key: string): unknown => {
    const text = raw(key);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      // A value that is not JSON: the default applies.
      return null;
    }
  };
  return normalizeTerminalPrefs({ defaultMode: parse(DEFAULT_MODE_KEY), fontSize: parse(FONT_SIZE_KEY) });
}

/** What a write stores: each key with its JSON text, or null to remove it (a value equal to its default is not stored). */
export function terminalPrefEntries(prefs: TerminalPrefs): Array<[string, string | null]> {
  return [
    [DEFAULT_MODE_KEY, prefs.defaultMode === DEFAULT_TERMINAL_PREFS.defaultMode ? null : JSON.stringify(prefs.defaultMode)],
    [FONT_SIZE_KEY, prefs.fontSize === DEFAULT_TERMINAL_PREFS.fontSize ? null : JSON.stringify(prefs.fontSize)],
  ];
}

export function terminalFontStack(font: TerminalFontId): string {
  return TERMINAL_FONTS.find((f) => f.id === font)?.stack ?? TERMINAL_FONTS[0].stack;
}

/** A session's own mode if it has one, else the default. */
export function resolveViewMode(sessionMode: unknown, defaultMode: ViewMode): ViewMode {
  return isViewMode(sessionMode) ? sessionMode : defaultMode;
}
