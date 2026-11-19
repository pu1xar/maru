// A Claude session's /goal as the transcript tells it, and as a live process tells it.
//
// Claude Code 2.1.326 keeps the goal as a session-scoped Stop hook with a condition; at the end of
// every turn an evaluator judges the condition. The transcript holds one `goal_status` attachment
// per step (2.1.326 bundle: O8r, M3o, B7e, D5t, the Stop hook loop):
//   set      {met:false, sentinel:true,  condition}                        /goal <condition>, a goal Claude proposed and the user approved
//   clear    {met:true,  sentinel:true,  condition}                        /goal clear|stop|off|reset|none|cancel, or the goal cleared after an unrecoverable error
//   unmet    {met:false, condition, reason}                                a turn ended and the evaluator said not yet
//   met      {met:true,  condition, reason, iterations, durationMs, tokens}
//   failed   {met:false, failed:true, condition, reason, iterations, ...}  the evaluator found the condition impossible
// The CLI restores a goal on resume from the newest goal_status record alone (eer): a record with
// met or failed (the clear sentinel has met:true) gives no goal, any other (a set or an unmet)
// gives an active goal.
// A goal that is met, failed or cleared is gone, so a Claude goal has no ended state to show.
import type { ClaudeGoalDetail, ThreadGoalState } from "@maru/shared";

export type GoalEventKind = "set" | "clear" | "met" | "failed" | "unmet";

export interface GoalEvent {
  /** Byte offset of the transcript line; orders events and tells a scanned one from a live one. */
  offset: number;
  kind: GoalEventKind;
  condition: string;
  /** The evaluator's reason (unmet, met, failed); null when the record has none. */
  reason: string | null;
  /** The record's timestamp, ms; null when it has none. */
  at: number | null;
}

/** The event a `goal_status` attachment is; null when it is not a goal_status object. */
export function goalEventOf(attachment: Record<string, unknown>, timestamp: string | null, offset: number): GoalEvent | null {
  if (attachment.type !== "goal_status") return null;
  const met = attachment.met === true;
  const kind: GoalEventKind =
    attachment.sentinel === true ? (met ? "clear" : "set")
    : met ? "met"
    : attachment.failed === true ? "failed"
    : "unmet";
  const parsed = timestamp === null ? Number.NaN : Date.parse(timestamp);
  const reason = typeof attachment.reason === "string" && attachment.reason.trim().length > 0 ? attachment.reason : null;
  return {
    offset,
    kind,
    condition: typeof attachment.condition === "string" ? attachment.condition : "",
    reason,
    at: Number.isNaN(parsed) ? null : parsed,
  };
}

/**
 * The goal after the events, oldest first: a set starts one; met, failed and clear end it; an unmet
 * of the same condition adds a check and its reason. An unmet with no goal before it (the set is
 * older than what was read, or never written) is an active goal with that one check, as the CLI's
 * restore takes it.
 */
export function reduceGoal(events: readonly GoalEvent[]): ThreadGoalState | null {
  let goal: { condition: string; detail: ClaudeGoalDetail } | null = null;
  for (const e of events) {
    switch (e.kind) {
      case "set":
        goal = { condition: e.condition, detail: { checks: 0, setAt: e.at, lastReason: null } };
        break;
      case "clear":
      case "met":
      case "failed":
        goal = null;
        break;
      case "unmet":
        goal =
          goal !== null && goal.condition === e.condition
            ? { condition: goal.condition, detail: { checks: goal.detail.checks + 1, setAt: goal.detail.setAt, lastReason: e.reason } }
            : { condition: e.condition, detail: { checks: 1, setAt: e.at, lastReason: e.reason } };
        break;
    }
  }
  return goal === null ? null : stateOf(goal.condition, goal.detail);
}

function stateOf(condition: string, detail: ClaudeGoalDetail): ThreadGoalState {
  return { objective: condition, status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, claude: detail };
}

/** The newest event's time (ms); null when none has one. */
export function lastEventAt(events: readonly GoalEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const at = events[i]!.at;
    if (at !== null) return at;
  }
  return null;
}

/**
 * A running process's `active_goal` message (SDKActiveGoalMessage): the goal now (null: none), and
 * when this server received it, ms.
 */
export interface LiveGoal {
  value: { condition: string; iterations: number; setAt: number; lastReason: string | null } | null;
  receivedAt: number;
}

/**
 * The goal to show, from the transcript's and the live process's.
 *
 * The transcript decides, because it is what the CLI itself restores from and it survives a server
 * restart. The live message stands in only for the stretch the transcript has not caught up with:
 * it wins while it was received after the transcript's newest goal record, and the next record the
 * transcript writes takes over again (so a clear the transcript shows is never undone by an older
 * live goal). With no live message, or when the process is gone, the transcript's goal is shown.
 */
export function chooseGoal(fromTranscript: ThreadGoalState | null, transcriptNewestAt: number | null, live: LiveGoal | null | undefined): ThreadGoalState | null {
  if (live === null || live === undefined) return fromTranscript;
  if (transcriptNewestAt !== null && transcriptNewestAt >= live.receivedAt) return fromTranscript;
  if (live.value === null) return null;
  const v = live.value;
  return stateOf(v.condition, { checks: v.iterations, setAt: v.setAt, lastReason: v.lastReason });
}

/** An `active_goal` message from the SDK stream as a LiveGoal; null when it is not one. */
export function liveGoalOf(message: Record<string, unknown>, receivedAt: number): LiveGoal | null {
  if (message.type !== "active_goal") return null;
  const v = message.value;
  if (v === null || v === undefined) return { value: null, receivedAt };
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.condition !== "string" || typeof o.iterations !== "number" || typeof o.set_at !== "number") return null;
  return {
    value: {
      condition: o.condition,
      iterations: o.iterations,
      setAt: o.set_at,
      lastReason: typeof o.last_reason === "string" && o.last_reason.trim().length > 0 ? o.last_reason : null,
    },
    receivedAt,
  };
}
