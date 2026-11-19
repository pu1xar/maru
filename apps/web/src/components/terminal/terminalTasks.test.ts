// Expected values come from tmux captures of Claude Code 2.1.325 with background agents and a
// workflow running (DESIGN.md 6i, ↓ 작업 목록).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAgentView } from "@maru/shared";

import { ENDED_ROW_MS, panelElapsed, panelWindow, selectionHint, taskRows, workflowBar } from "./terminalTasks.ts";

const KEY = "claude:a:s";
const NOW = Date.parse("2026-11-16T11:30:00.000Z");
const agent = (id: string, over: Partial<SessionAgentView> = {}): SessionAgentView => ({
  id,
  kind: "agent",
  title: "Slow counter",
  status: "running",
  agentType: "general-purpose",
  model: "haiku",
  parentAgentId: null,
  childThreadId: `${KEY}:agent-${id}`,
  startedAt: new Date(NOW - 11_000).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  completedAt: null,
  stop: { enabled: true, reason: null },
  ...over,
});

test("the panel lists main, then running agents with their time (capture 04)", () => {
  const rows = taskRows([agent("a1")], NOW, KEY, KEY);
  assert.deepEqual(rows.map((r) => [r.glyph, r.name, r.detail, r.right]), [
    ["⏺", "main", "", ""],
    ["◯", "general-purpose", "Slow counter", "11s"],
  ]);
  assert.deepEqual(taskRows([], NOW, KEY, KEY), []);
});

test("the agent on screen gets the filled bullet; an ended agent stays a while in its end color", () => {
  const viewing = taskRows([agent("a1")], NOW, KEY, `${KEY}:agent-a1`);
  assert.deepEqual(viewing.map((r) => r.glyph), ["◯", "⏺"]);
  const stopped = agent("a2", { status: "cancelled", completedAt: new Date(NOW - 5_000).toISOString() });
  const done = agent("a3", { status: "completed", completedAt: new Date(NOW - 5_000).toISOString() });
  const old = agent("a4", { status: "completed", completedAt: new Date(NOW - ENDED_ROW_MS - 1).toISOString() });
  assert.deepEqual(taskRows([stopped, done, old], NOW, KEY, KEY).map((r) => r.tone), ["viewing", "stopped", "done"]);
});

test("a workflow row has its 20-cell bar and counts (capture 44)", () => {
  const wf: SessionAgentView = {
    ...agent("wf_1", { kind: "workflow", title: "Tiny sleep workflow", startedAt: new Date(NOW - 81_000).toISOString() }),
    workflow: { name: "Tiny sleep workflow", phases: [], agents: [{ index: 0, label: "a", state: "completed" }, { index: 1, label: "b", state: "running" }], totalTokens: 85_500 },
  };
  const row = taskRows([wf], NOW, KEY, KEY)[1]!;
  assert.equal(row.right, "1/2  1m21s  ↓ 85.5k tokens");
  assert.deepEqual(workflowBar(1, 2), { filled: "▰".repeat(10), empty: "▱".repeat(10) });
});

test("time and windows as the panel counts them", () => {
  assert.equal(panelElapsed(11_400), "11s");
  assert.equal(panelElapsed(81_000), "1m21s");
  assert.equal(panelElapsed(3_725_000), "1h02m");
  assert.deepEqual(panelWindow(3, null), { start: 0, end: 3 });
  assert.deepEqual(panelWindow(8, 0), { start: 0, end: 5 });
  assert.deepEqual(panelWindow(8, 8), { start: 3, end: 8 });
});

test("the footer says what Enter and x do on the selected row (captures 05, 06)", () => {
  const rows = taskRows([agent("a1")], NOW, KEY, KEY);
  assert.equal(selectionHint(rows[0]!, KEY), "↑/↓ to select");
  assert.equal(selectionHint(rows[1]!, KEY), "Enter to view  x to stop");
  assert.equal(selectionHint(rows[0]!, `${KEY}:agent-a1`), "↑/↓ to select  Enter to view");
});

test("background shell commands and Monitors of the 작업 tab are not rows of the CLI's agent panel", () => {
  const rows = taskRows([agent("a1"), agent("sh1", { kind: "shell", childThreadId: null }), agent("mon1", { kind: "monitor", childThreadId: null })], NOW, KEY, KEY);
  assert.deepEqual(rows.map((r) => r.key), ["main", "agent:a1"]);
  assert.deepEqual(taskRows([agent("sh1", { kind: "shell", childThreadId: null })], NOW, KEY, KEY), [], "no panel for a shell command alone");
});
