// The diagram page's renderer bundle (src/mermaid/peleBundle.generated.ts) is what a build from the
// web's installed pele and dompurify packages gives, so the app draws with the web's versions.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { BUNDLE_FILE, WEB_ROOT, asciiEscaped, bundleSource } from "./mermaid-bundle.mts";

const peleFile = path.join(WEB_ROOT, "node_modules/pele/dist/pele.global.js");
const stripMap = (text: string) => text.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, "");

test("the committed bundle equals a fresh build from apps/web's pele and dompurify", () => {
  assert.equal(fs.readFileSync(BUNDLE_FILE, "utf8"), bundleSource(), "run: node scripts/mermaid-bundle.mts");
});

test("the bundle's versions are the ones apps/web pins", () => {
  const deps = (JSON.parse(fs.readFileSync(path.join(WEB_ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies;
  const text = fs.readFileSync(BUNDLE_FILE, "utf8");
  assert.ok(text.includes(`export const PELE_VERSION = ${JSON.stringify(deps["pele"])};`));
  assert.ok(text.includes(`export const PURIFY_VERSION = ${JSON.stringify(deps["dompurify"])};`));
});

test("a build leaves out the source map comment and writes non-ASCII characters as escapes, nothing else", () => {
  const text = bundleSource();
  assert.ok(!text.includes("sourceMappingURL"));
  assert.ok(text.includes(JSON.stringify(asciiEscaped(stripMap(fs.readFileSync(peleFile, "utf8"))))));
  assert.equal(asciiEscaped("a、b"), "a\\u3001b");
  assert.equal(asciiEscaped("plain ascii"), "plain ascii");
});

test("both files are pure ASCII and compile as classic scripts", async () => {
  const { PELE_JS, PURIFY_JS } = await import("../src/mermaid/peleBundle.generated.ts");
  for (const script of [PELE_JS, PURIFY_JS]) {
    assert.ok(/^[\x00-\x7f]*$/.test(script));
    assert.doesNotThrow(() => new vm.Script(script));
  }
});

test("the escaped renderer draws exactly what the original does, Korean and CJK punctuation included", async () => {
  const { PELE_JS } = await import("../src/mermaid/peleBundle.generated.ts");
  const load = (code: string) => {
    const context = vm.createContext({});
    vm.runInContext(`${code}\n;globalThis.__pele = pele;`, context);
    return (context as { __pele: { render: (text: string) => { svg: string } } }).__pele;
  };
  const original = load(stripMap(fs.readFileSync(peleFile, "utf8")));
  const escaped = load(PELE_JS);
  for (const diagram of [
    "flowchart LR\n A[한글、 상자。] --> B{결정！}",
    "sequenceDiagram\n A->>B: 안녕、하세요。",
    'pie title 사용량\n "a":1\n"b":2',
    'graph TD\n A["° ¶ ß 、 。 ， ．"] --> B',
  ]) {
    const svg = original.render(diagram).svg;
    assert.ok(svg.length > 500);
    assert.equal(escaped.render(diagram).svg, svg, diagram);
  }
});
