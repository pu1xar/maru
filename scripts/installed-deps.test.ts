// installed-deps.ts: when npm's hidden lockfile counts as the package-lock.json's install.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { npmInstalledMismatch } from "./installed-deps.ts";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "installed-deps.ts");

const wanted = {
  "": { name: "app", dependencies: { a: "1.0.0" } },
  "node_modules/a": { version: "1.0.0", integrity: "sha512-a" },
  "node_modules/b-linux": { version: "2.0.0", optional: true },
  "node_modules/c-win": { version: "3.0.0", devOptional: true },
};

test("installed matches when only the root and skipped optional packages are absent", () => {
  assert.equal(npmInstalledMismatch(wanted, { "node_modules/a": { version: "1.0.0", integrity: "sha512-a" } }), null);
});

test("a required package the lockfile gained after the install is a mismatch", () => {
  const reason = npmInstalledMismatch({ ...wanted, "node_modules/d": { version: "4.0.0" } }, {
    "node_modules/a": { version: "1.0.0", integrity: "sha512-a" },
  });
  assert.equal(reason, "node_modules/d is in package-lock.json but not installed");
});

test("a different version and a package the lockfile dropped are mismatches", () => {
  assert.equal(
    npmInstalledMismatch(wanted, { "node_modules/a": { version: "1.0.1", integrity: "sha512-x" } }),
    "node_modules/a is installed at a different version or source",
  );
  assert.equal(
    npmInstalledMismatch(wanted, {
      "node_modules/a": { version: "1.0.0", integrity: "sha512-a" },
      "node_modules/old": { version: "0.1.0" },
    }),
    "node_modules/old is installed but not in package-lock.json",
  );
});

test("the command exits 0 on a match, 1 with the reason otherwise, 1 for a missing file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maru-installed-deps-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "package-lock.json");
  const hidden = path.join(dir, ".package-lock.json");
  fs.writeFileSync(lock, JSON.stringify({ packages: wanted }));
  fs.writeFileSync(hidden, JSON.stringify({ packages: { "node_modules/a": wanted["node_modules/a"] } }));
  const run = (a: string, b: string) => spawnSync(process.execPath, [SCRIPT, a, b], { encoding: "utf8" });

  assert.equal(run(hidden, lock).status, 0);
  fs.writeFileSync(hidden, JSON.stringify({ packages: {} }));
  const differ = run(hidden, lock);
  assert.equal(differ.status, 1);
  assert.equal(differ.stdout.trim(), "node_modules/a is in package-lock.json but not installed");
  const missing = run(path.join(dir, "absent.json"), lock);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /absent\.json is missing/);
});
