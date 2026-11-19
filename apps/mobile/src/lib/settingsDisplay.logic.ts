// The rows of the Appearance tab: the choices each row offers and the control its data calls for
// (a few labeled choices on a line, colors as circles, numbers typed or stepped, a long list in a
// select; web lib/settingControl.logic.ts has the rules), which rows changed (the section's Reset
// and a row's undo mark), and the notes under the font rows. The lists are the web's (DisplayPanel.tsx
// builds the same ones from the same sources), in the same words. React Native-free.
import {
  CHAT_CODE_PRESETS,
  CHAT_TEXT_RANGE,
  MESSAGE_BUBBLE_STYLES,
  UI_SCALE_RANGE,
  isCustomChatCodeBackground,
  type ChatCodeBackground,
} from "../../../web/src/lib/displayPrefs.logic.ts";
import { AREA_ZOOM_RANGE } from "../../../web/src/lib/areaZoom.logic.ts";
import { clampInt, parseTypedNumber, type IntRange } from "../../../web/src/lib/settingControl.logic.ts";
import { THEME_PREFS } from "../../../web/src/lib/theme.logic.ts";
import { UI_FONTS } from "../../../web/src/lib/uiFonts.logic.ts";
import { TERMINAL_FONTS, TERMINAL_FONT_RANGE, VIEW_MODES, type TerminalFontId } from "../../../web/src/lib/viewMode.logic.ts";
import { TERMINAL_COLORSETS, colorsetById } from "../../../web/src/lib/terminalTheme.logic.ts";
import { darkPalette, lightPalette } from "../palette.ts";
import { CHAT_CODE_TERMINAL, type Scheme } from "./appearancePalette.ts";
import { DEFAULT_APPEARANCE, type AppearancePrefs } from "./appearance.logic.ts";

export interface Option {
  value: string;
  label: string;
}

export const THEME_OPTIONS: readonly Option[] = THEME_PREFS.map((t) => ({ value: t.id, label: t.label }));

/** A round swatch: the color it stands for in the theme being drawn, and its name (the accessible name). */
export interface Swatch {
  value: string;
  label: string;
  color: string;
}

/** The user's bubble colors as they look in a theme: the theme's message surface, and the accent for blue. */
export function bubbleSwatches(scheme: Scheme): readonly Swatch[] {
  const base = scheme === "light" ? lightPalette : darkPalette;
  return MESSAGE_BUBBLE_STYLES.map((b) => ({ value: b.id, label: b.label, color: b.id === "blue" ? base.accent : base.userBubble }));
}

/** The code block color's two presets as they look in a theme (web index.css --chat-code-preset-*). */
export function codeBackgroundSwatches(scheme: Scheme): readonly Swatch[] {
  const base = scheme === "light" ? lightPalette : darkPalette;
  return CHAT_CODE_PRESETS.map((p) => ({ value: p.id, label: p.label, color: p.id === "terminal" ? CHAT_CODE_TERMINAL[scheme] : base.code }));
}

/** The code block color's third choice: a color typed as hex. */
export const CODE_BACKGROUND_CUSTOM = "custom";

/** Which choice a stored code background is: a preset's id, or custom. */
export function codeBackgroundChoice(value: ChatCodeBackground): string {
  return isCustomChatCodeBackground(value) ? CODE_BACKGROUND_CUSTOM : value;
}

export const UI_FONT_OPTIONS: readonly Option[] = UI_FONTS.map((f) => ({ value: f.id, label: f.label }));
/** The conversation font's choices: the interface's font, or one of the same list. */
export const CHAT_FONT_OPTIONS: readonly Option[] = [{ value: "ui", label: "Same as UI" }, ...UI_FONT_OPTIONS];
export const MONO_FONT_OPTIONS: readonly Option[] = TERMINAL_FONTS.map((f) => ({ value: f.id, label: f.label }));

/** The number rows' ranges (whole numbers) and units. */
export const NUMBER_ROWS = {
  uiScale: { range: UI_SCALE_RANGE, unit: "%" },
  chatText: { range: CHAT_TEXT_RANGE, unit: "pt" },
  sidebarZoom: { range: AREA_ZOOM_RANGE, unit: "%" },
  terminalFontSize: { range: TERMINAL_FONT_RANGE, unit: "pt" },
} as const satisfies Record<string, { range: IntRange; unit: string }>;

/** What typed text applies as: the nearest allowed whole number, or the value it had when the text is no number. */
export function appliedNumber(text: string, range: IntRange, current: number): number {
  return parseTypedNumber(text, range) ?? current;
}

/** One step of the minus or plus button, held to the range. */
export function steppedNumber(value: number, direction: 1 | -1, range: IntRange): number {
  return clampInt(value + direction, range);
}

const D = DEFAULT_APPEARANCE;

/** The Colors section's values and their defaults. */
export const COLOR_DEFAULTS = { theme: D.theme, messageBubble: D.messageBubble, chatCodeBackground: D.chatCodeBackground, terminalColorset: D.terminalColorset } as const;
/** The Fonts and sizes section's values and their defaults. */
export const TYPE_DEFAULTS = {
  uiFont: D.uiFont,
  uiScale: D.uiScale,
  chatFont: D.chatFont,
  chatText: D.chatText,
  chatInlineCodeText: D.chatInlineCodeText,
  monoFont: D.monoFont,
  chatCodeText: D.chatCodeText,
  sidebarZoom: D.sidebarZoom,
  terminalFontSize: D.terminalFontSize,
} as const;
/** The View section's value and its default (web "Default view mode"). */
export const VIEW_DEFAULTS = { defaultViewMode: D.defaultViewMode } as const;

/** Default view mode's choices, in the web's words. */
export const VIEW_MODE_OPTIONS: readonly Option[] = VIEW_MODES.map((m) => ({ value: m, label: m === "chat" ? "Chat" : "Terminal" }));

/** Terminal color set's list: every set by name (the web's select shows a swatch of role colors beside each). */
export const TERMINAL_COLORSET_OPTIONS: readonly Option[] = TERMINAL_COLORSETS.map((c) => ({ value: c.id, label: c.label }));

/** The row's description line: the chosen set's name and what it is like (web TerminalThemeRows). */
export function terminalColorsetNote(id: string): string {
  const set = colorsetById(id);
  return `${set.label}: ${set.hint}`;
}

function differs(prefs: AppearancePrefs, defaults: Partial<AppearancePrefs>): boolean {
  return (Object.keys(defaults) as Array<keyof AppearancePrefs>).some((k) => prefs[k] !== defaults[k]);
}

export const colorChanged = (prefs: AppearancePrefs) => differs(prefs, COLOR_DEFAULTS);
export const typeChanged = (prefs: AppearancePrefs) => differs(prefs, TYPE_DEFAULTS);
export const viewChanged = (prefs: AppearancePrefs) => differs(prefs, VIEW_DEFAULTS);

/** Under the monospace font row: what the phone draws for the fonts it cannot have as the web does. */
export const MONO_FONT_NOTES: Partial<Record<TerminalFontId, string>> = {
  "sf-mono": "SF Mono is an Apple device font, so this device draws the system monospace instead",
};
