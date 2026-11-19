import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The fingerprint needs V8's module parser behind --experimental-vm-modules, so these tests run
// the command (fingerprintCli.ts), which adds the flag itself, on small fake releases.
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "fingerprintCli.ts");

let dir: string;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maru-fp-"));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

/** A release with a host entry, its imports, a package, and files the host does not load. */
function release(name: string): string {
  const root = path.join(dir, name);
  write(root, "apps/server/src/host/main.ts", [
    'import { a } from "./a.ts";',
    'import type { T } from "../web/types.ts";',
    'import { pkg } from "fake-pkg";',
    'import fs from "node:fs";',
    "const x: T | null = null;",
    "console.log(a, pkg, fs, x);",
  ].join("\n"));
  write(root, "apps/server/src/host/a.ts", 'export { b as a } from "./b.ts";\n');
  write(root, "apps/server/src/host/b.ts", "export const b: number = 1;\n");
  write(root, "apps/server/src/web/types.ts", "export type T = string;\n");
  write(root, "apps/server/src/web/server.ts", "export const web = 1;\n");
  write(root, "node_modules/fake-pkg/package.json", JSON.stringify({ name: "fake-pkg", version: "1.2.3", type: "module", exports: "./index.js" }));
  write(root, "node_modules/fake-pkg/index.js", "export const pkg = 1;\n");
  write(root, "node_modules/fake-pkg/node_modules/inner/x.js", "ignored\n");
  return root;
}

function run(root: string, list = false) {
  const r = spawnSync(process.execPath, [cli, root, ...(list ? ["--list"] : [])], { encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim().split("\n"), err: r.stderr.trim() };
}

test("the fingerprint follows the host's imports only, and two copies of one release agree", () => {
  const one = release("one");
  const listed = run(one, true);
  assert.equal(listed.code, 0, listed.err);
  assert.match(listed.out[0]!, /^v1-[0-9a-f]{64}$/);
  const files = listed.out.filter((l) => l.startsWith("file ") || l.startsWith("package ")).map((l) => l.split(" ").slice(0, 2).join(" "));
  assert.deepEqual(files, [
    "file apps/server/src/host/a.ts",
    "file apps/server/src/host/b.ts",
    "file apps/server/src/host/main.ts",
    "package fake-pkg@1.2.3",
  ], "a type-only import and files outside the graph are not host code");
  assert.ok(listed.out.includes("builtins fs"));

  const two = release("two");
  assert.equal(run(two).out[0], listed.out[0], "paths count from the release root");

  // A web-only change keeps it; a change in the graph or the package moves it.
  write(two, "apps/server/src/web/server.ts", "export const web = 2;\n");
  write(two, "apps/server/src/web/types.ts", "export type T = number;\n");
  assert.equal(run(two).out[0], listed.out[0]);
  write(two, "apps/server/src/host/b.ts", "export const b: number = 2;\n");
  const changed = run(two).out[0];
  assert.notEqual(changed, listed.out[0]);
  write(two, "node_modules/fake-pkg/index.js", "export const pkg = 2;\n");
  assert.notEqual(run(two).out[0], changed);
});

test("an import the fingerprint cannot follow is reported and the exit code says so", () => {
  const root = release("dyn");
  write(root, "apps/server/src/host/b.ts", 'export const b = 1;\nexport const later = () => import("./c.ts");\n');
  const r = run(root);
  assert.equal(r.code, 2);
  assert.match(r.out[0]!, /^v1-/);
  assert.match(r.err, /apps\/server\/src\/host\/b\.ts: dynamic import\(\) is not followed/);
});
