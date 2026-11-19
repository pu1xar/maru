import assert from "node:assert/strict";
import { test } from "node:test";
import { formatGoalElapsed, formatTokensCompact, goalAtTime, goalDetailText, goalIndicatorText, goalIndicatorTextChat, goalWithElapsed } from "./goal.ts";
import type { ThreadGoalState } from "./turnItems.ts";

const goal = (over: Partial<ThreadGoalState>): ThreadGoalState => ({ objective: "x", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, ...over });

// The expected values are the ones in the TUI's own tests (goal_display.rs, goal_status.rs).
test("elapsed time is the TUI's compact form", () => {
  assert.deepEqual([0, 59, 60, 30 * 60, 90 * 60, 2 * 3600, 24 * 3600 - 1, 24 * 3600, 2 * 86400 + 23 * 3600 + 42 * 60, 36720].map(formatGoalElapsed),
    ["0s", "59s", "1m", "30m", "1h 30m", "2h", "23h 59m", "1d 0h 0m", "2d 23h 42m", "10h 12m"]);
});

test("token counts are the TUI's compact form", () => {
  assert.deepEqual([0, 7, 999, 1000, 1734, 12_500, 50_000, 63_876, 125_000, 999_499, 999_500, 1_200_000].map(formatTokensCompact),
    ["0", "7", "999", "1K", "1.73K", "12.5K", "50K", "63.9K", "125K", "999K", "1M", "1.2M"]);
});

test("the indicator reads as the TUI's footer does for every status", () => {
  assert.equal(goalIndicatorText(goal({ timeUsedSeconds: 120 })), "Pursuing goal (2m)");
  assert.equal(goalIndicatorText(goal({ tokenBudget: 50_000, tokensUsed: 12_500 })), "Pursuing goal (12.5K / 50K)");
  assert.equal(goalIndicatorText(goal({ status: "paused" })), "Goal paused (/goal resume)");
  assert.equal(goalIndicatorText(goal({ status: "blocked" })), "Goal stalled (/goal resume)");
  assert.equal(goalIndicatorText(goal({ status: "usageLimited" })), "Goal hit usage limits (/goal resume)");
  assert.equal(goalIndicatorText(goal({ status: "budgetLimited", tokenBudget: 50_000, tokensUsed: 63_876 })), "Goal unmet (63.9K / 50K tokens)");
  assert.equal(goalIndicatorText(goal({ status: "budgetLimited" })), "Goal abandoned");
  assert.equal(goalIndicatorText(goal({ status: "complete", timeUsedSeconds: 8 })), "Goal achieved (8s)");
  assert.equal(goalIndicatorText(goal({ status: "complete", tokenBudget: 50_000, tokensUsed: 40_000 })), "Goal achieved (40K tokens)");
  assert.equal(goalIndicatorTextChat(goal({ timeUsedSeconds: 75 })), "Goal active (1m)");
  assert.equal(goalIndicatorTextChat(goal({ status: "complete", timeUsedSeconds: 8 })), "Goal met (8s)");
  assert.equal(goalIndicatorTextChat(goal({ status: "paused" })), "Goal paused (/goal resume)");
});

const claudeGoal = (checks: number, setAt: number | null, lastReason: string | null = null): ThreadGoalState =>
  goal({ claude: { checks, setAt, lastReason } });

test("a Claude goal reads its clock from when it was set, in the CLI's words and the chat's", () => {
  const set = 10_000_000;
  const at = (sec: number) => goalAtTime(claudeGoal(2, set), set + sec * 1000);
  // terminal mode: "/goal active (5m)", nothing under a second, the largest unit
  assert.deepEqual([0, 0.9, 5, 59, 60, 330, 3599, 3600, 7300, 86_400, 200_000].map((s) => goalIndicatorText(at(s))), [
    "/goal active", "/goal active", "/goal active (5s)", "/goal active (59s)", "/goal active (1m)", "/goal active (5m)",
    "/goal active (59m)", "/goal active (1h)", "/goal active (2h)", "/goal active (1d)", "/goal active (2d)",
  ]);
  // chat view: the clock and the check count
  assert.equal(goalIndicatorTextChat(at(330)), "Goal active (5m, 2 checks)");
  assert.equal(goalIndicatorTextChat(goalAtTime(claudeGoal(1, set), set + 30_000)), "Goal active (30s, 1 check)");
  assert.equal(goalIndicatorTextChat(goalAtTime(claudeGoal(0, set), set + 30_000)), "Goal active (30s)");
  assert.equal(goalIndicatorTextChat(goalAtTime(claudeGoal(3, null), set + 30_000)), "Goal active (3 checks)");
  assert.equal(goalIndicatorTextChat(goalAtTime(claudeGoal(0, null), set)), "Goal active");
  // a clock before the set time (skew between server and viewer) reads as zero
  assert.equal(goalAtTime(claudeGoal(0, set), set - 5000).timeUsedSeconds, 0);
  // a Codex goal is returned as it is
  const codex = goal({ timeUsedSeconds: 60 });
  assert.equal(goalAtTime(codex, 123), codex);
});

test("a goal's hover text: the objective, and for Claude the last check and how to end it", () => {
  assert.equal(goalDetailText(goal({ objective: "ship it" })), "ship it");
  assert.equal(
    goalDetailText({ ...claudeGoal(1, 0, " Two tests fail.\nThe build is red. "), objective: "tests pass" }),
    "tests pass\n\nLast check: Two tests fail.\nThe build is red.\n\nEnd it with /goal clear",
  );
  assert.equal(goalDetailText({ ...claudeGoal(0, 0), objective: "tests pass" }), "tests pass\n\nNot checked yet\n\nEnd it with /goal clear");
});

test("a running turn's time is added to an active goal only", () => {
  assert.equal(goalIndicatorText(goalWithElapsed(goal({ timeUsedSeconds: 60 }), 60.9)), "Pursuing goal (2m)");
  assert.equal(goalWithElapsed(goal({ status: "paused", timeUsedSeconds: 60 }), 60).timeUsedSeconds, 60);
  assert.equal(goalWithElapsed(goal({ timeUsedSeconds: 60 }), -5).timeUsedSeconds, 60);
});
