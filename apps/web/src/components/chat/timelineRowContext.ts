// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/timelineRowContext.ts
// Local changes: the shared row state keeps only what a read-only viewer uses. Approvals,
// citations, replies, forks, rewind, diffs, media, html renders, MCP apps and worktree setup are
// gone. `onOpenThread` opens a child thread id; live subagent records come from the snapshot.
import type { OrchestrationV2Subagent } from "@maru/shared";
import type { LegendListRef } from "@legendapp/list/react";
import { createContext, useEffect, useRef, type RefObject } from "react";

import type { MessagesTimelineRow, WorkGroupScrollAnchor } from "./MessagesTimeline.logic";
import type { TimestampFormat } from "../../timestampFormat";

export interface TimelineRowSharedState {
  listRef: RefObject<LegendListRef | null>;
  timestampFormat: TimestampFormat;
  /** Identity of the thread this list shows. */
  routeThreadKey: string;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  /** The snapshot's subagent records, by subagent id: live status, progress and result. */
  subagentsById: ReadonlyMap<string, OrchestrationV2Subagent>;
  /** Opens a child thread (a subagent transcript) in place of this one. */
  onOpenThread: (threadId: string) => void;
  onToggleTurnFold: (runId: string) => void;
  onToggleAttemptFold: (attemptId: string) => void;
  onToggleWorkGroup: (groupId: string, anchorKey: string) => void;
  onToggleWorkEntry: (anchorKey: string, collapsed: boolean, entryId?: string) => void;
  onWorkEntryContentReady?: (anchorKey: string, entryId: string) => void;
  workGroupViewState: WorkGroupViewState;
}

export interface TimelineRowActivityState {
  isWorking: boolean;
  isCompacting: boolean;
  latestRunId: string | null;
  liveAnswerPreview: string | null;
}

export const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);

export const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);

export interface WorkGroupViewState {
  scrollPositions: Map<string, WorkGroupScrollAnchor>;
  expandedEntries: Set<string>;
}

export const WorkGroupViewCtx = createContext<{
  state: WorkGroupViewState;
  onToggleEntry: (collapsed: boolean, entryId: string) => void;
  onContentReady?: ((entryId: string) => void) | undefined;
} | null>(null);

export type TimelineWorkEntry = Extract<
  MessagesTimelineRow,
  { kind: "work" }
>["groupedEntries"][number];

export type TimelineRow = MessagesTimelineRow;

export function useInitialOutputReady(pending: boolean, onReady: (() => void) | undefined) {
  const notified = useRef(false);
  // Reveals a disclosure after its first output commits.
  useEffect(() => {
    if (!pending && !notified.current) {
      notified.current = true;
      onReady?.();
    }
  }, [pending, onReady]);
}
