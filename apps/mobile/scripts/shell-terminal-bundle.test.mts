// The shell page's xterm bundle (src/shell/xtermBundle.generated.ts) is what a build from the web's
// installed @xterm packages gives, so the app's terminal is the web's version.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { BUNDLE_FILE, WEB_ROOT, bundleSource } from "./shell-terminal-bundle.mts";

test("the committed bundle equals a fresh build from apps/web's @xterm packages", () => {
  assert.equal(fs.readFileSync(BUNDLE_FILE, "utf8"), bundleSource(), "run: node scripts/shell-terminal-bundle.mts");
});

test("the bundle's versions are the ones apps/web pins", () => {
  const deps = (JSON.parse(fs.readFileSync(path.join(WEB_ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies;
  const text = fs.readFileSync(BUNDLE_FILE, "utf8");
  assert.ok(text.includes(`export const XTERM_VERSION = ${JSON.stringify(deps["@xterm/xterm"])};`));
  assert.ok(text.includes(`export const XTERM_FIT_VERSION = ${JSON.stringify(deps["@xterm/addon-fit"])};`));
});

test("a build leaves out the source map comment and nothing else of the files", () => {
  const text = bundleSource();
  assert.ok(!text.includes("sourceMappingURL"));
  const xterm = fs.readFileSync(path.join(WEB_ROOT, "node_modules/@xterm/xterm/lib/xterm.js"), "utf8");
  assert.ok(text.includes(JSON.stringify(xterm.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, ""))));
});
