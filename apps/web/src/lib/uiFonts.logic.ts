// Proportional fonts offered in Settings (화면) for the interface and for the conversation's
// text (displayPrefs.ts), and how a chosen one reaches the page.
//
// A font is a CSS stack and the stylesheets that define its @font-face rules. The default,
// "system", has no stylesheet: it is the interface's own stack (index.css `--font-sans`), so a
// browser that never picks a font makes no font request. Inter ships inside the app (main.tsx
// imports @fontsource-variable/inter, whose files the browser fetches from this server only for
// glyphs drawn in it). The others come from jsDelivr's npm mirror at a fixed version, as stylesheets
// that split each family into unicode-range files (a page downloads only the files for the
// characters it draws, which matters for Hangul's thousands of glyphs). A stylesheet is added to
// the page when a chosen font needs it (ensureStylesheets), once.
//
// Hangul: Inter has none, so its stack ends with the system stack and Hangul draws in the
// platform's own font (Apple SD Gothic Neo on a Mac, as the page did before this setting).
// Pretendard and IBM Plex Sans KR carry Latin and Hangul in one family.

/** The interface's default stack; index.css `@theme --font-sans` has the same list. */
const SYSTEM_STACK = '-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif';
/** What follows a web font's own family: the system faces for the glyphs it lacks. */
const FALLBACK_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

const JSDELIVR = "https://cdn.jsdelivr.net/npm";
const PLEX_KR = `${JSDELIVR}/@fontsource/ibm-plex-sans-kr@5.3.0`;

export const UI_FONTS = [
  { id: "system", label: "System", stack: SYSTEM_STACK, sheets: [] },
  { id: "inter", label: "Inter", stack: `"Inter Variable", ${FALLBACK_STACK}`, sheets: [] },
  {
    id: "pretendard",
    label: "Pretendard",
    stack: `"Pretendard Variable", ${FALLBACK_STACK}`,
    sheets: [`${JSDELIVR}/pretendard@1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.css`],
  },
  {
    id: "plex-kr",
    label: "IBM Plex Sans KR",
    stack: `"IBM Plex Sans KR", ${FALLBACK_STACK}`,
    // One stylesheet per weight: the family is not variable. 400, 500, 600 and 700 are the weights
    // the interface draws (font-normal, font-medium, font-semibold, font-bold).
    sheets: [400, 500, 600, 700].map((w) => `${PLEX_KR}/${w}.css`),
  },
] as const;

export type UiFontId = (typeof UI_FONTS)[number]["id"];

/** The conversation's font: its own choice, or the interface's. */
export type ChatFontId = UiFontId | "ui";

export const DEFAULT_UI_FONT: UiFontId = "system";
export const DEFAULT_CHAT_FONT: ChatFontId = "ui";

export function uiFontStack(font: UiFontId): string {
  return UI_FONTS.find((f) => f.id === font)?.stack ?? SYSTEM_STACK;
}

export function uiFontSheets(font: UiFontId): readonly string[] {
  return UI_FONTS.find((f) => f.id === font)?.sheets ?? [];
}

export function normalizeUiFont(value: unknown): UiFontId {
  return UI_FONTS.find((f) => f.id === value)?.id ?? DEFAULT_UI_FONT;
}

export function normalizeChatFont(value: unknown): ChatFontId {
  return value === "ui" ? "ui" : UI_FONTS.find((f) => f.id === value)?.id ?? DEFAULT_CHAT_FONT;
}

/** The font the conversation's text draws in. */
export function resolveChatFont(chat: ChatFontId, ui: UiFontId): UiFontId {
  return chat === "ui" ? ui : chat;
}

/** The stylesheets the two chosen fonts need, each once. */
export function neededSheets(ui: UiFontId, chat: ChatFontId): string[] {
  return [...new Set([...uiFontSheets(ui), ...uiFontSheets(resolveChatFont(chat, ui))])];
}
