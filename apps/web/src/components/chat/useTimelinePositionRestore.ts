// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/useTimelinePositionRestore.ts (startTimelinePositionRestore).
// Local changes: maru mounts a list per thread visit, so the live end needs no restore here (the
// list opens there with initialScrollAtEnd); this only brings back a position away from the end.
// There is no citation or find to hand positioning to. settleListScroll lives in
// timelineScrollAnchoring.ts.
import type { LegendListRef } from "@legendapp/list/react";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { measuredEndOffset, settleListScroll } from "./timelineScrollAnchoring";
import type { RememberedTimelinePosition } from "./timelinePositions";
import type { TimelineViewport } from "./timelineViewport";

/**
 * Scrolls a newly shown thread back to the row the reader left at the top, and reports the thread
 * positioned once that row settles. Any navigation on the viewport cancels it where it is. A row
 * that is gone (history rewritten) falls back to the remembered offset. Returns the cancel for the
 * operation's owner.
 */
export function startTimelinePositionRestore({
  list,
  viewport,
  listIdentityKey,
  rememberedPosition: position,
  onPositioned,
}: {
  readonly list: LegendListRef;
  readonly viewport: TimelineViewport;
  readonly listIdentityKey: string;
  readonly rememberedPosition: RememberedTimelinePosition;
  readonly onPositioned: (identity: string) => void;
}): () => void {
  let cancelled = false;
  const rows = list.getState().data as ReadonlyArray<MessagesTimelineRow>;
  const index = rows.findIndex((row) => row.id === position.rowId);
  // Reading history: follow lets go before the restore claims the viewport.
  viewport.navigate({ releasesFollow: true });
  const releaseScrollHold = viewport.holdProgrammaticScroll();
  const stop = () => {
    cancelled = true;
    releaseScrollHold();
    unsubscribe();
  };
  const unsubscribe = viewport.subscribe(() => {
    if (cancelled) return;
    stop();
    void list.scrollToOffset({ offset: viewport.scrollNode.scrollTop, animated: false });
    onPositioned(listIdentityKey);
  });
  const finish = () => {
    stop();
    onPositioned(listIdentityKey);
  };
  const scrolling =
    index >= 0
      ? list.scrollToIndex({
          index,
          animated: false,
          viewPosition: 0,
          viewOffset: -position.offsetWithinRow,
        })
      : list.scrollToOffset({ offset: position.scrollOffset, animated: false });
  void Promise.resolve(scrolling).then(async () => {
    if (cancelled) return;
    if (index >= 0) {
      // Keep the saved row mounted until its measured position and the DOM agree.
      await settleListScroll(
        list,
        (element) => {
          const state = list.getState();
          const rowIndex = state.indexByKey(position.rowId);
          const row = rowIndex === undefined ? undefined : state.elementAtIndex(rowIndex);
          if (!row) return undefined;
          return Math.max(
            0,
            Math.min(
              element.scrollTop +
                row.getBoundingClientRect().top -
                element.getBoundingClientRect().top +
                position.offsetWithinRow,
              measuredEndOffset(element),
            ),
          );
        },
        () => cancelled,
      );
    }
    if (!cancelled) finish();
  });
  return stop;
}
