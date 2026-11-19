// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/useTimelineFollow.ts
// Local changes: a read-only viewer sends no turns, so anchoring a newly sent turn near the top,
// the composer page-scroll keys and the composer inset are gone. A visit starts following the end
// unless the thread was left away from it (timelinePositions.ts), as in T3; the first visit of a
// mounted timeline reads that too, since maru mounts the timeline per visit. The
// @tanstack/react-pacer Debouncer that delays the "scroll to end" pill is a small setTimeout
// debouncer.
import type { LegendListRef } from "@legendapp/list/react";
import { useRef, useState, useSyncExternalStore, type RefObject } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  measuredEndOffset,
  settleListScroll,
  timelineContentOverflowsViewport,
} from "./timelineScrollAnchoring";
import { readTimelinePosition } from "./timelinePositions";
import {
  FOLLOWING,
  initialTimelineFollow,
  navigationReleasesFollow,
  transitionTimelineFollow,
  type TimelineFollow,
  type TimelineFollowEvent,
  type TimelineNavigation,
  type TimelineViewport,
} from "./timelineViewport";

/** Stands in for @tanstack/react-pacer's Debouncer: run once `wait` ms after the last call. */
function createDebouncer(fn: () => void, wait: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    maybeExecute() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, wait);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** One visit to a thread; a switch starts a new one. */
interface TimelineFollowVisit {
  readonly threadKey: string;
  readonly followEnd: boolean;
}

/**
 * Scroll bookkeeping that belongs to one visit. Handlers fetch it for the
 * current visit, so a thread switch leaves the old one behind instead of
 * resetting it.
 */
function createVisitScrollState(
  visit: TimelineFollowVisit,
  showScrollToBottom: (visit: TimelineFollowVisit) => void,
) {
  return {
    visit,
    // Debounce *showing* the scroll-to-bottom pill so it doesn't flash during
    // thread switches. LegendList fires scroll events with isAtEnd=false while
    // initialScrollAtEnd is settling; hiding is always immediate.
    showScrollDebouncer: createDebouncer(() => showScrollToBottom(visit), 150),
  };
}
type VisitScrollState = ReturnType<typeof createVisitScrollState>;

/**
 * The follow mode, read by scroll listeners at event time and by render
 * through useSyncExternalStore. State recorded for an earlier visit is
 * discarded, so a thread switch needs no reset step.
 */
function createTimelineFollowStore() {
  let snapshot: { readonly visit: TimelineFollowVisit | null; readonly follow: TimelineFollow } = {
    visit: null,
    follow: FOLLOWING,
  };
  const listeners = new Set<() => void>();
  const read = (visit: TimelineFollowVisit) =>
    snapshot.visit === visit ? snapshot.follow : initialTimelineFollow(visit.followEnd);
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    read,
    dispatch: (visit: TimelineFollowVisit, event: TimelineFollowEvent) => {
      const before = read(visit);
      const after = transitionTimelineFollow(before, event);
      if (snapshot.visit !== visit || after !== snapshot.follow) {
        snapshot = { visit, follow: after };
        for (const listener of listeners) listener();
      }
      return { before, after };
    },
  };
}

interface TimelineFollowInput {
  readonly legendListRef: RefObject<LegendListRef | null>;
  /** The thread the list shows. */
  readonly threadKey: string;
}

/**
 * Keeps the timeline following the live end and lets the user scroll away.
 * Follow lives in a store the viewport's navigation signal writes, so a scroll
 * gesture does not re-render the view unless the follow mode flips.
 */
export function useTimelineFollow(input: TimelineFollowInput) {
  const { legendListRef, threadKey } = input;
  const [visitState, setVisit] = useState<TimelineFollowVisit>(() => ({
    threadKey,
    followEnd: readTimelinePosition(threadKey)?.atEnd !== false,
  }));
  let visit = visitState;
  if (visit.threadKey !== threadKey) {
    visit = { threadKey, followEnd: readTimelinePosition(threadKey)?.atEnd !== false };
    setVisit(visit);
  }
  // Keyed by visit, so a pill decision from the previous thread (a pending
  // debounce) never shows here. A first visit left away from the end shows it at once, as a later
  // visit does.
  const [pill, setPill] = useState<{ readonly visit: TimelineFollowVisit; readonly show: boolean }>(
    () => ({ visit, show: !visit.followEnd }),
  );
  const showScrollToBottom = pill.visit === visit ? pill.show : !visit.followEnd;
  // Called on every streamed chunk while following; an unchanged pill must bail out.
  const setShowScrollToBottom = (show: boolean) =>
    setPill((current) =>
      current.visit === visit && current.show === show ? current : { visit, show },
    );
  const [followStore] = useState(createTimelineFollowStore);
  const followSnapshot = useSyncExternalStore(followStore.subscribe, followStore.snapshot);
  const follow =
    followSnapshot.visit === visit ? followSnapshot.follow : initialTimelineFollow(visit.followEnd);
  const timelineLiveFollowEnabled = follow.mode === "following";
  const readFollow = () => followStore.read(visit);
  // Async settles outlive their render; this reads the visit shown now.
  const readCurrentFollow = useStableCallback(readFollow);
  const visitScrollRef = useRef<VisitScrollState | null>(null);
  /** Only from handlers: the bookkeeping of the visit they run in. */
  const visitScroll = () => {
    if (visitScrollRef.current?.visit !== visit) {
      visitScrollRef.current?.showScrollDebouncer.cancel();
      visitScrollRef.current = createVisitScrollState(visit, (shownVisit) => {
        // A debounce that outlived its visit must not overwrite the current one's pill.
        if (visitScrollRef.current?.visit === shownVisit)
          setPill({ visit: shownVisit, show: true });
      });
    }
    return visitScrollRef.current;
  };
  const viewportRef = useRef<TimelineViewport | null>(null);
  const releaseFollowForNavigation = () => {
    const { before } = followStore.dispatch(visit, { type: "navigated" });
    if (before.mode === "following") {
      viewportRef.current?.followReleased();
      legendListRef.current?.cancelScroll();
    }
  };

  const timelineRealContentOverflowsViewport = () =>
    timelineContentOverflowsViewport(legendListRef.current?.getState(), {
      composerInset: 0,
      anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
    });

  const scrollToEnd = (animated: boolean = false) => {
    // Re-arms follow; the scroll below lands on the measured end.
    viewportRef.current?.navigate({ releasesFollow: false });
    followStore.dispatch(visit, { type: "followEnd" });
    visitScroll().showScrollDebouncer.cancel();
    setShowScrollToBottom(false);
    requestAnimationFrame(() => {
      const list = legendListRef.current;
      if (!list) return;
      void Promise.resolve(
        list.scrollToEnd?.({
          animated: animated && !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        }),
      ).then(() =>
        settleListScroll(
          list,
          measuredEndOffset,
          () => readCurrentFollow().mode !== "following" || legendListRef.current !== list,
        ),
      );
    });
  };

  const handleNavigation = (navigation: TimelineNavigation) => {
    const awayFromEnd = () => resolveTimelineIsAtEnd(legendListRef.current?.getState()) === false;
    const releases = navigationReleasesFollow(navigation, {
      contentScrollsUp: timelineRealContentOverflowsViewport,
      awayFromEnd,
    });
    if (releases) releaseFollowForNavigation();
  };
  const handleNavigationStable = useStableCallback(handleNavigation);
  /**
   * Attached by the timeline's list ref callback, so follow hears the
   * viewport's navigation exactly as long as the scroll node exists.
   */
  const attachTimelineViewport = (viewport: TimelineViewport) => {
    viewportRef.current = viewport;
    const unsubscribe = viewport.subscribe(handleNavigationStable);
    return () => {
      unsubscribe();
      if (viewportRef.current === viewport) viewportRef.current = null;
    };
  };

  const onIsAtEndChange = (isAtEnd: boolean) => {
    const scroll = visitScroll();
    if (!isAtEnd && readFollow().mode === "following") {
      scroll.showScrollDebouncer.cancel();
      setShowScrollToBottom(false);
      return;
    }
    const { before, after } = followStore.dispatch(visit, {
      type: isAtEnd ? "reachedEnd" : "leftEnd",
    });
    if (after === before) return;
    if (after.mode === "following") {
      scroll.showScrollDebouncer.cancel();
      setShowScrollToBottom(false);
    } else {
      scroll.showScrollDebouncer.maybeExecute();
    }
  };
  const onIsAtEndChangeStable = useStableCallback(onIsAtEndChange);

  return {
    showScrollToBottom,
    timelineLiveFollowEnabled,
    scrollToEnd,
    onIsAtEndChangeStable,
    attachTimelineViewport,
  };
}
