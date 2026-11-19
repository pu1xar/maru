import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_TEXT_BASE_PT,
  CHAT_TEXT_STEPS,
  DEFAULT_DISPLAY_PREFS,
  LEGACY_CHAT_TEXT_PERCENT_STEPS,
  LEGACY_DISPLAY_KEYS,
  UI_SCALE_STEPS,
  applyDisplayPrefs,
  backgroundScheme,
  chatInlineCodePt,
  chatInlineCodeRatio,
  displayCss,
  displayPrefEntries,
  legacyPercentToPt,
  normalizeDisplayPrefs,
  readDisplayPrefsFrom,
  normalizeChatCodeBackground,
  normalizeMonoFont,
  normalizeChatCodeText,
  normalizeChatInlineCodeText,
  normalizeMessageBubble,
  normalizeStep,
  parseHexColor,
  readDisplayPrefs,
  setDisplayPrefs,
} from "./displayPrefs.ts";
import { UI_FONTS, uiFontStack } from "./uiFonts.ts";
import { terminalFontStack } from "./viewMode.ts";

/** localStorage, and a root element that records inline properties and attributes. */
class FakeStorage {
  map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

class FakeRoot {
  props = new Map<string, string>();
  attrs = new Map<string, string>();
  style = {
    setProperty: (name: string, value: string) => void this.props.set(name, value),
    removeProperty: (name: string) => void this.props.delete(name),
  };
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
}

let storage: FakeStorage;
let root: FakeRoot;

beforeEach(() => {
  storage = new FakeStorage();
  root = new FakeRoot();
  Object.assign(globalThis, {
    window: { localStorage: storage, addEventListener() {}, removeEventListener() {} },
    document: { documentElement: root },
  });
});

const base = DEFAULT_DISPLAY_PREFS;

test("normalizeStep keeps a whole number from the first to the last step and falls back for anything else", () => {
  assert.equal(normalizeStep(125, UI_SCALE_STEPS, 100), 125);
  assert.equal(normalizeStep(124, UI_SCALE_STEPS, 100), 124);
  assert.equal(normalizeStep(80, UI_SCALE_STEPS, 100), 80);
  assert.equal(normalizeStep(150, UI_SCALE_STEPS, 100), 150);
  assert.equal(normalizeStep(79, UI_SCALE_STEPS, 100), 100);
  assert.equal(normalizeStep(151, UI_SCALE_STEPS, 100), 100);
  assert.equal(normalizeStep(124.5, UI_SCALE_STEPS, 100), 100);
  assert.equal(normalizeStep("125", UI_SCALE_STEPS, 100), 100);
  assert.equal(normalizeStep(null, CHAT_TEXT_STEPS, 14), 14);
  assert.equal(normalizeStep(15, CHAT_TEXT_STEPS, 14), 15);
  assert.equal(normalizeStep(110, CHAT_TEXT_STEPS, 14), 14);
});

test("a typed text size between the steps is kept for the conversation, inline code and code block", () => {
  assert.equal(normalizeChatCodeText(17), 17);
  assert.equal(normalizeChatCodeText(10), null);
  assert.equal(normalizeChatCodeText(23), null);
  assert.equal(normalizeChatCodeText(13.5), null);
  assert.equal(normalizeDisplayPrefs({ ...base, chatText: 17, uiScale: 118 }).chatText, 17);
  assert.equal(normalizeDisplayPrefs({ ...base, chatText: 17, uiScale: 118 }).uiScale, 118);
  assert.equal(normalizeDisplayPrefs({ ...base, uiScale: 500 }).uiScale, base.uiScale);
});

test("the monospace font is one list for code and the terminal, Bon Google Sans Code by default", () => {
  assert.equal(DEFAULT_DISPLAY_PREFS.monoFont, "bon");
  assert.equal(normalizeMonoFont("d2coding"), "d2coding");
  assert.equal(normalizeMonoFont("comic"), "bon");
  assert.equal(normalizeMonoFont(null), "bon");
  assert.equal(terminalFontStack("system"), 'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace');
});

test("the two old font keys are not read and a write removes them", () => {
  storage.setItem("maru_terminal_font", '"d2coding"');
  storage.setItem("maru_chat_code_font", '"sf-mono"');
  assert.equal(readDisplayPrefs().monoFont, "bon");
  setDisplayPrefs({ chatText: 16 });
  assert.equal(storage.getItem("maru_terminal_font"), null);
  assert.equal(storage.getItem("maru_chat_code_font"), null);
  assert.equal(storage.getItem("maru_mono_font"), null);
  setDisplayPrefs({ monoFont: "sf-mono", chatText: 15 });
  assert.equal(storage.getItem("maru_mono_font"), '"sf-mono"');
  setDisplayPrefs({ monoFont: "bon" });
  assert.equal(storage.map.size, 0);
});

test("the chat code background keeps presets and #rrggbb colors only", () => {
  assert.equal(normalizeChatCodeBackground("default"), "default");
  // The removed presets (푸른 회색, 따뜻한 회색) fall back to the default.
  assert.equal(normalizeChatCodeBackground("slate"), DEFAULT_DISPLAY_PREFS.chatCodeBackground);
  assert.equal(normalizeChatCodeBackground("warm"), DEFAULT_DISPLAY_PREFS.chatCodeBackground);
  assert.equal(normalizeChatCodeBackground("#1A2B3C"), "#1a2b3c");
  assert.equal(normalizeChatCodeBackground("#1a2b3"), DEFAULT_DISPLAY_PREFS.chatCodeBackground);
  assert.equal(normalizeChatCodeBackground("red"), DEFAULT_DISPLAY_PREFS.chatCodeBackground);
  assert.equal(normalizeChatCodeBackground(12), DEFAULT_DISPLAY_PREFS.chatCodeBackground);
  assert.equal(parseHexColor(" 1d1d20 "), "#1d1d20");
  assert.equal(parseHexColor("#ABCDEF"), "#abcdef");
  assert.equal(parseHexColor("#abcd"), null);
});

test("a custom background names the scheme its text reads in", () => {
  assert.equal(backgroundScheme("#1d1d20"), "dark");
  assert.equal(backgroundScheme("#000000"), "dark");
  assert.equal(backgroundScheme("#f0f0f0"), "light");
  // Around relative luminance 0.18, where black and white text have the same contrast.
  assert.equal(backgroundScheme("#757575"), "dark");
  assert.equal(backgroundScheme("#777777"), "light");
});

test("displayCss leaves the theme's own values unset; the defaults (15pt, 13pt code on the terminal background) are set", () => {
  const plain = {
    uiFont: "system",
    uiScale: 100,
    chatFont: "ui",
    chatText: 14,
    chatInlineCodeText: null,
    monoFont: "system",
    chatCodeBackground: "default",
    chatCodeText: null,
    messageBubble: "default",
  } as const;
  assert.deepEqual(displayCss(plain), {
    uiFont: null,
    chatFont: null,
    chatFontAttribute: null,
    fontSheets: [],
    rootFontSize: null,
    chatTextScale: null,
    monoFont: terminalFontStack("system"),
    chatCodePreset: null,
    chatCodeBackground: null,
    chatCodeScheme: null,
    chatCodeTextScale: null,
    chatInlineCodeTextScale: null,
    messageBubble: null,
  });
  const d = displayCss(base);
  assert.deepEqual([d.chatTextScale, d.chatCodePreset, d.chatCodeTextScale], [String(15 / 14), "terminal", String(13 / 14)]);
});

test("displayCss gives the root size as a percent, a preset as the attribute, a custom color as properties", () => {
  const set = {
    uiFont: "system",
    uiScale: 125,
    chatFont: "ui",
    chatText: 12,
    chatInlineCodeText: 16,
    monoFont: "bon",
    chatCodeBackground: "default",
    chatCodeText: 17,
    messageBubble: "blue",
  } as const;
  assert.deepEqual(displayCss(set), {
    uiFont: null,
    chatFont: null,
    chatFontAttribute: null,
    fontSheets: [],
    rootFontSize: "125%",
    chatTextScale: String(12 / 14),
    monoFont: terminalFontStack("bon"),
    chatCodePreset: null,
    chatCodeBackground: null,
    chatCodeScheme: null,
    chatCodeTextScale: String(17 / 14),
    chatInlineCodeTextScale: String(16 / 14),
    messageBubble: "blue",
  });
  const custom = displayCss({ ...base, chatCodeBackground: "#f0f0f0" });
  assert.equal(custom.chatCodePreset, null);
  assert.equal(custom.chatCodeBackground, "#f0f0f0");
  assert.equal(custom.chatCodeScheme, "light");
});

test("setDisplayPrefs stores what differs from the defaults and reads back the same", () => {
  setDisplayPrefs({ monoFont: "d2coding", chatCodeBackground: "#ABCDEF", chatText: 16 });
  assert.deepEqual(Object.fromEntries(storage.map), {
    maru_chat_text_pt: "16",
    maru_mono_font: '"d2coding"',
    maru_chat_code_background: '"#abcdef"',
  });
  assert.deepEqual(readDisplayPrefs(), {
    uiFont: "system",
    uiScale: 100,
    chatFont: "ui",
    chatText: 16,
    chatInlineCodeText: null,
    monoFont: "d2coding",
    chatCodeBackground: "#abcdef",
    chatCodeText: 13,
    messageBubble: "default",
  });
  assert.equal(root.props.get("--font-chat-code"), terminalFontStack("d2coding"));
  assert.equal(root.props.get("--chat-code-background"), "#abcdef");
  assert.equal(root.attrs.get("data-chat-code-scheme"), "light");
  assert.equal(root.attrs.has("data-chat-code-background"), false);

  // Back to a preset: the custom color and its scheme go; "default" is the stylesheet's own value.
  setDisplayPrefs({ chatCodeBackground: "default" });
  assert.equal(storage.getItem("maru_chat_code_background"), '"default"');
  assert.equal(root.props.has("--chat-code-background"), false);
  assert.equal(root.attrs.has("data-chat-code-scheme"), false);
  assert.equal(root.attrs.has("data-chat-code-background"), false);

  // Back to the defaults: nothing stays stored; the root carries the defaults' values.
  setDisplayPrefs({ monoFont: "bon", chatCodeBackground: "terminal", chatText: 15 });
  assert.equal(storage.map.size, 0);
  assert.equal(root.attrs.get("data-chat-code-background"), "terminal");
});

test("the chat code text size is 13pt by default; following the conversation is a stored choice", () => {
  assert.equal(DEFAULT_DISPLAY_PREFS.chatCodeText, 13);
  assert.equal(readDisplayPrefs().chatCodeText, 13);
  assert.equal(normalizeChatCodeText(17), 17);
  assert.equal(normalizeChatCodeText(125), null);
  assert.equal(normalizeChatCodeText("17"), null);
  setDisplayPrefs({ chatCodeText: 19 });
  assert.equal(storage.getItem("maru_chat_code_text_pt"), "19");
  assert.equal(root.props.get("--chat-code-scale-setting"), String(19 / 14));
  assert.equal(readDisplayPrefs().chatCodeText, 19);
  // The conversation text size moves on its own.
  setDisplayPrefs({ chatText: 13 });
  assert.equal(readDisplayPrefs().chatCodeText, 19);
  // "대화와 같게" is stored as null, since nothing stored is the 13pt default.
  setDisplayPrefs({ chatCodeText: null, chatText: 15 });
  assert.equal(storage.getItem("maru_chat_code_text_pt"), "null");
  assert.equal(readDisplayPrefs().chatCodeText, null);
  assert.equal(root.props.has("--chat-code-scale-setting"), false);
  setDisplayPrefs({ chatCodeText: 13 });
  assert.equal(storage.map.size, 0);
});

test("readDisplayPrefs falls back for hand-edited or broken values", () => {
  storage.setItem("maru_chat_code_font", '"comic"');
  storage.setItem("maru_chat_code_background", "not json");
  storage.setItem("maru_ui_scale", "125");
  assert.deepEqual(readDisplayPrefs(), { ...base, uiScale: 125 });
});

test("applyDisplayPrefs writes the root from stored values", () => {
  storage.setItem("maru_chat_code_background", '"default"');
  storage.setItem("maru_message_bubble", '"blue"');
  applyDisplayPrefs(readDisplayPrefs(), root as unknown as HTMLElement);
  assert.equal(root.attrs.has("data-chat-code-background"), false);
  assert.equal(root.props.has("--chat-code-background"), false);
  assert.equal(root.attrs.get("data-message-bubble"), "blue");
  // A removed preset reads as the default (the terminal background).
  storage.setItem("maru_chat_code_background", '"slate"');
  applyDisplayPrefs(readDisplayPrefs(), root as unknown as HTMLElement);
  assert.equal(root.attrs.get("data-chat-code-background"), "terminal");
});

test("the pt steps hold the whole range the percent steps had; 14pt is the base, 15pt the default", () => {
  assert.equal(CHAT_TEXT_BASE_PT, 14);
  assert.equal(DEFAULT_DISPLAY_PREFS.chatText, 15);
  const percentPt = LEGACY_CHAT_TEXT_PERCENT_STEPS.map((p) => (p / 100) * CHAT_TEXT_BASE_PT);
  assert.ok(Math.min(...percentPt) >= CHAT_TEXT_STEPS[0]);
  assert.ok(Math.max(...percentPt) <= CHAT_TEXT_STEPS[CHAT_TEXT_STEPS.length - 1]!);
  // Whole points, 1pt apart.
  CHAT_TEXT_STEPS.forEach((n, i) => assert.equal(n, CHAT_TEXT_STEPS[0] + i));
});

test("legacyPercentToPt maps each old percent step to the nearest pt step", () => {
  const expected: Record<number, number> = { 85: 12, 90: 13, 100: 14, 110: 15, 120: 17, 135: 19, 150: 21 };
  for (const percent of LEGACY_CHAT_TEXT_PERCENT_STEPS) {
    const pt = legacyPercentToPt(percent);
    assert.equal(pt, expected[percent], `${percent}%`);
    // No other step is closer to what the percent drew (percent of 14pt).
    const drawn = (percent / 100) * 14;
    for (const step of CHAT_TEXT_STEPS) assert.ok(Math.abs(pt! - drawn) <= Math.abs(step - drawn) + 1e-9);
  }
  assert.equal(legacyPercentToPt(125), null);
  assert.equal(legacyPercentToPt("110"), null);
  assert.equal(legacyPercentToPt(null), null);
});

test("percent values stored by an earlier version read as the nearest pt, and the next write drops the old keys", () => {
  storage.setItem("maru_chat_text_scale", "110");
  storage.setItem("maru_chat_code_text_scale", "135");
  assert.deepEqual(readDisplayPrefs(), { ...base, chatText: 15, chatCodeText: 19 });
  // A new key wins over an old one left beside it.
  storage.setItem("maru_chat_text_pt", "18");
  assert.equal(readDisplayPrefs().chatText, 18);
  storage.map.delete("maru_chat_text_pt");
  // An unusable old value is the default (follow, for the code size).
  storage.setItem("maru_chat_text_scale", "117");
  storage.setItem("maru_chat_code_text_scale", "abc");
  assert.deepEqual(readDisplayPrefs(), base);
  // Choosing the default size after a migrated 110% must not bring the old value back.
  storage.setItem("maru_chat_text_scale", "110");
  assert.equal(readDisplayPrefs().chatText, 15);
  setDisplayPrefs({ chatText: 15, chatCodeText: 13 });
  assert.equal(storage.map.size, 0);
  assert.equal(readDisplayPrefs().chatText, 15);
});

test("the user's bubble is the theme's own color by default; blue is stored and set on the root", () => {
  assert.equal(DEFAULT_DISPLAY_PREFS.messageBubble, "default");
  assert.equal(normalizeMessageBubble("blue"), "blue");
  assert.equal(normalizeMessageBubble("green"), "default");
  setDisplayPrefs({ messageBubble: "blue" });
  assert.equal(storage.getItem("maru_message_bubble"), '"blue"');
  assert.equal(root.attrs.get("data-message-bubble"), "blue");
  assert.equal(readDisplayPrefs().messageBubble, "blue");
  setDisplayPrefs({ messageBubble: "default" });
  assert.equal(storage.getItem("maru_message_bubble"), null);
  assert.equal(root.attrs.has("data-message-bubble"), false);
});

test("the interface font is the system stack by default; a chosen font sets --font-sans and is stored", () => {
  assert.equal(DEFAULT_DISPLAY_PREFS.uiFont, "system");
  assert.equal(root.props.has("--font-sans"), false);
  setDisplayPrefs({ uiFont: "pretendard" });
  assert.equal(storage.getItem("maru_ui_font"), '"pretendard"');
  assert.equal(root.props.get("--font-sans"), uiFontStack("pretendard"));
  assert.equal(readDisplayPrefs().uiFont, "pretendard");
  // The conversation follows it until it has a font of its own.
  assert.equal(root.attrs.has("data-chat-font"), false);
  assert.equal(root.props.has("--font-chat-text-setting"), false);
  setDisplayPrefs({ uiFont: "system" });
  assert.equal(storage.map.size, 0);
  assert.equal(root.props.has("--font-sans"), false);
});

test("a conversation font of its own sets the attribute and the setting; \"ui\" removes both", () => {
  setDisplayPrefs({ chatFont: "plex-kr" });
  assert.equal(storage.getItem("maru_chat_font"), '"plex-kr"');
  assert.equal(root.attrs.get("data-chat-font"), "");
  assert.equal(root.props.get("--font-chat-text-setting"), uiFontStack("plex-kr"));
  assert.equal(root.props.has("--font-sans"), false);
  // Choosing the system font for the conversation under another interface font is a choice, not "ui".
  setDisplayPrefs({ uiFont: "inter", chatFont: "system" });
  assert.equal(root.props.get("--font-sans"), uiFontStack("inter"));
  assert.equal(root.props.get("--font-chat-text-setting"), uiFontStack("system"));
  assert.equal(readDisplayPrefs().chatFont, "system");
  setDisplayPrefs({ uiFont: "system", chatFont: "ui" });
  assert.equal(storage.map.size, 0);
  assert.equal(root.attrs.has("data-chat-font"), false);
  assert.equal(root.props.has("--font-chat-text-setting"), false);
});

test("a hand-edited font value is the default", () => {
  storage.setItem("maru_ui_font", '"comic"');
  storage.setItem("maru_chat_font", "not json");
  assert.deepEqual(readDisplayPrefs(), base);
  storage.setItem("maru_chat_font", '"ui"');
  assert.equal(readDisplayPrefs().chatFont, "ui");
});

test("only the chosen fonts add their web stylesheets, once", () => {
  const added: string[] = [];
  const host = {
    head: { appendChild: (node: unknown) => void added.push((node as { href: string }).href) },
    querySelector: (selector: string) => (added.some((href) => selector.includes(href)) ? {} : null),
    createElement: () => ({ rel: "", href: "", setAttribute() {} }),
  };
  Object.assign(globalThis, { document: { documentElement: root, ...host } });
  // The defaults and Inter (bundled with the app) request nothing.
  applyDisplayPrefs(base, root as unknown as HTMLElement);
  applyDisplayPrefs({ ...base, uiFont: "inter" }, root as unknown as HTMLElement);
  assert.deepEqual(added, []);
  applyDisplayPrefs({ ...base, chatFont: "pretendard" }, root as unknown as HTMLElement);
  assert.equal(added.length, 1);
  assert.match(added[0]!, /^https:\/\/cdn\.jsdelivr\.net\/npm\/pretendard@\d+\.\d+\.\d+\//);
  // The same font for both, and the same prefs again, add nothing more.
  applyDisplayPrefs({ ...base, uiFont: "pretendard", chatFont: "ui" }, root as unknown as HTMLElement);
  applyDisplayPrefs({ ...base, uiFont: "pretendard", chatFont: "pretendard" }, root as unknown as HTMLElement);
  assert.equal(added.length, 1);
  applyDisplayPrefs({ ...base, uiFont: "plex-kr" }, root as unknown as HTMLElement);
  assert.equal(added.length, 1 + UI_FONTS.find((f) => f.id === "plex-kr")!.sheets.length);
});

test("every web stylesheet is a version-pinned jsDelivr npm URL", () => {
  for (const font of UI_FONTS) {
    for (const sheet of font.sheets) assert.match(sheet, /^https:\/\/cdn\.jsdelivr\.net\/npm\/(@[\w-]+\/)?[\w-]+@\d+\.\d+\.\d+\/.+\.css$/, font.id);
  }
});

test("the inline code size follows the conversation until it is set, and is its own size once set", () => {
  assert.equal(DEFAULT_DISPLAY_PREFS.chatInlineCodeText, null);
  assert.equal(normalizeChatInlineCodeText(15), 15);
  assert.equal(normalizeChatInlineCodeText(125), null);
  assert.equal(normalizeChatInlineCodeText("15"), null);
  assert.equal(normalizeChatInlineCodeText(null), null);
  // Following: the conversation's pt, a ratio of 1 at any conversation size.
  for (const chatText of [11, 15, 22]) {
    assert.equal(chatInlineCodePt({ chatText, chatInlineCodeText: null }), chatText);
    assert.equal(chatInlineCodeRatio({ chatText, chatInlineCodeText: null }), 1);
  }
  // Set: its own pt, a ratio over the conversation's.
  assert.equal(chatInlineCodePt({ chatText: 15, chatInlineCodeText: 13 }), 13);
  assert.equal(chatInlineCodeRatio({ chatText: 15, chatInlineCodeText: 13 }), 13 / 15);
  assert.equal(chatInlineCodeRatio({ chatText: 18, chatInlineCodeText: 13 }), 13 / 18);
  // Stored only when set; the root carries it as a factor over the 14pt base.
  setDisplayPrefs({ chatInlineCodeText: 13 });
  assert.equal(storage.getItem("maru_chat_inline_code_text_pt"), "13");
  assert.equal(root.props.get("--chat-inline-code-scale-setting"), String(13 / 14));
  assert.equal(readDisplayPrefs().chatInlineCodeText, 13);
  // The code block's size and the conversation's move on their own.
  setDisplayPrefs({ chatCodeText: null, chatText: 18 });
  assert.equal(readDisplayPrefs().chatInlineCodeText, 13);
  setDisplayPrefs({ chatInlineCodeText: null, chatCodeText: 13, chatText: 15 });
  assert.equal(storage.map.size, 0);
  assert.equal(root.props.has("--chat-inline-code-scale-setting"), false);
});

test("the store-agnostic read and write the Android app shares give what the browser's give", () => {
  setDisplayPrefs({ uiFont: "inter", chatText: 17, chatCodeText: null, messageBubble: "blue", chatCodeBackground: "#abcdef" });
  const stored = new Map(storage.map);
  const viaLogic = readDisplayPrefsFrom((key) => stored.get(key) ?? null);
  assert.deepEqual(viaLogic, readDisplayPrefs());
  for (const [key, value] of displayPrefEntries(viaLogic)) assert.equal(stored.get(key) ?? null, value, key);
  // The old percent keys are removed on a write, and read as the nearest pt step.
  assert.equal(readDisplayPrefsFrom((key) => (key === "maru_chat_text_scale" ? "150" : null)).chatText, 21);
  assert.deepEqual(LEGACY_DISPLAY_KEYS, ["maru_chat_text_scale", "maru_chat_code_text_scale", "maru_chat_code_font", "maru_terminal_font"]);
  assert.equal(normalizeDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, chatText: 99 }).chatText, DEFAULT_DISPLAY_PREFS.chatText);
});
