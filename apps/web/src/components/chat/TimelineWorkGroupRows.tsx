// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/TimelineWorkGroupRows.tsx
// Local changes: read-only viewer. Pending approval rows, worktree setup, viewed image galleries
// and T3 thread-read labels are gone. Compact reasoning previews are plain text
// (`thoughtPreviewText`) because ChatMarkdown here takes no extra remark plugins. The working
// timer reads this machine's clock. UI text is Korean.
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { Minimize2Icon, XIcon } from "lucide-react";
import { memo, use, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { tickTextContent } from "~/lib/tickTextContent";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { liveThoughtLine } from "../../client-runtime/work-log/presentation.ts";
import { resolveWorkGroupScrollAnchor } from "../../client-runtime/work-log/scrollAnchor.ts";
import { workEntryDisplayIndicatesToolFailure } from "../../session-logic.ts";
import type { TimestampFormat } from "../../timestampFormat";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import {
  liveWorkEntryLabel,
  resolveWorkGroupScrollIndex,
  shouldFollowWorkGroupAppend,
  workEntryIsVisibleInGroup,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import {
  TimelineRowActivityCtx,
  TimelineRowCtx,
  WorkGroupViewCtx,
  type TimelineRow,
  type TimelineWorkEntry,
} from "./timelineRowContext";
import { ActivityShimmerOverlay, TimelineRowTimestamp } from "./TimelineRowParts";
import {
  failedToolIconClassName,
  toolIconAcceptsTint,
  ToolActivityIconView,
  type WorkEntryIconName,
} from "./TimelineToolActivityIcon";
import { BackgroundButton } from "./BackgroundButton";
import { ReasoningTraceContent, SimpleWorkEntryRow } from "./TimelineWorkEntryRow";
import {
  THOUGHT_PREVIEW_SOURCE_MAX_LENGTH,
  thoughtPreviewText,
  toolGroupSummaryIconName,
  workEntryIconName,
} from "./TimelineWorkEntryRow.logic";
import { formatWorkingTimerNow } from "./TimelineWorkGroupRows.logic";
import { WorkLogButton, WorkLogList, WorkLogRow } from "./WorkLog";

export const WorkGroupSection = memo(function WorkGroupSection({
  anchorKey,
  disclosureAnchorKey = anchorKey,
  groupedEntries,
  isExpandedToolGroup,
  displayLabel,
}: {
  anchorKey: string;
  disclosureAnchorKey?: string;
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
  isExpandedToolGroup: boolean;
  displayLabel?: string | undefined;
}) {
  const { workspaceRoot, routeThreadKey, onToggleWorkEntry, onWorkEntryContentReady } =
    use(TimelineRowCtx);
  const nonEmptyEntries = groupedEntries.filter((entry) =>
    workEntryIsVisibleInGroup(entry, isExpandedToolGroup),
  );

  if (nonEmptyEntries.length === 0) return null;
  if (isExpandedToolGroup && nonEmptyEntries.every((entry) => entry.itemType === "reasoning")) {
    return <ReasoningTraceContent entries={nonEmptyEntries} />;
  }
  if (isExpandedToolGroup) {
    return (
      <ExpandedWorkGroupEntries
        key={`${routeThreadKey}:${anchorKey}`}
        anchorKey={anchorKey}
        disclosureAnchorKey={disclosureAnchorKey}
        entries={nonEmptyEntries}
        workspaceRoot={workspaceRoot}
      />
    );
  }

  return (
    <section aria-label="Activity">
      {nonEmptyEntries.map((workEntry) => (
        <SimpleWorkEntryRow
          key={workEntry.id}
          workEntry={workEntry}
          workspaceRoot={workspaceRoot}
          displayLabel={displayLabel}
          onToggleEntry={(collapsed) =>
            onToggleWorkEntry(disclosureAnchorKey, collapsed, workEntry.id)
          }
          onContentReady={() => onWorkEntryContentReady?.(disclosureAnchorKey, workEntry.id)}
        />
      ))}
    </section>
  );
});

function WorkingTimer({ createdAt }: { createdAt: string }) {
  return (
    <span
      ref={tickTextContent((nowMs) => formatWorkingTimerNow(createdAt, nowMs), true)}
      className="tabular-nums"
    />
  );
}

const compactWorkEntryHeight = 24;

function ExpandedWorkGroupEntries({
  anchorKey,
  disclosureAnchorKey,
  entries,
  workspaceRoot,
}: {
  anchorKey: string;
  disclosureAnchorKey: string;
  entries: TimelineWorkEntry[];
  workspaceRoot: string | undefined;
}) {
  const {
    workGroupViewState: viewState,
    onToggleWorkEntry,
    onWorkEntryContentReady,
  } = use(TimelineRowCtx);
  const [initialScrollIndex] = useState(() =>
    resolveWorkGroupScrollIndex(entries, viewState.scrollPositions.get(anchorKey)),
  );
  const [restoringPosition, setRestoringPosition] = useState(initialScrollIndex !== undefined);
  const listRef = useRef<LegendListRef>(null);
  const [expandedContentHeight, setExpandedContentHeight] = useState(0);
  const [fades, setFades] = useState({ top: false, bottom: false, viewportHeight: 0 });
  const [appendState, setAppendState] = useState({ entries, follow: false });
  // Capture the pre-change edge once per incoming array, before new layout
  // metrics arrive. Edge/viewport changes never turn a status update into a follow.
  if (appendState.entries !== entries) {
    setAppendState({
      entries,
      follow:
        fades.viewportHeight > 0 &&
        shouldFollowWorkGroupAppend(appendState.entries, entries, fades.bottom ? Infinity : 0),
    });
  }

  const groupView = {
    state: viewState,
    onToggleEntry: (collapsed: boolean, entryId: string) =>
      onToggleWorkEntry(disclosureAnchorKey, collapsed, entryId),
    onContentReady: (entryId: string) => onWorkEntryContentReady?.(disclosureAnchorKey, entryId),
  };
  const updateScrollFades = () => {
    const element = listRef.current?.getScrollableNode();
    if (!element) return;
    const distanceFromEnd = element.scrollHeight - element.clientHeight - element.scrollTop;
    const viewportHeight = element.clientHeight;
    const top = element.scrollTop > 1;
    const bottom = distanceFromEnd > 1;
    setFades((previous) =>
      previous.top === top &&
      previous.bottom === bottom &&
      previous.viewportHeight === viewportHeight
        ? previous
        : { top, bottom, viewportHeight },
    );
  };

  const handleScroll = () => {
    const state = listRef.current?.getState();
    const position = state && resolveWorkGroupScrollAnchor(state);
    if (position) {
      viewState.scrollPositions.set(anchorKey, {
        entryId: position.rowId,
        offset: position.offsetWithinRow,
      });
    }
    updateScrollFades();
  };

  const handleLoad = () => {
    const list = listRef.current;
    const element = list?.getScrollableNode();
    if (initialScrollIndex && list && element) {
      // Bootstrap can report the restored target before the DOM has applied it.
      // Reconcile once at load, before releasing the measured anchor row.
      const offset = Math.max(
        0,
        Math.min(list.getState().scroll, element.scrollHeight - element.clientHeight),
      );
      if (Math.abs(element.scrollTop - offset) > 1) {
        void list.scrollToOffset({ offset, animated: false });
      }
    }
    setRestoringPosition(false);
  };

  const updateScrollFadesStable = useStableCallback(updateScrollFades);
  // Observes the list scroller and its content with ResizeObserver to update scroll fades.
  useLayoutEffect(() => {
    const element = listRef.current?.getScrollableNode();
    if (!element) return;
    updateScrollFadesStable();
    const content = element.firstElementChild;
    return observeResize(content ? [element, content] : element, updateScrollFadesStable);
  }, [updateScrollFadesStable]);

  const renderEntry = ({ item }: { item: TimelineWorkEntry }) => (
    <SimpleWorkEntryRow key={item.id} workEntry={item} workspaceRoot={workspaceRoot} />
  );

  const updateExpandedContentHeight = () => {
    const state = listRef.current?.getState();
    let height = 0;
    for (const entryId of viewState.expandedEntries) {
      if (state?.indexByKey(entryId) === undefined) continue;
      height += Math.max(
        0,
        (state.sizes.get(entryId) ?? compactWorkEntryHeight) - compactWorkEntryHeight,
      );
    }
    setExpandedContentHeight((current) => (current === height ? current : height));
  };

  // Reads expanded row sizes from LegendList's measured state after layout.
  useLayoutEffect(updateExpandedContentHeight, [entries]);

  return (
    <WorkGroupViewCtx value={groupView}>
      <WorkLogList>
        <LegendList
          ref={listRef}
          data={entries}
          extraData={workspaceRoot}
          keyExtractor={workEntryKey}
          renderItem={renderEntry}
          estimatedItemSize={compactWorkEntryHeight}
          drawDistance={240}
          recycleItems
          {...(initialScrollIndex ? { initialScrollIndex } : {})}
          maintainScrollAtEnd={
            appendState.follow ? { animated: false, on: { dataChange: true } } : false
          }
          maintainScrollAtEndThreshold={1 / Math.max(1, fades.viewportHeight)}
          // Measure the restored row even when an intra-row offset puts its
          // estimated bounds outside the list's small bootstrap render window.
          {...(restoringPosition && initialScrollIndex
            ? { alwaysRender: { indices: [initialScrollIndex.index] } }
            : {})}
          maintainVisibleContentPosition
          onLoad={handleLoad}
          onScroll={handleScroll}
          onLayout={updateScrollFades}
          onItemSizeChanged={updateExpandedContentHeight}
          tabIndex={0}
          role="region"
          aria-label="Tool call"
          data-tool-group-scroll
          style={{ maxHeight: `calc(min(18rem, 50dvh) + ${expandedContentHeight}px)` }}
          className={cn(
            "scrollbar-gutter-stable scroll-py-6 overflow-x-hidden rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            getVirtualizedScrollFadeClassName(fades),
          )}
        />
      </WorkLogList>
    </WorkGroupViewCtx>
  );
}

const workEntryKey = (entry: TimelineWorkEntry) => entry.id;

export function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const { isCompacting } = use(TimelineRowActivityCtx);
  const compacting = row.compacting === true || isCompacting;
  const label = compacting ? (
    <CompactingLabel createdAt={row.createdAt} />
  ) : row.createdAt ? (
    <>
      Working for <WorkingTimer createdAt={row.createdAt} />
    </>
  ) : (
    "Working"
  );
  return (
    <div className="border-b border-border/60 pb-2 pt-1 select-none">
      <div className="flex min-h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
        <span
          ref={compacting ? observeVisibleAnimation : undefined}
          className="relative shrink-0 overflow-hidden whitespace-nowrap"
        >
          {label}
          {compacting ? <ActivityShimmerOverlay>{label}</ActivityShimmerOverlay> : null}
        </span>
      </div>
    </div>
  );
}

function CompactingLabel({ createdAt }: { createdAt: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Minimize2Icon aria-hidden="true" className="size-3" />
      {createdAt ? (
        <span>
          Compacting context <WorkingTimer createdAt={createdAt} />
        </span>
      ) : (
        "Compacting context"
      )}
    </span>
  );
}

export function ThinkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "thinking" }> }) {
  const ctx = use(TimelineRowCtx);
  const { isCompacting, liveAnswerPreview } = use(TimelineRowActivityCtx);
  if (isCompacting) return <WorkLogRow label="" />;
  const activity = (
    <LiveActivityRow
      label={row.label ?? liveAnswerPreview ?? "Thinking"}
      iconName="brain"
      active
      shimmer
    />
  );
  const { groupId } = row;
  if (groupId === undefined) return activity;
  return (
    <button
      type="button"
      className="group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      aria-expanded={row.expanded === true}
      onClick={() => ctx.onToggleWorkGroup(groupId, row.id)}
    >
      {activity}
    </button>
  );
}

function LiveActivityRow({
  label,
  iconName,
  failed = false,
  active = false,
  shimmer = false,
}: {
  label: ReactNode;
  iconName?: WorkEntryIconName;
  failed?: boolean;
  active?: boolean;
  shimmer?: boolean;
}) {
  const animated = active && !failed;
  const showShimmer = animated && shimmer;
  return (
    <div
      ref={animated ? observeVisibleAnimation : undefined}
      className="relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed"
    >
      <LiveActivityContent
        label={label}
        iconName={iconName}
        failed={failed}
        announceFailure={failed}
        active={animated && !shimmer}
      />
      {showShimmer ? (
        <ActivityShimmerOverlay>
          <LiveActivityContent label={label} iconName={iconName} highlighted />
        </ActivityShimmerOverlay>
      ) : null}
    </div>
  );
}

function LiveActivityContent({
  label,
  iconName,
  failed = false,
  announceFailure = false,
  active = false,
  highlighted = false,
}: {
  label: ReactNode;
  iconName: WorkEntryIconName | undefined;
  failed?: boolean;
  announceFailure?: boolean;
  active?: boolean;
  highlighted?: boolean;
}) {
  const showTrailingFailureMark =
    failed && iconName !== undefined && !toolIconAcceptsTint(undefined);

  return (
    <WorkLogRow
      icon={
        iconName ? (
          <span
            className={cn(
              "flex size-4 items-center justify-center",
              failed
                ? failedToolIconClassName
                : highlighted
                  ? "text-foreground"
                  : "text-icon-muted",
            )}
            role={announceFailure ? "img" : undefined}
            aria-label={announceFailure ? "Tool call failed" : undefined}
          >
            <ToolActivityIconView
              fallbackName={iconName}
              className="block size-4 shrink-0 stroke-2"
              muted={!highlighted}
            />
          </span>
        ) : null
      }
      label={
        <span
          className={cn(
            "block truncate",
            highlighted && "text-foreground",
            active && "live-tool-shine",
          )}
        >
          {label}
        </span>
      }
      trailing={
        showTrailingFailureMark ? (
          <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
        ) : null
      }
    />
  );
}

export function LiveWorkEntryTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-live" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const label = liveWorkEntryLabel(row.entry, ctx.workspaceRoot, row.active);
  const failed = workEntryDisplayIndicatesToolFailure(row.entry);
  const thoughtLine =
    row.thought && !row.expanded
      ? liveThoughtLine((row.thought.detail ?? "").slice(0, THOUGHT_PREVIEW_SOURCE_MAX_LENGTH))
      : "";
  const thoughtIsStatus = thoughtLine !== "" && row.entry === row.thought;
  // The row is a button, so "백그라운드로" for a foreground Bash call sits beside it (DESIGN.md 4.5).
  const payload = row.entry.structuredPayload;
  const foregroundCommand = row.active && payload?.type === "command_execution" && payload.status === "running" ? payload : null;

  const liveRow = (
    <button
      type="button"
      className={cn(
        "group/live-work flex w-full max-w-full cursor-pointer rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        thoughtLine ? "flex-col items-start" : "min-h-6 items-center",
      )}
      aria-label={
        failed ? `${thoughtLine ? `${thoughtLine} ` : ""}${label}, tool call failed` : undefined
      }
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    >
      {thoughtLine ? (
        <WorkLogRow
          icon={
            <span className="flex size-4 items-center justify-center text-icon-muted">
              <ToolActivityIconView
                fallbackName="brain"
                className="block size-4 shrink-0 stroke-2"
                muted
              />
            </span>
          }
          label={<span className="line-clamp-4">{thoughtPreviewText(thoughtLine, "Thought")}</span>}
          wrapLabel
        />
      ) : null}
      <LiveActivityRow
        label={
          thoughtIsStatus
            ? row.active
              ? "Thinking"
              : "Thought"
            : row.entry.itemType === "reasoning"
              ? thoughtPreviewText(row.entry.detail ?? label, row.active ? "Thinking" : "Thought")
              : label
        }
        iconName={workEntryIconName(row.entry)}
        failed={failed}
        active={row.active}
      />
    </button>
  );
  if (foregroundCommand === null) return liveRow;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">{liveRow}</div>
      <BackgroundButton itemId={foregroundCommand.id} kind="command" />
    </div>
  );
}

export function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <WorkGroupHeader
      label={row.summary}
      iconName={toolGroupSummaryIconName(row.summaryKind)}
      failed={row.hasFailure}
      expanded={row.expanded}
      createdAt={row.createdAt}
      timestampFormat={ctx.timestampFormat}
      onToggle={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    />
  );
}

function WorkGroupHeader(props: {
  label: string;
  iconName: WorkEntryIconName;
  failed?: boolean | undefined;
  expanded: boolean;
  createdAt: string;
  timestampFormat: TimestampFormat;
  onToggle: () => void;
}) {
  return (
    <WorkLogButton
      aria-label={props.failed ? `${props.label}, tool call failed` : props.label}
      aria-expanded={props.expanded}
      onClick={props.onToggle}
      icon={
        <ToolActivityIconView
          fallbackName={props.iconName}
          className="size-4 shrink-0 stroke-2 text-icon-muted"
          muted
        />
      }
      label={<span className="block truncate">{props.label}</span>}
      trailing={
        <TimelineRowTimestamp createdAt={props.createdAt} timestampFormat={props.timestampFormat} />
      }
    />
  );
}
