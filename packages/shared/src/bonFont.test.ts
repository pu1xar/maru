import { test } from "node:test";
import assert from "node:assert/strict";
import { BON_FAMILY, BON_PIECES, bonFontFaceCss, bonPieceUrl, normalizeFontCdn } from "./bonFont.ts";

const CDN = "https://cdn.example.com/fonts/v1/bon-google-sans-code";

test("normalizeFontCdn keeps an https directory URL and drops a trailing slash", () => {
  assert.equal(normalizeFontCdn(CDN), CDN);
  assert.equal(normalizeFontCdn(`${CDN}/`), CDN);
  assert.equal(normalizeFontCdn("https://fonts.example.com:8443/b"), "https://fonts.example.com:8443/b");
});

test("normalizeFontCdn refuses what a CSS url() or a style element could not carry safely", () => {
  for (const bad of [
    "", "   ", "http://cdn.example.com/f", "//cdn.example.com/f", "cdn.example.com/f",
    'https://cdn.example.com/f"); } body { x: y', "https://cdn.example.com/f)", "https://cdn.example.com/</style>",
    "https://u@cdn.example.com/f", "https://cdn.example.com/f?x=1", "https://cdn.example.com/f#x", "https://cdn.example.com/a b",
  ]) {
    assert.equal(normalizeFontCdn(bad), null, bad);
  }
  assert.equal(normalizeFontCdn(null), null);
  assert.equal(normalizeFontCdn(undefined), null);
});

test("bonFontFaceCss declares every piece under one family, or nothing without a CDN", () => {
  assert.equal(bonFontFaceCss(null), "");
  assert.equal(bonFontFaceCss("not a url"), "");
  const css = bonFontFaceCss(CDN);
  const rules = css.split("\n");
  assert.equal(rules.length, BON_PIECES.length);
  for (const [i, piece] of BON_PIECES.entries()) {
    const rule = rules[i]!;
    assert.ok(rule.startsWith(`@font-face{font-family:"${BON_FAMILY}";`));
    assert.ok(rule.includes(`url("${bonPieceUrl(CDN, piece)}")`));
    assert.ok(rule.includes(`font-style:${piece.style};font-weight:${piece.weight};`));
    assert.ok(rule.includes(`unicode-range:${piece.range}`));
  }
  assert.ok(!css.includes("</"));
});
