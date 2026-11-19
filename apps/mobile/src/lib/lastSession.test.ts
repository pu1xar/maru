import assert from "node:assert/strict";
import { test } from "node:test";

import { rememberableSession, restorableSession } from "./lastSession.logic.ts";

const listed = new Set(["claude:a:s1", "codex:b:s2"]);

test("a stored session that is still listed is reopened", () => {
  assert.equal(restorableSession("claude:a:s1", listed), "claude:a:s1");
});

test("nothing, a gone session or a subagent thread opens the list instead", () => {
  assert.equal(restorableSession(null, listed), null);
  assert.equal(restorableSession("", listed), null);
  assert.equal(restorableSession("claude:a:gone", listed), null);
  assert.equal(restorableSession("claude:a:s1:agent-x", new Set(["claude:a:s1:agent-x"])), null);
});

test("only a listed session of its own is remembered", () => {
  assert.equal(rememberableSession("codex:b:s2", listed), true);
  assert.equal(rememberableSession(null, listed), false);
  assert.equal(rememberableSession("claude:a:other", listed), false);
  assert.equal(rememberableSession("claude:a:s1:agent-x", new Set(["claude:a:s1:agent-x"])), false);
});
