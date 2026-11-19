import { test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGE_BUBBLE_STYLES } from "../../../web/src/lib/displayPrefs.logic.ts";
import { DEFAULT_APPEARANCE } from "./appearance.logic.ts";
import { darkPalette, lightPalette } from "../palette.ts";
import {
  CHAT_FONT_OPTIONS,
  COLOR_DEFAULTS,
  MONO_FONT_NOTES,
  MONO_FONT_OPTIONS,
  NUMBER_ROWS,
  TERMINAL_COLORSET_OPTIONS,
  THEME_OPTIONS,
  TYPE_DEFAULTS,
  UI_FONT_OPTIONS,
  VIEW_DEFAULTS,
  VIEW_MODE_OPTIONS,
  appliedNumber,
  bubbleSwatches,
  codeBackgroundChoice,
  codeBackgroundSwatches,
  colorChanged,
  steppedNumber,
  terminalColorsetNote,
  typeChanged,
  viewChanged,
} from "./settingsDisplay.logic.ts";
import { TERMINAL_COLORSETS } from "../../../web/src/lib/terminalTheme.logic.ts";

const labels = (o: readonly { label: string }[]) => o.map((x) => x.label);

test("the rows offer the web's choices in the web's words", () => {
  assert.deepEqual(labels(THEME_OPTIONS), ["System", "Light", "Dark"]);
  assert.deepEqual(labels(bubbleSwatches("dark")), ["Default", "Blue"]);
  assert.equal(bubbleSwatches("dark").length, MESSAGE_BUBBLE_STYLES.length);
  assert.deepEqual(labels(codeBackgroundSwatches("dark")), ["Default", "Terminal background"]);
  assert.deepEqual(labels(UI_FONT_OPTIONS), ["System", "Inter", "Pretendard", "IBM Plex Sans KR"]);
  assert.deepEqual(labels(CHAT_FONT_OPTIONS), ["Same as UI", ...labels(UI_FONT_OPTIONS)]);
  assert.deepEqual(labels(MONO_FONT_OPTIONS), ["Bon Google Sans Code", "Bon Google Sans Code (web font)", "D2Coding", "SF Mono", "System monospace"]);
});

test("the swatches are painted in the colors they stand for in each theme", () => {
  for (const [scheme, base] of [["dark", darkPalette], ["light", lightPalette]] as const) {
    const [def, blue] = bubbleSwatches(scheme);
    assert.equal(def!.color, base.userBubble);
    assert.equal(blue!.color, base.accent);
    const [code, terminal] = codeBackgroundSwatches(scheme);
    assert.equal(code!.color, base.code);
    assert.equal(terminal!.color, scheme === "dark" ? "#0f0f0f" : "#eceff3");
  }
});

test("the number rows' ranges are the web's, whole numbers with their units", () => {
  assert.deepEqual(NUMBER_ROWS.uiScale, { range: { min: 80, max: 150 }, unit: "%" });
  assert.deepEqual(NUMBER_ROWS.chatText, { range: { min: 11, max: 22 }, unit: "pt" });
  assert.deepEqual(NUMBER_ROWS.sidebarZoom, { range: { min: 85, max: 150 }, unit: "%" });
});

test("every default is one of its row's choices or inside its range", () => {
  const has = (o: readonly { value: string }[], v: string) => o.some((x) => x.value === v);
  const inside = (v: number, r: { min: number; max: number }) => v >= r.min && v <= r.max;
  assert.ok(has(THEME_OPTIONS, COLOR_DEFAULTS.theme));
  assert.ok(has(bubbleSwatches("dark"), COLOR_DEFAULTS.messageBubble));
  assert.ok(has(codeBackgroundSwatches("dark"), codeBackgroundChoice(COLOR_DEFAULTS.chatCodeBackground)));
  assert.ok(has(UI_FONT_OPTIONS, TYPE_DEFAULTS.uiFont));
  assert.ok(inside(TYPE_DEFAULTS.uiScale, NUMBER_ROWS.uiScale.range));
  assert.ok(has(CHAT_FONT_OPTIONS, TYPE_DEFAULTS.chatFont));
  assert.ok(inside(TYPE_DEFAULTS.chatText, NUMBER_ROWS.chatText.range));
  assert.ok(TYPE_DEFAULTS.chatInlineCodeText === null || inside(TYPE_DEFAULTS.chatInlineCodeText, NUMBER_ROWS.chatText.range));
  assert.ok(has(MONO_FONT_OPTIONS, TYPE_DEFAULTS.monoFont));
  assert.ok(TYPE_DEFAULTS.chatCodeText === null || inside(TYPE_DEFAULTS.chatCodeText, NUMBER_ROWS.chatText.range));
  assert.ok(inside(TYPE_DEFAULTS.sidebarZoom, NUMBER_ROWS.sidebarZoom.range));
});

test("typed text applies as the nearest allowed number, and no number keeps the value", () => {
  const { range } = NUMBER_ROWS.chatText;
  assert.equal(appliedNumber("17", range, 15), 17);
  assert.equal(appliedNumber("3", range, 15), 11);
  assert.equal(appliedNumber("99", range, 15), 22);
  assert.equal(appliedNumber("16.6", range, 15), 17);
  assert.equal(appliedNumber("", range, 15), 15);
  assert.equal(appliedNumber("abc", range, 15), 15);
});

test("the minus and plus buttons move by one and stop at the ends", () => {
  const { range } = NUMBER_ROWS.uiScale;
  assert.equal(steppedNumber(100, 1, range), 101);
  assert.equal(steppedNumber(100, -1, range), 99);
  assert.equal(steppedNumber(150, 1, range), 150);
  assert.equal(steppedNumber(80, -1, range), 80);
});

test("a custom code color is its own choice, a preset is itself", () => {
  assert.equal(codeBackgroundChoice("#123456"), "custom");
  assert.equal(codeBackgroundChoice("terminal"), "terminal");
  assert.equal(codeBackgroundChoice("default"), "default");
});

test("a section is changed when any of its rows differs from the default", () => {
  assert.equal(colorChanged(DEFAULT_APPEARANCE), false);
  assert.equal(typeChanged(DEFAULT_APPEARANCE), false);
  assert.equal(colorChanged({ ...DEFAULT_APPEARANCE, theme: "light" }), true);
  assert.equal(colorChanged({ ...DEFAULT_APPEARANCE, chatCodeBackground: "#101010" }), true);
  assert.equal(colorChanged({ ...DEFAULT_APPEARANCE, uiScale: 110 }), false);
  assert.equal(typeChanged({ ...DEFAULT_APPEARANCE, uiScale: 110 }), true);
  assert.equal(typeChanged({ ...DEFAULT_APPEARANCE, chatCodeText: null }), true);
  assert.equal(typeChanged({ ...DEFAULT_APPEARANCE, sidebarZoom: 90 }), true);
  assert.equal(typeChanged({ ...DEFAULT_APPEARANCE, monoFont: "d2coding" }), true);
  // The section reset brings a changed section back to unchanged.
  const changed = { ...DEFAULT_APPEARANCE, theme: "light" as const, uiFont: "inter" as const, sidebarZoom: 90 };
  assert.equal(colorChanged({ ...changed, ...COLOR_DEFAULTS }), false);
  assert.equal(typeChanged({ ...changed, ...TYPE_DEFAULTS }), false);
});

test("the terminal rows are the web's: its color sets, its sizes, its two view modes", () => {
  assert.deepEqual(labels(VIEW_MODE_OPTIONS), ["Chat", "Terminal"]);
  assert.deepEqual(NUMBER_ROWS.terminalFontSize, { range: { min: 11, max: 22 }, unit: "pt" });
  assert.equal(TERMINAL_COLORSET_OPTIONS.length, TERMINAL_COLORSETS.length);
  assert.equal(labels(TERMINAL_COLORSET_OPTIONS)[0], "Current (as in iTerm)");
  assert.ok(TERMINAL_COLORSET_OPTIONS.some((o) => o.value === COLOR_DEFAULTS.terminalColorset));
  const { min, max } = NUMBER_ROWS.terminalFontSize.range;
  assert.ok(TYPE_DEFAULTS.terminalFontSize >= min && TYPE_DEFAULTS.terminalFontSize <= max);
  assert.ok(VIEW_MODE_OPTIONS.some((o) => o.value === VIEW_DEFAULTS.defaultViewMode));
  assert.match(terminalColorsetNote("dracula"), /^Dracula: /);
  assert.equal(viewChanged(DEFAULT_APPEARANCE), false);
  assert.equal(viewChanged({ ...DEFAULT_APPEARANCE, defaultViewMode: "terminal" }), true);
  // The terminal's color set belongs to the Colors section and its size to Fonts and sizes.
  assert.equal(colorChanged({ ...DEFAULT_APPEARANCE, terminalColorset: "dracula" }), true);
  assert.equal(typeChanged({ ...DEFAULT_APPEARANCE, terminalFontSize: 18 }), true);
  assert.equal(viewChanged({ ...DEFAULT_APPEARANCE, ...VIEW_DEFAULTS }), false);
});

test("the note under the monospace font says what the phone draws instead", () => {
  assert.equal(MONO_FONT_NOTES.bon, undefined);
  assert.match(MONO_FONT_NOTES["sf-mono"] ?? "", /system monospace/);
  assert.equal(MONO_FONT_NOTES.system, undefined);
});
