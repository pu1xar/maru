import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CodexHeldStore } from "./codexHeld.ts";

test("held threads, their open turns and the goal flag survive a reopen; drop removes the row", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-held-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.sqlite");
  const a = new CodexHeldStore(file);
  a.hold("codex:cx:t1");
  a.addTurn("codex:cx:t1", "turn-1");
  a.addTurn("codex:cx:t1", "turn-2");
  a.addTurn("codex:cx:t1", "turn-2");
  a.endTurn("codex:cx:t1", "turn-1");
  a.setGoal("codex:cx:t1", true);
  a.hold("codex:cx:t2");
  a.drop("codex:cx:t2");
  a.addTurn("codex:cx:unknown", "x");
  a.close();

  const b = new CodexHeldStore(file);
  t.after(() => b.close());
  assert.deepEqual(b.list().map((h) => [h.key, h.turns, h.goalByUs]), [["codex:cx:t1", ["turn-2"], true]]);
  const db = new DatabaseSync(file);
  db.prepare("UPDATE codex_held SET turns = 'not json'").run();
  db.close();
  const c = new CodexHeldStore(file);
  t.after(() => c.close());
  assert.deepEqual(c.list().map((h) => [h.key, h.turns]), [["codex:cx:t1", []]], "an unreadable turn list keeps the hold without turns");
});
