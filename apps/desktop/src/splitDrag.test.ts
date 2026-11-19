import assert from "node:assert/strict";
import { test } from "node:test";

import { DropReplies, SplitDragTracker, closesAfter, contentPoint, type Point, type Rect, type TrackerDeps } from "./splitDrag.ts";

test("contentPoint: client pixels of a cursor inside the content area, null outside, zoom divides", () => {
  const b: Rect = { x: 100, y: 50, width: 800, height: 600 };
  assert.deepEqual(contentPoint({ x: 150, y: 80 }, b, 1), { x: 50, y: 30 });
  assert.deepEqual(contentPoint({ x: 150, y: 80 }, b, 2), { x: 25, y: 15 });
  assert.equal(contentPoint({ x: 99, y: 80 }, b, 1), null);
  assert.equal(contentPoint({ x: 900, y: 80 }, b, 1), null);
  assert.equal(contentPoint({ x: 150, y: 650 }, b, 1), null);
  assert.equal(contentPoint({ x: 150, y: 80 }, b, 0), null);
});

/** A tracker over a fake screen: the main window's content is x 0..1000, y 0..800; the lean window follows `lean`. */
function rig(idleMs: number | null) {
  const log: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let cursor: Point = { x: 2000, y: 100 };
  let lean: Rect = { x: 1900, y: 90, width: 480, height: 680 };
  const deps: TrackerDeps = {
    cursor: () => cursor,
    windowBounds: () => lean,
    mainPoint: (c) => (c.x >= 0 && c.x < 1000 && c.y >= 0 && c.y < 800 ? { x: c.x, y: c.y } : null),
    preview: (p) => log.push(p ? `preview ${p.x},${p.y}` : "preview off"),
    drop: (p) => log.push(`drop ${p.x},${p.y}`),
    idleMs,
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { live: boolean }).live = false;
    },
  };
  const tracker = new SplitDragTracker(deps);
  return {
    tracker,
    log,
    timers,
    /** The user drags the window: the cursor and the window (grabbed at its header) move together. */
    dragTo(x: number, y: number) {
      cursor = { x, y };
      lean = { x: x - 240, y: y - 10, width: 480, height: 680 };
      tracker.moved();
    },
    /** The program moves the window while the cursor stays where it is. */
    programmaticMove() {
      lean = { x: 5000, y: 5000, width: 480, height: 680 };
      tracker.moved();
    },
    fireIdle() {
      const t = timers.filter((x) => x.live).at(-1);
      assert.ok(t, "an idle timer is waiting");
      t.live = false;
      t.fn();
    },
  };
}

test("a window carried over the main page previews, and letting go there drops at the cursor (idle end)", () => {
  const r = rig(350);
  r.dragTo(1500, 100);
  r.dragTo(900, 300);
  r.dragTo(700, 300);
  assert.deepEqual(r.log, ["preview 900,300", "preview 700,300"]);
  r.fireIdle();
  assert.deepEqual(r.log, ["preview 900,300", "preview 700,300", "preview off", "drop 700,300"]);
});

test("a window let go outside the main page only moves: no drop", () => {
  const r = rig(350);
  r.dragTo(1500, 100);
  r.dragTo(1600, 200);
  r.fireIdle();
  assert.deepEqual(r.log, []);
});

test("passing over the main page and leaving turns the preview off and does not drop", () => {
  const r = rig(350);
  r.dragTo(900, 300);
  r.dragTo(1200, 300);
  r.fireIdle();
  assert.deepEqual(r.log, ["preview 900,300", "preview off"]);
});

test("every move restarts the idle wait, so only the last stop counts", () => {
  const r = rig(350);
  r.dragTo(900, 300);
  r.dragTo(800, 300);
  assert.equal(r.timers.filter((t) => t.live).length, 1);
});

test("Windows: the platform's moved event ends it, no idle timer", () => {
  const r = rig(null);
  r.dragTo(500, 400);
  assert.equal(r.timers.length, 0);
  r.tracker.ended();
  assert.deepEqual(r.log, ["preview 500,400", "preview off", "drop 500,400"]);
});

test("a move with the cursor away from the lean window is not a drag", () => {
  const r = rig(350);
  r.programmaticMove();
  assert.deepEqual(r.log, []);
  assert.equal(r.timers.length, 0);
});

test("DropReplies: the page's answer resolves the ask; an unknown id is refused; silence resolves none", async () => {
  const replies = new DropReplies();
  let asked = "";
  const answered = replies.ask((id) => (asked = id), 1000);
  assert.equal(replies.answer("nope", "placed"), false);
  assert.equal(replies.answer(asked, "placed"), true);
  assert.equal(await answered, "placed");
  assert.equal(await replies.ask(() => {}, 5), "none");
});

test("closesAfter: only a session that is now in a pane closes the window", () => {
  assert.equal(closesAfter("placed"), true);
  assert.equal(closesAfter("focused"), true);
  assert.equal(closesAfter("noRoom"), false);
  assert.equal(closesAfter("none"), false);
});
