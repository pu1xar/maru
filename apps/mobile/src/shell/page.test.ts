import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { DEFAULT_SHELL_LOOK, SHELL_SCROLLBACK_LINES, pageLook } from "./look.ts";
import { inScript, PAGE_SCRIPT, shellPageHtml } from "./page.ts";
import { XTERM_CSS, XTERM_FIT_JS, XTERM_FIT_VERSION, XTERM_JS, XTERM_VERSION } from "./xtermBundle.generated.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web");
const webDeps = (JSON.parse(fs.readFileSync(path.join(webRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies;

test("the page carries the xterm packages at the versions the web uses", () => {
  assert.equal(XTERM_VERSION, webDeps["@xterm/xterm"]);
  assert.equal(XTERM_FIT_VERSION, webDeps["@xterm/addon-fit"]);
  assert.ok(XTERM_JS.length > 100_000 && XTERM_CSS.length > 1000 && XTERM_FIT_JS.length > 500);
});

test("the page script compiles and holds no template literal (it sits in a template string)", () => {
  assert.doesNotThrow(() => new vm.Script(PAGE_SCRIPT));
  assert.doesNotThrow(() => new vm.Script(XTERM_FIT_JS));
  assert.doesNotThrow(() => new vm.Script(XTERM_JS));
  assert.ok(!PAGE_SCRIPT.includes("`") && !PAGE_SCRIPT.includes("${"));
});

test("a script's end tag cannot appear inside the inlined scripts", () => {
  assert.equal(inScript("a</script>b</SCRIPT >c"), "a<\\/script>b<\\/SCRIPT >c");
  const html = shellPageHtml(pageLook(DEFAULT_SHELL_LOOK));
  // Exactly the four script elements the page builds, each closed once.
  assert.equal((html.match(/<script>/g) ?? []).length, 4);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 4);
});

test("the page is self-contained: its policy lets it load fonts and nothing else, and it has no external script or stylesheet", () => {
  const html = shellPageHtml(pageLook(DEFAULT_SHELL_LOOK));
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /font-src https:/);
  assert.match(csp, /script-src 'unsafe-inline'/);
  assert.doesNotMatch(csp, /script-src[^;]*https?:/);
  assert.doesNotMatch(html, /<script[^>]*\ssrc=/i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<img\b|<iframe\b|<form\b|<a\s/i);
  // The look and the scrollback the page starts with.
  const cfg = /window\.__MARU_PAGE__=(\{.*?\});<\/script>/s.exec(html)![1]!;
  const parsed = JSON.parse(cfg) as { look: { fontSize: number; theme: { background: string } }; scrollback: number };
  assert.equal(parsed.scrollback, SHELL_SCROLLBACK_LINES);
  assert.equal(parsed.look.fontSize, 13);
  assert.equal(parsed.look.theme.background, "#0f0f0f");
  assert.ok(html.includes('<body style="background:#0f0f0f">'));
});

test("settings text cannot end its script element", () => {
  const look = pageLook(DEFAULT_SHELL_LOOK);
  const html = shellPageHtml({ ...look, fontFamily: '"x</script><b>"' });
  assert.equal((html.match(/<\/script>/g) ?? []).length, 4);
  assert.ok(html.includes("\\u003c/script>"));
});
