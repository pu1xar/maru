import { test } from "node:test";
import assert from "node:assert/strict";
import { lexMarkdown } from "../components/markdownModel.ts";
import { isMermaidLanguage } from "../../../web/src/components/chat/MarkdownMermaid.logic.ts";
import { codeLanguage } from "../components/markdownModel.ts";
import { darkPalette, lightPalette } from "../palette.ts";
import { fenceClosed, mixColor, pageColors, parsePageMessage, SERIES_COLORS } from "./model.ts";

/** The code tokens marked gives for a text, with what Markdown.tsx decides for each. */
function fences(text: string) {
  const out: { lang: string; closed: boolean; mermaid: boolean }[] = [];
  const walk = (tokens: { type: string; raw: string; lang?: string; tokens?: unknown[]; items?: unknown[] }[]) => {
    for (const t of tokens) {
      if (t.type === "code") {
        out.push({ lang: t.lang ?? "", closed: fenceClosed(t.raw), mermaid: isMermaidLanguage(codeLanguage(t.lang)) });
      }
      if (Array.isArray(t.tokens)) walk(t.tokens as never);
      if (Array.isArray(t.items)) walk(t.items as never);
    }
  };
  walk(lexMarkdown(text) as never);
  return out;
}

test("a closed fence offers a diagram, an unfinished one does not", () => {
  assert.deepEqual(fences("```mermaid\ngraph TD\n A-->B\n```\n"), [{ lang: "mermaid", closed: true, mermaid: true }]);
  assert.deepEqual(fences("```mermaid\ngraph TD\n A-->B\n"), [{ lang: "mermaid", closed: false, mermaid: true }]);
  assert.equal(fences("```mermaid\ngraph TD\n A-->B\n``")[0]!.closed, false);
});

test("fences of other lengths and kinds", () => {
  assert.equal(fences("````mermaid\ngraph TD\n```\n````\n")[0]!.closed, true);
  assert.equal(fences("~~~mermaid\ngraph TD\n~~~\n")[0]!.closed, true);
  assert.equal(fences("```Mermaid title=x\ngraph TD\n```")[0]!.mermaid, true);
  assert.equal(fences("```mermaidjs\ngraph TD\n```")[0]!.mermaid, false);
  assert.equal(fences("```ts\nconst a = 1\n```")[0]!.mermaid, false);
});

test("an indented code block and a fence inside a list or quote are judged by their own raw text", () => {
  assert.equal(fenceClosed("    graph TD\n    A-->B"), false);
  assert.equal(fenceClosed(""), false);
  assert.equal(fences("1. step\n\n   ```mermaid\n   graph TD\n   ```\n")[0]!.closed, true);
  assert.equal(fences("> ```mermaid\n> graph TD\n> ```\n")[0]!.closed, true);
});

test("mixColor is the opaque color-mix of the web", () => {
  assert.equal(mixColor("#ffffff", "#000000", 0.5), "#808080");
  assert.equal(mixColor("#000000", "#ffffff", 0.06), "#f0f0f0");
  assert.equal(mixColor("#fff", "#000", 1), "#ffffff");
  // A form it cannot read comes back as the foreground, never as NaN.
  assert.equal(mixColor("rgba(1,2,3,0.5)", "#000000", 0.5), "rgba(1,2,3,0.5)");
});

test("the page colors follow the theme and name every Pele variable the web names", () => {
  const dark = pageColors(darkPalette);
  const light = pageColors(lightPalette);
  const names = [
    "--pele-bg", "--pele-fg", "--pele-muted", "--pele-line", "--pele-surface", "--pele-surface-alt",
    "--pele-border", "--pele-accent", "--pele-critical", "--pele-radius",
    ...SERIES_COLORS.map((_, i) => `--pele-series-${i + 1}`),
  ];
  for (const name of names) {
    assert.ok(dark[name], `dark ${name}`);
    assert.ok(light[name], `light ${name}`);
  }
  assert.equal(dark["--pele-bg"], "transparent");
  assert.equal(dark["--pele-fg"], darkPalette.text);
  assert.equal(light["--pele-fg"], lightPalette.text);
  assert.notEqual(dark["--pele-surface"], light["--pele-surface"]);
  for (const value of Object.values({ ...dark, ...light })) assert.doesNotMatch(value, /NaN|undefined/);
  // Node fills are opaque, so an edge under a node stays hidden.
  assert.match(dark["--pele-surface"]!, /^#[0-9a-f]{6}$/);
  assert.match(light["--pele-border"]!, /^#[0-9a-f]{6}$/);
});

test("the page may say drawn or failed, and nothing else", () => {
  assert.deepEqual(parsePageMessage('{"t":"drawn"}'), { t: "drawn" });
  assert.deepEqual(parsePageMessage('{"t":"failed","code":"syntax","line":3,"message":"m"}'), { t: "failed", code: "syntax", line: 3, message: "m" });
  assert.deepEqual(parsePageMessage('{"t":"failed"}'), { t: "failed", code: "", line: 0, message: "" });
  for (const bad of ["", "nope", "[]", "null", "3", '{"t":"open","url":"https://x"}', '{"x":1}']) {
    assert.equal(parsePageMessage(bad), null, bad);
  }
});
