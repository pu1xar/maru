// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/TimelineV2EventRow.logic.ts
// Local changes: times are ISO strings (event-model 2). The group wording comes from
// client-runtime/state/subagentDisplay.ts, as in T3.
import type { OrchestrationV2TurnItem } from "@maru/shared";

export function subagentGroupTiming(
  agents: ReadonlyArray<{
    status: OrchestrationV2TurnItem["status"];
    startedAt: string | null;
    completedAt: string | null;
  }>,
) {
  let startMs: number | null = null;
  let endMs: number | null = null;
  let endUnknown = false;
  for (const agent of agents) {
    const started = agent.startedAt === null ? Number.NaN : Date.parse(agent.startedAt);
    if (Number.isFinite(started)) {
      startMs = startMs === null ? started : Math.min(startMs, started);
    }
    const completed = agent.completedAt === null ? Number.NaN : Date.parse(agent.completedAt);
    if (Number.isFinite(completed)) {
      endMs = endMs === null ? completed : Math.max(endMs, completed);
    } else {
      endUnknown = true;
    }
  }
  const live = agents.some(
    ({ status }) => status === "pending" || status === "running" || status === "waiting",
  );
  return {
    status: live ? ("running" as const) : ("completed" as const),
    startedAt: startMs === null ? null : new Date(startMs).toISOString(),
    completedAt: live || endUnknown || endMs === null ? null : new Date(endMs).toISOString(),
  };
}
