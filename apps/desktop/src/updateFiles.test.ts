import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findBaseline, pruneUpdates } from "./updateFiles.ts";

test("updates folder: the running build's folder and the target's stay, other versions and their files go", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "updates-"));
  try {
    for (const v of ["0.1.5", "0.1.6", "0.1.7"]) {
      fs.mkdirSync(path.join(dir, v, "stage"), { recursive: true });
      fs.writeFileSync(path.join(dir, v, `maru-${v}-mac-arm64.zip`), v);
    }
    fs.writeFileSync(path.join(dir, "swap.sh"), "#!/bin/sh");
    pruneUpdates(dir, ["0.1.6", "0.1.7"]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["0.1.6", "0.1.7", "swap.sh"]);
    pruneUpdates(path.join(dir, "missing"), []);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("baseline: the finished update file of the running version, never a partial one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "updates-"));
  try {
    assert.equal(findBaseline(dir, "0.1.6", ".zip"), null, "no folder");
    fs.mkdirSync(path.join(dir, "0.1.6"));
    fs.writeFileSync(path.join(dir, "0.1.6", "maru-0.1.6-mac-arm64.zip.partial"), "x");
    assert.equal(findBaseline(dir, "0.1.6", ".zip"), null, "only a partial file");
    fs.writeFileSync(path.join(dir, "0.1.6", "maru-0.1.6-mac-arm64.zip"), "x");
    assert.equal(findBaseline(dir, "0.1.6", ".zip"), path.join(dir, "0.1.6", "maru-0.1.6-mac-arm64.zip"));
    assert.equal(findBaseline(dir, "0.1.6", ".exe"), null, "another platform's file");
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
