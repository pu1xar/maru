import assert from "node:assert/strict";
import { test } from "node:test";

import { agentDone, visibleAgents } from "./agentsFilter.ts";

const a = (id: string, status: string, parentAgentId: string | null = null, settling?: string) => ({ id, status, parentAgentId, settling });

test("completed, stopped and failed rows hide; running stays", () => {
  const list = [a("1", "completed"), a("2", "running"), a("3", "failed"), a("4", "cancelled"), a("6", "interrupted"), a("5", "completed", null, "stopping")];
  const { shown, hidden } = visibleAgents(list, true);
  assert.deepEqual(shown.map((x) => x.id), ["2", "5"]);
  assert.equal(hidden, 4);
  assert.equal(agentDone(a("5", "completed", null, "stopping")), false, "a row on its way is not done");
});

test("a finished parent stays while one of its subagents shows", () => {
  const list = [a("p", "completed"), a("c", "running", "p"), a("q", "completed"), a("d", "completed", "q")];
  assert.deepEqual(visibleAgents(list, true).shown.map((x) => x.id), ["p", "c"]);
});

test("off shows everything", () => {
  const list = [a("1", "completed"), a("2", "running")];
  assert.deepEqual(visibleAgents(list, false), { shown: list, hidden: 0 });
});
