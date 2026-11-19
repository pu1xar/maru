import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { darkPalette } from "../palette.ts";
import { inScript, mermaidPageHtml, PAGE_SCRIPT } from "./page.ts";
import { PELE_JS, PURIFY_JS } from "./peleBundle.generated.ts";

const NONCE = "testnonce123";

test("the page script compiles and holds no template literal (it sits in a template string)", () => {
  assert.doesNotThrow(() => new vm.Script(PAGE_SCRIPT));
  assert.ok(!PAGE_SCRIPT.includes("`") && !PAGE_SCRIPT.includes("${"));
});

test("a script's end tag cannot appear inside the inlined scripts", () => {
  assert.equal(inScript("a</script>b</SCRIPT >c"), "a<\\/script>b<\\/SCRIPT >c");
  const html = mermaidPageHtml("graph TD\n A-->B", darkPalette, NONCE);
  // The four script elements the page builds, each closed once.
  assert.equal((html.match(/<script nonce="testnonce123">/g) ?? []).length, 4);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 4);
  assert.ok(PELE_JS.length > 100_000 && PURIFY_JS.length > 10_000);
});

test("the page is self-contained: one script by nonce, no connection, image, font or frame", () => {
  const html = mermaidPageHtml("graph TD\n A-->B", darkPalette, NONCE);
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-testnonce123'(;|$)/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(csp, /script-src[^;]*https?:/);
  for (const directive of ["connect-src 'none'", "img-src 'none'", "font-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(csp.includes(directive), directive);
  }
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  assert.ok(!/<script[^>]*\ssrc=/i.test(html));
  assert.ok(!/<link\b|<img\b|<iframe\b|<form\b|<a\s/i.test(markup), "no external or interactive element outside the scripts");
  // Every script element carries the nonce.
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) assert.ok(tag.includes('nonce="testnonce123"'), tag);
});

test("each page gets its own nonce unless one is given", () => {
  const a = /nonce-([a-z0-9]+)'/.exec(mermaidPageHtml("graph TD", darkPalette))![1]!;
  const b = /nonce-([a-z0-9]+)'/.exec(mermaidPageHtml("graph TD", darkPalette))![1]!;
  assert.ok(a.length >= 16);
  assert.notEqual(a, b);
});

test("diagram text cannot end its script element or break out of the page's data", () => {
  const source = 'graph TD\n A["</script><img src=x onerror=alert(1)>"] --> B';
  const html = mermaidPageHtml(source, darkPalette, NONCE);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 4);
  assert.ok(html.includes("\\u003c/script>"));
  const data = /window\.__MARU_MERMAID__=(\{.*?\});<\/script>/s.exec(html)![1]!;
  assert.equal((JSON.parse(data) as { source: string }).source, source);
});

test("the page paints with the theme's colors", () => {
  const html = mermaidPageHtml("graph TD", darkPalette, NONCE);
  assert.ok(html.includes(`--pele-fg:${darkPalette.text}`));
  assert.ok(html.includes(`background:${darkPalette.bg}`));
  assert.ok(html.includes("--pele-bg:transparent"));
});
