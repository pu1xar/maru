import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FreeStore } from "./freeStore.ts";

test("FREE marks persist in the state db and report changes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "free-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.sqlite");

  const a = new FreeStore(file);
  assert.equal(a.set("codex-x", true), true);
  assert.equal(a.set("codex-x", true), false, "already marked");
  assert.equal(a.set("claude-y", false), false, "not marked");
  a.set("claude-y", true);
  assert.deepEqual(a.list(), ["claude-y", "codex-x"]);
  a.close();

  const b = new FreeStore(file);
  assert.equal(b.has("codex-x"), true);
  assert.equal(b.set("codex-x", false), true);
  b.close();
  const c = new FreeStore(file);
  assert.deepEqual(c.list(), ["claude-y"]);
  c.close();
});

test("a mark written by another process counts at once", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "free-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.sqlite");
  const server = new FreeStore(file);
  const script = new FreeStore(file);
  script.set("codex-z", true);
  assert.equal(server.has("codex-z"), true);
  assert.equal(server.set("codex-z", false), true, "the server clears the row the script wrote");
  assert.equal(script.has("codex-z"), false);
  server.close();
  script.close();
});
