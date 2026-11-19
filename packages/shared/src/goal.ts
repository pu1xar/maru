// A thread's goal as its TUI shows it. A Codex goal: codex-cli 0.169.0, tag rust-v0.169.0:
// codex-rs/tui/src/goal_display.rs, chatwidget/goal_status.rs, bottom_pane/footer.rs. A Claude goal
// (ThreadGoalState.claude): Claude Code 2.1.326, "/goal active (5m)" in the prompt footer. The
// status indicator is the TUI's own text; the chat text is what the chat view says for the same state.
import type { ThreadGoalState, ThreadGoalStatus } from "./turnItems.ts";

/** TUI `format_goal_elapsed_seconds`: "45s", "2m", "1h 30m", "2d 23h 42m". */
export function formatGoalElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h ${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** TUI `format_tokens_compact`: "0", "999", "1.73K", "12.5K", "125K", "1.2M". */
export function formatTokensCompact(value: number): string {
  const v = Math.max(0, Math.floor(value));
  if (v === 0) return "0";
  if (v < 1000) return String(v);
  const [scaled, suffix] =
    v >= 999_500_000_000 ? [v / 1e12, "T"]
    : v >= 999_500_000 ? [v / 1e9, "B"]
    : v >= 999_500 ? [v / 1e6, "M"]
    : [v / 1e3, "K"];
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  let out = (scaled as number).toFixed(decimals);
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  return `${out}${suffix}`;
}

/** The goal with the running turn's time added: the TUI adds the time since it last heard of the goal while a turn runs. */
export function goalWithElapsed(goal: ThreadGoalState, extraSeconds: number): ThreadGoalState {
  if (goal.status !== "active" || extraSeconds <= 0) return goal;
  return { ...goal, timeUsedSeconds: goal.timeUsedSeconds + Math.floor(extraSeconds) };
}

/**
 * A Claude goal with its clock read at `nowMs`: the Claude CLI counts the time since the goal was
 * set whether or not a turn runs, so its elapsed time is the clock's, not the server's snapshot.
 * Any other goal is returned as it is.
 */
export function goalAtTime(goal: ThreadGoalState, nowMs: number): ThreadGoalState {
  const setAt = goal.claude?.setAt ?? null;
  if (goal.claude === undefined || setAt === null) return goal;
  return { ...goal, timeUsedSeconds: Math.max(0, Math.floor((nowMs - setAt) / 1000)) };
}

/** The Claude CLI's elapsed time: nothing under a second, then the largest unit ("5s", "3m", "1h"). */
function claudeElapsed(goal: ThreadGoalState): string | null {
  if (goal.claude === undefined || goal.claude.setAt === null || goal.timeUsedSeconds < 1) return null;
  const s = goal.timeUsedSeconds;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** The TUI's status indicator text for a goal ("Pursuing goal (2m)", "Goal achieved (8s)", "/goal active (5m)", ...). */
export function goalIndicatorText(goal: ThreadGoalState): string {
  if (goal.claude !== undefined) {
    const t = claudeElapsed(goal);
    return t === null ? "/goal active" : `/goal active (${t})`;
  }
  switch (goal.status) {
    case "active":
      return `Pursuing goal (${goal.tokenBudget !== null ? `${formatTokensCompact(goal.tokensUsed)} / ${formatTokensCompact(goal.tokenBudget)}` : formatGoalElapsed(goal.timeUsedSeconds)})`;
    case "paused":
      return "Goal paused (/goal resume)";
    case "blocked":
      return "Goal stalled (/goal resume)";
    case "usageLimited":
      return "Goal hit usage limits (/goal resume)";
    case "budgetLimited":
      return goal.tokenBudget !== null ? `Goal unmet (${formatTokensCompact(goal.tokensUsed)} / ${formatTokensCompact(goal.tokenBudget)} tokens)` : "Goal abandoned";
    case "complete":
      return `Goal achieved (${goal.tokenBudget !== null ? `${formatTokensCompact(goal.tokensUsed)} tokens` : formatGoalElapsed(goal.timeUsedSeconds)})`;
  }
}

/** The chat view's indicator text for the same states (same parenthesis as the TUI's; a Claude goal adds its check count). */
export function goalIndicatorTextChat(goal: ThreadGoalState): string {
  if (goal.claude !== undefined) {
    const parts = [claudeElapsed(goal), goal.claude.checks > 0 ? `${goal.claude.checks} ${goal.claude.checks === 1 ? "check" : "checks"}` : null].filter((x) => x !== null);
    return parts.length === 0 ? "Goal active" : `Goal active (${parts.join(", ")})`;
  }
  const budgeted = goal.tokenBudget !== null;
  const tokens = `${formatTokensCompact(goal.tokensUsed)} / ${formatTokensCompact(goal.tokenBudget ?? 0)}`;
  switch (goal.status) {
    case "active":
      return `Goal active (${budgeted ? tokens : formatGoalElapsed(goal.timeUsedSeconds)})`;
    case "paused":
      return "Goal paused (/goal resume)";
    case "blocked":
      return "Goal blocked (/goal resume)";
    case "usageLimited":
      return "Goal hit the usage limit (/goal resume)";
    case "budgetLimited":
      return budgeted ? `Goal not met (tokens ${tokens})` : "Goal stopped";
    case "complete":
      return `Goal met (${budgeted ? `tokens ${formatTokensCompact(goal.tokensUsed)}` : formatGoalElapsed(goal.timeUsedSeconds)})`;
  }
}

/** Name of a status as the goal notices say it ("Goal met: <objective>" is the Claude goal row's form too). */
export const GOAL_STATUS_LABEL: Record<ThreadGoalStatus, string> = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  usageLimited: "hit the usage limit",
  budgetLimited: "token budget used up",
  complete: "met",
};

/**
 * The hover text of a goal line: the objective and, for a Claude goal, what the Stop hook's
 * evaluator last said and how to end the goal (/goal clear). A Codex goal's is its objective.
 */
export function goalDetailText(goal: ThreadGoalState): string {
  if (goal.claude === undefined) return goal.objective;
  const check = goal.claude.lastReason === null ? "Not checked yet" : `Last check: ${goal.claude.lastReason.trim()}`;
  return `${goal.objective}\n\n${check}\n\nEnd it with /goal clear`;
}
