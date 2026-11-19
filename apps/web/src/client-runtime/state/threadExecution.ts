// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: packages/client-runtime/src/state/threadExecution.ts (the run and notification helpers
// the timeline reads) and apps/web/src/components/guest/GuestPage.tsx (how a read-only timeline
// derives its run inputs).
// Local changes: T3 summarizes its run records from a ThreadStructure projection; maru's
// ThreadSnapshot already carries ThreadRunSummary rows in run order, so the latest run is the last
// row and the activity run is the last row still preparing, starting, running or waiting.
import type {
  OrchestrationV2NotificationSource,
  ThreadRunSummary,
  ThreadRuntimeSummary,
  ThreadSnapshot,
} from "@maru/shared";
import { threadRuntimeIsActive } from "./models.ts";

const ACTIVITY_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

export function deriveLatestThreadRun(
  snapshot: Pick<ThreadSnapshot, "runs">,
): ThreadRunSummary | null {
  return snapshot.runs.at(-1) ?? null;
}

export function deriveThreadActivityRun(
  snapshot: Pick<ThreadSnapshot, "runs">,
): ThreadRunSummary | null {
  return (
    snapshot.runs.findLast((run) => ACTIVITY_RUN_STATUSES.has(run.status)) ??
    deriveLatestThreadRun(snapshot)
  );
}

export function threadRuntimeHasInterruptibleRun(
  runtime: Pick<ThreadRuntimeSummary, "status" | "activeRunId"> | null | undefined,
): boolean {
  return (
    threadRuntimeIsActive(runtime) &&
    runtime?.activeRunId !== null &&
    runtime?.activeRunId !== undefined
  );
}

export function notificationChildThreadId(
  source: OrchestrationV2NotificationSource,
): string | undefined {
  switch (source.kind) {
    case "subagent":
    case "delegated_task":
      return source.childThreadId;
    case "command":
    case "monitor":
    case "background_task":
    case "system":
      return undefined;
    default:
      source satisfies never;
      return undefined;
  }
}
