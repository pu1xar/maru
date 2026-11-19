import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FOLLOWING,
  initialTimelineFollow,
  navigationReleasesFollow,
  nextListOpening,
  transitionTimelineFollow,
  type TimelineFollow,
} from "./timelineViewport.ts";

const RELEASED_AT_END: TimelineFollow = { mode: "released", atEnd: true };
const RELEASED_AWAY: TimelineFollow = { mode: "released", atEnd: false };

test("follow: navigating away releases, and only a return to the end re-arms", () => {
  let follow = initialTimelineFollow(true);
  assert.equal(follow, FOLLOWING);
  follow = transitionTimelineFollow(follow, { type: "navigated" });
  assert.deepEqual(follow, RELEASED_AT_END);
  // A scroll key at the end does not re-arm until the list reports leaving and returning.
  assert.deepEqual(transitionTimelineFollow(follow, { type: "reachedEnd" }), RELEASED_AT_END);
  follow = transitionTimelineFollow(follow, { type: "leftEnd" });
  assert.deepEqual(follow, RELEASED_AWAY);
  assert.equal(transitionTimelineFollow(follow, { type: "reachedEnd" }), FOLLOWING);
});

test("follow: a streamed chunk that briefly leaves the end keeps following", () => {
  assert.equal(transitionTimelineFollow(FOLLOWING, { type: "leftEnd" }), FOLLOWING);
  assert.equal(transitionTimelineFollow(RELEASED_AWAY, { type: "followEnd" }), FOLLOWING);
  assert.deepEqual(initialTimelineFollow(false), RELEASED_AWAY);
});

test("navigationReleasesFollow: upward input releases only when the content can scroll up", () => {
  const fits = { contentScrollsUp: () => false, awayFromEnd: () => false };
  const overflows = { contentScrollsUp: () => true, awayFromEnd: () => false };
  const away = { contentScrollsUp: () => true, awayFromEnd: () => true };
  assert.equal(navigationReleasesFollow({ source: "wheel", direction: "up" }, fits), false);
  assert.equal(navigationReleasesFollow({ source: "wheel", direction: "up" }, overflows), true);
  assert.equal(navigationReleasesFollow({ source: "wheel", direction: "down" }, away), false);
  assert.equal(
    navigationReleasesFollow({ source: "key", key: "End", direction: "down" }, overflows),
    false,
  );
  assert.equal(navigationReleasesFollow({ source: "touch" }, away), true);
  assert.equal(navigationReleasesFollow({ source: "pointer", onScrollbar: true }, overflows), true);
  assert.equal(navigationReleasesFollow({ source: "command", releasesFollow: false }, away), false);
});

test("nextListOpening: the opening applies to the first thread only", () => {
  let opening = nextListOpening({ mounted: false }, true, "a");
  assert.deepEqual(opening, { mounted: true, identity: "a" });
  assert.equal(nextListOpening(opening, true, "a"), opening);
  opening = nextListOpening(opening, true, "b");
  assert.deepEqual(opening, { mounted: true, identity: null });
  assert.deepEqual(nextListOpening(opening, false, "b"), { mounted: false });
});
