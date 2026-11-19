// How the shell looks on the phone (DESIGN.md 6s): the web's shell terminal reads the terminal
// font (Settings, the monospace font), its size and its color set (ShellView.tsx); the app reads
// the same three. The font comes from the app's own Monospace setting (the chat code font, as on
// the web); the size and the color set are kept under the web's storage keys in the app's secure
// store, so the terminal mode's settings and the shell share one choice.
import { COLORSET_KEY, DEFAULT_TERMINAL_THEME, normalizeTerminalTheme, resolveTerminalTokens } from "../../../web/src/lib/terminalTheme.logic.ts";
import { DEFAULT_TERMINAL_PREFS, FONT_SIZE_KEY, normalizeTerminalPrefs, type TerminalFontId } from "../../../web/src/lib/viewMode.logic.ts";
import { BON_PIECES, bonPieceUrl, type BonPiece } from "../../../../packages/shared/src/bonFont.ts";
import { FONT_CDN, codeFaces } from "../lib/appFonts.logic.ts";
import type { PageLook } from "./bridge.ts";

/** The terminal text size and color set keys, the same ones the web and the app's Appearance settings write. */
export const TERMINAL_FONT_SIZE_KEY = FONT_SIZE_KEY;
export const TERMINAL_COLORSET_KEY = COLORSET_KEY;

/** The page terminal's scrollback; the same number of lines tmux keeps (server shell/tmux.ts SHELL_HISTORY_LINES), as the web's ShellView. */
export const SHELL_SCROLLBACK_LINES = 1_000;

export interface ShellLook {
  /** pt, which is 1 CSS px in the page. */
  fontSize: number;
  /** A terminal color set id (terminalTheme.logic.ts). */
  colorset: string;
  monoFont: TerminalFontId;
}

function parseStored(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The look from the stored values (`raw` reads a key's text, null when it is not stored). */
export function readShellLook(raw: (key: string) => string | null, monoFont: TerminalFontId): ShellLook {
  const prefs = normalizeTerminalPrefs({ fontSize: parseStored(raw(TERMINAL_FONT_SIZE_KEY)) });
  const theme = normalizeTerminalTheme({ colorset: parseStored(raw(TERMINAL_COLORSET_KEY)) });
  return { fontSize: prefs.fontSize, colorset: theme.colorset, monoFont };
}

export const DEFAULT_SHELL_LOOK: ShellLook = {
  fontSize: DEFAULT_TERMINAL_PREFS.fontSize,
  colorset: DEFAULT_TERMINAL_THEME.colorset,
  monoFont: "bon",
};

/** The family name the page gives the downloaded monospace font. */
export const PAGE_FONT_FAMILY = "MaruShellMono";

/**
 * Bon Google Sans Code as the web draws it: the woff2 pieces (Latin and Hangul under one family,
 * chosen per character by unicode-range) that the web declares from the same font CDN
 * (packages/shared bonFont.ts, apps/web lib/bonFont.ts), without the italic one. The app's own text
 * uses a whole .ttf per weight (appFonts.logic.ts), which Android's font loader reads and the
 * WebView's font sanitizer refuses (measured in Chromium: "OTS parsing error: glyf: Bad glyph
 * flag"), so the page takes the web's files.
 */
export const BON_PAGE_PIECES: readonly BonPiece[] = BON_PIECES.filter((p) => p.style === "normal");

function faceRule(weight: number, src: string, range?: string): string {
  const unicodeRange = range ? `;unicode-range:${range}` : "";
  return `@font-face{font-family:"${PAGE_FONT_FAMILY}";font-style:normal;font-weight:${weight};font-display:swap;src:url("${src}")${unicodeRange}}`;
}

/**
 * The page's font: the chosen monospace font's files as @font-face rules (pinned URLs with CORS
 * open, kept by the WebView's cache), then the phone's monospace while a file is on its way or
 * offline. SF Mono and the system monospace have no file; they are the phone's own monospace, as
 * the app's other text treats them (appFonts.logic.ts).
 */
export function pageFont(monoFont: TerminalFontId, cdn: string | null = FONT_CDN): { family: string; faceCss: string } {
  const family = `"${PAGE_FONT_FAMILY}", monospace`;
  if (monoFont === "bon" || monoFont === "bon-web") {
    // Without a font CDN the page keeps the phone's monospace.
    if (!cdn) return { family: "monospace", faceCss: "" };
    return { family, faceCss: BON_PAGE_PIECES.map((p) => faceRule(p.weight, bonPieceUrl(cdn, p), p.range)).join("") };
  }
  const faces = codeFaces(cdn)[monoFont];
  if (!faces || faces.length === 0) return { family: "monospace", faceCss: "" };
  return { family, faceCss: faces.map((f) => faceRule(f.weight, f.source.uri)).join("") };
}

/**
 * The xterm settings of a look: the colors are the web ShellView's xtermTheme (background, text,
 * cursor, selection; the 16 ANSI colors stay xterm's own).
 */
export function pageLook(look: ShellLook): PageLook {
  const t = resolveTerminalTokens(look.colorset);
  const font = pageFont(look.monoFont);
  return {
    fontFamily: font.family,
    faceCss: font.faceCss,
    fontSize: look.fontSize,
    theme: {
      background: t.bg,
      foreground: t.fg,
      cursor: t.cursor,
      cursorAccent: t.bg,
      selectionBackground: t.selectionBg,
      selectionForeground: t.selectionFg,
    },
  };
}
