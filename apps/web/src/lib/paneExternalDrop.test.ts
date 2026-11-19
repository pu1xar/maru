// A session let go on the split view from a lean window (DESIGN.md 6x): dropHitAt (what a point is
// over) and placeSessionAt (what letting go does). The rules are the sidebar row's, plus focusing
// the pane that already shows the session.
import assert from "node:assert/strict";
import { test } from "node:test";

import { EMPTY_LAYOUT, computeFrames, describeLayout, dropHitAt, openSession, splitPane, type FrameOptions, type PaneLayout } from "./paneLayout.ts";
import { activeLayout, describeTabs, placeSessionAt, tabsOf, type PaneTabs } from "./paneTabs.ts";

const OPTS: FrameOptions = { minWidth: 360, minHeight: 240, gap: 1 };

function ids(prefix = "p") {
  let n = 0;
  return () => `${prefix}${++n}`;
}

const text = (l: PaneLayout) => describeLayout(l.root, (p) => `${p.id}:${p.sessionKey ?? "-"}`);
const showTabs = (t: PaneTabs) => describeTabs(t, text);

/** One pane p1 showing A, in a 1200x600 area. */
function one(): PaneTabs {
  return tabsOf(openSession(EMPTY_LAYOUT, "A", ids()), ids("t"));
}

const SIZE = { w: 1200, h: 600 };

test("dropHitAt: the empty view is one target, the whole area", () => {
  const whole = { x: 0, y: 0, w: 1200, h: 600 };
  const hit = dropHitAt(EMPTY_LAYOUT, null, whole, 300, 300, OPTS);
  assert.deepEqual(hit?.target, { paneId: null, zone: "center" });
  assert.equal(dropHitAt(EMPTY_LAYOUT, null, whole, 1300, 300, OPTS), null);
});

test("dropHitAt: an edge with room previews its equal share, the middle previews the pane", () => {
  const layout = openSession(EMPTY_LAYOUT, "A", ids());
  const frames = computeFrames(layout.root, SIZE.w, SIZE.h, OPTS);
  const right = dropHitAt(layout, frames, null, 1190, 300, OPTS);
  assert.deepEqual(right?.target, { paneId: "p1", zone: "right" });
  assert.ok(right?.preview && right.preview.w < 1200);
  const middle = dropHitAt(layout, frames, null, 600, 300, OPTS);
  assert.deepEqual(middle?.target, { paneId: "p1", zone: "center" });
});

test("dropHitAt: an edge whose line cannot take another pane is noRoom", () => {
  // Three panes of 360 each fill 1082px; a fourth does not fit in 1200.
  const id = ids();
  let l = openSession(EMPTY_LAYOUT, "A", id);
  l = splitPane(l, "p1", "right", "B", id);
  l = splitPane(l, "p2", "right", "C", id);
  const size = { w: 1100, h: 600 };
  const frames = computeFrames(l.root, size.w, size.h, OPTS);
  const hit = dropHitAt(l, frames, null, 1095, 300, OPTS);
  assert.equal(hit?.target, null);
  assert.ok(hit?.noRoom);
});

test("placeSessionAt: a session a pane already shows only takes focus, wherever the point is", () => {
  const id = ids();
  let l = openSession(EMPTY_LAYOUT, "A", id);
  l = splitPane(l, "p1", "right", "B", id); // focus on B's pane
  const t = tabsOf(l, ids("t"));
  const res = placeSessionAt(t, "A", { x: 5000, y: 5000 }, SIZE, OPTS);
  assert.equal(res.outcome, "focused");
  assert.equal(activeLayout(res.tabs).focused, "p1");
  assert.equal(text(activeLayout(res.tabs)), text(l));
});

test("placeSessionAt: the right edge of a pane inserts a new pane there with the line shared equally", () => {
  const res = placeSessionAt(one(), "B", { x: 1190, y: 300 }, SIZE, OPTS, ids("n"));
  assert.equal(res.outcome, "placed");
  assert.equal(text(activeLayout(res.tabs)), "row(0.50,[p1:A],[n1:B])");
});

test("placeSessionAt: the middle replaces that pane's session", () => {
  const res = placeSessionAt(one(), "B", { x: 600, y: 300 }, SIZE, OPTS);
  assert.equal(res.outcome, "placed");
  assert.equal(text(activeLayout(res.tabs)), "[p1:B]");
});

test("placeSessionAt: an empty view takes it as the first pane", () => {
  const res = placeSessionAt(tabsOf(EMPTY_LAYOUT, ids("t")), "B", { x: 10, y: 10 }, SIZE, OPTS, ids("n"));
  assert.equal(res.outcome, "placed");
  assert.equal(text(activeLayout(res.tabs)), "[n1:B]");
});

test("placeSessionAt: no room leaves the tabs as they were", () => {
  const id = ids();
  let l = openSession(EMPTY_LAYOUT, "A", id);
  l = splitPane(l, "p1", "right", "B", id);
  l = splitPane(l, "p2", "right", "C", id);
  const t = tabsOf(l, ids("t"));
  const res = placeSessionAt(t, "D", { x: 1095, y: 300 }, { w: 1100, h: 600 }, OPTS);
  assert.equal(res.outcome, "noRoom");
  assert.equal(res.tabs, t);
});

test("placeSessionAt: a point over no pane does nothing", () => {
  const t = one();
  const res = placeSessionAt(t, "B", { x: 2000, y: 300 }, SIZE, OPTS);
  assert.equal(res.outcome, "none");
  assert.equal(res.tabs, t);
});

test("placeSessionAt: a session another tab shows brings that tab up", () => {
  const first = openSession(EMPTY_LAYOUT, "A", ids());
  const second = openSession(EMPTY_LAYOUT, "C", ids("q"));
  const t: PaneTabs = {
    tabs: [
      { id: "t1", name: null, layout: first },
      { id: "t2", name: null, layout: second },
    ],
    active: "t1",
  };
  const res = placeSessionAt(t, "C", { x: 0, y: 0 }, SIZE, OPTS);
  assert.equal(res.outcome, "focused");
  assert.equal(res.tabs.active, "t2");
  assert.ok(showTabs(res.tabs).length > 0);
});
