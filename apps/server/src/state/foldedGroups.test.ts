import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { FoldedGroupStore, FoldError } from "./foldedGroups.ts";

test("set merges one key at a time and reports changes", () => {
  const store = new FoldedGroupStore(":memory:");
  const seen: string[][] = [];
  store.onChange((k) => seen.push(k));
  assert.equal(store.set("pinned", true), true);
  assert.equal(store.set("project:a-1", true), true);
  // A second client's older view cannot unfold what it never touched: only the named key changes.
  assert.equal(store.set("pinned", false), true);
  assert.deepEqual(store.keys(), ["project:a-1"]);
  assert.equal(store.set("pinned", false), false);
  assert.deepEqual(seen, [["pinned"], ["pinned", "project:a-1"], ["project:a-1"]]);
});

test("set refuses keys that are not folders", () => {
  const live = new Set(["project:p1"]);
  const store = new FoldedGroupStore(":memory:", (k) => !k.startsWith("project:") || live.has(k));
  assert.throws(() => store.set("../x", true), FoldError);
  assert.throws(() => store.set("project:", true), FoldError);
  assert.throws(() => store.set("project:gone", true), FoldError);
  assert.throws(() => store.set("pinned", "yes" as unknown as boolean), FoldError);
  assert.equal(store.set("archive:open", true), true);
});

test("importOnce takes an older client's list while the server holds none, then never again", () => {
  const live = new Set(["project:p1"]);
  const store = new FoldedGroupStore(":memory:", (k) => !k.startsWith("project:") || live.has(k));
  assert.equal(store.importOnce(["pinned", "project:p1", "project:gone", "bad key", "pinned"]), true);
  assert.deepEqual(store.keys(), ["pinned", "project:p1"]);
  assert.equal(store.importOnce(["unassigned"]), false);
  assert.deepEqual(store.keys(), ["pinned", "project:p1"]);
});

test("a fold set by the user closes the import, even when the list is empty again", () => {
  const store = new FoldedGroupStore(":memory:");
  store.set("pinned", true);
  store.set("pinned", false);
  assert.equal(store.importOnce(["unassigned"]), false);
  assert.deepEqual(store.keys(), []);
});

test("an import of nothing still closes the import", () => {
  const store = new FoldedGroupStore(":memory:");
  assert.equal(store.importOnce([]), true);
  assert.equal(store.importOnce(["pinned"]), false);
});

test("prune drops the keys of deleted projects and announces it", () => {
  const live = new Set(["project:p1", "project:p2"]);
  const store = new FoldedGroupStore(":memory:", (k) => !k.startsWith("project:") || live.has(k));
  store.set("project:p1", true);
  store.set("project:p2", true);
  store.set("pinned", true);
  const seen: string[][] = [];
  store.onChange((k) => seen.push(k));
  live.delete("project:p1");
  assert.equal(store.prune(), 1);
  assert.deepEqual(store.keys(), ["pinned", "project:p2"]);
  assert.deepEqual(seen, [["pinned", "project:p2"]]);
  assert.equal(store.prune(), 0);
});

test("folds and the import mark survive reopening the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maru-folds-"));
  try {
    const file = path.join(dir, "state.sqlite");
    const a = new FoldedGroupStore(file);
    a.set("unassigned", true);
    a.close();
    const b = new FoldedGroupStore(file);
    assert.deepEqual(b.keys(), ["unassigned"]);
    assert.equal(b.importOnce(["pinned"]), false);
    b.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
