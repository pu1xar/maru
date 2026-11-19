import assert from "node:assert/strict";
import { test } from "node:test";

import { isBareSessionId, keyForSessionId, sessionUrlValue } from "./sessionUrl.ts";

test("the address carries the session id; an old full key is still told apart", () => {
  assert.equal(sessionUrlValue("claude:claude-personal:0561ca94-5113-4961-be22-60f4d2420c53"), "0561ca94-5113-4961-be22-60f4d2420c53");
  assert.equal(sessionUrlValue("codex:codex-personal:01a1e2ca-f860"), "01a1e2ca-f860");
  assert.equal(sessionUrlValue("plain"), "plain");
  assert.equal(isBareSessionId("0561ca94-5113-4961-be22-60f4d2420c53"), true);
  assert.equal(isBareSessionId("claude:claude-personal:0561ca94"), false);
});

test("a bare id finds the listed session's key", () => {
  const list = [{ key: "claude:a:1", id: "1" }, { key: "codex:b:2", id: "2" }];
  assert.equal(keyForSessionId("2", list), "codex:b:2");
  assert.equal(keyForSessionId("3", list), null);
});
