// Reopening a pane the user closed (DESIGN.md 6k): the record, and what bringing it back does.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_LAYOUT,
  closePane,
  closedPaneOf,
  describeLayout,
  openSession,
  panesOf,
  reopenClosedPane,
  splitPane,
  splitPaneWith,
  type ClosedPane,
  type PaneLayout,
} from "./paneLayout.ts";

function ids(prefix = "p") {
  let n = 0;
  return () => `${prefix}${++n}`;
}

const shape = (l: PaneLayout) => describeLayout(l.root, (p) => p.sessionKey ?? p.shellId ?? "-");
const yes = () => true;
const fits = () => true;

/** row(A, column(B, C)) */
function three() {
  const id = ids();
  let l = openSession(EMPTY_LAYOUT, "A", id); // p1
  l = splitPane(l, "p1", "right", "B", id); // p2, p3
  l = splitPane(l, "p2", "bottom", "C", id); // p4, p5
  return { l, id };
}

test("the record names the content, the nearest pane of the sibling and the side it was on", () => {
  const { l } = three();
  assert.deepEqual(closedPaneOf(l, "p1"), { content: { type: "session", key: "A" }, siblingId: "p2", edge: "left" });
  assert.deepEqual(closedPaneOf(l, "p4"), { content: { type: "session", key: "C" }, siblingId: "p2", edge: "bottom" });
  assert.equal(closedPaneOf(splitPane(l, "p1", "left", null, ids("q")), "q1"), null, "an empty pane leaves nothing to bring back");
  assert.deepEqual(closedPaneOf(openSession(EMPTY_LAYOUT, "Z", ids()), "p1"), { content: { type: "session", key: "Z" }, siblingId: null, edge: null });
});

test("a closed pane returns beside its sibling on its side, sharing the line equally", () => {
  const { l, id } = three();
  const rec = closedPaneOf(l, "p4")!;
  const closed = closePane(l, "p4");
  assert.equal(shape(closed), "row(0.50,[A],[B])");
  const back = reopenClosedPane(closed, [rec], yes, fits, id);
  assert.equal(back.outcome, "reopened");
  assert.deepEqual(back.stack, []);
  assert.deepEqual(panesOf(back.layout.root).map((p) => p.sessionKey), ["A", "B", "C"]);
  assert.equal(back.layout.focused, panesOf(back.layout.root)[2]!.id, "the pane that came back has focus");
  const recA = closedPaneOf(l, "p1")!;
  const withoutA = closePane(l, "p1");
  const backA = reopenClosedPane(withoutA, [recA], yes, fits, ids("n"));
  assert.deepEqual(panesOf(backA.layout.root).map((p) => p.sessionKey), ["A", "B", "C"], "A returns to the left of B");
});

test("the newest comes back first; gone content is dropped; content shown elsewhere only takes focus", () => {
  const { l, id } = three();
  const recB = closedPaneOf(l, "p2")!;
  const l1 = closePane(l, "p2");
  const recC = closedPaneOf(l1, "p4")!;
  const l2 = closePane(l1, "p4");
  assert.equal(shape(l2), "[A]");
  const stack: ClosedPane[] = [recB, recC];
  const first = reopenClosedPane(l2, stack, yes, fits, id);
  assert.deepEqual(panesOf(first.layout.root).map((p) => p.sessionKey).sort(), ["A", "C"]);
  assert.equal(first.stack.length, 1, "C's record was used");
  const skipGone = reopenClosedPane(l2, stack, (c) => c.type === "session" && c.key !== "C", fits, id);
  assert.deepEqual(panesOf(skipGone.layout.root).map((p) => p.sessionKey).sort(), ["A", "B"], "C is gone, B is next");
  assert.deepEqual(skipGone.stack, []);
  const shownAlready = splitPaneWith(l2, "p1", "right", { type: "session", key: "C" }, ids("z"));
  const focus = reopenClosedPane(focusFirst(shownAlready), stack, yes, fits, id);
  assert.equal(focus.outcome, "focused");
  assert.equal(focus.layout.focused, panesOf(focus.layout.root).find((p) => p.sessionKey === "C")!.id);
  assert.equal(panesOf(focus.layout.root).length, 2, "no pane was added");
  assert.equal(reopenClosedPane(l2, [recC], () => false, fits, id).outcome, "nothing");
});

function focusFirst(l: PaneLayout): PaneLayout {
  return { ...l, focused: panesOf(l.root)[0]!.id };
}

test("no room keeps the record; a gone sibling falls back to the focused pane; an empty view gets a first pane", () => {
  const { l, id } = three();
  const rec = closedPaneOf(l, "p4")!;
  const closed = closePane(l, "p4");
  const refused = reopenClosedPane(closed, [rec], yes, () => false, id);
  assert.equal(refused.outcome, "noRoom");
  assert.deepEqual(refused.stack, [rec]);
  assert.equal(refused.layout, closed);
  const noSibling = closePane(closePane(closed, "p2"), "p1");
  assert.equal(noSibling.root, null);
  const first = reopenClosedPane(noSibling, [rec], yes, fits, id);
  assert.equal(shape(first.layout), "[C]");
  const moved = openSession(EMPTY_LAYOUT, "X", ids("m"));
  const fallback = reopenClosedPane(moved, [rec], yes, fits, id);
  assert.deepEqual(panesOf(fallback.layout.root).map((p) => p.sessionKey), ["X", "C"], "C was below its sibling, so it goes below the focused pane");
});
