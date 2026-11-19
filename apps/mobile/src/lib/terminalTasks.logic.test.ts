import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrchestrationV2Subagent } from "@maru/shared";
import { taskRows } from "../../../web/src/components/terminal/terminalTasks.ts";
import { agentViewOf, agentViewsOf } from "./terminalTasks.logic.ts";

function sub(over: Partial<OrchestrationV2Subagent>): OrchestrationV2Subagent {
  return {
    id: "claude:a:s:tool:toolu_1",
    threadId: "claude:a:s",
    runId: null,
    parentNodeId: "n",
    origin: "provider_native",
    createdBy: { kind: "provider" } as never,
    driver: "claude",
    providerInstanceId: "claude",
    providerThreadId: null,
    childThreadId: "claude:a:s:agent-1",
    nativeTaskRef: null,
    prompt: "do it",
    title: "Count files",
    model: "haiku",
    status: "running",
    result: null,
    startedAt: "2026-11-18T01:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-11-18T01:00:05.000Z",
    ...over,
  };
}

test("a subagent record becomes the panel's row, a workflow record a workflow row", () => {
  const agent = agentViewOf(sub({ agentType: "Explore", modelResolved: "claude-haiku-4-5" }));
  assert.equal(agent.kind, "agent");
  assert.equal(agent.agentType, "Explore");
  assert.equal(agent.model, "claude-haiku-4-5");
  assert.equal(agent.childThreadId, "claude:a:s:agent-1");
  const workflow = agentViewOf(sub({ workflow: { name: "audit", phases: [], agents: [] } as never }));
  assert.equal(workflow.kind, "workflow");
});

test("the web's taskRows rules read the rows: main first, then the running agent with its time", () => {
  const now = Date.parse("2026-11-18T01:00:12.000Z");
  const rows = taskRows(agentViewsOf([sub({})]), now, "claude:a:s", "claude:a:s");
  assert.deepEqual(
    rows.map((r) => [r.kind, r.glyph, r.name, r.right]),
    [
      ["main", "⏺", "main", ""],
      ["agent", "◯", "agent", "12s"],
    ],
  );
  assert.equal(rows[1]?.threadId, "claude:a:s:agent-1");
  assert.equal(rows[1]?.detail, "Count files");
});

test("an agent that ended long ago leaves, and with none left there is no panel", () => {
  const ended = sub({ status: "completed", completedAt: "2026-11-18T01:00:08.000Z" });
  assert.equal(taskRows(agentViewsOf([ended]), Date.parse("2026-11-18T01:00:20.000Z"), "k", "k").length, 2);
  assert.equal(taskRows(agentViewsOf([ended]), Date.parse("2026-11-18T01:05:00.000Z"), "k", "k").length, 0);
});
