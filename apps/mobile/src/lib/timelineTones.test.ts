import { test } from "node:test";
import assert from "node:assert/strict";
import { darkPalette, lightPalette } from "../palette.ts";
import { blendOver, chatCode, findPaint, isLightPalette, mixColors, parseColor, tones } from "./timelineTones.ts";

test("colors parse in the forms the theme uses and mix channel by channel", () => {
  assert.deepEqual(parseColor("#fff"), [255, 255, 255, 1]);
  assert.deepEqual(parseColor("rgba(255, 255, 255, 0.08)"), [255, 255, 255, 0.08]);
  assert.equal(parseColor("oklch(0.5 0.1 20)"), null);
  assert.equal(mixColors("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mixColors("not a color", "#ffffff", 0.5), "not a color");
  // A see-through bubble over the canvas is the one color it shows.
  assert.equal(blendOver("rgba(255, 255, 255, 0.5)", "#000000"), "#808080");
});

test("status text takes the web's -foreground colors, not the fills", () => {
  assert.equal(tones(lightPalette).error, "#a83634");
  assert.equal(tones(darkPalette).error, "#ff6467");
  assert.equal(tones(darkPalette).success, "#00d492");
  assert.notEqual(tones(lightPalette).error, lightPalette.danger);
  assert.equal(isLightPalette(lightPalette), true);
  assert.equal(isLightPalette(darkPalette), false);
});

test("a find paints the web's amber: light and dark matches, one active color", () => {
  assert.deepEqual(findPaint(lightPalette, false), { backgroundColor: "#ffde8b", color: "#21180a" });
  assert.deepEqual(findPaint(darkPalette, false), { backgroundColor: "#8c6c1f", color: "#f5f5f5" });
  assert.deepEqual(findPaint(darkPalette, true), findPaint(lightPalette, true));
});

test("the chat code surface: the bubble lightens it in the light theme only, the border moves toward the code text", () => {
  const light = chatCode(lightPalette, false);
  const lightBubble = chatCode(lightPalette, true);
  assert.equal(light.surface, lightPalette.code);
  assert.notEqual(lightBubble.surface, light.surface);
  assert.equal(chatCode(darkPalette, true).surface, darkPalette.code);
  assert.equal(light.border, mixColors(light.surface, "#18181b", 0.2));
  assert.equal(chatCode(darkPalette, false).border, mixColors(darkPalette.code, "#f5f5f5", 0.16));
});
