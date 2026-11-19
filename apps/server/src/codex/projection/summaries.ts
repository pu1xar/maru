// Codex turn, thread status and token usage as T3 side records (docs/event-model.md 2.5, 7.6,
// 7.10, 7.12). Pure functions; the thread view decides when to call them.

import { sessionKey } from "@maru/shared";
import type {
  IsoDateTime,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2RunStatus,
  ThreadRunSummary,
  ThreadRuntimeSummary,
  ThreadTokenUsageSnapshot,
} from "@maru/shared";
import type { CodexErrorInfo } from "../protocol/v2/CodexErrorInfo.ts";
import type { ThreadStatus } from "../protocol/v2/ThreadStatus.ts";
import type { ThreadTokenUsage } from "../protocol/v2/ThreadTokenUsage.ts";
import type { Turn } from "../protocol/v2/Turn.ts";
import type { TurnError } from "../protocol/v2/TurnError.ts";

export const CODEX_DRIVER = "codex";

/** A turn without its items: what the view keeps per turn. */
export type TurnSummary = Omit<Turn, "items" | "itemsView">;

/** Our thread key for a Codex thread: `codex:<account>:<threadId>`. */
export function codexThreadKey(account: string, threadId: string): string {
  return sessionKey("codex", account, threadId);
}

export function codexRunId(threadKey: string, turnId: string): string {
  return `${threadKey}:run:${turnId}`;
}

export function isoFromMs(ms: number | null | undefined): IsoDateTime | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Turn and Thread times are Unix seconds (event-model 7.6). */
export function isoFromSec(sec: number | null | undefined): IsoDateTime | null {
  return typeof sec === "number" && Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null;
}

export function turnSummary(turn: Turn): TurnSummary {
  const { items: _items, itemsView: _view, ...rest } = turn;
  return rest;
}

export function runStatus(turn: Pick<TurnSummary, "status">, waiting: boolean): OrchestrationV2RunStatus {
  switch (turn.status) {
    case "inProgress":
      return waiting ? "waiting" : "running";
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    default:
      return "running";
  }
}

/** One turn is one T3 run (event-model 7.6). */
export function turnToRun(
  threadKey: string,
  turn: TurnSummary,
  opts: { assistantMessageId: string | null; waiting: boolean },
): ThreadRunSummary {
  const startedAt = isoFromSec(turn.startedAt);
  return {
    runId: codexRunId(threadKey, turn.id),
    status: runStatus(turn, opts.waiting),
    requestedAt: startedAt,
    startedAt,
    completedAt: isoFromSec(turn.completedAt),
    assistantMessageId: opts.assistantMessageId,
    turnEnded: turn.status !== "inProgress",
  };
}

export function isLoadedStatus(status: ThreadStatus): boolean {
  return status.type === "idle" || status.type === "active";
}

export function isWaitingStatus(status: ThreadStatus): boolean {
  return status.type === "active" && (status.activeFlags ?? []).length > 0;
}

/** Thread status → runtime (event-model 7.10). */
export function threadRuntime(
  status: ThreadStatus,
  opts: {
    providerInstanceId: string;
    activeRunId: string | null;
    activityStartedAt: IsoDateTime | null;
    lastError: string | null;
  },
): ThreadRuntimeSummary {
  const base = {
    providerInstanceId: opts.providerInstanceId,
    providerName: "Codex",
    lastError: opts.lastError,
  };
  switch (status.type) {
    case "active":
      return {
        ...base,
        status: isWaitingStatus(status) ? "waiting" : "running",
        activeRunId: opts.activeRunId,
        activityStartedAt: opts.activityStartedAt,
      };
    case "systemError":
      return { ...base, status: "failed", activeRunId: null, lastError: opts.lastError ?? "Codex reported a system error" };
    case "idle":
    case "notLoaded":
    default:
      return { ...base, status: "idle", activeRunId: null };
  }
}

/** total → cumulative fields, last → last* fields, modelContextWindow → maxTokens (event-model 7.12). */
export function tokenUsageSnapshot(u: ThreadTokenUsage): ThreadTokenUsageSnapshot {
  return {
    // The context in use is the last request's size; T3's Codex adapter uses the same value.
    usedTokens: Math.max(0, u.last.totalTokens),
    totalProcessedTokens: u.total.totalTokens,
    ...(u.modelContextWindow === null ? {} : { maxTokens: u.modelContextWindow }),
    inputTokens: u.total.inputTokens,
    cachedInputTokens: u.total.cachedInputTokens,
    outputTokens: u.total.outputTokens,
    reasoningOutputTokens: u.total.reasoningOutputTokens,
    lastUsedTokens: u.last.totalTokens,
    lastInputTokens: u.last.inputTokens,
    lastCachedInputTokens: u.last.cachedInputTokens,
    lastOutputTokens: u.last.outputTokens,
    lastReasoningOutputTokens: u.last.reasoningOutputTokens,
  };
}

/** The variant name of a CodexErrorInfo, e.g. "usageLimitExceeded" or "httpConnectionFailed". */
export function codexErrorCode(info: CodexErrorInfo | null): string | null {
  if (info === null || info === undefined) return null;
  if (typeof info === "string") return info;
  return Object.keys(info)[0] ?? null;
}

function failureClass(code: string | null): OrchestrationV2ProviderFailureClass {
  switch (code) {
    case "usageLimitExceeded":
    case "rateLimitExceeded":
    case "sessionBudgetExceeded":
      return "usage_limit";
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
    case "responseStreamDisconnected":
    case "responseTooManyFailedAttempts":
      return "transport_error";
    case "unauthorized":
      return "permission_error";
    case "badRequest":
      return "validation_error";
    case null:
      return "unknown";
    default:
      return "provider_error";
  }
}

export function turnFailure(error: TurnError, willRetry: boolean | null): OrchestrationV2ProviderFailure {
  const code = codexErrorCode(error.codexErrorInfo);
  const details = error.additionalDetails ? `\n${error.additionalDetails}` : "";
  return {
    class: failureClass(code),
    message: `${error.message}${details}`,
    code,
    retryable: willRetry,
  };
}
