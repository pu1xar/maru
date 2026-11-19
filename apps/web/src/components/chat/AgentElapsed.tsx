// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/AgentElapsed.tsx
// Local changes: the agent shape is the plain status and ISO times both callers have; the time
// text is agentElapsed.logic.ts (the compact form reads hours as 1h 24m).
import type { OrchestrationV2TurnItemStatus } from "@maru/shared";

import { formatCompactElapsedSeconds, formatElapsedSeconds } from "./agentElapsed.logic.ts";
import { tickTextContent } from "~/lib/tickTextContent";
import { isOrchestrationV2WorkActive } from "../../t3-shared/contracts.ts";
import { deriveSubagentElapsedMs } from "../../t3-shared/orchestrationTiming.ts";

export interface AgentTiming {
  readonly status: OrchestrationV2TurnItemStatus;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export function AgentElapsed({
  agent,
  compact = false,
}: {
  agent: AgentTiming;
  compact?: boolean;
}) {
  const format = compact ? formatCompactElapsedSeconds : formatElapsedSeconds;
  const live = isOrchestrationV2WorkActive(agent.status);
  const { status, startedAt, completedAt } = agent;
  if (deriveSubagentElapsedMs(agent, 0) === null) {
    return null;
  }
  return (
    <span
      ref={tickTextContent((nowMs) => {
        const elapsedMs = deriveSubagentElapsedMs({ status, startedAt, completedAt }, nowMs);
        return elapsedMs === null ? "" : format(elapsedMs / 1000);
      }, live)}
      className="tabular-nums"
    />
  );
}
