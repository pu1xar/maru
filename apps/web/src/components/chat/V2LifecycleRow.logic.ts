// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/V2LifecycleRow.logic.ts
// Local changes: times are ISO strings (event-model 2), parsed with Date.parse. The interrupt
// divider's detail is local.
import type { OrchestrationV2Subagent } from "@maru/shared";

const ACTIVE_SUBAGENT_STATUSES = new Set<OrchestrationV2Subagent["status"]>([
  "pending",
  "running",
  "waiting",
]);

/** Claude can reuse resumed agent ids. Active agents supersede outcomes; settled agents must start after notification. */
export function subagentResumedSince(
  agent: Pick<OrchestrationV2Subagent, "status" | "startedAt">,
  notifiedAt: string,
): boolean {
  if (ACTIVE_SUBAGENT_STATUSES.has(agent.status)) return true;
  if (agent.startedAt === null) return false;
  const notifiedAtMillis = Date.parse(notifiedAt);
  const startedAtMillis = Date.parse(agent.startedAt);
  return (
    !Number.isNaN(notifiedAtMillis) &&
    !Number.isNaN(startedAtMillis) &&
    startedAtMillis > notifiedAtMillis
  );
}

/** The subagent status words a card shows (T3's STATUS_VISUALS labels, in Korean). */
export const SUBAGENT_STATUS_LABEL: Record<OrchestrationV2Subagent["status"], string> = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting for reply",
  idle: "Idle, can resume",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

const GENERIC_CHILD_END = /^Child task ended with status\b/i;

function plainDetail(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What an interrupt divider adds after "Interrupted". The record's own words only repeat it
 * (Claude's "[Request interrupted by user]", Codex's "Turn interrupted", or "턴이 중단됨" in older transcripts), so those add nothing; a
 * reason after them, or any other text, stays.
 */
export function interruptDividerDetail(message: string): string | null {
  const text = message.trim();
  if (/^\[Request interrupted by user\]$/i.test(text)) return null;
  if (/^\[Request interrupted by user for tool use\]$/i.test(text)) return "during tool use";
  const codex = /^(?:턴이 중단됨|Turn interrupted)(?::\s*([\s\S]*))?$/u.exec(text);
  if (codex) return codex[1]?.trim() || null;
  return text || null;
}

const SETTLED_SUBAGENT_STATUSES = new Set<OrchestrationV2Subagent["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** The one-line detail under a subagent's title: progress while it works, its result after. */
export function subagentDetailLine(input: {
  readonly status: OrchestrationV2Subagent["status"];
  readonly result: string | null | undefined;
  readonly progress: string | undefined;
}): string | null {
  const result = input.result?.trim();
  const progress = input.progress?.trim();
  const rawDetail = SETTLED_SUBAGENT_STATUSES.has(input.status)
    ? result || progress
    : progress || result;
  return rawDetail && !GENERIC_CHILD_END.test(rawDetail) ? plainDetail(rawDetail) || null : null;
}
