import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadGoalState, ThreadSnapshot } from "@maru/shared";
import { composerStatus, contextLabel, goalOf, goalText } from "./composerStatus.ts";

function snapshot(state: Record<string, unknown>, tokenUsage: Record<string, unknown> | null = null): ThreadSnapshot {
  return { state: { ownership: "headless", control: "headless", nameSource: "id", ...state }, tokenUsage } as unknown as ThreadSnapshot;
}

test("the line names the model and effort the thread runs on", () => {
  const s = composerStatus(snapshot({ model: "claude-opus-5-5", effort: "high" }));
  assert.equal(s.model, "Opus 5.5");
  assert.equal(s.effort, "high");
  assert.equal(s.context, null);
  // A choice made here wins over the latest response's.
  const chosen = composerStatus(snapshot({ model: "claude-opus-5-5", effort: "high", chosen: { model: "claude-sonnet-4-8", effort: "low" } }));
  assert.equal(chosen.model, "Sonnet 4.8");
  assert.equal(chosen.effort, "low");
  assert.deepEqual(composerStatus(null), { model: null, effort: null, context: null });
});

test("the context use shows its window and share", () => {
  assert.equal(contextLabel(27_000, 200_000), "27K / 200K (14%)");
  assert.equal(contextLabel(27_000, undefined), "27K");
  const s = composerStatus(snapshot({ model: "claude-haiku-4-5" }, { usedTokens: 32_000, maxTokens: 200_000 }));
  assert.equal(s.context, "32K / 200K (16%)");
});

test("a goal shows for either provider, and a Codex goal's running turn counts on", () => {
  const goal: ThreadGoalState = { objective: "ship it", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 60 };
  const snap = snapshot({ goal });
  assert.equal(goalOf(snap), goal);
  assert.equal(goalOf(snapshot({})), null);
  assert.equal(goalOf(null), null);
  assert.equal(goalText(goal, false, 120, 0), "Goal active (1m)");
  assert.equal(goalText(goal, true, 120, 0), "Goal active (3m)");
  assert.equal(goalText({ ...goal, status: "paused" }, true, 120, 0), "Goal paused (/goal resume)");
});

test("a Claude goal counts the clock since it was set, and its checks", () => {
  const setAt = 1_000_000;
  const goal: ThreadGoalState = {
    objective: "tests pass", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0,
    claude: { checks: 2, setAt, lastReason: "one test fails" },
  };
  assert.equal(goalText(goal, true, 999, setAt + 5 * 60_000), "Goal active (5m, 2 checks)");
  assert.equal(goalText(goal, false, 0, setAt + 30_000), "Goal active (30s, 2 checks)");
});
