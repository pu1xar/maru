// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/TimelineWorkGroupRows.logic.ts
// Local changes: there is one server, on this machine, so no per-environment clock offset.
import { formatDuration } from "../../t3-shared/orchestrationTiming.ts";

export function formatWorkingTimerNow(startIso: string, nowMs: number = Date.now()): string {
  const startedAtMs = Date.parse(startIso);
  if (!Number.isFinite(startedAtMs)) {
    return "0s";
  }
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }
  return formatDuration(elapsedSeconds * 1_000);
}
