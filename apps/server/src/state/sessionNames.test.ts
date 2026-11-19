import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionNameStore } from "./sessionNames.ts";

test("resolve: maru's name wins over the provider's, and the provider's shows when no row stands", () => {
  const s = new SessionNameStore(":memory:");
  assert.equal(s.resolve("claude", "a", "cli name"), "cli name");
  assert.equal(s.resolve("claude", "a", null), null);
  s.set("claude", "a", "  mine  ", ["cli name"]);
  assert.equal(s.resolve("claude", "a", "cli name"), "mine");
  assert.equal(s.resolve("claude", "a", null), "mine", "no provider name says nothing");
  assert.equal(s.resolve("claude", "a", "mine"), "mine", "the provider shows the name maru wrote");
  s.close();
});

test("resolve: a provider name that is new since the row wins and drops the row", () => {
  const s = new SessionNameStore(":memory:");
  s.set("codex", "t", "mine", ["old"]);
  assert.equal(s.resolve("codex", "t", "typed in the CLI"), "typed in the CLI");
  assert.equal(s.get("codex", "t"), null);
  assert.equal(s.resolve("codex", "t", "typed in the CLI"), "typed in the CLI");
  s.close();
});

test("set: the row changes the listeners' keys, replaces an older row, and rejects bad input", () => {
  const s = new SessionNameStore(":memory:");
  const seen: string[][] = [];
  s.onChange((k) => seen.push(k));
  s.set("claude", "a", "one", []);
  s.set("claude", "a", "two", ["one"]);
  assert.deepEqual(seen, [["claude:a"], ["claude:a"]]);
  assert.equal(s.get("claude", "a")?.name, "two");
  assert.throws(() => s.set("claude", "a", "   ", []));
  assert.throws(() => s.set("gemini" as never, "a", "x", []));
  s.close();
});

test("the key has no account, and forget removes rows", () => {
  const s = new SessionNameStore(":memory:");
  s.set("claude", "a", "n", []);
  s.set("codex", "b", "m", []);
  assert.deepEqual(s.keys().sort(), ["claude:a", "codex:b"]);
  assert.equal(s.forget(["claude:a", "claude:none"]), 1);
  assert.deepEqual(s.keys(), ["codex:b"]);
  s.close();
});

test("rows survive a reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "names-"));
  try {
    const file = path.join(dir, "state.sqlite");
    const a = new SessionNameStore(file);
    a.set("claude", "a", "kept", ["cli"]);
    a.close();
    const b = new SessionNameStore(file);
    assert.equal(b.resolve("claude", "a", "cli"), "kept");
    assert.equal(b.resolve("claude", "a", "other"), "other");
    b.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
