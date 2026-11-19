// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/timelineScrollAnchoring.ts
// Local changes: the remembered per-thread positions live in timelinePositions.ts, and the run
// observation for anchoring a newly sent turn is gone (this viewer anchors no new turn).

// Match the titlebar fade inset so the first row keeps its position.
export const CHAT_TIMELINE_ANCHOR_OFFSET = 24;

interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }
  return top + Math.max(1, height);
}

/**
 * The list's own content length includes the bottom inset spacer, so this
 * measures from the last row instead. Unknown row positions or an unmeasured
 * viewport counts as fitting.
 */
export function timelineContentOverflowsViewport(
  state: TimelineListMeasurementState | undefined,
  input: { readonly composerInset: number; readonly anchorOffset: number },
): boolean {
  if (!state || !state.data || state.data.length === 0) {
    return false;
  }
  const scrollLength = state.scrollLength;
  if (typeof scrollLength !== "number" || !Number.isFinite(scrollLength) || scrollLength <= 0) {
    return false;
  }
  const lastIndex = state.data.length - 1;
  // Overflow can use an unmeasured tail's lower bound.
  const lastTop = state.positionAtIndex(lastIndex);
  const lastBottom =
    getRowBottom(state, lastIndex) ??
    (typeof lastTop === "number" && Number.isFinite(lastTop) ? lastTop + 1 : null);
  if (lastBottom === null) {
    return false;
  }
  const visibleScrollLength = Math.max(0, scrollLength - input.composerInset - input.anchorOffset);
  return lastBottom > visibleScrollLength;
}

export function resolveDisclosureRevealScrollDelta({
  rowTop,
  rowBottom,
  viewportTop,
  viewportBottom,
  composerOverlayHeight,
  anchorOffset,
}: {
  readonly rowTop: number;
  readonly rowBottom: number;
  readonly viewportTop: number;
  readonly viewportBottom: number;
  readonly composerOverlayHeight: number;
  readonly anchorOffset: number;
}): number {
  const hiddenBelow = rowBottom - (viewportBottom - composerOverlayHeight);
  if (!(hiddenBelow > 0)) return 0;
  const roomAbove = rowTop - (viewportTop + anchorOffset);
  return Math.max(0, Math.min(hiddenBelow, roomAbove));
}

// A streaming reply moves the end every frame, so the target may never hold
// still. Past this many frames the list's own end maintenance takes over.
const SETTLE_MAX_FRAMES = 60;

/**
 * Re-applies a target scroll offset over a few frames until the list stops moving.
 * Source: apps/web/src/components/chat/useTimelinePositionRestore.ts (settleListScroll).
 */
export function settleListScroll(
  list: {
    getScrollableNode(): HTMLElement | null;
    scrollToOffset(params: { offset: number; animated?: boolean }): Promise<void> | void;
  },
  target: (element: HTMLElement) => number | undefined,
  isCancelled: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    let stableFrames = 0;
    let frames = 0;
    const reconcile = () => {
      if (isCancelled()) return resolve();
      const element = list.getScrollableNode();
      const offset = element ? target(element) : undefined;
      frames += 1;
      if (!element || offset === undefined || frames > SETTLE_MAX_FRAMES) return resolve();
      if (Math.abs(element.scrollTop - offset) > 1) {
        stableFrames = 0;
        void Promise.resolve(list.scrollToOffset({ offset, animated: false })).then(() => {
          requestAnimationFrame(reconcile);
        });
        return;
      }
      stableFrames += 1;
      if (stableFrames >= 2) resolve();
      else requestAnimationFrame(reconcile);
    };
    requestAnimationFrame(reconcile);
  });
}

export const measuredEndOffset = (element: HTMLElement) =>
  element.scrollHeight - element.clientHeight;
