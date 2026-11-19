import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MARK_STROKE, MARK_STROKES, MARK_VIEW, markRects } from "./maruMark.ts";

const webMark = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/src/components/MaruMark.tsx"), "utf8");

/** The corner points of an SVG path of M, H and V commands (the only ones the web mark uses). */
function corners(d: string): [number, number][] {
  const pts: [number, number][] = [];
  let x = 0;
  let y = 0;
  for (const m of d.matchAll(/([MHV])\s*(-?[\d.]+)(?:[ ,]+(-?[\d.]+))?/g)) {
    const [, cmd, a, b] = m;
    if (cmd === "M") {
      x = Number(a);
      y = Number(b);
    } else if (cmd === "H") x = Number(a);
    else y = Number(a);
    pts.push([x, y]);
  }
  return pts;
}

test("the app's strokes are the web mark's paths, view box and stroke width", () => {
  const ds = [...webMark.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(ds.length, MARK_STROKES.length);
  assert.deepEqual(ds.map(corners), MARK_STROKES);
  assert.match(webMark, new RegExp(`viewBox="${MARK_VIEW.origin} ${MARK_VIEW.origin} ${MARK_VIEW.size} ${MARK_VIEW.size}"`));
  assert.match(webMark, new RegExp(`strokeWidth="${MARK_STROKE}"`));
  assert.match(webMark, /strokeLinecap="butt"/);
  assert.match(webMark, /strokeLinejoin="miter"/);
});

test("six rectangles: the two L frames grow a corner square, the rung and the board are plain", () => {
  const rects = markRects();
  assert.equal(rects.length, 6);
  const s = MARK_VIEW.size;
  const o = MARK_VIEW.origin;
  // First L's upright: x 138..152, y 138..250 (the corner's square reaches up to 138).
  const first = rects[0]!;
  assert.ok(Math.abs(first.left - (138 - o) / s) < 1e-9);
  assert.ok(Math.abs(first.top - (138 - o) / s) < 1e-9);
  assert.ok(Math.abs(first.width - 14 / s) < 1e-9);
  assert.ok(Math.abs(first.height - 112 / s) < 1e-9);
  // Its arm: x 138..304, y 138..152.
  const arm = rects[1]!;
  assert.ok(Math.abs(arm.left - (138 - o) / s) < 1e-9);
  assert.ok(Math.abs(arm.width - 166 / s) < 1e-9);
  assert.ok(Math.abs(arm.height - 14 / s) < 1e-9);
  // The rung (170..262 at y 216) has flat ends: exactly its length by one stroke.
  const rung = rects[4]!;
  assert.ok(Math.abs(rung.width - 92 / s) < 1e-9);
  assert.ok(Math.abs(rung.height - 14 / s) < 1e-9);
});

test("every rectangle lies inside the mark's box", () => {
  for (const r of markRects()) {
    assert.ok(r.left >= 0 && r.top >= 0 && r.left + r.width <= 1 && r.top + r.height <= 1, JSON.stringify(r));
  }
});
