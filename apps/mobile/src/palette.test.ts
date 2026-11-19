import assert from "node:assert/strict";
import { test } from "node:test";
import { themeColors } from "../../../packages/shared/src/themeColors.ts";
import { darkPalette, lightPalette, paletteFrom } from "./palette.ts";

test("the app's palettes are the shared theme colors", () => {
  assert.equal(darkPalette.bg, themeColors.dark.background);
  assert.equal(darkPalette.accent, themeColors.dark.primary);
  assert.equal(lightPalette.bg, themeColors.light.background);
  assert.equal(lightPalette.userBubble, themeColors.light.messageSurface);
});

test("a changed source color reaches the palette", () => {
  const changed = paletteFrom({ ...themeColors.dark, primary: "#123456" }, "rgba(0,0,0,0.5)");
  assert.equal(changed.accent, "#123456");
});

test("every palette value is a color React Native takes", () => {
  for (const palette of [darkPalette, lightPalette]) {
    for (const [role, value] of Object.entries(palette)) {
      assert.match(value, /^(#[0-9a-f]{6}|rgba\(\d+, ?\d+, ?\d+, ?[\d.]+\))$/, role);
    }
  }
});
