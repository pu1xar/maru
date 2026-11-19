import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionAgentView } from "@maru/shared";
import { actionTooltip, agentMenuItems, agentRowActive, agentRowKey, agentStatusLabel, workflowAgentState } from "./agentActions.ts";

function row(over: Partial<SessionAgentView>): SessionAgentView {
  return {
    id: "a1", kind: "agent", title: "t", status: "running", agentType: null, model: null, parentAgentId: null,
    childThreadId: null, startedAt: null, updatedAt: null, completedAt: null, ...over,
  };
}

test("the menu lists the row's actions, then opening its conversation; nothing when it offers none", () => {
  const off = { enabled: false, reason: "터미널에서 실행 중인 세션이라 여기서 멈출 수 없음" };
  assert.deepEqual(agentMenuItems(row({ stop: { enabled: true, reason: null }, childThreadId: "k:agent-a1" })), ["stop", "open"]);
  assert.deepEqual(agentMenuItems(row({ kind: "workflow", status: "cancelled", resume: { enabled: true, reason: null } })), ["resume"]);
  assert.deepEqual(agentMenuItems(row({ stop: off })), ["stop"], "a disabled action still shows, with its reason");
  assert.deepEqual(agentMenuItems(row({ status: "completed" })), []);
});

test("a disabled action's tooltip is its reason; an enabled one's is its name", () => {
  assert.equal(actionTooltip("중단", { enabled: true, reason: null }), "중단");
  assert.equal(actionTooltip("중단", { enabled: false, reason: "Claude session host가 꺼져 있음" }), "Claude session host가 꺼져 있음");
  assert.equal(actionTooltip("이어서 실행", { enabled: false, reason: null }), "이어서 실행");
});

test("a stopped subagent is Cancelled whoever stopped it; an action on its way names itself", () => {
  assert.equal(agentStatusLabel(row({ status: "cancelled" })), "Cancelled");
  assert.equal(agentStatusLabel(row({ status: "interrupted" })), "Interrupted");
  assert.equal(agentStatusLabel(row({ status: "running", settling: "stopping" })), "Stopping");
  assert.equal(agentStatusLabel(row({ kind: "workflow", status: "cancelled", settling: "resuming" })), "Resuming");
  assert.equal(agentRowActive(row({ status: "cancelled", settling: "resuming" })), true);
  assert.equal(agentRowActive(row({ status: "cancelled" })), false);
});

test("a workflow agent its records leave running takes the state of the workflow that no longer runs", () => {
  assert.deepEqual(workflowAgentState({ state: "running" }, "cancelled"), { status: "cancelled", label: "Cancelled" });
  assert.deepEqual(workflowAgentState({ state: "queued" }, "failed"), { status: "failed", label: "Failed" });
  assert.deepEqual(workflowAgentState({ state: "completed" }, "cancelled"), { status: "completed", label: "Completed" });
  assert.deepEqual(workflowAgentState({ state: "running" }, null), { status: "running", label: "Running" });
});

test("an agent and a workflow with the same id are different rows", () => {
  assert.notEqual(agentRowKey({ kind: "agent", id: "x" }), agentRowKey({ kind: "workflow", id: "x" }));
});
