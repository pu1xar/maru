import assert from "node:assert/strict";
import { test } from "node:test";

import { moveThreadStack, movedFamilyKeys, movedFamilyThreadId, readThreadStack, rememberThreadStack } from "./threadStack.ts";

test("a session's stack outlives its view; an empty stack is the session's own thread", () => {
  assert.deepEqual(readThreadStack("claude:a:s1"), []);
  const stack = [{ threadId: "claude:a:s1:agent-x", title: "explore" }];
  rememberThreadStack("claude:a:s1", stack);
  assert.equal(readThreadStack("claude:a:s1"), stack);
  rememberThreadStack("claude:a:s1", []);
  assert.deepEqual(readThreadStack("claude:a:s1"), []);
});

test("a family thread is the same thread under the new account", () => {
  assert.equal(movedFamilyThreadId("claude:a:s1:agent-x", "claude:a:s1", "claude:b:s1"), "claude:b:s1:agent-x");
  assert.equal(movedFamilyThreadId("codex:a:t9", "codex:a:t1", "codex:b:t1"), "codex:b:t9");
  assert.equal(movedFamilyThreadId("codex:c:t9", "codex:a:t1", "codex:b:t1"), null);
});

test("a move renames the stack's threads to the new account: Claude subagents and Codex child threads", () => {
  rememberThreadStack("claude:a:s2", [
    { threadId: "claude:a:s2:agent-x", title: "x" },
    { threadId: "claude:a:s2:agent-y", title: null },
  ]);
  moveThreadStack("claude:a:s2", "claude:b:s2");
  assert.deepEqual(readThreadStack("claude:a:s2"), []);
  assert.deepEqual(readThreadStack("claude:b:s2"), [
    { threadId: "claude:b:s2:agent-x", title: "x" },
    { threadId: "claude:b:s2:agent-y", title: null },
  ]);
  // A Codex child thread is a key of its own that carries the account; the server moves it with
  // its parent.
  rememberThreadStack("codex:a:t1", [{ threadId: "codex:a:t9", title: "child" }]);
  moveThreadStack("codex:a:t1", "codex:b:t1");
  assert.deepEqual(readThreadStack("codex:b:t1"), [{ threadId: "codex:b:t9", title: "child" }]);
});

test("a move keeps a stack the new key already has, and a second call changes nothing", () => {
  rememberThreadStack("claude:a:s3", [{ threadId: "claude:a:s3:agent-old", title: null }]);
  rememberThreadStack("claude:b:s3", [{ threadId: "claude:b:s3:agent-new", title: null }]);
  moveThreadStack("claude:a:s3", "claude:b:s3");
  assert.deepEqual(readThreadStack("claude:b:s3"), [{ threadId: "claude:b:s3:agent-new", title: null }]);
  moveThreadStack("claude:a:s3", "claude:b:s3");
  assert.deepEqual(readThreadStack("claude:b:s3"), [{ threadId: "claude:b:s3:agent-new", title: null }]);
});

test("the family keys a move also carries: Codex child threads from the answer and the stack", () => {
  const stack = [{ threadId: "codex:a:t9", title: null }];
  assert.deepEqual(movedFamilyKeys("codex:a:t1", "codex:b:t1", ["t1", "t8"], stack), [
    ["codex:a:t8", "codex:b:t8"],
    ["codex:a:t9", "codex:b:t9"],
  ]);
  // A Claude move answers with the session id, and its subagent threads live under the session key.
  assert.deepEqual(movedFamilyKeys("claude:a:s1", "claude:b:s1", ["s1"], [{ threadId: "claude:a:s1:agent-x", title: null }]), []);
});
