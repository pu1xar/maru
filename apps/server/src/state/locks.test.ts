import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChosenStore } from "./chosen.ts";
import { LockStore } from "./locks.ts";

test("locks persist by provider and id, announce changes, and survive ChosenStore on the same file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maru-locks-"));
  const file = path.join(dir, "state.sqlite");
  const a = new LockStore(file);
  const seen: string[][] = [];
  a.onChange((k) => seen.push(k));
  a.set("claude", "s1", true);
  a.set("claude", "s1", true); // no-op
  a.set("codex", "t1", true);
  a.set("codex", "t1", false);
  assert.deepEqual(seen, [["claude:s1"], ["codex:t1"], ["codex:t1"]]);
  assert.throws(() => a.set("gemini" as never, "x", true), /bad provider/);
  a.close();
  // ChosenStore migrates a table named session_locks; the lock table must not be that one.
  new ChosenStore(file).close();
  const b = new LockStore(file);
  assert.equal(b.has("claude", "s1"), true);
  assert.equal(b.has("codex", "t1"), false);
  assert.equal(b.count(), 1);
  b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
