// The maru mark as boxes. The web draws it as an SVG of four butt-capped strokes (MaruMark.tsx);
// the app lays the same strokes as rectangles (plain Views, checked against the web paths without
// React Native): every stroke is horizontal or vertical, a butt end is a flat edge, and
// the miter join of a right angle is the square the two rectangles share. React Native-free.

/** The web mark's view box (MaruMark.tsx): its origin and side. */
export const MARK_VIEW = { origin: 120.96, size: 190.08 } as const;
export const MARK_STROKE = 14;

/** The web mark's paths as corner points, in the same order as its `d` attributes. */
export const MARK_STROKES: readonly (readonly (readonly [number, number])[])[] = [
  [[145, 250], [145, 145], [304, 145]],
  [[287, 182], [287, 287], [128, 287]],
  [[170, 216], [262, 216]],
  [[216, 162], [216, 270]],
];

export interface MarkRect {
  /** Fractions of the mark's box (0 to 1). */
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The rectangles that draw the strokes: one per segment, grown at a corner by half the stroke width. */
export function markRects(): MarkRect[] {
  const half = MARK_STROKE / 2;
  const out: MarkRect[] = [];
  for (const points of MARK_STROKES) {
    for (let i = 0; i < points.length - 1; i++) {
      const [x1, y1] = points[i]!;
      const [x2, y2] = points[i + 1]!;
      // An end that is a corner (not the stroke's first or last point) takes the join's square.
      const growStart = i > 0 ? half : 0;
      const growEnd = i + 1 < points.length - 1 ? half : 0;
      const horizontal = y1 === y2;
      const lo = horizontal ? Math.min(x1, x2) : Math.min(y1, y2);
      const hi = horizontal ? Math.max(x1, x2) : Math.max(y1, y2);
      const startIsLow = (horizontal ? x1 : y1) <= (horizontal ? x2 : y2);
      const a = lo - (startIsLow ? growStart : growEnd);
      const b = hi + (startIsLow ? growEnd : growStart);
      // Across the segment the rectangle is one stroke wide, centered on the segment's line.
      const cross = (horizontal ? y1 : x1) - half;
      const rect = horizontal ? { x: a, y: cross, w: b - a, h: MARK_STROKE } : { x: cross, y: a, w: MARK_STROKE, h: b - a };
      out.push({
        left: (rect.x - MARK_VIEW.origin) / MARK_VIEW.size,
        top: (rect.y - MARK_VIEW.origin) / MARK_VIEW.size,
        width: rect.w / MARK_VIEW.size,
        height: rect.h / MARK_VIEW.size,
      });
    }
  }
  return out;
}
