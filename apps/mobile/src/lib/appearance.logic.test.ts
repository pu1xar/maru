import { codeFaces } from "./appFonts.logic.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPEARANCE_KEYS,
  APP_SIDEBAR_ZOOM_DEFAULT,
  CODE_FAMILY,
  INLINE_CODE_FAMILY,
  TERMINAL_FAMILY,
  DEFAULT_APPEARANCE,
  NEUTRAL_ENV,
  appearanceEntries,
  normalizeAppearance,
  readAppearanceFrom,
  resolveTextStyle,
  textEnv,
  type AppearancePrefs,
} from "./appearance.logic.ts";

function store(values: Record<string, string>): (key: string) => string | null {
  return (key) => values[key] ?? null;
}

// Faces with a font CDN as a deployment sets it (build.env MARU_FONT_CDN).
const BON_FACES = codeFaces("https://cdn.example.com/fonts/v1/bon-google-sans-code");

test("nothing stored is the web's defaults, with the drawer at 100% and the theme dark", () => {
  const prefs = readAppearanceFrom(store({}));
  assert.deepEqual(prefs, DEFAULT_APPEARANCE);
  assert.equal(prefs.theme, "dark");
  assert.equal(prefs.chatText, 15);
  assert.equal(prefs.chatCodeText, 13);
  assert.equal(prefs.chatCodeBackground, "terminal");
  assert.equal(prefs.sidebarZoom, APP_SIDEBAR_ZOOM_DEFAULT);
});

test("stored values use the web's keys and JSON forms", () => {
  const prefs = readAppearanceFrom(
    store({
      maru_ui_font: '"pretendard"',
      maru_ui_scale: "110",
      maru_chat_font: '"ui"',
      maru_chat_text_pt: "17",
      maru_chat_inline_code_text_pt: "12",
      maru_mono_font: '"d2coding"',
      maru_chat_code_background: '"#abcdef"',
      maru_chat_code_text_pt: "null",
      maru_message_bubble: '"blue"',
      maru_theme: '"light"',
      maru_sidebar_zoom: "120",
    }),
  );
  assert.equal(prefs.uiFont, "pretendard");
  assert.equal(prefs.uiScale, 110);
  assert.equal(prefs.chatText, 17);
  assert.equal(prefs.chatInlineCodeText, 12);
  assert.equal(prefs.monoFont, "d2coding");
  assert.equal(prefs.chatCodeBackground, "#abcdef");
  assert.equal(prefs.chatCodeText, null);
  assert.equal(prefs.messageBubble, "blue");
  assert.equal(prefs.theme, "light");
  assert.equal(prefs.sidebarZoom, 120);
});

test("a hand-edited or old value falls back to its default", () => {
  const prefs = readAppearanceFrom(
    store({ maru_ui_font: '"comic"', maru_ui_scale: "500", maru_theme: '"sepia"', maru_sidebar_zoom: "7", maru_chat_text_pt: "banana", maru_message_bubble: "{" }),
  );
  assert.deepEqual(prefs, DEFAULT_APPEARANCE);
});

test("a typed whole number between the steps is kept, one outside the range is not", () => {
  assert.equal(readAppearanceFrom(store({ maru_ui_scale: "103", maru_sidebar_zoom: "123", maru_chat_text_pt: "17" })).uiScale, 103);
  assert.equal(readAppearanceFrom(store({ maru_sidebar_zoom: "123" })).sidebarZoom, 123);
  assert.equal(readAppearanceFrom(store({ maru_sidebar_zoom: "84" })).sidebarZoom, 100);
  assert.equal(readAppearanceFrom(store({ maru_chat_text_pt: "10" })).chatText, DEFAULT_APPEARANCE.chatText);
});

test("the two old font keys are not read, and a write removes them", () => {
  assert.equal(readAppearanceFrom(store({ maru_terminal_font: '"d2coding"', maru_chat_code_font: '"sf-mono"' })).monoFont, DEFAULT_APPEARANCE.monoFont);
  const entries = new Map(appearanceEntries(DEFAULT_APPEARANCE));
  assert.equal(entries.get("maru_terminal_font"), null);
  assert.equal(entries.get("maru_chat_code_font"), null);
  assert.equal(entries.get("maru_mono_font"), null);
});

test("inline code takes the monospace font but the conversation's size scale, not the code block's", () => {
  const prefs = { ...DEFAULT_APPEARANCE, monoFont: "bon" as const, chatText: 18, chatCodeText: 20 };
  const env = textEnv(prefs, new Set(["maru-bon-400", "maru-bon-700"]), BON_FACES);
  const out = resolveTextStyle({ fontFamily: INLINE_CODE_FAMILY, fontSize: 15, fontWeight: "400" }, { nested: false, scope: "chat" }, env);
  assert.equal(out?.fontFamily, "maru-bon-400");
  // 15 drawn at the 18pt conversation size (18 over 15), not at the 20pt code block size.
  assert.equal(out?.fontSize, 18);
  const waiting = resolveTextStyle({ fontFamily: INLINE_CODE_FAMILY, fontSize: 15 }, { nested: false, scope: "chat" }, textEnv(prefs, new Set()));
  assert.equal(waiting?.fontFamily, "monospace");
});

test("the web's old percent keys read as the nearest pt step", () => {
  assert.equal(readAppearanceFrom(store({ maru_chat_text_scale: "150" })).chatText, 21);
});

test("writing stores only what differs from the default and removes the rest, with the old percent keys", () => {
  const entries = new Map(appearanceEntries({ ...DEFAULT_APPEARANCE, theme: "light", chatText: 17 }));
  assert.equal(entries.get("maru_theme"), '"light"');
  assert.equal(entries.get("maru_chat_text_pt"), "17");
  assert.equal(entries.get("maru_ui_font"), null);
  assert.equal(entries.get("maru_sidebar_zoom"), null);
  assert.equal(entries.get("maru_chat_text_scale"), null);
  assert.equal(entries.get("maru_chat_code_text_scale"), null);
  // Every key the settings read is one a write decides.
  for (const key of APPEARANCE_KEYS) assert.ok(entries.has(key), key);
});

test("a write read back gives the same settings", () => {
  const prefs: AppearancePrefs = {
    ...DEFAULT_APPEARANCE,
    uiFont: "pretendard",
    uiScale: 125,
    chatFont: "plex-kr",
    chatText: 13,
    chatInlineCodeText: 11,
    monoFont: "bon-web",
    chatCodeBackground: "default",
    chatCodeText: null,
    messageBubble: "blue",
    theme: "system",
    sidebarZoom: 85,
  };
  const written = new Map(appearanceEntries(prefs));
  assert.deepEqual(readAppearanceFrom((key) => written.get(key) ?? null), prefs);
});

test("a change merged over the settings is normalized", () => {
  const next = normalizeAppearance({ ...DEFAULT_APPEARANCE, theme: "neon" as never, sidebarZoom: 84, chatText: 99, chatCodeBackground: "#ABCDEF" });
  assert.equal(next.theme, "dark");
  assert.equal(next.sidebarZoom, 100);
  assert.equal(next.chatText, 15);
  assert.equal(next.chatCodeBackground, "#abcdef");
});

test("the factors are the settings over the sizes the app is drawn at", () => {
  const env = textEnv({ ...DEFAULT_APPEARANCE, uiScale: 110, chatText: 18, chatCodeText: 11, chatInlineCodeText: 9, sidebarZoom: 120 }, new Set());
  assert.equal(env.ui, 1.1);
  assert.equal(env.chat, 18 / 15);
  assert.equal(env.code, 11 / 13);
  assert.equal(env.inlineCode, 9 / 18);
  assert.equal(env.sidebar, 1.2);
  // Code and inline code follow the conversation text size until they are set.
  const follow = textEnv({ ...DEFAULT_APPEARANCE, chatText: 20, chatCodeText: null, chatInlineCodeText: null }, new Set());
  assert.equal(follow.code, 20 / 13);
  assert.equal(follow.inlineCode, 1);
});

test("at the defaults a Text keeps its style as it is", () => {
  const style = { fontSize: 15, lineHeight: 24, fontWeight: "600" as const, color: "#fff" };
  assert.equal(resolveTextStyle(style, { nested: false, scope: "chat" }, NEUTRAL_ENV), style);
  assert.equal(resolveTextStyle(undefined, { nested: false, scope: "ui" }, NEUTRAL_ENV), undefined);
});

test("the UI scale and the scope's factor scale the size and the line height", () => {
  const env = textEnv({ ...DEFAULT_APPEARANCE, uiScale: 110, chatText: 18, sidebarZoom: 120 }, new Set());
  const style = { fontSize: 15, lineHeight: 24, color: "#fff" };
  assert.deepEqual(resolveTextStyle(style, { nested: false, scope: "ui" }, env), { fontSize: 16.5, lineHeight: 26.4, color: "#fff" });
  assert.deepEqual(resolveTextStyle(style, { nested: false, scope: "chat" }, env), { fontSize: 19.8, lineHeight: 31.68, color: "#fff" });
  assert.deepEqual(resolveTextStyle(style, { nested: false, scope: "sidebar" }, env), { fontSize: 19.8, lineHeight: 31.68, color: "#fff" });
});

test("a Text with no size takes React Native's 14 scaled, a nested one inherits its parent's", () => {
  const env = textEnv({ ...DEFAULT_APPEARANCE, uiScale: 125 }, new Set());
  assert.deepEqual(resolveTextStyle({ color: "#fff" }, { nested: false, scope: "ui" }, env), { color: "#fff", fontSize: 17.5 });
  assert.deepEqual(resolveTextStyle({ color: "#fff" }, { nested: true, scope: "ui" }, env), { color: "#fff" });
  assert.deepEqual(resolveTextStyle({ fontWeight: "600" }, { nested: true, scope: "ui" }, env), { fontWeight: "600" });
});

test("a loaded face replaces the family and the weight, by the scope's font", () => {
  const prefs = { ...DEFAULT_APPEARANCE, uiFont: "pretendard" as const, chatFont: "plex-kr" as const };
  const env = textEnv(prefs, new Set(["maru-pretendard-400", "maru-pretendard-600", "maru-plex-kr-400", "maru-plex-kr-700"]));
  assert.deepEqual(resolveTextStyle({ fontWeight: "600", fontSize: 14 }, { nested: false, scope: "ui" }, env), { fontFamily: "maru-pretendard-600", fontSize: 14 });
  assert.deepEqual(resolveTextStyle({ fontWeight: "bold" }, { nested: true, scope: "ui" }, env), { fontFamily: "maru-pretendard-600" });
  // The drawer reads the interface font; the conversation its own.
  assert.equal(resolveTextStyle({ fontSize: 14 }, { nested: false, scope: "sidebar" }, env)?.fontFamily, "maru-pretendard-400");
  assert.equal(resolveTextStyle({ fontSize: 14 }, { nested: false, scope: "chat" }, env)?.fontFamily, "maru-plex-kr-400");
  // Weight 500 has no Plex face loaded: the nearest is 400.
  assert.equal(resolveTextStyle({ fontWeight: "500" }, { nested: false, scope: "chat" }, env)?.fontFamily, "maru-plex-kr-400");
});

test("until a font's file is in, the text stays in the phone's font", () => {
  const env = textEnv({ ...DEFAULT_APPEARANCE, uiFont: "pretendard" }, new Set());
  const style = { fontSize: 14, fontWeight: "600" as const };
  assert.equal(resolveTextStyle(style, { nested: false, scope: "ui" }, env), style);
});

test("a style that names its own family keeps it", () => {
  const env = textEnv({ ...DEFAULT_APPEARANCE, uiFont: "pretendard" }, new Set(["maru-pretendard-400"]));
  const style = { fontFamily: "monospace", fontSize: 14 };
  assert.equal(resolveTextStyle(style, { nested: false, scope: "ui" }, env), style);
});

test("the chat code family becomes the chosen font's face, or the phone's monospace until it is in", () => {
  const prefs = { ...DEFAULT_APPEARANCE, monoFont: "bon" as const, chatCodeText: 16 };
  const loaded = textEnv(prefs, new Set(["maru-bon-400", "maru-bon-700"]), BON_FACES);
  const out = resolveTextStyle({ fontFamily: CODE_FAMILY, fontSize: 13, lineHeight: 18, fontWeight: "bold" }, { nested: false, scope: "chat" }, loaded);
  assert.equal(out?.fontFamily, "maru-bon-700");
  assert.equal(out?.fontWeight, undefined);
  // The code size is its own setting, not the conversation's: 16pt over the 13pt it is drawn at.
  assert.equal(out?.fontSize, 16);
  assert.equal(out?.lineHeight, 22.15);
  const waiting = resolveTextStyle({ fontFamily: CODE_FAMILY, fontSize: 13, fontWeight: "bold" }, { nested: false, scope: "chat" }, textEnv(prefs, new Set()));
  assert.equal(waiting?.fontFamily, "monospace");
  assert.equal(waiting?.fontWeight, "bold");
  // The system monospace has no file at all.
  const system = resolveTextStyle({ fontFamily: CODE_FAMILY, fontSize: 13 }, { nested: false, scope: "chat" }, NEUTRAL_ENV);
  assert.deepEqual(system, { fontFamily: "monospace", fontSize: 13 });
});

test("the UI scale reaches code too", () => {
  const env = textEnv({ ...DEFAULT_APPEARANCE, uiScale: 150 }, new Set());
  assert.equal(resolveTextStyle({ fontFamily: CODE_FAMILY, fontSize: 13 }, { nested: false, scope: "chat" }, env)?.fontSize, 19.5);
});

test("the terminal family is the chosen monospace face at the style's own size, with no UI scale or code size on it", () => {
  const prefs = { ...DEFAULT_APPEARANCE, monoFont: "bon" as const, uiScale: 150, chatCodeText: 20 };
  const env = textEnv(prefs, new Set(["maru-bon-400", "maru-bon-700"]), BON_FACES);
  const out = resolveTextStyle({ fontFamily: TERMINAL_FAMILY, fontSize: 15, lineHeight: 20, letterSpacing: 0.2, fontWeight: "bold" }, { nested: false, scope: "ui" }, env);
  assert.equal(out?.fontFamily, "maru-bon-700");
  assert.equal(out?.fontSize, 15);
  assert.equal(out?.lineHeight, 20);
  assert.equal(out?.letterSpacing, 0.2);
  // Until the file is in, the phone's monospace stands in, with the weight kept.
  const waiting = resolveTextStyle({ fontFamily: TERMINAL_FAMILY, fontSize: 15, fontWeight: "bold" }, { nested: false, scope: "ui" }, textEnv(prefs, new Set()));
  assert.equal(waiting?.fontFamily, "monospace");
  assert.equal(waiting?.fontWeight, "bold");
  // A nested run takes no size of its own: it inherits the row's.
  const nested = resolveTextStyle({ fontFamily: TERMINAL_FAMILY }, { nested: true, scope: "ui" }, env);
  assert.equal(nested?.fontSize, undefined);
});

test("the terminal settings use the web's keys and forms, and a write reads back", () => {
  const prefs = readAppearanceFrom(store({ maru_default_view_mode: '"terminal"', maru_terminal_font_size: "17", maru_terminal_colorset: '"dracula"' }));
  assert.equal(prefs.defaultViewMode, "terminal");
  assert.equal(prefs.terminalFontSize, 17);
  assert.equal(prefs.terminalColorset, "dracula");
  // A hand-edited value falls back to its default.
  const bad = readAppearanceFrom(store({ maru_default_view_mode: '"tui"', maru_terminal_font_size: "9", maru_terminal_colorset: '"nope"' }));
  assert.equal(bad.defaultViewMode, DEFAULT_APPEARANCE.defaultViewMode);
  assert.equal(bad.terminalFontSize, DEFAULT_APPEARANCE.terminalFontSize);
  assert.equal(bad.terminalColorset, DEFAULT_APPEARANCE.terminalColorset);
  const entries = new Map(appearanceEntries(prefs));
  assert.equal(entries.get("maru_default_view_mode"), '"terminal"');
  assert.equal(entries.get("maru_terminal_font_size"), "17");
  assert.equal(entries.get("maru_terminal_colorset"), '"dracula"');
  // The defaults are not stored.
  const defaults = new Map(appearanceEntries(DEFAULT_APPEARANCE));
  for (const key of ["maru_default_view_mode", "maru_terminal_font_size", "maru_terminal_colorset"]) assert.equal(defaults.get(key), null);
  const stored = Object.fromEntries([...entries].flatMap(([k, v]) => (v === null ? [] : [[k, v]])));
  assert.deepEqual(readAppearanceFrom(store(stored)), prefs);
  assert.equal(normalizeAppearance({ ...prefs, terminalFontSize: 99, defaultViewMode: "x" as never, terminalColorset: "y" }).terminalFontSize, DEFAULT_APPEARANCE.terminalFontSize);
});
