// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/MessagesTimeline.tsx
// Local changes: a read-only viewer of one thread snapshot. Kept: the LegendList setup (end
// follow, visible content position, first and last message rows always mounted), turn, attempt
// and work group disclosures with their scroll anchoring, the history control, and the row
// switch. Gone: minimap, T3's find store (maru's find searches on the server and this list shows its
// row, `find`, DESIGN.md 6u), citations and the selection toolbar, the screen reader activity
// announcer, rewind, fork and reply, worktree setup, html renders, MCP apps, sent messages,
// audio, pending approvals, the composer-anchored new turn and deferred work loading. The list is
// keyed per thread, and a visit restores the thread's remembered position (T3's restore on a switch,
// timelinePositions.ts): the live end, or the row the reader left at the top, loading older history
// first when that row is not in the newest page. Scrolling near the top asks for older history
// (LegendList onStartReached). Viewed images show
// as paths. The shared row state is memoized by hand; T3 relies on the React Compiler.
// Message times sit in the gutters beside the lane (MessageGutterTimestamp). A copy anywhere in
// the list serializes like a copy inside one message, and rows that are not messages are
// select-none, so a drag across messages copies only the messages (user request).
// UI text is Korean.
import type { OrchestrationV2Subagent } from "@maru/shared";
import {
  LegendList,
  type LegendListRef,
  type MaintainScrollAtEndOptions,
} from "@legendapp/list/react";
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  Minimize2Icon,
} from "lucide-react";
import {
  memo,
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import { chatMarkdownClipboardPayload } from "~/markdown-clipboard";
import { resolveUserMessagePresentation } from "../../client-runtime/userMessage.ts";
import { resolveWorkGroupScrollAnchor } from "../../client-runtime/work-log/scrollAnchor.ts";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { useWindowKeysRef } from "../../lib/windowKeys";
import type { TimelineEntry } from "../../session-logic.ts";
import {
  DEFAULT_TIMESTAMP_FORMAT,
  formatChatTimestampTooltip,
  formatDayAwareTimestamp,
  type TimestampFormat,
} from "../../timestampFormat";
import type { ChatMessage } from "../../types.ts";
import { TooltipScrollDismissArea } from "../ui/tooltip";
import { MarkdownFindContext } from "./markdownFindContext";
import { paintFindHighlights, revealFolded, useFindHighlights } from "./threadFindHighlights";
import { FindRevealContext } from "./findReveal";
import type { FindTimelineProps } from "./useThreadFind";
import {
  resolveTimelineIsAtEnd,
  timelineTurnFoldRunIdsByEntryId,
  type MessagesTimelineRow,
  type MessagesTimelineRowsInput,
  type TimelineLatestRun,
} from "./MessagesTimeline.logic";
import { AssistantMetaTimelineRow, AssistantTimelineRow, ProposedPlanTimelineRow } from "./TimelineAssistantRows";
import {
  TimelineRowActivityCtx,
  TimelineRowCtx,
  type TimelineRow,
  type TimelineRowActivityState,
  type TimelineRowSharedState,
  type WorkGroupViewState,
} from "./timelineRowContext";
import { ActivityShimmerOverlay, TimelineRowTimestamp, UncopiedText } from "./TimelineRowParts";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  resolveDisclosureRevealScrollDelta,
  settleListScroll,
} from "./timelineScrollAnchoring";
import {
  readTimelinePosition,
  rememberTimelinePosition,
  timelineRestoreStep,
  type OlderHistoryForRestore,
  type RememberedTimelinePosition,
} from "./timelinePositions";
import { UserMessageRow } from "./TimelineUserMessageRow";
import { ViewedImagesTimelineRow } from "./TimelineWorkEntryRow";
import { V2EventTimelineRow } from "./TimelineV2EventRow";
import { attachTimelineViewport, type TimelineViewport } from "./timelineViewport";
import { startTimelinePositionRestore } from "./useTimelinePositionRestore";
import {
  LiveWorkEntryTimelineRow,
  ThinkingTimelineRow,
  WorkGroupSection,
  WorkGroupToggleTimelineRow,
  WorkingTimelineRow,
} from "./TimelineWorkGroupRows";
import { useIncrementalTimelineRows, useStableRows } from "./useTimelineRows";
import { WorkLogBlock } from "./WorkLog";

const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
// With the top fade on, the first row starts below the fade (T3: the fade's own height, 24px).
const TIMELINE_LIST_FADE_HEADER = <div className="h-[var(--workspace-titlebar-scroll-fade-height)]" />;

const TIMELINE_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: {
    dataChange: true,
    footerLayout: false,
    itemLayout: true,
    layout: true,
  },
} as const satisfies MaintainScrollAtEndOptions;
const TIMELINE_MAINTAIN_SCROLL_AT_END_SMOOTH = {
  ...TIMELINE_MAINTAIN_SCROLL_AT_END,
  animated: true,
} as const satisfies MaintainScrollAtEndOptions;
const MAINTAIN_VISIBLE_CONTENT_POSITION = { data: true, size: true } as const;
/** How near the top (in viewport heights) older history loads. */
const START_REACHED_THRESHOLD = 0.5;

// Row inputs are compared by identity (sameRowsInput); a fresh `[]` per render would re-derive
// the rows on every render and loop through useIncrementalTimelineRows' render-time update.
const NO_TURN_DIFF_SUMMARIES: MessagesTimelineRowsInput["turnDiffSummaries"] = [];

export interface MessagesTimelineHistoryControls {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadEarlier: () => void;
}

interface MessagesTimelineProps {
  listRef: RefObject<LegendListRef | null>;
  /** Identity of the shown thread; a change resets disclosures. */
  routeThreadKey: string;
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestRun: TimelineLatestRun | null;
  runningRunId: string | null;
  isWorking: boolean;
  /** Native subagent work has no app run; runless entries form the live response. */
  runlessWorkActive?: boolean;
  activeTurnStartedAt: string | null;
  isCompacting?: boolean;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  subagents: ReadonlyArray<OrchestrationV2Subagent>;
  onOpenThread: (threadId: string) => void;
  historyControls?: MessagesTimelineHistoryControls | undefined;
  /** The list fades out under the header; off while a banner sits above the timeline (T3). */
  topFadeEnabled?: boolean;
  /** Off while reading history so LegendList does not re-pin to the bottom. */
  liveFollowEnabled: boolean;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  /** Receives the list's viewport when it mounts; the returned cleanup runs when it goes away. */
  onViewportAttach?: (viewport: TimelineViewport) => () => void;
  /** Drawn after the last row, inside the list (the messages that wait, DESIGN.md 4.4). */
  footer?: ReactNode;
  /** Find in the thread (DESIGN.md 6u): the query to paint and the occurrence to show. */
  find?: FindTimelineProps | null;
}

function emptyWorkGroupViewState(): WorkGroupViewState {
  return { scrollPositions: new Map(), expandedEntries: new Set() };
}

function timelineListStateFor(identity: string): {
  readonly identity: string;
  readonly rememberedPosition: RememberedTimelinePosition | undefined;
  readonly workGroupViewState: WorkGroupViewState;
} {
  const rememberedPosition = readTimelinePosition(identity);
  return {
    identity,
    rememberedPosition,
    workGroupViewState: rememberedPosition?.disclosures?.workGroupState ?? emptyWorkGroupViewState(),
  };
}

export const MessagesTimeline = memo(function MessagesTimeline({
  listRef,
  routeThreadKey,
  timelineEntries,
  latestRun,
  runningRunId,
  isWorking,
  runlessWorkActive = false,
  activeTurnStartedAt,
  isCompacting = false,
  markdownCwd,
  workspaceRoot,
  subagents,
  onOpenThread,
  historyControls,
  topFadeEnabled = false,
  liveFollowEnabled,
  onIsAtEndChange,
  onViewportAttach,
  footer,
  find = null,
}: MessagesTimelineProps) {
  const listIdentityKey = routeThreadKey;
  // Snapshot restore positions on identity changes; ongoing scroll writes must not move them.
  const [listState, setListState] = useState(() => timelineListStateFor(listIdentityKey));
  const [collapsedRunIds, setCollapsedRunIds] = useState<ReadonlySet<string>>(
    () => listState.rememberedPosition?.disclosures?.collapsedRuns ?? new Set(),
  );
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(
    () => listState.rememberedPosition?.disclosures?.workGroups ?? new Set(),
  );
  const [expandedAttemptIds, setExpandedAttemptIds] = useState<ReadonlySet<string>>(
    () => listState.rememberedPosition?.disclosures?.attempts ?? new Set(),
  );
  // A thread left away from its end is not positioned until the restore lands; one left at the end
  // opens there (initialScrollAtEnd) and is positioned from the start.
  const [positionedThreadKey, setPositionedThreadKey] = useState<string | null>(() =>
    listState.rememberedPosition?.atEnd === false ? null : listIdentityKey,
  );
  const restoringThreadPosition = positionedThreadKey !== listIdentityKey;
  // The older history a restore of this identity asked for (restoreStep below).
  const [olderForRestoreState, setOlderForRestore] = useState<OlderHistoryForRestore | null>(null);
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [settlingListIdentity, setSettlingListIdentity] = useState<string | null>(listIdentityKey);
  let paintedCollapsedRunIds = collapsedRunIds;
  let paintedExpandedWorkGroupIds = expandedWorkGroupIds;
  let paintedExpandedAttemptIds = expandedAttemptIds;
  const identityChanged = listState.identity !== listIdentityKey;
  const { rememberedPosition, workGroupViewState } = identityChanged
    ? timelineListStateFor(listIdentityKey)
    : listState;
  if (identityChanged) {
    setListState({ identity: listIdentityKey, rememberedPosition, workGroupViewState });
    setPositionedThreadKey(rememberedPosition?.atEnd === false ? null : listIdentityKey);
    setOlderForRestore(null);
    setSettlingListIdentity(listIdentityKey);
    paintedCollapsedRunIds = rememberedPosition?.disclosures?.collapsedRuns ?? new Set();
    paintedExpandedWorkGroupIds = rememberedPosition?.disclosures?.workGroups ?? new Set();
    paintedExpandedAttemptIds = rememberedPosition?.disclosures?.attempts ?? new Set();
    setCollapsedRunIds(paintedCollapsedRunIds);
    setExpandedWorkGroupIds(paintedExpandedWorkGroupIds);
    setExpandedAttemptIds(paintedExpandedAttemptIds);
  }

  const disclosureRevealRef = useRef<{
    key: string;
    identity: string;
    entryId: string | undefined;
    contentKey: string | undefined;
    ready: boolean;
  } | null>(null);
  const disclosureRevealFrameRef = useRef<number | null>(null);

  // Anchoring keeps the toggled row still, so content that expands below it
  // near the bottom would otherwise land under the viewport's bottom edge.
  const revealExpandedDisclosure = useStableCallback(() => {
    const pending = disclosureRevealRef.current;
    if (!pending || pending.identity !== listIdentityKey) return;
    const state = listRef.current?.getState();
    const element = listRef.current?.getScrollableNode();
    const index = state?.indexByKey(pending.key);
    const row = index === undefined ? undefined : state?.elementAtIndex(index);
    if (!element || !(row instanceof HTMLElement)) return;
    const viewport = element.getBoundingClientRect();
    const entry = pending.entryId
      ? row.querySelector<HTMLElement>(`[data-work-entry-id="${CSS.escape(pending.entryId)}"]`)
      : null;
    const contentIndex = pending.contentKey ? state?.indexByKey(pending.contentKey) : undefined;
    const content = contentIndex === undefined ? null : state?.elementAtIndex(contentIndex);
    const bounds = (entry ?? row).getBoundingClientRect();
    const delta = resolveDisclosureRevealScrollDelta({
      rowTop: bounds.top,
      rowBottom: content?.getBoundingClientRect().bottom ?? bounds.bottom,
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom,
      composerOverlayHeight: 0,
      anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
    });
    // Nested lists can finish measuring before their height reaches the outer scroller.
    if (pending.ready && element.scrollTop + delta <= element.scrollHeight - element.clientHeight) {
      disclosureRevealRef.current = null;
    }
    if (delta > 0) {
      element.scrollBy({ top: delta, behavior: prefersReducedMotion ? "auto" : "smooth" });
    }
  });
  const scheduleDisclosureReveal = useStableCallback(() => {
    if (disclosureRevealFrameRef.current !== null) {
      cancelAnimationFrame(disclosureRevealFrameRef.current);
    }
    disclosureRevealFrameRef.current = requestAnimationFrame(() => {
      disclosureRevealFrameRef.current = null;
      revealExpandedDisclosure();
    });
  });

  const preserveDisclosurePosition = useStableCallback(
    (
      anchorKey: string,
      reveal?: { readonly entryId?: string | undefined; readonly contentKey?: string | undefined },
    ) => {
      const list = listRef.current;
      disclosureRevealRef.current = null;
      // An anchor ends end-follow until the reader scrolls, so a streaming turn keeps the live end.
      if (!list || (isWorking && list.getState().isFollowingEnd)) return;
      if (reveal) {
        disclosureRevealRef.current = {
          key: anchorKey,
          identity: listIdentityKey,
          entryId: reveal.entryId,
          contentKey: reveal.contentKey,
          ready: false,
        };
      }
      list.cancelScroll();
      list.anchorVisibleContent({ key: anchorKey });
    },
  );

  const toggleIn = <T,>(existing: ReadonlySet<T>, value: T): ReadonlySet<T> => {
    const next = new Set(existing);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };
  // Turn and attempt folds reveal later rows rather than growing their own row.
  const onToggleTurnFold = useStableCallback((runId: string) => {
    preserveDisclosurePosition(`turn-fold:${runId}`);
    setCollapsedRunIds((existing) => toggleIn(existing, runId));
  });
  const onToggleWorkGroup = useStableCallback((groupId: string, anchorKey: string) => {
    preserveDisclosurePosition(
      anchorKey,
      expandedWorkGroupIds.has(groupId) ? undefined : { contentKey: `${groupId}:details` },
    );
    setExpandedWorkGroupIds((existing) => toggleIn(existing, groupId));
  });
  const onToggleAttemptFold = useStableCallback((attemptId: string) => {
    preserveDisclosurePosition(`attempt-fold:${attemptId}`);
    setExpandedAttemptIds((existing) => toggleIn(existing, attemptId));
  });
  const onToggleWorkEntry = useStableCallback(
    (anchorKey: string, collapsed: boolean, entryId?: string) =>
      preserveDisclosurePosition(anchorKey, collapsed ? undefined : { entryId }),
  );
  const onWorkEntryContentReady = useStableCallback((anchorKey: string, entryId: string) => {
    const pending = disclosureRevealRef.current;
    if (
      !pending ||
      pending.identity !== listIdentityKey ||
      (pending.contentKey === undefined
        ? pending.key !== anchorKey || pending.entryId !== entryId
        : pending.contentKey !== anchorKey)
    )
      return;
    pending.ready = pending.contentKey === undefined;
    scheduleDisclosureReveal();
  });

  const rawRows = useIncrementalTimelineRows(`${listIdentityKey}\0${workspaceRoot ?? ""}`, {
    timelineEntries,
    latestRun,
    runningRunId,
    collapsedRunIds: paintedCollapsedRunIds,
    expandedAttemptIds: paintedExpandedAttemptIds,
    expandedWorkGroupIds: paintedExpandedWorkGroupIds,
    isWorking,
    runlessWorkActive,
    activeTurnStartedAt,
    turnDiffSummaries: NO_TURN_DIFF_SUMMARIES,
    supportsConversationRollback: false,
    toolCallVisibility: "showAll",
  });
  const rows = useStableRows(rawRows, listIdentityKey);
  const showsEmptyState = rows.length === 0 && !isWorking && historyControls === undefined;

  // A position away from the end being restored. A view reads the newest page of the thread, so the
  // row the reader left may be in older history: older pages are asked for until the row shows, the
  // history ends, the oldest row the list held then is back (past it, the row is gone: folded or
  // rewritten), or a request ends without new rows. A row that never shows leaves the remembered
  // offset. The list stays hidden for the whole restore, so neither the newest page's top nor an
  // older page's flashes before the row lands.
  const restoreTarget =
    restoringThreadPosition && rememberedPosition?.atEnd === false ? rememberedPosition : undefined;
  const restoreRowIndex = restoreTarget ? rows.findIndex((row) => row.id === restoreTarget.rowId) : -1;
  const olderForRestore = identityChanged ? null : olderForRestoreState;
  const oldestRowId = restoreTarget?.oldestRowId;
  const restoreStep = timelineRestoreStep({
    restoring: restoreTarget !== undefined,
    rowFound: restoreRowIndex >= 0,
    hasMoreHistory: historyControls?.hasMoreHistory === true,
    historyReached: oldestRowId !== undefined && rows.some((row) => row.id === oldestRowId),
    gaveUp: olderForRestore?.identity === listIdentityKey && olderForRestore.gaveUp,
  });
  const historyLoading = historyControls?.loading ?? false;
  const requestOlderHistory = historyControls?.onLoadEarlier;
  useEffect(() => {
    if (restoreStep !== "load-older" || historyLoading || !requestOlderHistory) return;
    const asked = olderForRestore?.identity === listIdentityKey ? olderForRestore : null;
    // Progress is measured on the entries: older history comes a few conversation rows at a time
    // and may fold into rows already drawn (DESIGN.md 6r), which leaves `rows` as it was.
    if (asked?.rows === timelineEntries) {
      // The last request ended (answered, failed or never sent) without new entries.
      setOlderForRestore({ identity: listIdentityKey, rows: timelineEntries, gaveUp: true });
      return;
    }
    setOlderForRestore({ identity: listIdentityKey, rows: timelineEntries, gaveUp: false });
    requestOlderHistory();
  }, [restoreStep, historyLoading, requestOlderHistory, olderForRestore, timelineEntries, listIdentityKey]);
  // The reader asked for the end (the scroll-to-end pill) before the row landed: the restore gives
  // way and the list follows the end.
  useEffect(() => {
    if (restoreTarget !== undefined && liveFollowEnabled) setPositionedThreadKey(listIdentityKey);
  }, [restoreTarget, liveFollowEnabled, listIdentityKey]);

  // Screen readers can only reach headings in the DOM. Keeping the first and
  // last messages mounted lets heading navigation wrap to either end.
  const firstMessageRow = rows.find(isMessageRow);
  const lastMessageRow = rows.findLast(isMessageRow);
  const alwaysRenderKeys = [
    ...(firstMessageRow ? [firstMessageRow.id] : []),
    ...(lastMessageRow && lastMessageRow !== firstMessageRow ? [lastMessageRow.id] : []),
  ];
  // Local change (DESIGN.md 6u): the row a find shows. A message folded into its finished turn opens
  // that turn first; the row stays mounted while it is the find's.
  const findTarget = find?.target ?? null;
  const findRowIndex = findTarget ? rows.findIndex((row) => row.id === findTarget.entryId) : -1;
  useEffect(() => {
    if (!findTarget || findRowIndex >= 0) return;
    const runId = timelineTurnFoldRunIdsByEntryId({
      timelineEntries,
      latestRun,
      isWorking,
      runlessWorkActive,
      runningRunId,
      toolCallVisibility: "showAll",
    }).get(findTarget.entryId);
    if (runId === undefined || !collapsedRunIds.has(runId)) return;
    setCollapsedRunIds((existing) => {
      const next = new Set(existing);
      next.delete(runId);
      return next;
    });
  }, [findTarget, findRowIndex, timelineEntries, latestRun, isWorking, runlessWorkActive, runningRunId, collapsedRunIds]);
  // The row being restored stays mounted until it settles, and so does the find's.
  const alwaysRenderIndices = [
    ...(restoreRowIndex >= 0 ? [restoreRowIndex] : []),
    ...(findRowIndex >= 0 && findRowIndex !== restoreRowIndex ? [findRowIndex] : []),
  ];
  const alwaysRender =
    alwaysRenderIndices.length === 0 && alwaysRenderKeys.length === 0
      ? undefined
      : {
          ...(alwaysRenderIndices.length === 0 ? {} : { indices: alwaysRenderIndices }),
          ...(alwaysRenderKeys.length === 0 ? {} : { keys: alwaysRenderKeys }),
        };

  const viewportRef = useRef<TimelineViewport | null>(null);
  const restoreReady = restoreStep === "scroll" && rows.length > 0;
  // Restores LegendList's scroll position for the shown thread before paint, after the list's own
  // layout applied the rows. Any navigation by the reader takes over.
  useLayoutEffect(() => {
    const list = listRef.current;
    const viewport = viewportRef.current;
    if (!restoreReady || !restoreTarget || !list || !viewport) return;
    return startTimelinePositionRestore({
      list,
      viewport,
      listIdentityKey,
      rememberedPosition: restoreTarget,
      onPositioned: (identity) => {
        setPositionedThreadKey(identity);
        // LegendList reported the start while the restore held older loads back, so a position
        // that lands near the top asks for the previous page itself.
        const element = list.getScrollableNode();
        if (element && element.scrollTop < element.clientHeight * START_REACHED_THRESHOLD) requestOlderHistory?.();
      },
    });
    // restoreTarget is this identity's remembered position, fixed while it restores.
  }, [restoreReady, listIdentityKey, listRef]);

  // Local change (DESIGN.md 6u): a find's step scrolls its row into view once per step, then puts
  // the occurrence a third down the viewport (a long message's occurrence can be far below its
  // row's top), opening a fold that hides it. Reading history: follow lets go.
  const [scrollNode, setScrollNode] = useState<HTMLElement | null>(null);
  const findQuery = find?.query ?? "";
  const findActive = findTarget && findRowIndex >= 0 ? { rowId: rows[findRowIndex]!.id, occurrence: findTarget.occurrence } : null;
  useFindHighlights(scrollNode, findQuery, findActive);
  const scrolledFindSeqRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const viewport = viewportRef.current;
    if (!findTarget || findRowIndex < 0 || restoringThreadPosition || !list || !viewport) return;
    if (scrolledFindSeqRef.current === findTarget.seq) return;
    scrolledFindSeqRef.current = findTarget.seq;
    const seq = findTarget.seq;
    const rowId = rows[findRowIndex]!.id;
    const occurrence = findTarget.occurrence;
    viewport.navigate({ releasesFollow: true });
    const release = viewport.holdProgrammaticScroll();
    const placeOccurrence = (attempt: number) => {
      if (scrolledFindSeqRef.current !== seq) return release();
      const element = list.getScrollableNode();
      if (!element) return release();
      const range = paintFindHighlights(element, findQuery, { rowId, occurrence });
      if (range && revealFolded(range, element) && attempt < 3) {
        requestAnimationFrame(() => placeOccurrence(attempt + 1));
        return;
      }
      const box = element.getBoundingClientRect();
      const at = (range ?? element.querySelector(`[data-timeline-row-id="${CSS.escape(rowId)}"]`))?.getBoundingClientRect();
      if (at && (at.top < box.top + 48 || at.bottom > box.bottom - 48)) {
        element.scrollTop += at.top - (box.top + box.height / 3);
      }
      release();
    };
    void Promise.resolve(list.scrollToIndex({ index: findRowIndex, animated: false, viewPosition: 0 })).then(() =>
      settleListScroll(
        list,
        (element) => {
          const row = element.querySelector(`[data-timeline-row-id="${CSS.escape(rowId)}"]`);
          return row ? Math.max(0, element.scrollTop + row.getBoundingClientRect().top - element.getBoundingClientRect().top) : undefined;
        },
        () => scrolledFindSeqRef.current !== seq,
      ).then(() => requestAnimationFrame(() => placeOccurrence(0))),
    );
  }, [findTarget, findRowIndex, restoringThreadPosition, rows, findQuery, listRef]);

  // The measurement the last remember wrote, so a follow release can rewrite
  // it without reading render state from a listener.
  const lastRememberedRef = useRef<{
    readonly data: unknown;
    readonly threadKey: string;
    readonly position: RememberedTimelinePosition;
  } | null>(null);
  const rememberPosition = (followingEnd: boolean) => {
    const state = listRef.current?.getState?.();
    if (restoringThreadPosition || state?.data !== rows) return undefined;
    const isAtEnd = resolveTimelineIsAtEnd(state);
    const position = state.data.length ? resolveWorkGroupScrollAnchor(state) : undefined;
    if (position && isAtEnd !== undefined) {
      const index = state.indexByKey(position.rowId);
      const row = index === undefined ? undefined : state.elementAtIndex(index);
      const element = listRef.current?.getScrollableNode();
      if (row && element) {
        const measured: RememberedTimelinePosition = {
          ...position,
          offsetWithinRow: element.getBoundingClientRect().top - row.getBoundingClientRect().top,
          scrollOffset: element.scrollTop,
          atEnd: isAtEnd,
          oldestRowId: rows[0]?.id,
          disclosures: {
            collapsedRuns: paintedCollapsedRunIds,
            workGroups: paintedExpandedWorkGroupIds,
            attempts: paintedExpandedAttemptIds,
            workGroupState: workGroupViewState,
          },
        };
        lastRememberedRef.current = { data: rows, threadKey: listIdentityKey, position: measured };
        rememberTimelinePosition(listIdentityKey, measured, followingEnd);
      }
    }
    return isAtEnd;
  };
  // A follow release without a scroll after it would leave the position
  // remembered as following.
  const rememberReleasedPosition = () => {
    const last = lastRememberedRef.current;
    if (last && listRef.current?.getState().data === last.data) {
      rememberTimelinePosition(last.threadKey, last.position, false);
    }
  };

  const handleScroll = () => {
    if (restoringThreadPosition || listRef.current?.getState?.().data !== rows) return;
    const isAtEnd = rememberPosition(liveFollowEnabled);
    if (isAtEnd !== undefined) onIsAtEndChange(isAtEnd);
  };
  // Rows added, removed or rewrapped change the content size, which moves the
  // scroll position and the overflow.
  const handleContentSizeChanged = useStableCallback((laidOutData: unknown) => {
    // The first laid-out content of a newly shown thread ends its settling.
    if (laidOutData === rows) {
      setSettlingListIdentity((current) => (current === listIdentityKey ? null : current));
    }
    handleScroll();
  });

  const subagentsById = useMemo(
    () => new Map(subagents.map((agent) => [agent.id, agent] as const)),
    [subagents],
  );
  const sharedState: TimelineRowSharedState = useMemo(
    () => ({
      listRef,
      timestampFormat: DEFAULT_TIMESTAMP_FORMAT,
      routeThreadKey,
      markdownCwd,
      workspaceRoot,
      subagentsById,
      onOpenThread,
      onToggleTurnFold,
      onToggleAttemptFold,
      onToggleWorkGroup,
      onToggleWorkEntry,
      onWorkEntryContentReady,
      workGroupViewState,
    }),
    [
      listRef,
      routeThreadKey,
      markdownCwd,
      workspaceRoot,
      subagentsById,
      onOpenThread,
      onToggleTurnFold,
      onToggleAttemptFold,
      onToggleWorkGroup,
      onToggleWorkEntry,
      onWorkEntryContentReady,
      workGroupViewState,
    ],
  );
  const compactionAwaitingRow =
    isCompacting &&
    !rows.some(
      (row) =>
        (row.kind === "context-compaction" && row.active) ||
        (row.kind === "working" && row.compacting),
    );
  const latestRunId = latestRun?.runId ?? null;
  const activityState: TimelineRowActivityState = useMemo(
    () => ({
      isWorking,
      isCompacting: compactionAwaitingRow,
      latestRunId,
      liveAnswerPreview: null,
    }),
    [isWorking, compactionAwaitingRow, latestRunId],
  );

  // In the split view only the focused pane's timeline hears scroll keys pressed on the page.
  const windowKeys = useWindowKeysRef();
  // Stable so the list attaches once per mount, not on every render.
  const setTimelineList = useStableCallback((list: LegendListRef | null) => {
    listRef.current = list;
    const scrollNode: HTMLElement | null = list?.getScrollableNode() ?? null;
    setScrollNode(scrollNode);
    const viewport = scrollNode ? attachTimelineViewport(scrollNode, { hearsPageKeys: () => windowKeys.current }) : null;
    viewportRef.current = viewport;
    const detachViewport = viewport ? onViewportAttach?.(viewport) : undefined;
    const stopRememberingRelease = viewport?.onFollowReleased(rememberReleasedPosition);
    const stopDisclosureReveal = viewport?.subscribe(() => {
      disclosureRevealRef.current = null;
    });
    let contentSizeFrame: number | null = null;
    // LegendList lays rows out from layout effects; the next frame sees them settled.
    let scheduledData: unknown = null;
    const scheduleContentSizeChanged = () => {
      if (!list) return;
      const laidOutData = list.getState().data;
      if (contentSizeFrame !== null) {
        if (scheduledData === laidOutData) return;
        cancelAnimationFrame(contentSizeFrame);
      }
      scheduledData = laidOutData;
      contentSizeFrame = requestAnimationFrame(() => {
        contentSizeFrame = null;
        handleContentSizeChanged(laidOutData);
        revealExpandedDisclosure();
      });
    };
    const stopListeningToContentSize = list
      ?.getState()
      .listen("totalSize", () => scheduleContentSizeChanged());
    scheduleContentSizeChanged();
    return () => {
      stopListeningToContentSize?.();
      stopRememberingRelease?.();
      stopDisclosureReveal?.();
      if (contentSizeFrame !== null) cancelAnimationFrame(contentSizeFrame);
      if (disclosureRevealFrameRef.current !== null) {
        cancelAnimationFrame(disclosureRevealFrameRef.current);
        disclosureRevealFrameRef.current = null;
      }
      detachViewport?.();
      viewport?.dispose();
      if (viewportRef.current === viewport) viewportRef.current = null;
      listRef.current = null;
    };
  });

  // The start is "reached" while the list still sits at offset 0 before its initial scroll to
  // the end lands, so older history loads only after the list reports its first placement. A
  // restore asks for the pages it needs itself.
  const loadedIdentityRef = useRef<string | null>(null);
  const loadEarlier = () => {
    if (
      loadedIdentityRef.current === listIdentityKey &&
      !restoringThreadPosition &&
      historyControls?.hasMoreHistory &&
      !historyControls.loading
    ) {
      historyControls.onLoadEarlier();
    }
  };
  // Local change (DESIGN.md 6r): older history comes a few conversation rows at a time, and a page
  // whose rows fold into the turn already shown draws nothing above. The list then stays at its
  // start, where LegendList reports no new start reached, so the next page is asked for here once
  // per change of the entries (the drawn rows can stay the same while folded ones grow; a request
  // that brought none, a failure, does not repeat).
  const askedAtEntriesRef = useRef<unknown>(null);
  useEffect(() => {
    if (loadedIdentityRef.current !== listIdentityKey || restoringThreadPosition) return;
    if (!historyControls?.hasMoreHistory || historyControls.loading || askedAtEntriesRef.current === timelineEntries) return;
    const element = listRef.current?.getScrollableNode();
    if (!element || element.scrollTop >= element.clientHeight * START_REACHED_THRESHOLD) return;
    askedAtEntriesRef.current = timelineEntries;
    historyControls.onLoadEarlier();
  });

  // Local change: a message's time sits in the empty space beside the conversation lane when that
  // space is wide enough for it (the frame is a size container): an answer's on the left, always
  // shown, and the user's on the right of the bubble while the pointer is over the row or focus is
  // in it. Touch screens never show the user's (user decision). Narrower frames show the time in
  // T3's places instead (the answer's meta row, the user message's action row).
  const renderItem = ({ item }: { item: MessagesTimelineRow }) => (
    <TimelineRowCtx value={sharedState}>
      <div className="messages-timeline-row-frame group/frame relative @container/frame">
        {item.kind === "message" &&
        (item.message.role === "user" || item.message.role === "assistant") ? (
          <MessageGutterTimestamp message={item.message} timestampFormat={sharedState.timestampFormat} />
        ) : null}
        <div className="chat-content-lane overflow-x-clip" data-timeline-root="true">
          <TimelineRowContent row={item} />
        </div>
      </div>
    </TimelineRowCtx>
  );
  const listExtraData = { identity: listIdentityKey, rowCount: rows.length, sharedState };
  const listHeader = (
    <>
      {topFadeEnabled ? TIMELINE_LIST_FADE_HEADER : TIMELINE_LIST_HEADER}
      {historyControls ? <TimelineHistoryControl {...historyControls} /> : null}
    </>
  );
  const listFooter = (
    <>
      {footer}
      <div aria-hidden className="h-3 sm:h-4" />
    </>
  );

  if (showsEmptyState) {
    return (
      <div className="flex h-full flex-col ps-(--chat-lane-inset-start) pe-(--chat-lane-inset-end)">
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">No conversation to show</p>
        </div>
        {footer}
      </div>
    );
  }

  return (
    <MarkdownFindContext value={findQuery !== ""}>
    <FindRevealContext value={findTarget?.entryId ?? null}>
    <TimelineRowActivityCtx value={activityState}>
      <TooltipScrollDismissArea className="relative h-full min-h-0" onCopy={copyTimelineSelection}>
        <LegendList<MessagesTimelineRow>
          // One list per thread visit (T3 keeps one list across switches): the opening scroll to
          // the end applies to every thread left at its end, and the restore above to the others.
          key={listIdentityKey}
          ref={setTimelineList}
          data={rows}
          extraData={listExtraData}
          keyExtractor={keyExtractor}
          getItemType={getItemType}
          renderItem={renderItem}
          estimatedItemSize={90}
          initialScrollAtEnd={rememberedPosition?.atEnd !== false}
          dataVersion={`${listIdentityKey}:${alwaysRenderKeys.join(",")}`}
          {...(alwaysRender ? { alwaysRender } : {})}
          maintainScrollAtEnd={
            restoreTarget !== undefined || !liveFollowEnabled
              ? false
              : isWorking && !prefersReducedMotion && settlingListIdentity === null
                ? TIMELINE_MAINTAIN_SCROLL_AT_END_SMOOTH
                : TIMELINE_MAINTAIN_SCROLL_AT_END
          }
          maintainVisibleContentPosition={
            restoreTarget !== undefined ? false : MAINTAIN_VISIBLE_CONTENT_POSITION
          }
          maintainScrollAtEndThreshold={1}
          onScroll={handleScroll}
          onLoad={() => {
            loadedIdentityRef.current = listIdentityKey;
          }}
          onStartReached={loadEarlier}
          onStartReachedThreshold={START_REACHED_THRESHOLD}
          // Keyboard scrolling only moves the focused element; clicks land here.
          tabIndex={-1}
          className={cn(
            "messages-timeline-scroll scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain [overflow-anchor:none]",
            topFadeEnabled && "topbar-scroll-fade",
            restoreTarget !== undefined && "invisible",
          )}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
        />
      </TooltipScrollDismissArea>
    </TimelineRowActivityCtx>
    </FindRevealContext>
    </MarkdownFindContext>
  );
});

/**
 * A drag across rows copies as a drag inside one message does (ChatMarkdown's handler, which runs
 * first when the selection starts in a message): the messages' markdown, without the timeline's
 * buttons, badges, headings and times.
 */
function copyTimelineSelection(event: ClipboardEvent<HTMLDivElement>) {
  if (event.isDefaultPrevented() || !event.clipboardData) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  const payload = chatMarkdownClipboardPayload(selection);
  if (!payload) return;
  event.preventDefault();
  event.clipboardData.setData("text/plain", payload.text);
  event.clipboardData.setData("text/html", payload.html);
}

// 1.25rem off the lane edge, on either side of the centered lane.
const GUTTER_OFFSET = "calc(50% + var(--chat-content-max-width) / 2 + 1.25rem)";

/**
 * A message's time beside the lane, level with the message's first line. The line box matches
 * the first line's (chat markdown is text-sm at relaxed leading, a folded message header is
 * text-sm at its default leading), so it follows the conversation text size.
 */
function MessageGutterTimestamp({
  message,
  timestampFormat,
}: {
  message: ChatMessage;
  timestampFormat: TimestampFormat;
}) {
  const user = message.role === "user";
  const folded = user && resolveUserMessagePresentation(message).attribution !== null;
  return (
    <UncopiedText
      text={formatDayAwareTimestamp(message.createdAt, timestampFormat)}
      className={cn(
        "absolute hidden whitespace-nowrap text-xs text-muted-foreground tabular-nums",
        user
          ? [
              "@min-[62rem]/frame:not-pointer-coarse:block",
              "opacity-0 transition-opacity duration-200 group-hover/frame:opacity-100 group-focus-within/frame:opacity-100",
              folded
                ? "top-2 leading-[calc(var(--text-sm)*20/14)]"
                : "top-3 leading-[calc(var(--text-sm)*1.625)]",
            ]
          : "top-0.5 leading-[calc(var(--text-sm)*1.625)] @min-[62rem]/frame:block",
      )}
      style={user ? { left: GUTTER_OFFSET } : { right: GUTTER_OFFSET }}
      title={formatChatTimestampTooltip(message.createdAt, timestampFormat)}
      data-message-gutter-time={message.role}
    />
  );
}

function TimelineHistoryControl(props: MessagesTimelineHistoryControls) {
  if (!props.hasMoreHistory && props.error === null) {
    return null;
  }
  return (
    <div className="messages-timeline-row-frame select-none">
      <div className="chat-content-lane flex flex-col gap-1.5 pb-2">
        {props.hasMoreHistory ? (
          <button
            type="button"
            disabled={props.loading}
            aria-label="Load earlier history"
            onClick={() => props.onLoadEarlier()}
            className="flex w-full cursor-pointer items-center gap-3 py-1.5 text-muted-foreground text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
          >
            <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
            <span className="shrink-0">
              {props.loading ? "Loading earlier history" : "Load earlier history"}
            </span>
            <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
          </button>
        ) : null}
        {props.error !== null ? (
          <p role="status" className="text-center text-muted-foreground text-xs">
            {props.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function isMessageRow(row: MessagesTimelineRow) {
  return row.kind === "message" && row.message.role !== "system";
}

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

// LegendList estimates unmeasured rows from their type's average. Long messages of equal length
// can differ in height by orders of magnitude, so each gets its own type to avoid nested-update loops.
function getItemType(item: MessagesTimelineRow) {
  if (item.kind !== "message") return item.kind;
  const lengthBucket = Math.max(0, Math.floor(Math.log2(item.message.text.length / 1000)));
  return lengthBucket < 2
    ? `message:${item.message.role}:${lengthBucket}`
    : `message:${item.message.id}`;
}

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  const isExpandedToolGroup = row.kind === "work" && row.isExpandedToolGroup;
  const isSubagentGroup = row.kind === "event" && row.projectedItem.item.type === "subagent";
  const isWorkLogRow =
    row.kind === "work" ||
    row.kind === "work-live" ||
    row.kind === "work-toggle" ||
    row.kind === "thinking";
  const isExpandedToolGroupHeader =
    (row.kind === "work-toggle" || row.kind === "work-live" || row.kind === "thinking") &&
    row.expanded === true;

  return (
    <div
      className={cn(
        isWorkLogRow || isSubagentGroup
          ? undefined
          : row.kind === "turn-fold" || row.kind === "working"
            ? "pb-1.5"
            : row.kind === "message" && row.groupedWithNext
              ? "pb-1"
              : (row.kind === "message" &&
                    row.message.role === "assistant" &&
                    !row.showAssistantMeta) ||
                  row.kind === "event" ||
                  row.kind === "attempt-fold" ||
                  row.kind === "viewed-images"
                ? "pb-2"
                : "pb-4",
        (row.kind === "message" && row.message.role === "assistant") ||
          row.kind === "assistant-meta"
          ? "group/assistant"
          : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={
        row.kind === "message" || row.kind === "assistant-meta" ? row.message.id : undefined
      }
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {isWorkLogRow ? (
        <WorkLogBlock
          continues={row.continuesWorkLog}
          layout={
            isExpandedToolGroup
              ? "group-content"
              : isExpandedToolGroupHeader
                ? "group-header"
                : "standalone"
          }
        >
          {row.kind === "work" ? (
            <WorkGroupSection
              anchorKey={row.id}
              groupedEntries={row.groupedEntries}
              isExpandedToolGroup={row.isExpandedToolGroup}
              displayLabel={row.displayLabel}
            />
          ) : null}
          {row.kind === "work-live" ? <LiveWorkEntryTimelineRow row={row} /> : null}
          {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
          {row.kind === "thinking" ? <ThinkingTimelineRow row={row} /> : null}
        </WorkLogBlock>
      ) : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow key={row.id} row={row} /> : null}
      {row.kind === "attempt-fold" ? <AttemptFoldTimelineRow row={row} /> : null}
      {row.kind === "context-compaction" ? <ContextCompactionTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserMessageRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "assistant-meta" ? <AssistantMetaTimelineRow row={row} /> : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "viewed-images" ? <ViewedImagesTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
      {row.kind === "event" ? <V2EventTimelineRow row={row} /> : null}
    </div>
  );
});

function ContextCompactionTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "context-compaction" }>;
}) {
  const label = row.title ?? row.label;
  const content = (
    <span className="flex min-w-0 items-center gap-1.5">
      {row.failed ? (
        <CircleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
      ) : (
        <Minimize2Icon aria-hidden="true" className="size-3" />
      )}
      {row.tokenCounts ? (
        <>
          {row.title ?? "Context compaction"} {row.tokenCounts.before}
          <ArrowRightIcon aria-hidden="true" className="size-3" />
          {row.tokenCounts.after} tokens
        </>
      ) : (
        label
      )}
      {row.failure ? <span className="min-w-0 truncate opacity-80">, {row.failure}</span> : null}
    </span>
  );
  return (
    <div
      role="separator"
      aria-label={row.failure ? `${label}: ${row.failure}` : label}
      className={cn(
        "mx-auto flex w-full max-w-(--chat-content-max-width) items-center gap-3 py-1 text-xs select-none",
        row.failed ? "text-destructive-foreground" : "text-muted-foreground",
      )}
    >
      <span className={cn("h-px flex-1", row.failed ? "bg-destructive/30" : "bg-border/70")} />
      <span
        ref={row.active ? observeVisibleAnimation : undefined}
        className="relative min-w-0 overflow-hidden"
      >
        {content}
        {row.active ? <ActivityShimmerOverlay>{content}</ActivityShimmerOverlay> : null}
      </span>
      <span className={cn("h-px flex-1", row.failed ? "bg-destructive/30" : "bg-border/70")} />
    </div>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  return (
    <div className="group/timeline-row border-b border-border/60 pb-2 pe-0.5 pt-1 select-none">
      <div className="relative flex items-center gap-1">
        <button
          type="button"
          aria-expanded={row.expanded}
          data-scroll-anchor-ignore
          onClick={() => ctx.onToggleTurnFold(row.runId)}
          className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span>{row.label}</span>
          {row.expanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </button>
        <TimelineRowTimestamp
          createdAt={row.createdAt}
          timestampFormat={ctx.timestampFormat}
          className="ms-auto"
        />
      </div>
    </div>
  );
}

function AttemptFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "attempt-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  return (
    <div>
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        data-superseded-attempt-id={row.attemptId}
        onClick={() => ctx.onToggleAttemptFold(row.attemptId)}
        className="flex w-full cursor-pointer select-none items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {row.expanded ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="text-xs font-medium text-foreground/80">{row.label}</span>
        <span className="text-2xs text-muted-foreground">Interrupted by steer</span>
      </button>
    </div>
  );
}
