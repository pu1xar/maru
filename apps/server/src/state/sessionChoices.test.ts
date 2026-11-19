import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionChoiceStore } from "./sessionChoices.ts";

test("a choice survives a reopen of the state file; a cleared field and an emptied row stay gone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-choices-"));
  const file = path.join(dir, "nested", "state.sqlite");
  try {
    let s = new SessionChoiceStore(file);
    s.merge("claude", "s1", { model: "sonnet", effort: "low" });
    s.merge("claude", "s1", { permissionMode: "plan" });
    s.merge("codex", "s1", { effort: null });
    s.merge("claude", "s2", { fast: true });
    s.clear("claude", "s1", ["effort"]);
    s.clear("claude", "s2", ["fast"]);
    s.close();

    s = new SessionChoiceStore(file);
    assert.deepEqual(s.get("claude", "s1"), { model: "sonnet", permissionMode: "plan" });
    assert.deepEqual(s.get("codex", "s1"), { effort: null }, "null is a choice, kept apart per provider");
    assert.equal(s.get("claude", "s2"), null, "a row with nothing left is deleted");
    s.clear("claude", "s1");
    s.close();

    s = new SessionChoiceStore(file);
    assert.equal(s.get("claude", "s1"), null);
    s.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
