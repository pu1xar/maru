// Equal distribution (DESIGN.md 6k): a new pane shares its whole line, like VS Code's splitSizing "distribute".
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_LAYOUT,
  canInsertAt,
  computeFrames,
  describeLayout,
  dropPane,
  equalizeLine,
  insertPreview,
  openSession,
  panesOf,
  setRatio,
  splitPane,
  type FrameOptions,
  type PaneLayout,
} from "./paneLayout.ts";

function ids() {
  let n = 0;
  return () => `p${++n}`;
}

const OPTS: FrameOptions = { minWidth: 360, minHeight: 240, gap: 1 };
const show = (l: PaneLayout) => describeLayout(l.root, (p) => `${p.id}:${p.sessionKey ?? "-"}`);
/** The tree's shape alone: panes as x. */
const shape = (l: PaneLayout) => describeLayout(l.root, () => "x").replace(/\[x\]/g, "x");
const framesOf = (l: PaneLayout, w: number, h: number) => computeFrames(l.root, w, h, OPTS);

/** n sessions side by side, built through the public split. */
function rowOf(n: number) {
  const id = ids();
  let l = openSession(EMPTY_LAYOUT, "S1", id);
  for (let i = 2; i <= n; i++) l = splitPane(l, panesOf(l.root).at(-1)!.id, "right", `S${i}`, id);
  return { l, id };
}

test("a pane alone in its direction halves; a line shares equally (the two examples)", () => {
  const id = ids();
  let l = openSession(EMPTY_LAYOUT, "A", id); // p1
  l = splitPane(l, "p1", "right", "B", id); // p2, split p3
  l = splitPane(l, "p2", "bottom", "C", id); // p4, split p5: row(A, column(B, C))
  assert.equal(show(l), "row(0.50,[p1:A],column(0.50,[p2:B],[p4:C]))");
  const besideA = splitPane(l, "p1", "right", "N", id);
  assert.match(show(besideA), /^row\(0\.33,\[p1:A\],row\(0\.50,\[p\d+:N\],column\(0\.50,\[p2:B\],\[p4:C\]\)\)\)$/, "A | N | column(B, C), a third each");
  const besideB = splitPane(l, "p2", "right", "N", id);
  assert.match(show(besideB), /^row\(0\.50,\[p1:A\],column\(0\.50,row\(0\.50,\[p2:B\],\[p\d+:N\]\),\[p4:C\]\)\)$/, "B's parent runs the other way: B alone is halved");
});

test("three side by side plus one gives four equal shares: ratios 1/4, 1/3, 1/2", () => {
  const { l, id } = rowOf(3);
  assert.equal(shape(l), "row(0.33,x,row(0.50,x,x))");
  const four = splitPane(l, "p4", "right", "S4", id);
  assert.equal(shape(four), "row(0.25,x,row(0.33,x,row(0.50,x,x)))");
  assert.deepEqual(panesOf(four.root).map((p) => p.sessionKey), ["S1", "S2", "S3", "S4"]);
  const f = framesOf(four, 1801, 900);
  const widths = panesOf(four.root).map((p) => f.panes.get(p.id)!.w);
  assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `equal within the gap: ${widths}`);
  const inMiddle = splitPane(l, "p2", "left", "X", id);
  assert.deepEqual(panesOf(inMiddle.root).map((p) => p.sessionKey), ["S1", "X", "S2", "S3"], "the new cell goes before the target");
});

test("the same holds for a column (top and bottom)", () => {
  const id = ids();
  let l = openSession(EMPTY_LAYOUT, "A", id);
  l = splitPane(l, "p1", "bottom", "B", id);
  l = splitPane(l, "p2", "bottom", "C", id);
  l = splitPane(l, "p1", "top", "D", id);
  assert.deepEqual(panesOf(l.root).map((p) => p.sessionKey), ["D", "A", "B", "C"]);
  assert.equal(shape(l), "column(0.25,x,column(0.33,x,column(0.50,x,x)))");
});

test("moving a pane inside its own line reorders it; the line stays equal", () => {
  const { l, id } = rowOf(3);
  const moved = dropPane(l, "p1", "p4", "right", id);
  assert.deepEqual(panesOf(moved.root).map((p) => p.sessionKey), ["S2", "S3", "S1"]);
  assert.equal(shape(moved), "row(0.33,x,row(0.50,x,x))");
  const out = dropPane(l, "p1", "p2", "bottom", id);
  assert.equal(shape(out), "row(0.50,column(0.50,x,x),x)", "an opposite-direction drop makes its own pair");
});

test("room is judged on the whole line: 1800 holds a fourth of three, 1400 does not", () => {
  const { l } = rowOf(3);
  assert.equal(canInsertAt(l, framesOf(l, 1800, 900), "p4", "right", OPTS), true, "(1800 - 3) / 4 = 449 >= 360");
  assert.equal(canInsertAt(l, framesOf(l, 1443, 900), "p4", "right", OPTS), true, "4 x 360 + 3 = 1443");
  assert.equal(canInsertAt(l, framesOf(l, 1442, 900), "p4", "right", OPTS), false);
  assert.equal(canInsertAt(l, framesOf(l, 1400, 900), "p4", "right", OPTS), false);
  assert.equal(canInsertAt(l, framesOf(l, 1800, 900), "p4", "bottom", OPTS), true, "p4 alone in its column: 900 >= 2 x 240 + 1");
  assert.equal(canInsertAt(l, framesOf(l, 1800, 450), "p4", "bottom", OPTS), false, "450 < 481");
  const single = openSession(EMPTY_LAYOUT, "A", ids());
  assert.equal(canInsertAt(single, framesOf(single, 721, 900), "p1", "right", OPTS), true);
  assert.equal(canInsertAt(single, framesOf(single, 720, 900), "p1", "right", OPTS), false);
  assert.equal(canInsertAt(l, framesOf(l, 1800, 900), "nope", "right", OPTS), false);
});

test("a dragged pane's own place does not count against the room", () => {
  const { l } = rowOf(3);
  const f = framesOf(l, 1100, 900); // three at about 365: no room for a fourth
  assert.equal(canInsertAt(l, f, "p4", "right", OPTS), false);
  assert.equal(canInsertAt(l, f, "p4", "right", OPTS, "p1"), true, "p1 leaves and joins the same line: still three");
  assert.equal(canInsertAt(l, f, "p1", "right", OPTS, "p1"), false, "onto itself");
});

test("the preview is the share the new cell gets", () => {
  const { l } = rowOf(3);
  const f = framesOf(l, 1801, 900);
  const p = insertPreview(l, f, "p4", "right", OPTS)!;
  assert.equal(p.w, (1801 - 3) / 4);
  assert.equal(p.x, 3 * (p.w + 1));
  assert.equal(insertPreview(l, f, "p1", "left", OPTS)!.x, 0);
  assert.equal(insertPreview(l, framesOf(l, 1400, 900), "p4", "right", OPTS), null);
});

test("a divider double click equalizes its whole line and keeps the split ids", () => {
  const { l } = rowOf(4);
  const skewed = setRatio(setRatio(setRatio(l, "p3", 0.7), "p5", 0.2), "p7", 0.9);
  const eq = equalizeLine(skewed, "p5");
  assert.equal(shape(eq), "row(0.25,x,row(0.33,x,row(0.50,x,x)))");
  assert.equal(describeLayout(eq.root).replace(/\[[^\]]*\]/g, "x"), describeLayout(l.root).replace(/\[[^\]]*\]/g, "x"));
  assert.deepEqual(panesOf(eq.root).map((p) => p.id), panesOf(l.root).map((p) => p.id));
  assert.equal(equalizeLine(l, "p3"), l, "an equal line is returned as it is");
});

test("a line of two equalizes to 0.5; a divider across the other direction leaves the line alone", () => {
  const { l } = rowOf(2);
  assert.equal(show(equalizeLine(setRatio(l, "p3", 0.8), "p3")), "row(0.50,[p1:S1],[p2:S2])");
  const id = ids();
  let m = openSession(EMPTY_LAYOUT, "A", id); // p1
  m = splitPane(m, "p1", "right", "B", id); // p2, p3
  m = splitPane(m, "p2", "bottom", "C", id); // p4, p5: row(A, column(B, C))
  m = setRatio(setRatio(m, "p3", 0.3), "p5", 0.8);
  const col = equalizeLine(m, "p5");
  assert.equal(show(col), "row(0.30,[p1:A],column(0.50,[p2:B],[p4:C]))", "only the column line");
  assert.equal(equalizeLine(m, "nope"), m);
});
