import { test } from "node:test";
import assert from "node:assert/strict";
import { darkPalette, lightPalette } from "../palette.ts";
import { CHAT_CODE_TERMINAL, bubbleContent, codeSurface, paletteFor } from "./appearancePalette.ts";
import { chatCode, isLightPalette } from "./timelineTones.ts";

const plain = { chatCodeBackground: "default", messageBubble: "default" } as const;

test("the default code background is the theme's, the terminal preset is the web's two colors", () => {
  assert.equal(paletteFor("dark", plain).code, darkPalette.code);
  assert.equal(paletteFor("light", plain).code, lightPalette.code);
  assert.equal(paletteFor("dark", { ...plain, chatCodeBackground: "terminal" }).code, "#0f0f0f");
  assert.equal(paletteFor("light", { ...plain, chatCodeBackground: "terminal" }).code, "#eceff3");
  assert.deepEqual(CHAT_CODE_TERMINAL, { dark: "#0f0f0f", light: "#eceff3" });
});

test("a custom color brings the scheme its text reads in, a preset keeps the theme's", () => {
  assert.deepEqual(codeSurface("#ffffff", "dark", "#1c1c1c"), { surface: "#ffffff", scheme: "light" });
  assert.deepEqual(codeSurface("#101010", "light", "#f1f1f3"), { surface: "#101010", scheme: "dark" });
  assert.equal(codeSurface("terminal", "light", "#f1f1f3").scheme, "light");
  assert.equal(codeSurface("default", "dark", "#1c1c1c").scheme, "dark");
});

test("the same settings give the same palette object, and the rest of the palette is the theme's", () => {
  const a = paletteFor("dark", { chatCodeBackground: "#abcdef", messageBubble: "blue" });
  assert.equal(a, paletteFor("dark", { chatCodeBackground: "#abcdef", messageBubble: "blue" }));
  assert.equal(a.bg, darkPalette.bg);
  assert.equal(a.surface, darkPalette.surface);
  assert.equal(a.sunken, darkPalette.sunken);
  assert.equal(isLightPalette(paletteFor("light", plain)), true);
  assert.equal(isLightPalette(paletteFor("dark", plain)), false);
});

test("the blue bubble is the accent with white text, links and a muted label at 75%", () => {
  const p = paletteFor("light", { ...plain, messageBubble: "blue" });
  assert.equal(p.userBubble, lightPalette.accent);
  assert.equal(paletteFor("dark", plain).userBubble, darkPalette.userBubble);
  assert.equal(bubbleContent(paletteFor("dark", plain), "default"), null);
  const inside = bubbleContent(p, "blue")!;
  assert.equal(inside.text, "#ffffff");
  assert.equal(inside.info, "#ffffff");
  assert.equal(inside.muted, "rgba(255, 255, 255, 0.75)");
  assert.equal(inside.userBubble, p.userBubble);
});

test("the chat code text follows the code background's scheme, the border and the bubble shift the theme's", () => {
  // A light custom color in the dark theme: dark text on it.
  const p = paletteFor("dark", { ...plain, chatCodeBackground: "#ffffff" });
  const code = chatCode(p, false);
  assert.equal(code.ink, "#18181b");
  assert.equal(code.surface, "#ffffff");
  // A preset keeps the theme's text.
  assert.equal(chatCode(paletteFor("dark", plain), false).ink, "#f5f5f5");
  assert.equal(chatCode(paletteFor("light", plain), false).ink, "#18181b");
  // No code scheme (a plain palette) reads the theme.
  assert.equal(chatCode(darkPalette, false).ink, "#f5f5f5");
  // In a bubble the light theme moves the code toward white; the dark theme does not.
  assert.notEqual(chatCode(paletteFor("light", plain), true).surface, paletteFor("light", plain).code);
  assert.equal(chatCode(paletteFor("dark", plain), true).surface, paletteFor("dark", plain).code);
});
