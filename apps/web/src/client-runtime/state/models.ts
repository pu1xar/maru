// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: packages/client-runtime/src/state/models.ts (run status helpers).
// Local changes: the run and runtime summaries are maru's ThreadSnapshot records.
import type { ThreadRunSummary, ThreadRuntimeSummary } from "@maru/shared";

export function threadRunStatusIsActive(status: ThreadRuntimeSummary["status"]): boolean {
  return (
    status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
  );
}

export function threadRuntimeIsActive(
  runtime: Pick<ThreadRuntimeSummary, "status"> | null | undefined,
): boolean {
  return runtime !== null && runtime !== undefined && threadRunStatusIsActive(runtime.status);
}

export function resolveThreadWorkingStartedAt(input: {
  readonly latestRun: Pick<
    ThreadRunSummary,
    "runId" | "startedAt" | "requestedAt" | "completedAt"
  > | null;
  readonly runtime: Pick<ThreadRuntimeSummary, "activeRunId" | "activityStartedAt"> | null;
}): string | null {
  const valid = (value: string | null | undefined) =>
    value != null && Number.isFinite(Date.parse(value)) ? value : null;
  if (input.runtime?.activityStartedAt !== undefined) return valid(input.runtime.activityStartedAt);
  const run = input.latestRun;
  if (run?.completedAt === null && run.runId === input.runtime?.activeRunId) {
    return valid(run.startedAt) ?? valid(run.requestedAt);
  }
  return null;
}

export function formatWorkingDurationLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
