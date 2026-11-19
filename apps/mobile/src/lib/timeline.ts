// The conversation's rows, derived by the web's own timeline code (DESIGN.md 2d): the same entry
// projection (session-logic.ts), the same grouping, turn folds and tool rows
// (MessagesTimeline.logic.ts) with the inputs the web's MessagesTimeline passes, so the phone
// groups, folds and labels a thread exactly as the web does. Only the drawing is the app's own
// (components/timeline/). This module is pure, so node tests run it.
import type { ThreadSnapshot } from "@maru/shared";
import {
  deriveThreadTimelineRunState,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntriesProjection,
} from "../../../web/src/session-logic.ts";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
  timelineTurnFoldRunIdsByEntryId,
  type MessagesTimelineRow,
  type MessagesTimelineRowsInput,
  type MessagesTimelineRowsProjection,
  type StableMessagesTimelineRowsState,
  type TimelineLatestRun,
} from "../../../web/src/components/chat/MessagesTimeline.logic.ts";

export type { MessagesTimelineRow } from "../../../web/src/components/chat/MessagesTimeline.logic.ts";
export type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];

/** What the reader changed: turn folds they closed (by run id; finished turns show their work by default), tool groups they opened (by group id), superseded attempts they opened. */
export interface TimelineDisclosure {
  readonly collapsedRunIds: ReadonlySet<string>;
  readonly expandedWorkGroupIds: ReadonlySet<string>;
  readonly expandedAttemptIds: ReadonlySet<string>;
}

export const CLOSED: TimelineDisclosure = {
  collapsedRunIds: new Set(),
  expandedWorkGroupIds: new Set(),
  expandedAttemptIds: new Set(),
};

/** Shared by every derivation: the web passes these same constants (MessagesTimeline.tsx). */
const NO_OPTIMISTIC_MESSAGES: never[] = [];
const NO_TURN_DIFF_SUMMARIES: MessagesTimelineRowsInput["turnDiffSummaries"] = [];

/**
 * The previous derivation of the same thread, so a streamed text update patches its rows instead
 * of deriving every row again (the web's useIncrementalTimelineEntries, useIncrementalTimelineRows
 * and useStableRows). Unchanged rows keep their identity, so memoized row views skip them.
 */
export interface TimelineMemo {
  readonly threadId: string;
  readonly entries: TimelineEntriesProjection;
  readonly rows: MessagesTimelineRowsProjection;
  readonly stable: StableMessagesTimelineRowsState;
}

export interface TimelineResult {
  readonly rows: MessagesTimelineRow[];
  /** The run the fold rules look at. */
  readonly latestRun: TimelineLatestRun | null;
  readonly isWorking: boolean;
  readonly memo: TimelineMemo;
  /**
   * The finished turn's fold that hides entry `entryId` (opening it brings the entry's row), or
   * undefined when no fold does (a conversation find, DESIGN.md 6u). Derived on the call.
   */
  readonly foldRunIdOf: (entryId: string) => string | undefined;
}

export function timelineRows(
  snapshot: ThreadSnapshot,
  open: TimelineDisclosure,
  previous: TimelineMemo | null = null,
): TimelineResult {
  const same = previous !== null && previous.threadId === snapshot.threadId ? previous : null;
  const entries = deriveTimelineEntriesFromVisibleTurnItemsWithState(
    { visibleTurnItems: snapshot.visibleTurnItems, optimisticMessages: NO_OPTIMISTIC_MESSAGES },
    same?.entries ?? null,
  );
  const run = deriveThreadTimelineRunState(snapshot);
  const input: MessagesTimelineRowsInput = {
    timelineEntries: entries.entries,
    latestRun: run.latestRun,
    runningRunId: run.runningRunId,
    collapsedRunIds: open.collapsedRunIds,
    expandedAttemptIds: open.expandedAttemptIds,
    expandedWorkGroupIds: open.expandedWorkGroupIds,
    isWorking: run.isWorking,
    runlessWorkActive: run.runlessWorkActive,
    activeTurnStartedAt: run.activeTurnStartedAt,
    turnDiffSummaries: NO_TURN_DIFF_SUMMARIES,
    supportsConversationRollback: false,
    toolCallVisibility: "showAll",
  };
  const rows = deriveMessagesTimelineRowsWithState(input, same?.rows ?? null);
  const stable = computeStableMessagesTimelineRows(rows.rows, same?.stable ?? { byId: new Map(), result: [] });
  return {
    rows: stable.result,
    latestRun: run.latestRun,
    isWorking: run.isWorking,
    memo: { threadId: snapshot.threadId, entries, rows, stable },
    foldRunIdOf: (entryId) =>
      timelineTurnFoldRunIdsByEntryId({
        timelineEntries: entries.entries,
        latestRun: run.latestRun,
        isWorking: run.isWorking,
        runlessWorkActive: run.runlessWorkActive,
        runningRunId: run.runningRunId,
        toolCallVisibility: "showAll",
      }).get(entryId),
  };
}

/** Opens or closes one id. */
export function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
