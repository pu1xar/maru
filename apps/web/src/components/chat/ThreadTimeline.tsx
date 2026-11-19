// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/ThreadTimeline.tsx, with the follow wiring T3's
// ChatView.tsx does around it (useTimelineFollow and the scroll to end pill). The run inputs come
// from session-logic deriveThreadTimelineRunState.
// Local changes: the input is one ThreadSnapshot from /ws instead of thread atoms; there are no
// optimistic messages, no composer, no thread switch cache and no anchored new turn. Scrolling
// near the top, or the history control, asks for the previous page.
import type { ThreadSnapshot } from "@maru/shared";
import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useMemo, useRef } from "react";

import { useIncrementalTimelineEntries } from "~/hooks/useIncrementalTimelineEntries";
import { useStableCallback } from "~/hooks/useStableCallback";
import { deriveThreadTimelineRunState } from "../../session-logic.ts";
import type { ChatMessage } from "../../types.ts";
import { useQueuedMessages, useSentCount } from "~/lib/queuedMessages";
import { addedQueuedIds, sendBringsEnd } from "~/lib/queuedMessages.logic";
import { MessagesTimeline, type MessagesTimelineHistoryControls } from "./MessagesTimeline";
import { QueuedMessages } from "./QueuedMessages";
import { ScrollToEndButton } from "./TimelineOverlays";
import { useTimelineFollow } from "./useTimelineFollow";
import type { FindTimelineProps } from "./useThreadFind";

const EMPTY_OPTIMISTIC_MESSAGES: ReadonlyArray<ChatMessage> = [];

export function ThreadTimeline(props: {
  snapshot: ThreadSnapshot;
  cwd: string | undefined;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onOpenChildThread: (childThreadId: string) => void;
  /** Find in the thread (DESIGN.md 6u). */
  find?: FindTimelineProps | null;
  /** No banner sits above the timeline, so it fades out under the header (T3 ChatView). */
  topFadeEnabled: boolean;
}) {
  const { snapshot } = props;
  const listRef = useRef<LegendListRef | null>(null);
  const timelineEntries = useIncrementalTimelineEntries(snapshot.threadId, {
    visibleTurnItems: snapshot.visibleTurnItems,
    optimisticMessages: EMPTY_OPTIMISTIC_MESSAGES,
  });
  const { latestRun, isWorking, activeTurnStartedAt, runningRunId, runlessWorkActive } =
    deriveThreadTimelineRunState(snapshot);
  const follow = useTimelineFollow({ legendListRef: listRef, threadKey: snapshot.threadId });
  const onOpenThread = useStableCallback((threadId: string) => props.onOpenChildThread(threadId));
  const onLoadEarlier = useStableCallback(() => props.onLoadOlder());
  // The messages that wait sit in the list's footer (DESIGN.md 4.4).
  const footer = useMemo(
    () => <QueuedMessages sessionKey={snapshot.threadId} items={snapshot.visibleTurnItems} />,
    [snapshot.threadId, snapshot.visibleTurnItems],
  );
  // The list does not follow its footer's growth on its own (T3 ChatView does the same for its
  // footer rows): a new waiting message scrolls to the end while the reader is there.
  const queued = useQueuedMessages(snapshot.threadId);
  const seenQueued = useRef<ReadonlySet<string>>(new Set(queued.map((s) => s.id)));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows a list change the LegendList does not track
  useEffect(() => {
    const added = addedQueuedIds(seenQueued.current, queued);
    seenQueued.current = new Set(queued.map((s) => s.id));
    if (added.length > 0 && follow.timelineLiveFollowEnabled) follow.scrollToEnd(true);
  }, [queued, follow]);
  // A message sent from this page brings the end into view, also from a scrolled-up reader: the
  // waiting row and the model's answer both land there.
  const sentCount = useSentCount(snapshot.threadId);
  const seenSent = useRef(sentCount);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a send is an event of the composer, not state of this list
  useEffect(() => {
    const before = seenSent.current;
    seenSent.current = sentCount;
    if (sendBringsEnd(before, sentCount)) follow.scrollToEnd(true);
  }, [sentCount, follow]);
  const historyControls: MessagesTimelineHistoryControls | undefined =
    snapshot.hasMoreBefore || props.loadingOlder
      ? {
          hasMoreHistory: snapshot.hasMoreBefore,
          loading: props.loadingOlder,
          error: null,
          onLoadEarlier,
        }
      : undefined;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <MessagesTimeline
        listRef={listRef}
        routeThreadKey={snapshot.threadId}
        timelineEntries={timelineEntries}
        latestRun={latestRun}
        runningRunId={runningRunId}
        isWorking={isWorking}
        runlessWorkActive={runlessWorkActive}
        activeTurnStartedAt={activeTurnStartedAt}
        markdownCwd={props.cwd}
        workspaceRoot={props.cwd}
        subagents={snapshot.subagents}
        onOpenThread={onOpenThread}
        historyControls={historyControls}
        topFadeEnabled={props.topFadeEnabled}
        liveFollowEnabled={follow.timelineLiveFollowEnabled}
        onIsAtEndChange={follow.onIsAtEndChangeStable}
        onViewportAttach={follow.attachTimelineViewport}
        footer={footer}
        find={props.find ?? null}
      />
      {follow.showScrollToBottom ? (
        <ScrollToEndButton bottom={8} summary={null} onScrollToEnd={() => follow.scrollToEnd(true)} />
      ) : null}
    </div>
  );
}
