// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/timelineViewport.ts and the focus selectors of
// apps/web/src/components/chat/composerFocusRedirect.ts.
// Local changes: scroll keys come from a window keydown listener (T3 observes them through its
// shortcut dispatcher), there is no side chat pane, and embedded html-render frames do not exist,
// so their resize messages are not heard.
import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic.ts";
import { createUpwardScrollDetector, isTimelineScrollTarget } from "./timelineScrollTarget.ts";

const TYPE_TO_FOCUS_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");
// Closed popups can stay mounted; match only open or closing layers.
const TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR = [
  '[role="dialog"][aria-modal="true"]',
  '[data-slot="alert-dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="command-dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="sheet-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="sidebar"][data-mobile="true"]:is([data-open],[data-ending-style])',
  '[data-slot="menu-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="select-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="popover-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="combobox-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="autocomplete-popup"]:is([data-open],[data-ending-style])',
].join(",");

function eventPathContainsSelector(event: Event, selector: string): boolean {
  const path = event.composedPath();
  if (path.length === 0 && event.target) {
    path.push(event.target);
  }
  return path.some((target) => target instanceof Element && target.closest(selector));
}

/**
 * Which thread the mounted timeline list opened on. LegendList's
 * initialScrollAtEnd only measures for that thread; once the same list shows
 * another thread the opening no longer applies, even if it later returns.
 */
export type TimelineListOpening =
  | { readonly mounted: false }
  | { readonly mounted: true; readonly identity: string | null };

export function nextListOpening(
  current: TimelineListOpening,
  listMounted: boolean,
  identity: string,
): TimelineListOpening {
  if (!listMounted) return current.mounted ? { mounted: false } : current;
  if (!current.mounted) return { mounted: true, identity };
  if (current.identity !== null && current.identity !== identity) {
    return { mounted: true, identity: null };
  }
  return current;
}

export type TimelineScrollDirection = "up" | "down";

/**
 * One user attempt to move the timeline. Gestures come from the viewport's own
 * listeners; "command" is a UI action that is about to move it (scroll to end).
 */
export type TimelineNavigation =
  | { readonly source: "wheel"; readonly direction: TimelineScrollDirection }
  | { readonly source: "touch" }
  | { readonly source: "pointer"; readonly onScrollbar: boolean }
  | { readonly source: "key"; readonly key: string; readonly direction: TimelineScrollDirection }
  | { readonly source: "scroll" }
  | { readonly source: "command"; readonly releasesFollow: boolean };

export interface TimelineViewport {
  readonly scrollNode: HTMLElement;
  /** Every consumer hears the same navigation, in subscription order. */
  readonly subscribe: (listener: (navigation: TimelineNavigation) => void) => () => void;
  readonly navigate: (options: { readonly releasesFollow: boolean }) => void;
  /**
   * Marks our own scrolling (restoring a position) so the upward scroll it
   * causes is not read as the user's. Returns the release.
   */
  readonly holdProgrammaticScroll: () => () => void;
  /** Follow announces letting go, so the list can remember it is reading history. */
  readonly followReleased: () => void;
  readonly onFollowReleased: (listener: () => void) => () => void;
}

const UP_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);
const DOWN_KEYS = new Set(["PageDown", "End", "ArrowDown", " "]);
// Wide enough for an overlay scrollbar, which takes no layout space (macOS Firefox).
const SCROLLBAR_HIT_PX = 16;

/**
 * Owns the timeline scroll node's input listeners for as long as the node is
 * mounted, and turns them into one navigation signal.
 */
export function attachTimelineViewport(
  scrollNode: HTMLElement,
  options: {
    /**
     * Whether a scroll key pressed with focus on the page is this timeline's. The split view has a
     * timeline per pane and gives such keys to the focused pane's (lib/windowKeys.ts).
     */
    readonly hearsPageKeys?: () => boolean;
  } = {},
): TimelineViewport & {
  readonly dispose: () => void;
} {
  const listeners = new Set<(navigation: TimelineNavigation) => void>();
  const followReleasedListeners = new Set<() => void>();
  let programmaticHolds = 0;
  const emit = (navigation: TimelineNavigation) => {
    for (const listener of listeners) listener(navigation);
  };
  const handleWheel = (event: WheelEvent) => {
    if (event.ctrlKey || !isTimelineScrollTarget(event.target, scrollNode, event.deltaY, event))
      return;
    emit({ source: "wheel", direction: event.deltaY < 0 ? "up" : "down" });
  };
  const handleTouchMove = () => emit({ source: "touch" });
  // Scrollbar drags produce no wheel/touch events. The scroll node's own padding
  // also targets it, so only a press at its trailing edge counts.
  const handlePointerDown = (event: PointerEvent) =>
    emit({
      source: "pointer",
      onScrollbar:
        event.target === scrollNode &&
        scrollNode.getBoundingClientRect().right - event.clientX <=
          Math.max(SCROLLBAR_HIT_PX, scrollNode.offsetWidth - scrollNode.clientWidth),
    });
  // Clicking message text can leave DOM focus on body, and keyboard scrolling
  // bypasses wheel and pointer events, so scroll keys are heard app-wide.
  const handleKeyDown = (event: KeyboardEvent) => {
    const direction = UP_KEYS.has(event.key) ? "up" : DOWN_KEYS.has(event.key) ? "down" : null;
    if (
      direction === null ||
      event.defaultPrevented ||
      !(event.target instanceof Node) ||
      (!scrollNode.contains(event.target) &&
        ((event.target !== document.body && event.target !== document.documentElement) ||
          options.hearsPageKeys?.() === false)) ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR) ||
      document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR) ||
      (scrollNode.contains(event.target) &&
        !isTimelineScrollTarget(event.target, scrollNode, direction === "up" ? -1 : 1))
    ) {
      return;
    }
    emit({ source: "key", key: event.key, direction });
  };
  // An unexplained upward move is not the reader's: the browser clamps scrollTop when content
  // briefly shrinks. T3 reads one as navigation only while an embedded frame has input; this
  // timeline has no frames, so the detector only keeps its baseline current.
  const scrolledUp = createUpwardScrollDetector({
    top: scrollNode.scrollTop,
    height: scrollNode.scrollHeight,
  });
  const handleScroll = () => {
    scrolledUp({
      top: scrollNode.scrollTop,
      height: scrollNode.scrollHeight,
      programmatic: programmaticHolds > 0,
    });
  };
  scrollNode.addEventListener("scroll", handleScroll, { passive: true });
  scrollNode.addEventListener("wheel", handleWheel, { passive: true });
  scrollNode.addEventListener("touchmove", handleTouchMove, { passive: true });
  scrollNode.addEventListener("pointerdown", handlePointerDown, { passive: true });
  window.addEventListener("keydown", handleKeyDown);
  return {
    scrollNode,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    navigate: ({ releasesFollow }) => emit({ source: "command", releasesFollow }),
    holdProgrammaticScroll: () => {
      programmaticHolds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        programmaticHolds -= 1;
      };
    },
    followReleased: () => {
      for (const listener of followReleasedListeners) listener();
    },
    onFollowReleased: (listener) => {
      followReleasedListeners.add(listener);
      return () => followReleasedListeners.delete(listener);
    },
    dispose: () => {
      listeners.clear();
      followReleasedListeners.clear();
      scrollNode.removeEventListener("scroll", handleScroll);
      scrollNode.removeEventListener("wheel", handleWheel);
      scrollNode.removeEventListener("touchmove", handleTouchMove);
      scrollNode.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    },
  };
}

/**
 * Whether a navigation can carry the viewport away from the live edge. A spurious
 * release while pinned never re-arms, so streaming stops following. Downward input
 * counts only outside the end band: streaming growth makes isAtEnd flicker false
 * for a frame, and a gesture then must not release follow.
 */
export function navigationReleasesFollow(
  navigation: TimelineNavigation,
  viewport: { readonly contentScrollsUp: () => boolean; readonly awayFromEnd: () => boolean },
): boolean {
  switch (navigation.source) {
    case "wheel":
      return navigation.direction === "up" && viewport.contentScrollsUp();
    case "key":
      return navigation.direction === "up" ? viewport.contentScrollsUp() : viewport.awayFromEnd();
    case "pointer":
      return navigation.onScrollbar ? viewport.contentScrollsUp() : viewport.awayFromEnd();
    case "touch":
      // Touch direction is not observable; an upward flick leaves the end
      // band within its first few events.
      return viewport.awayFromEnd();
    case "scroll":
      return true;
    case "command":
      return navigation.releasesFollow;
  }
}

/**
 * Whether the timeline keeps the live end in view. `atEnd` only matters once
 * released: while following, the list is at its end by definition.
 */
export type TimelineFollow =
  | { readonly mode: "following" }
  | { readonly mode: "released"; readonly atEnd: boolean };

export type TimelineFollowEvent =
  | { readonly type: "navigated" }
  | { readonly type: "followEnd" }
  | { readonly type: "reachedEnd" }
  | { readonly type: "leftEnd" };

export const FOLLOWING: TimelineFollow = { mode: "following" };

export function initialTimelineFollow(followEnd: boolean): TimelineFollow {
  return followEnd ? FOLLOWING : { mode: "released", atEnd: false };
}

export function transitionTimelineFollow(
  state: TimelineFollow,
  event: TimelineFollowEvent,
): TimelineFollow {
  switch (event.type) {
    case "navigated":
      return state.mode === "released" ? state : { mode: "released", atEnd: true };
    case "followEnd":
      return FOLLOWING;
    case "reachedEnd":
      // Navigating away while still at the end stays released until the list
      // reports leaving and returning, so a scroll key at the end cannot re-arm.
      return state.mode === "released" && !state.atEnd ? FOLLOWING : state;
    case "leftEnd":
      // While following, the list leaves the end band for a frame on every
      // streamed chunk before the follow scroll catches up.
      return state.mode === "released" && state.atEnd ? { mode: "released", atEnd: false } : state;
  }
}
