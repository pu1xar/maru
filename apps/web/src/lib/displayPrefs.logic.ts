// The rules of the display preferences without the browser (displayPrefs.ts keeps localStorage,
// the root's CSS and the hooks): the steps and defaults, the value types, how a stored value is
// normalized, how the preferences read from and write to a key-value store, and what the root takes
// for them (displayCss). The Android app reads the same rules and keys from here, so a value means
// the same on both. displayPrefs.ts describes what each preference does on the page.
import {
  DEFAULT_CHAT_FONT,
  DEFAULT_UI_FONT,
  neededSheets,
  normalizeChatFont,
  normalizeUiFont,
  resolveChatFont,
  uiFontStack,
  type ChatFontId,
  type UiFontId,
} from "./uiFonts.logic.ts";
import { inIntRange, rangeOfSteps } from "./settingControl.logic.ts";
import { TERMINAL_FONTS, terminalFontStack, type TerminalFontId } from "./viewMode.logic.ts";

export const UI_SCALE_STEPS = [80, 90, 100, 110, 125, 150] as const;
/** The whole percents a typed UI scale may take: from the first to the last step. */
export const UI_SCALE_RANGE = rangeOfSteps(UI_SCALE_STEPS);
/**
 * The conversation text size (pt) at UI scale 100%: whole points like the terminal's list
 * (viewMode.ts), 11 to 22. The old percent steps (85 to 150% of 14pt, 11.9 to 21pt) fall inside.
 */
export const CHAT_TEXT_STEPS = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] as const;
/** The sizes a typed conversation, inline code or code block text size may take (whole pt). */
export const CHAT_TEXT_RANGE = rangeOfSteps(CHAT_TEXT_STEPS);
/** The conversation text's size (pt) with no setting: the theme's text-sm, 0.875rem at the default root. */
export const CHAT_TEXT_BASE_PT = 14;
/** The percent steps the text sizes had before they were pt (the old localStorage values). */
export const LEGACY_CHAT_TEXT_PERCENT_STEPS = [85, 90, 100, 110, 120, 135, 150] as const;

/** Chat code background presets; each id names the index.css token `--chat-code-preset-<id>`. */
export const CHAT_CODE_PRESETS = [
  { id: "default", label: "Default" },
  { id: "terminal", label: "Terminal background" },
] as const;

/** The user's bubble colors; each id other than "default" is a `data-message-bubble` value in index.css. */
export const MESSAGE_BUBBLE_STYLES = [
  { id: "default", label: "Default" },
  { id: "blue", label: "Blue" },
] as const;

export type MessageBubbleStyle = (typeof MESSAGE_BUBBLE_STYLES)[number]["id"];

export type ChatCodePresetId = (typeof CHAT_CODE_PRESETS)[number]["id"];
/** A preset id, or a custom color as lowercase `#rrggbb`. */
export type ChatCodeBackground = ChatCodePresetId | `#${string}`;

export interface DisplayPrefs {
  /** Font of the interface's text. */
  uiFont: UiFontId;
  /** Percent of the browser's default font size for the root. */
  uiScale: number;
  /** Font of the conversation's text; "ui" follows the interface font. */
  chatFont: ChatFontId;
  /** The conversation's text size (pt) at UI scale 100%. */
  chatText: number;
  /** The inline code's text size (pt, in the conversation's font); null follows `chatText`. */
  chatInlineCodeText: number | null;
  /** The one monospace font: code blocks, inline code, tool output, diffs, file previews and the terminal mode. */
  monoFont: TerminalFontId;
  /** Background of chat code blocks and inline code. */
  chatCodeBackground: ChatCodeBackground;
  /** The chat code's text size (pt, the same surfaces as the font); null follows `chatText`. */
  chatCodeText: number | null;
  /** Color of the user's bubble. */
  messageBubble: MessageBubbleStyle;
}

/** The monospace font default is the terminal font the user chose (iTerm's Bon Google Sans Code, DESIGN.md 6i). */
export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = {
  uiFont: DEFAULT_UI_FONT,
  uiScale: 100,
  chatFont: DEFAULT_CHAT_FONT,
  // The user's own settings made the defaults (2026-11-16): 15pt conversation, 13pt code on the
  // terminal background.
  chatText: 15,
  chatInlineCodeText: null,
  monoFont: "bon",
  chatCodeBackground: "terminal",
  chatCodeText: 13,
  messageBubble: "default",
};

export const UI_FONT_KEY = "maru_ui_font";
export const CHAT_FONT_KEY = "maru_chat_font";
export const CHAT_INLINE_CODE_TEXT_KEY = "maru_chat_inline_code_text_pt";
export const UI_SCALE_KEY = "maru_ui_scale";
export const CHAT_TEXT_KEY = "maru_chat_text_pt";
export const LEGACY_CHAT_TEXT_KEY = "maru_chat_text_scale";
export const MONO_FONT_KEY = "maru_mono_font";
/** The two keys the monospace font had before it was one: never read, a write removes them. */
export const LEGACY_CHAT_CODE_FONT_KEY = "maru_chat_code_font";
export const LEGACY_TERMINAL_FONT_KEY = "maru_terminal_font";
export const CHAT_CODE_BACKGROUND_KEY = "maru_chat_code_background";
export const CHAT_CODE_TEXT_KEY = "maru_chat_code_text_pt";
export const LEGACY_CHAT_CODE_TEXT_KEY = "maru_chat_code_text_scale";
export const MESSAGE_BUBBLE_KEY = "maru_message_bubble";
export const KEYS = [
  UI_FONT_KEY,
  CHAT_FONT_KEY,
  CHAT_INLINE_CODE_TEXT_KEY,
  UI_SCALE_KEY,
  CHAT_TEXT_KEY,
  LEGACY_CHAT_TEXT_KEY,
  MONO_FONT_KEY,
  CHAT_CODE_BACKGROUND_KEY,
  CHAT_CODE_TEXT_KEY,
  LEGACY_CHAT_CODE_TEXT_KEY,
  MESSAGE_BUBBLE_KEY,
];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * A stored value if it is a whole number from the first to the last step, else the default (an old
 * or hand-edited value). The steps are the wheel's grid; a typed number may sit between them.
 */
export function normalizeStep(value: unknown, steps: readonly number[], fallback: number): number {
  return inIntRange(value, rangeOfSteps(steps)) ? value : fallback;
}

/** The pt step nearest to a percent the text sizes were stored as, null for a value that was not one of its steps. */
export function legacyPercentToPt(value: unknown): number | null {
  if (typeof value !== "number" || !(LEGACY_CHAT_TEXT_PERCENT_STEPS as readonly number[]).includes(value)) return null;
  const pt = (value / 100) * CHAT_TEXT_BASE_PT;
  return CHAT_TEXT_STEPS.reduce((best, step) => (Math.abs(step - pt) < Math.abs(best - pt) ? step : best));
}

/** A chat code text size: a whole number in the conversation text size's range, else null (follow the conversation). */
export function normalizeChatCodeText(value: unknown): number | null {
  return inIntRange(value, CHAT_TEXT_RANGE) ? value : null;
}

/** An inline code text size: a whole number in the conversation text size's range, else null (follow the conversation). */
export function normalizeChatInlineCodeText(value: unknown): number | null {
  return normalizeChatCodeText(value);
}

/** The inline code's size (pt) at UI scale 100%: its own, else the conversation's. */
export function chatInlineCodePt(prefs: Pick<DisplayPrefs, "chatText" | "chatInlineCodeText">): number {
  return prefs.chatInlineCodeText ?? prefs.chatText;
}

/**
 * The inline code's size over the conversation's text around it, the factor index.css computes as
 * `--chat-inline-code-ratio` inside the conversation: 1 while it follows the conversation.
 */
export function chatInlineCodeRatio(prefs: Pick<DisplayPrefs, "chatText" | "chatInlineCodeText">): number {
  return chatInlineCodePt(prefs) / prefs.chatText;
}

export function normalizeMonoFont(value: unknown): TerminalFontId {
  const font = TERMINAL_FONTS.find((f) => f.id === value);
  return font ? font.id : DEFAULT_DISPLAY_PREFS.monoFont;
}

export function normalizeMessageBubble(value: unknown): MessageBubbleStyle {
  return MESSAGE_BUBBLE_STYLES.find((b) => b.id === value)?.id ?? DEFAULT_DISPLAY_PREFS.messageBubble;
}

/** A preset id as it is, a `#rrggbb` color in lowercase, anything else the default. */
export function normalizeChatCodeBackground(value: unknown): ChatCodeBackground {
  if (typeof value !== "string") return DEFAULT_DISPLAY_PREFS.chatCodeBackground;
  const preset = CHAT_CODE_PRESETS.find((p) => p.id === value);
  if (preset) return preset.id;
  return HEX_COLOR.test(value) ? (value.toLowerCase() as `#${string}`) : DEFAULT_DISPLAY_PREFS.chatCodeBackground;
}

/** `#rrggbb` from what a person types: with or without the `#`, any case; null when it is not a color. */
export function parseHexColor(input: string): `#${string}` | null {
  const text = input.trim();
  const hex = text.startsWith("#") ? text : `#${text}`;
  return HEX_COLOR.test(hex) ? (hex.toLowerCase() as `#${string}`) : null;
}

export function isCustomChatCodeBackground(value: ChatCodeBackground): value is `#${string}` {
  return value.startsWith("#");
}

/** WCAG relative luminance of `#rrggbb`. */
export function relativeLuminance(hex: string): number {
  const channel = (i: number) => {
    const s = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * The color scheme whose text reads on this background: "light" (dark text) when black text has
 * the higher WCAG contrast against it, else "dark". The code surface takes it, so its text and the
 * `light-dark()` syntax colors follow a custom background in either theme.
 */
export function backgroundScheme(hex: string): "light" | "dark" {
  const y = relativeLuminance(hex);
  return (y + 0.05) / 0.05 > 1.05 / (y + 0.05) ? "light" : "dark";
}

export interface DisplayCss {
  /** Root `--font-sans` (an interface font other than the system one). */
  uiFont: string | null;
  /** Root `--font-chat-text-setting` (a conversation font of its own). */
  chatFont: string | null;
  /** Root `data-chat-font`, present with `chatFont`. */
  chatFontAttribute: "" | null;
  /** The web stylesheets the interface and conversation fonts need. */
  fontSheets: string[];
  /** Root font-size. */
  rootFontSize: string | null;
  /** Root `--chat-text-scale-setting`. */
  chatTextScale: string | null;
  /** Root `--font-chat-code`, always set (the default is a font of its own, not the stylesheet's). */
  monoFont: string;
  /** Root `data-chat-code-background` (a preset other than the default). */
  chatCodePreset: string | null;
  /** Root `--chat-code-background` (a custom color). */
  chatCodeBackground: string | null;
  /** Root `data-chat-code-scheme` (with a custom color). */
  chatCodeScheme: "light" | "dark" | null;
  /** Root `--chat-code-scale-setting` (a chat code text size of its own). */
  chatCodeTextScale: string | null;
  /** Root `--chat-inline-code-scale-setting` (an inline code text size of its own). */
  chatInlineCodeTextScale: string | null;
  /** Root `data-message-bubble` (a bubble color other than the default). */
  messageBubble: string | null;
}

/** What the root takes for these preferences; null means "leave unset" (the stylesheet's default). */
export function displayCss(prefs: DisplayPrefs): DisplayCss {
  const bg = prefs.chatCodeBackground;
  const custom = isCustomChatCodeBackground(bg) ? bg : null;
  return {
    uiFont: prefs.uiFont === DEFAULT_UI_FONT ? null : uiFontStack(prefs.uiFont),
    chatFont: prefs.chatFont === DEFAULT_CHAT_FONT ? null : uiFontStack(resolveChatFont(prefs.chatFont, prefs.uiFont)),
    chatFontAttribute: prefs.chatFont === DEFAULT_CHAT_FONT ? null : "",
    fontSheets: neededSheets(prefs.uiFont, prefs.chatFont),
    rootFontSize: prefs.uiScale === 100 ? null : `${prefs.uiScale}%`,
    chatTextScale: prefs.chatText === CHAT_TEXT_BASE_PT ? null : String(prefs.chatText / CHAT_TEXT_BASE_PT),
    monoFont: terminalFontStack(prefs.monoFont),
    chatCodePreset: custom || bg === "default" ? null : bg,
    chatCodeBackground: custom,
    chatCodeScheme: custom ? backgroundScheme(custom) : null,
    chatCodeTextScale: prefs.chatCodeText === null ? null : String(prefs.chatCodeText / CHAT_TEXT_BASE_PT),
    chatInlineCodeTextScale: prefs.chatInlineCodeText === null ? null : String(prefs.chatInlineCodeText / CHAT_TEXT_BASE_PT),
    messageBubble: prefs.messageBubble === "default" ? null : prefs.messageBubble,
  };
}

/** The old percent keys and the two old font keys; a write removes them. */
export const LEGACY_DISPLAY_KEYS = [LEGACY_CHAT_TEXT_KEY, LEGACY_CHAT_CODE_TEXT_KEY, LEGACY_CHAT_CODE_FONT_KEY, LEGACY_TERMINAL_FONT_KEY];

function parseStored(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // A value that is not JSON: the default applies.
    return null;
  }
}

/** The stored pt size, else the old percent key's nearest step, else null. */
function storedPt(raw: (key: string) => string | null, key: string, legacyKey: string): number | null {
  const value = parseStored(raw(key));
  if (inIntRange(value, CHAT_TEXT_RANGE)) return value;
  return legacyPercentToPt(parseStored(raw(legacyKey)));
}

/**
 * The chat code text size: a stored step; a stored null is "대화와 같게" (follow the conversation),
 * kept as a value of its own since the default is a size (13pt); else the old percent key's step;
 * else the default.
 */
function storedChatCodeText(raw: (key: string) => string | null): number | null {
  if (raw(CHAT_CODE_TEXT_KEY) === "null") return null;
  return storedPt(raw, CHAT_CODE_TEXT_KEY, LEGACY_CHAT_CODE_TEXT_KEY) ?? DEFAULT_DISPLAY_PREFS.chatCodeText;
}

/** The preferences from a store that answers a key with its stored text (null when it has none). */
export function readDisplayPrefsFrom(raw: (key: string) => string | null): DisplayPrefs {
  const json = (key: string) => parseStored(raw(key));
  return {
    uiFont: normalizeUiFont(json(UI_FONT_KEY)),
    uiScale: normalizeStep(json(UI_SCALE_KEY), UI_SCALE_STEPS, DEFAULT_DISPLAY_PREFS.uiScale),
    chatFont: normalizeChatFont(json(CHAT_FONT_KEY)),
    chatText: storedPt(raw, CHAT_TEXT_KEY, LEGACY_CHAT_TEXT_KEY) ?? DEFAULT_DISPLAY_PREFS.chatText,
    chatInlineCodeText: normalizeChatInlineCodeText(json(CHAT_INLINE_CODE_TEXT_KEY)),
    monoFont: normalizeMonoFont(json(MONO_FONT_KEY)),
    chatCodeBackground: normalizeChatCodeBackground(json(CHAT_CODE_BACKGROUND_KEY)),
    chatCodeText: storedChatCodeText(raw),
    messageBubble: normalizeMessageBubble(json(MESSAGE_BUBBLE_KEY)),
  };
}

/** Every preference normalized: what a change merged over the current values becomes. */
export function normalizeDisplayPrefs(merged: DisplayPrefs): DisplayPrefs {
  return {
    uiFont: normalizeUiFont(merged.uiFont),
    uiScale: normalizeStep(merged.uiScale, UI_SCALE_STEPS, DEFAULT_DISPLAY_PREFS.uiScale),
    chatFont: normalizeChatFont(merged.chatFont),
    chatText: normalizeStep(merged.chatText, CHAT_TEXT_STEPS, DEFAULT_DISPLAY_PREFS.chatText),
    chatInlineCodeText: normalizeChatInlineCodeText(merged.chatInlineCodeText),
    monoFont: normalizeMonoFont(merged.monoFont),
    chatCodeBackground: normalizeChatCodeBackground(merged.chatCodeBackground),
    chatCodeText: normalizeChatCodeText(merged.chatCodeText),
    messageBubble: normalizeMessageBubble(merged.messageBubble),
  };
}

/** What a write stores: each key with its JSON text, or null to remove it (a value equal to its default is not stored). */
export function displayPrefEntries(prefs: DisplayPrefs): Array<[string, string | null]> {
  const entries: Array<[string, unknown, unknown]> = [
    [UI_FONT_KEY, prefs.uiFont, DEFAULT_DISPLAY_PREFS.uiFont],
    [UI_SCALE_KEY, prefs.uiScale, DEFAULT_DISPLAY_PREFS.uiScale],
    [CHAT_FONT_KEY, prefs.chatFont, DEFAULT_DISPLAY_PREFS.chatFont],
    [CHAT_TEXT_KEY, prefs.chatText, DEFAULT_DISPLAY_PREFS.chatText],
    [CHAT_INLINE_CODE_TEXT_KEY, prefs.chatInlineCodeText, DEFAULT_DISPLAY_PREFS.chatInlineCodeText],
    [MONO_FONT_KEY, prefs.monoFont, DEFAULT_DISPLAY_PREFS.monoFont],
    [CHAT_CODE_BACKGROUND_KEY, prefs.chatCodeBackground, DEFAULT_DISPLAY_PREFS.chatCodeBackground],
    [CHAT_CODE_TEXT_KEY, prefs.chatCodeText, DEFAULT_DISPLAY_PREFS.chatCodeText],
    [MESSAGE_BUBBLE_KEY, prefs.messageBubble, DEFAULT_DISPLAY_PREFS.messageBubble],
  ];
  return entries.map(([key, value, fallback]) => [key, value === fallback ? null : JSON.stringify(value)]);
}
