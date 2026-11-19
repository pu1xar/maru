import { test } from "node:test";
import assert from "node:assert/strict";
import { darkPalette, lightPalette } from "../palette.ts";
import { composerColors, scaleAlpha } from "./composerColors.ts";

test("scaleAlpha multiplies the alpha of a hex or an rgba color", () => {
  assert.equal(scaleAlpha("#ebebed", 0.6), "rgba(235, 235, 237, 0.6)");
  assert.equal(scaleAlpha("rgba(15, 15, 15, 0.8)", 0.6), "rgba(15, 15, 15, 0.48)");
});

test("the box is the card in light and surface level 2 in dark, at the glass opacity", () => {
  assert.equal(composerColors("light", lightPalette).box, "rgba(255, 255, 255, 0.8)");
  assert.equal(composerColors("dark", darkPalette).box, "rgba(28, 28, 28, 0.8)");
});

test("the outline steps up under focus in both themes", () => {
  assert.equal(composerColors("light", lightPalette).outline, "rgba(24, 24, 27, 0.08)");
  assert.equal(composerColors("light", lightPalette).outlineFocus, "rgba(24, 24, 27, 0.22)");
  assert.equal(composerColors("dark", darkPalette).outline, "rgba(245, 245, 245, 0.05)");
  assert.equal(composerColors("dark", darkPalette).outlineFocus, "rgba(245, 245, 245, 0.16)");
});

test("the error card reads the web's error-foreground, which the palette does not name", () => {
  assert.equal(composerColors("light", lightPalette).errorText, "#a83634");
  assert.equal(composerColors("dark", darkPalette).errorText, "#ff6467");
});
