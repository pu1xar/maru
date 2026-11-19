import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BON_FAMILY, bonFontFaceCss, bonPieceUrl } from "../../../../packages/shared/src/bonFont.ts";
import { TERMINAL_COLORSETS, resolveTerminalTokens } from "../../../web/src/lib/terminalTheme.logic.ts";
import { TERMINAL_FONTS, TERMINAL_FONT_SIZES } from "../../../web/src/lib/viewMode.logic.ts";
import {
  BON_PAGE_PIECES,
  DEFAULT_SHELL_LOOK,
  PAGE_FONT_FAMILY,
  TERMINAL_COLORSET_KEY,
  TERMINAL_FONT_SIZE_KEY,
  pageFont,
  pageLook,
  readShellLook,
} from "./look.ts";

const webSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/src");
const webText = (file: string) => fs.readFileSync(path.join(webSrc, file), "utf8");
// A font CDN as a deployment sets it (build.env MARU_FONT_CDN).
const CDN = "https://cdn.example.com/fonts/v1/bon-google-sans-code";
const none = () => null;

test("the storage keys are the web's and the Appearance settings' (viewMode.logic.ts, terminalTheme.logic.ts)", () => {
  assert.equal(TERMINAL_FONT_SIZE_KEY, "maru_terminal_font_size");
  assert.equal(TERMINAL_COLORSET_KEY, "maru_terminal_colorset");
});

test("a look is read from the stored JSON, with the web's defaults for anything missing or out of range", () => {
  assert.deepEqual(readShellLook(none, "bon"), DEFAULT_SHELL_LOOK);
  assert.equal(DEFAULT_SHELL_LOOK.fontSize, 13, "the web's terminal text size default");
  assert.equal(DEFAULT_SHELL_LOOK.colorset, "iterm");
  const stored: Record<string, string> = { [TERMINAL_FONT_SIZE_KEY]: "16", [TERMINAL_COLORSET_KEY]: JSON.stringify("dracula") };
  const colorset = TERMINAL_COLORSETS.find((c) => c.id !== "iterm")!.id;
  stored[TERMINAL_COLORSET_KEY] = JSON.stringify(colorset);
  assert.deepEqual(readShellLook((k) => stored[k] ?? null, "d2coding"), { fontSize: 16, colorset, monoFont: "d2coding" });
  for (const bad of ["99", "5", '"16"', "x", "null", "13.5"]) {
    assert.equal(readShellLook((k) => (k === TERMINAL_FONT_SIZE_KEY ? bad : null), "bon").fontSize, 13, bad);
  }
  assert.equal(readShellLook((k) => (k === TERMINAL_COLORSET_KEY ? '"no-such-set"' : null), "bon").colorset, "iterm");
  for (const size of TERMINAL_FONT_SIZES) assert.equal(readShellLook((k) => (k === TERMINAL_FONT_SIZE_KEY ? String(size) : null), "bon").fontSize, size);
});

test("the xterm colors are the web ShellView's xtermTheme of the colorset's tokens, for every colorset", () => {
  // ShellView.tsx maps the tokens: bg, fg, cursor, selectionBg, selectionFg, and cursorAccent as bg.
  const view = webText("components/shell/ShellView.tsx");
  for (const line of [
    "background: t.bg,",
    "foreground: t.fg,",
    "cursor: t.cursor,",
    "cursorAccent: t.bg,",
    "selectionBackground: t.selectionBg,",
    "selectionForeground: t.selectionFg,",
  ]) {
    assert.ok(view.includes(line), line);
  }
  for (const set of TERMINAL_COLORSETS) {
    const t = resolveTerminalTokens(set.id);
    const look = pageLook({ ...DEFAULT_SHELL_LOOK, colorset: set.id });
    assert.deepEqual(look.theme, {
      background: t.bg,
      foreground: t.fg,
      cursor: t.cursor,
      cursorAccent: t.bg,
      selectionBackground: t.selectionBg,
      selectionForeground: t.selectionFg,
    }, set.id);
  }
  assert.equal(pageLook(DEFAULT_SHELL_LOOK).theme.background, "#0f0f0f", "the iterm colorset's neutral background");
  console.log(`colorsets checked: ${TERMINAL_COLORSETS.length}`);
});

test("the Bon face pieces are the ones the web declares from the same CDN (file, weight and unicode-range)", () => {
  const css = bonFontFaceCss(CDN);
  const rules = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!).filter((r) => r.includes(`"${BON_FAMILY}"`));
  assert.ok(rules.length >= 4);
  assert.equal(BON_PAGE_PIECES.length, 4);
  for (const piece of BON_PAGE_PIECES) {
    const rule = rules.find((r) => r.includes(bonPieceUrl(CDN, piece)));
    assert.ok(rule, `no rule for ${piece.file}`);
    assert.ok(new RegExp(`font-weight:\\s*${piece.weight};`).test(rule), `${piece.file} weight`);
    const range = /unicode-range:\s*([^;]+)$/.exec(rule)![1]!.replace(/\s+/g, " ").trim();
    assert.equal(piece.range, range, `${piece.file} unicode-range`);
  }
});

test("each monospace font gives the page a family and its files; the phone's own monospace has none", () => {
  const seen: string[] = [];
  for (const font of TERMINAL_FONTS) {
    const { family, faceCss } = pageFont(font.id, CDN);
    seen.push(`${font.id}: ${faceCss ? "files" : "phone monospace"}`);
    assert.ok(!faceCss.includes("</"), "nothing in the css can end its style element");
    if (font.id === "sf-mono" || font.id === "system") {
      assert.equal(family, "monospace");
      assert.equal(faceCss, "");
    } else {
      assert.equal(family, `"${PAGE_FONT_FAMILY}", monospace`);
      assert.match(faceCss, /font-weight:400/);
      assert.match(faceCss, /font-weight:700/);
      for (const url of faceCss.matchAll(/url\("([^"]+)"\)/g)) assert.match(url[1]!, /^https:\/\//);
    }
  }
  // Bon takes the web's woff2 pieces, not the app's ttf the WebView's font sanitizer refuses.
  assert.match(pageFont("bon", CDN).faceCss, /\.woff2/);
  assert.doesNotMatch(pageFont("bon", CDN).faceCss, /android\.ttf/);
  assert.match(pageFont("d2coding", CDN).faceCss, /d2coding-full\.ttf/);
  // Without a font CDN Bon keeps the phone's monospace; D2Coding does not depend on it.
  assert.deepEqual(pageFont("bon", null), { family: "monospace", faceCss: "" });
  assert.match(pageFont("d2coding", null).faceCss, /d2coding-full\.ttf/);
  console.log(seen.join("; "));
});

test("the look carries the size and the chosen font to the page", () => {
  const look = pageLook({ fontSize: 17, colorset: "iterm", monoFont: "d2coding" });
  assert.equal(look.fontSize, 17);
  assert.equal(look.fontFamily, `"${PAGE_FONT_FAMILY}", monospace`);
  assert.ok(look.faceCss.includes("d2coding"));
});
