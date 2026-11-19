// The goal indicator's text for a thread: "Pursuing goal (1m)" (Codex) and "/goal active (5m)"
// (Claude) in the terminal mode (the TUIs' own words), "Goal active (1m)" and "Goal active (5m, 2 checks)"
// in the chat view. While a Codex goal is active and a turn runs the time ticks, from the later of
// the moment this page heard of the goal and the moment the turn was seen running (the TUI's
// baseline, chatwidget/goal_status.rs); the daemon's own count moves only when a tool call or turn
// ends. A Claude goal's time is the clock since the goal was set, running or not.
import { useMemo } from "react";
import { goalAtTime, goalIndicatorText, goalIndicatorTextChat, goalWithElapsed, type ThreadGoalState } from "@maru/shared";

import { tickTextContent } from "~/lib/tickTextContent";

export function GoalStatusText({
  goal,
  running,
  variant,
  className,
}: {
  goal: ThreadGoalState;
  /** A turn of this thread is running. */
  running: boolean;
  variant: "tui" | "chat";
  className?: string | undefined;
}) {
  // A new goal object is a new observation of the daemon's count.
  const observedAt = useMemo(() => Date.now(), [goal]);
  const runningSince = useMemo(() => (running ? Date.now() : null), [running]);
  const claude = goal.claude !== undefined;
  const ticking = goal.status === "active" && (running || claude);
  const text = variant === "tui" ? goalIndicatorText : goalIndicatorTextChat;
  const baseline = Math.max(observedAt, runningSince ?? 0);
  return (
    <span
      data-goal-status={goal.status}
      className={className}
      ref={tickTextContent(
        (nowMs) => text(claude ? goalAtTime(goal, nowMs) : ticking ? goalWithElapsed(goal, (nowMs - baseline) / 1000) : goal),
        ticking,
      )}
    />
  );
}
