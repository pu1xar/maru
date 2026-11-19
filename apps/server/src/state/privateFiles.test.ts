import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensurePrivateDir, protectPrivateFiles, protectStateFile } from "./privateFiles.ts";

const mode = (p: string) => fs.statSync(p).mode & 0o777;

function tmp(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maru-private-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a missing state folder and database are created as 0700 and 0600", (t) => {
  const root = tmp(t);
  const file = path.join(root, "cfg", "state.sqlite");
  protectStateFile(file, root);
  assert.equal(mode(path.dirname(file)), 0o700);
  assert.equal(mode(file), 0o600);
});

test("wider modes of an existing folder, database, sidecars and config file are narrowed", (t) => {
  const root = tmp(t);
  const dir = path.join(root, "cfg");
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  const state = path.join(dir, "state.sqlite");
  const config = path.join(dir, "config.json");
  const trash = path.join(dir, "trash");
  const attachments = path.join(dir, "attachments");
  for (const f of [state, `${state}-wal`, `${state}-shm`, config]) {
    fs.writeFileSync(f, "x");
    fs.chmodSync(f, 0o644);
  }
  fs.mkdirSync(trash, { mode: 0o755 });
  fs.chmodSync(trash, 0o755);
  protectPrivateFiles({ stateFile: state, configFile: config, folders: [trash, attachments], home: root });
  assert.equal(mode(dir), 0o700);
  for (const f of [state, `${state}-wal`, `${state}-shm`, config]) assert.equal(mode(f), 0o600, f);
  assert.equal(mode(trash), 0o700);
  assert.equal(mode(attachments), 0o700);
});

test("a stricter mode is kept and the home folder is never touched", (t) => {
  const root = tmp(t);
  fs.chmodSync(root, 0o755);
  const state = path.join(root, "state.sqlite");
  fs.writeFileSync(state, "x");
  fs.chmodSync(state, 0o400);
  protectStateFile(state, root);
  assert.equal(mode(state), 0o400);
  assert.equal(mode(root), 0o755, "the folder named as home is shared, not maru's");
  ensurePrivateDir(root, root);
  assert.equal(mode(root), 0o755);
});
