import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_LAYOUT,
  assignSession,
  canInsertAt,
  closePane,
  computeFrames,
  cycleFocus,
  describeLayout,
  dropPane,
  dropSession,
  dropZoneAt,
  insertPreview,
  pointerZoneAt,
  focusPane,
  moveFocus,
  movePane,
  neighborPane,
  openSession,
  panesOf,
  parseLayout,
  ratioForDrag,
  reconcileSessions,
  serializeLayout,
  setRatio,
  splitPane,
  swapPanes,
  type FrameOptions,
  type PaneLayout,
} from "./paneLayout.ts";

/** Ids p1, p2, ... in creation order, so trees read the same in every run. */
function ids() {
  let n = 0;
  return () => `p${++n}`;
}

const show = (l: PaneLayout) => describeLayout(l.root, (p) => `${p.id}:${p.sessionKey ?? "-"}`);
const OPTS: FrameOptions = { minWidth: 360, minHeight: 240, gap: 1 };

/** a | b over c, built through the public moves:  row(a, column(b, c)). */
function threePanes() {
  const id = ids();
  let l = openSession(EMPTY_LAYOUT, "A", id); // p1
  l = splitPane(l, "p1", "right", "B", id); // p2 in split p3
  l = splitPane(l, "p2", "bottom", "C", id); // p4 in split p5
  return { l, id };
}

test("opening into an empty view makes the first pane; opening again focuses or fills", () => {
  const id = ids();
  let l = openSession(EMPTY_LAYOUT, "A", id);
  assert.equal(show(l), "[p1:A]");
  assert.equal(l.focused, "p1");
  l = splitPane(l, "p1", "right", null, id);
  assert.equal(show(l), "row(0.50,[p1:A],[p2:-])");
  assert.equal(l.focused, "p2", "the new pane takes focus");
  l = openSession(l, "B", id);
  assert.equal(show(l), "row(0.50,[p1:A],[p2:B])", "a click fills the focused pane");
  l = openSession(l, "A", id);
  assert.equal(l.focused, "p1", "a shown session focuses its pane instead of showing twice");
  assert.equal(show(l), "row(0.50,[p1:A],[p2:B])");
});

test("splitting at each edge puts the new pane on that side", () => {
  for (const [edge, want] of [
    ["left", "row(0.50,[p2:N],[p1:A])"],
    ["right", "row(0.50,[p1:A],[p2:N])"],
    ["top", "column(0.50,[p2:N],[p1:A])"],
    ["bottom", "column(0.50,[p1:A],[p2:N])"],
  ] as const) {
    const id = ids();
    const l = splitPane(openSession(EMPTY_LAYOUT, "A", id), "p1", edge, "N", id);
    assert.equal(show(l), want, edge);
  }
});

test("closing gives the room to the sibling and focus to the nearest pane there", () => {
  const { l } = threePanes();
  assert.equal(show(l), "row(0.50,[p1:A],column(0.50,[p2:B],[p4:C]))");
  const closedC = closePane(l, "p4");
  assert.equal(show(closedC), "row(0.50,[p1:A],[p2:B])");
  assert.equal(closedC.focused, "p2", "C was focused; B is the pane beside it");
  const closedA = closePane(focusPane(l, "p1"), "p1");
  assert.equal(show(closedA), "column(0.50,[p2:B],[p4:C])");
  assert.equal(closedA.focused, "p2", "A's middle is level with the B/C border; ties go to the first");
  const unfocused = closePane(l, "p1");
  assert.equal(unfocused.focused, "p4", "closing another pane keeps focus");
  assert.deepEqual(closePane(openSession(EMPTY_LAYOUT, "A", ids()), "p1"), EMPTY_LAYOUT, "the last pane leaves an empty view");
});

test("ratios stay inside the band and only change the named split", () => {
  const { l } = threePanes();
  assert.equal(show(setRatio(l, "p3", 0.3)), "row(0.30,[p1:A],column(0.50,[p2:B],[p4:C]))");
  assert.equal(show(setRatio(l, "p5", 5)), "row(0.50,[p1:A],column(0.98,[p2:B],[p4:C]))");
  assert.equal(setRatio(l, "p3", Number.NaN), l);
  assert.equal(setRatio(l, "p3", 0.5), l, "no change keeps the same object");
});

test("arrow focus moves to the touching pane beside the middle, without wrapping", () => {
  const { l } = threePanes();
  const atA = focusPane(l, "p1");
  assert.equal(neighborPane(atA, "right"), "p2", "A's middle is on the B/C border; the first wins");
  assert.equal(neighborPane(setRatio(atA, "p5", 0.3), "right"), "p4", "C is beside A's middle once B is short");
  assert.equal(neighborPane(atA, "left"), null);
  assert.equal(neighborPane(atA, "up"), null);
  const atC = focusPane(l, "p4");
  assert.equal(neighborPane(atC, "up"), "p2");
  assert.equal(neighborPane(atC, "left"), "p1");
  assert.equal(neighborPane(atC, "down"), null);
  assert.equal(moveFocus(atC, "left").focused, "p1");
  assert.equal(moveFocus(atC, "down"), atC);
});

test("cycling walks the panes in reading order and wraps", () => {
  const { l } = threePanes();
  const atA = focusPane(l, "p1");
  assert.equal(cycleFocus(atA, 1).focused, "p2");
  assert.equal(cycleFocus(cycleFocus(atA, 1), 1).focused, "p4");
  assert.equal(cycleFocus(atA, -1).focused, "p4");
  assert.equal(cycleFocus(EMPTY_LAYOUT, 1), EMPTY_LAYOUT);
});

test("a pane dragged to another pane's edge moves there and keeps its id; the middle swaps", () => {
  const { l, id } = threePanes();
  const moved = dropPane(l, "p1", "p4", "bottom", id);
  assert.equal(show(moved), "column(0.33,[p2:B],column(0.50,[p4:C],[p1:A]))", "A leaves, B/C take the row, A joins their line under C and the line is shared equally");
  assert.equal(moved.focused, "p1");
  assert.equal(panesOf(moved.root).length, 3);
  const swapped = dropPane(l, "p1", "p4", "center", id);
  assert.equal(show(swapped), "row(0.50,[p4:C],column(0.50,[p2:B],[p1:A]))");
  assert.equal(swapped.focused, "p1");
  assert.equal(dropPane(l, "p2", "p2", "left", id).root, l.root, "a drop on itself changes nothing");
  assert.equal(show(movePane(l, "p2", "p4", "top", id)), "row(0.50,[p1:A],column(0.50,[p2:B],[p4:C]))", "B back above C");
  assert.equal(show(swapPanes(setRatio(l, "p3", 0.3), "p1", "p2")), "row(0.30,[p2:B],column(0.50,[p1:A],[p4:C]))", "ratios stay with the places");
});

test("a sidebar drop splits at an edge, replaces in the middle, and drags a shown session's pane", () => {
  const id = ids();
  let l = dropSession(EMPTY_LAYOUT, "A", null, "center", id);
  assert.equal(show(l), "[p1:A]", "a drop on the empty view makes the first pane");
  l = dropSession(l, "B", "p1", "right", id);
  assert.equal(show(l), "row(0.50,[p1:A],[p2:B])");
  l = dropSession(l, "C", "p1", "center", id);
  assert.equal(show(l), "row(0.50,[p1:C],[p2:B])", "the middle swaps the pane's session");
  const shownSwap = dropSession(l, "B", "p1", "center", id);
  assert.equal(show(shownSwap), "row(0.50,[p2:B],[p1:C])", "B is on screen: its pane swaps with the target");
  const shownMove = dropSession(l, "B", "p1", "top", id);
  assert.equal(show(shownMove), "column(0.50,[p2:B],[p1:C])", "B's pane moves above C");
  assert.equal(dropSession(l, "B", "p2", "left", id).root, l.root, "its own pane's edge changes nothing");
});

test("assigning a session another pane shows swaps the two panes", () => {
  const id = ids();
  let l = openSession(EMPTY_LAYOUT, "A", id);
  l = splitPane(l, "p1", "right", "B", id);
  assert.equal(show(assignSession(l, "p1", "B")), "row(0.50,[p2:B],[p1:A])");
});

test("reconcile follows a moved session, closes gone ones, and drops a key two panes would share", () => {
  const { l } = threePanes();
  const moved = reconcileSessions(l, (k) => (k === "B" ? "B2" : k));
  assert.equal(show(moved), "row(0.50,[p1:A],column(0.50,[p2:B2],[p4:C]))");
  assert.equal(moved.focused, l.focused);
  const gone = reconcileSessions(l, (k) => (k === "C" ? null : k));
  assert.equal(show(gone), "row(0.50,[p1:A],[p2:B])");
  const unknown = reconcileSessions(l, () => undefined);
  assert.equal(unknown, l, "unknown keeps the layout object");
  const clash = reconcileSessions(l, (k) => (k === "C" ? "A" : k));
  assert.equal(show(clash), "row(0.50,[p1:A],[p2:B])");
  assert.deepEqual(reconcileSessions(openSession(EMPTY_LAYOUT, "A", ids()), () => null), EMPTY_LAYOUT);
});

test("stored layouts round-trip; broken or foreign values give null", () => {
  const { l } = threePanes();
  assert.deepEqual(parseLayout(serializeLayout(l)), l);
  assert.deepEqual(parseLayout(serializeLayout(EMPTY_LAYOUT)), EMPTY_LAYOUT);
  assert.equal(parseLayout(null), null);
  assert.equal(parseLayout("{"), null);
  assert.equal(parseLayout(JSON.stringify({ v: 2, root: null })), null);
  const raw = JSON.parse(serializeLayout(l));
  assert.equal(parseLayout(JSON.stringify({ ...raw, root: { ...raw.root, ratio: 1.5 } })), null, "ratio out of range");
  assert.equal(parseLayout(JSON.stringify({ ...raw, root: { ...raw.root, dir: "diagonal" } })), null);
  assert.equal(parseLayout(JSON.stringify({ ...raw, root: { ...raw.root, b: { kind: "pane", id: "p1", sessionKey: "X" } } })), null, "repeated id");
  assert.equal(parseLayout(JSON.stringify({ ...raw, root: { ...raw.root, a: { kind: "pane", id: "p9", sessionKey: 3 } } })), null);
  const dup = parseLayout(JSON.stringify({ ...raw, root: { ...raw.root, a: { kind: "pane", id: "p9", sessionKey: "B" } } }));
  assert.equal(show(dup!), "row(0.50,[p9:B],[p4:C])", "a repeated session closes the later pane (its sibling takes the room)");
  assert.equal(parseLayout(JSON.stringify({ ...raw, focused: "nope" }))!.focused, "p1", "a missing focus falls to the first pane");
});

test("frames keep the ratio, honor minimums, and fall back to the ratio when the view is too small", () => {
  const { l } = threePanes();
  const f = computeFrames(l.root, 1201, 801, OPTS);
  assert.deepEqual(f.panes.get("p1"), { x: 0, y: 0, w: 600, h: 801 });
  assert.deepEqual(f.panes.get("p2"), { x: 601, y: 0, w: 600, h: 400 });
  assert.deepEqual(f.panes.get("p4"), { x: 601, y: 401, w: 600, h: 400 });
  const row = f.dividers.find((d) => d.splitId === "p3")!;
  assert.deepEqual({ rect: row.rect, min: row.min, max: row.max }, { rect: { x: 600, y: 0, w: 1, h: 801 }, min: 360, max: 840 });
  const narrow = computeFrames(setRatio(l, "p3", 0.1).root, 1201, 801, OPTS);
  assert.equal(narrow.panes.get("p1")!.w, 360, "a 10% ratio is raised to the minimum width");
  const tiny = computeFrames(l.root, 601, 400, OPTS);
  assert.equal(tiny.panes.get("p1")!.w, 300, "below the layout minimum the ratio holds");
  assert.equal(ratioForDrag(row, 100), 360 / 1200, "a drag stops at the minimum");
  assert.equal(ratioForDrag(row, 700), 700 / 1200);
  assert.equal(ratioForDrag(row, 1150), 840 / 1200);
});

test("drop zones are the outer quarters; an edge the check refuses gives null", () => {
  const wide = { x: 0, y: 0, w: 721, h: 400 };
  const yes = () => true;
  assert.equal(dropZoneAt(wide, 10, 200, yes), "left");
  assert.equal(dropZoneAt(wide, 700, 200, yes), "right");
  assert.equal(dropZoneAt(wide, 360, 200, yes), "center");
  assert.equal(dropZoneAt(wide, 360, 20, (e) => e !== "top"), null, "a refused edge");
  assert.equal(pointerZoneAt(wide, 360, 20), "top", "the pointer is still at the top edge");
  assert.equal(dropZoneAt(wide, 900, 200, yes), null, "outside the pane");
});
