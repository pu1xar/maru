// How a turn ended, from each provider's own turn end (policy.ts TurnOutcome), and a Codex thread
// status as the list states it.
import type { UnifiedStatus } from "@maru/shared";
import type { ThreadStatus } from "../codex/protocol/v2/ThreadStatus.ts";
import type { Turn } from "../codex/protocol/v2/Turn.ts";
import type { TurnOutcome } from "./policy.ts";

/**
 * A Codex thread status in the list's terms (DESIGN.md 4.1, the index's mapStatus in
 * codex/source.ts); null for a status this code does not know.
 */
export function codexStatus(s: ThreadStatus): UnifiedStatus | null {
  switch (s.type) {
    case "notLoaded":
      return "closed";
    case "idle":
      return "open-idle";
    case "systemError":
      return "error";
    case "active": {
      const flags = s.activeFlags ?? [];
      return flags.includes("waitingOnUserInput") || flags.includes("waitingOnApproval") ? "waiting-input" : "running";
    }
    default:
      return null;
  }
}

/** An interrupt (the composer's 멈추기, Esc) ends the turn with one of these terminal reasons. */
const CLAUDE_ABORTED = new Set(["aborted_streaming", "aborted_tools"]);

/** Why a turn stopped early, by the result subtype (SDK SDKResultError). */
const CLAUDE_STOPS: Record<string, string> = {
  error_max_turns: "Hit the turn limit",
  error_max_budget_usd: "Hit the cost limit",
  error_max_structured_output_retries: "Hit the structured output retry limit",
  error_during_execution: "Error during execution",
};

/**
 * A Claude result message (ClaudeRuns.onResult). Measured on CLI 2.1.325 (2026-11-16, haiku):
 *   interrupt   subtype error_during_execution, is_error true, terminal_reason aborted_streaming,
 *               errors ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"]
 *   API error   subtype success, is_error true, terminal_reason api_error, result "Not logged in ..."
 *   normal      subtype success, is_error false, terminal_reason completed
 * So is_error alone also marks an interrupt; the terminal reason tells it apart.
 */
export function claudeOutcome(result: Record<string, unknown>): TurnOutcome {
  if (typeof result.terminal_reason === "string" && CLAUDE_ABORTED.has(result.terminal_reason)) return { result: "interrupted" };
  if (result.is_error !== true) return { result: "completed" };
  return { result: "failed", reason: claudeFailure(result) };
}

function claudeFailure(r: Record<string, unknown>): string | null {
  // A turn that ended on an API error is a "success" whose result is the error text.
  if (r.subtype === "success") return typeof r.result === "string" && r.result.trim() ? r.result : null;
  // The CLI's diagnostics are not the reason (the interrupt above carried one).
  const errors = Array.isArray(r.errors)
    ? r.errors.filter((e): e is string => typeof e === "string" && e.trim() !== "" && !e.startsWith("[ede_diagnostic]"))
    : [];
  if (errors.length) return errors.join(", ");
  return typeof r.subtype === "string" ? (CLAUDE_STOPS[r.subtype] ?? null) : null;
}

/**
 * A Claude process of this server ended (ClaudeRuns.onRunExit). An exit in an error mid-turn (the
 * process crashed, the run ended while the session host connection was down) ends that turn as a
 * failure, "Abnormal exit" (user decision 2026-11-16). Any other exit ends no turn: a run that is
 * closed or interrupted reported its turn's result before.
 */
export function claudeExitOutcome(info: { code: "done" | "error" | "interrupted"; error?: string }): TurnOutcome | null {
  if (info.code !== "error") return null;
  const why = info.error?.trim();
  return { result: "failed", reason: why ? `Abnormal exit: ${why}` : "Abnormal exit" };
}

/** A Codex turn/completed (CodexRuns.onTurnEnd); null for a turn still in progress. */
export function codexOutcome(turn: Pick<Turn, "status" | "error">): TurnOutcome | null {
  switch (turn.status) {
    case "completed":
      return { result: "completed" };
    case "interrupted":
      return { result: "interrupted" };
    case "failed":
      return { result: "failed", reason: turn.error?.message.trim() || null };
    default:
      return null;
  }
}
