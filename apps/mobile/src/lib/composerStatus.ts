// The small line above the input: the session's model and effort, its context use, and the
// session's goal (the web's ComposerModelButton, ThreadComposer's goal line and the terminal
// footer's context figure). Read-only here; the model picker is not on the phone. Pure.
import type { ThreadGoalState, ThreadSnapshot } from "@maru/shared";
import { composerModelLabel, contextWindowOf, currentModel } from "../../../web/src/lib/modelLabel.ts";
import { currentEffort } from "../../../web/src/lib/sessionPicker.logic.ts";
import { formatTokensCompact, goalAtTime, goalIndicatorText, goalIndicatorTextChat, goalWithElapsed } from "../../../../packages/shared/src/goal.ts";

export interface ComposerStatus {
  /** "Opus 5.5"; null when the thread names no model yet. */
  model: string | null;
  effort: string | null;
  /** "27K / 200K (14%)", or the use alone when the window is unknown; null before any request. */
  context: string | null;
}

export function composerStatus(snapshot: ThreadSnapshot | null): ComposerStatus {
  const state = snapshot?.state ?? null;
  const usage = snapshot?.tokenUsage ?? null;
  return {
    model: composerModelLabel(currentModel(state)),
    effort: currentEffort(state),
    context: usage ? contextLabel(usage.usedTokens, contextWindowOf(state, usage)) : null,
  };
}

export function contextLabel(used: number, max: number | undefined): string {
  return max && max > 0 ? `${formatTokensCompact(used)} / ${formatTokensCompact(max)} (${Math.round((used / max) * 100)}%)` : formatTokensCompact(used);
}

/** The thread's goal (a Codex goal, or a Claude one: ThreadGoalState.claude), as on the web. */
export function goalOf(snapshot: ThreadSnapshot | null): ThreadGoalState | null {
  return snapshot?.state.goal ?? null;
}

/**
 * The goal's indicator text with the running turn's time added (the web's GoalStatusText): while a
 * Codex goal is active and a turn runs, the time since this app last heard of the goal counts on.
 * A Claude goal's time is the clock `nowMs` since it was set.
 */
export function goalText(goal: ThreadGoalState, ticking: boolean, extraSeconds: number, nowMs: number): string {
  if (goal.claude !== undefined) return goalIndicatorTextChat(goalAtTime(goal, nowMs));
  return goalIndicatorTextChat(ticking ? goalWithElapsed(goal, extraSeconds) : goal);
}

/** The same text in the TUIs' own words, for the terminal mode's footer ("Pursuing goal (1m)", "/goal active (5m)"; the web's GoalStatusText variant "tui"). */
export function goalTuiText(goal: ThreadGoalState, ticking: boolean, extraSeconds: number, nowMs: number): string {
  if (goal.claude !== undefined) return goalIndicatorText(goalAtTime(goal, nowMs));
  return goalIndicatorText(ticking ? goalWithElapsed(goal, extraSeconds) : goal);
}
