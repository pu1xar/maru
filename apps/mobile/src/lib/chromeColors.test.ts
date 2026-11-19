import { test } from "node:test";
import assert from "node:assert/strict";
import { themeColors } from "../../../../packages/shared/src/themeColors.ts";
import { chromeColorsFrom, darkChrome, lightChrome, scaleAlpha } from "./chromeColors.ts";

test("scaleAlpha multiplies the opacity of a rgba and gives a #rrggbb that opacity", () => {
  assert.equal(scaleAlpha("rgba(255, 255, 255, 0.11)", 0.32), "rgba(255, 255, 255, 0.0352)");
  assert.equal(scaleAlpha("#000000", 0.6), "rgba(0, 0, 0, 0.6)");
});

test("the field and button fills follow the web's tokens in each theme", () => {
  assert.equal(lightChrome.inputFill, themeColors.light.background);
  assert.equal(lightChrome.outlineFill, themeColors.light.card);
  assert.equal(darkChrome.inputFill, "rgba(255, 255, 255, 0.0352)");
  assert.equal(darkChrome.outlineFill, darkChrome.inputFill);
});

test("sheet edge and backdrop: the foreground at 10% in light, white at 8% in dark; the canvas at 60% and 64%", () => {
  assert.equal(lightChrome.sheetBorder, "rgba(24, 24, 27, 0.1)");
  assert.equal(darkChrome.sheetBorder, "rgba(255, 255, 255, 0.08)");
  assert.equal(lightChrome.backdrop, "rgba(252, 252, 252, 0.6)");
  assert.equal(darkChrome.backdrop, "rgba(0, 0, 0, 0.64)");
});

test("error surface tints the error fill 8% in light and 16% in dark, the text is the foreground token", () => {
  assert.equal(lightChrome.errorSurface, "rgba(193, 60, 59, 0.08)");
  assert.equal(darkChrome.errorSurface, "rgba(251, 65, 74, 0.16)");
  assert.equal(lightChrome.errorForeground, themeColors.light.errorForeground);
  assert.equal(darkChrome.warningForeground, themeColors.dark.warningForeground);
});

test("settings group: card at 40%, border at 60% and 50%", () => {
  assert.equal(lightChrome.groupFill, "rgba(255, 255, 255, 0.4)");
  assert.equal(darkChrome.groupBorder, "rgba(255, 255, 255, 0.048)");
  assert.equal(darkChrome.groupDivider, "rgba(255, 255, 255, 0.04)");
  assert.equal(lightChrome.groupBorder, "rgba(228, 228, 231, 0.6)");
});

test("a changed source color reaches the chrome colors", () => {
  assert.equal(chromeColorsFrom({ ...themeColors.dark, accent: "#123456" }, true).accent, "#123456");
});
