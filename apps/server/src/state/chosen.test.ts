import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ChosenStore } from "./chosen.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maru-chosen-"));
}

test("set and persist choices by provider and id", () => {
  const dir = tmp();
  const file = path.join(dir, "state.sqlite");
  const a = new ChosenStore(file);
  const seen: string[][] = [];
  a.onChange((k) => seen.push(k));
  a.set("claude", "s1", true);
  a.set("claude", "s1", true);   // no-op
  a.set("codex", "t1", true);
  a.set("codex", "t1", false);
  assert.deepEqual(seen, [["claude:s1"], ["codex:t1"], ["codex:t1"]]);
  a.close();
  const b = new ChosenStore(file);
  assert.equal(b.has("claude", "s1"), true);
  assert.equal(b.has("codex", "t1"), false);
  b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the dashboard import bookkeeping table is dropped and the chosen rows stay", () => {
  const dir = tmp();
  const file = path.join(dir, "state.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE chosen_sessions (session_key TEXT PRIMARY KEY, chosen_at INTEGER NOT NULL);
    CREATE TABLE dashboard_lock_imports (session_key TEXT PRIMARY KEY, imported_at INTEGER NOT NULL);`);
  db.prepare("INSERT INTO chosen_sessions VALUES (?, ?)").run("claude:s1", 1);
  db.prepare("INSERT INTO dashboard_lock_imports VALUES (?, ?)").run("claude:s1", 1);
  db.close();
  const st = new ChosenStore(file);
  assert.equal(st.has("claude", "s1"), true);
  st.close();
  const check = new DatabaseSync(file, { readOnly: true });
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  check.close();
  assert.deepEqual(tables, ["chosen_sessions"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rows from the first build's session_locks table carry over", () => {
  const dir = tmp();
  const file = path.join(dir, "state.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE session_locks (session_key TEXT PRIMARY KEY, locked_at INTEGER NOT NULL)");
  db.prepare("INSERT INTO session_locks VALUES (?, ?)").run("codex:t9", 1);
  db.close();
  const st = new ChosenStore(file);
  assert.equal(st.has("codex", "t9"), true);
  assert.equal(st.count(), 1);
  st.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
