import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary } from "@maru/shared";
import { rowFacts, sessionMark } from "./sessionMark.ts";

const s = (o: Partial<SessionSummary>) => ({ status: "open-idle", owner: "maru", pinPosition: null, ...o }) as SessionSummary;

test("only work and attention get a mark; an idle open session and a closed one get none", () => {
  assert.equal(sessionMark(s({ status: "open-idle" })), null);
  assert.equal(sessionMark(s({ status: "closed" })), null);
  assert.deepEqual(sessionMark(s({ status: "running" })), { shape: "solid", role: "info" });
  assert.deepEqual(sessionMark(s({ status: "waiting-input" })), { shape: "question", role: "attention" });
  assert.deepEqual(sessionMark(s({ status: "error" })), { shape: "alert", role: "danger" });
});

test("an idle turn with subagents or workflows running gets the dashed info mark; a left-running shell does not", () => {
  assert.deepEqual(sessionMark(s({ status: "open-idle", backgroundTasks: 2, backgroundAgents: 1 })), { shape: "dashed", role: "info" });
  assert.equal(sessionMark(s({ status: "open-idle", backgroundTasks: 1, backgroundAgents: 0 })), null);
});

test("closed rows recede, a terminal's hold shows while open, the pin shows in Groups only", () => {
  assert.equal(rowFacts(s({ status: "closed" }), { kind: "project" }).recede, true);
  assert.equal(rowFacts(s({ status: "running" }), { kind: "project" }).recede, false);
  assert.equal(rowFacts(s({ owner: "terminal" }), { kind: "project" }).terminalHeld, true);
  assert.equal(rowFacts(s({ owner: "terminal", status: "closed" }), { kind: "project" }).terminalHeld, false);
  assert.equal(rowFacts(s({ pinPosition: 0 }), { kind: "project" }).pinned, true);
  assert.equal(rowFacts(s({ pinPosition: 0 }), { kind: "unassigned" }).pinned, true);
  assert.equal(rowFacts(s({ pinPosition: 0 }), { kind: "pinned" }).pinned, false);
  assert.equal(rowFacts(s({ pinPosition: 0 }), { kind: "archive" }).pinned, false);
  assert.equal(rowFacts(s({ pinPosition: null }), { kind: "project" }).pinned, false);
});
