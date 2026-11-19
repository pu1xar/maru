// Layout math for the file preview's virtualized code lines (FilePreview.tsx, CodeLines). Every
// line has a height: one row unwrapped; wrapped, an estimate from its width in monospace columns
// until the rendered row is measured. Offsets are the running sum, so a scroll position maps to a
// line by binary search and only the lines near the viewport are in the DOM.

/** The text the lines are cut from: a final newline ends the last line rather than starting an empty one. */
export function codeBody(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** The file's lines (`codeBody` split at line breaks). */
export function splitLines(text: string): string[] {
  return codeBody(text).split("\n");
}

const TAB_STOP = 8;

/** East Asian wide and emoji code points, which a monospace font draws two columns wide. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** How many monospace columns `line` takes: tabs run to the next stop of 8, wide characters take 2. */
export function displayColumns(line: string): number {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 9) {
      col += TAB_STOP - (col % TAB_STOP);
      continue;
    }
    let cp = c;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < line.length) {
      const low = line.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = (c - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i++;
      }
    }
    col += isWide(cp) ? 2 : 1;
  }
  return col;
}

/** The index of the widest line; the preview sizes its scroll width from it. */
export function widestLine(columns: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < columns.length; i++) if (columns[i]! > columns[best]!) best = i;
  return best;
}

/**
 * Running sums of the line heights: `offsets[i]` is where line i starts, `offsets[n]` the total.
 * `measured` holds rendered heights (wrapped rows only) that replace the estimate.
 */
export function lineOffsets(
  columns: readonly number[],
  rowHeight: number,
  wrapColumns: number | null,
  measured?: ReadonlyMap<number, number>,
): Float64Array {
  const offsets = new Float64Array(columns.length + 1);
  for (let i = 0; i < columns.length; i++) {
    const estimate = wrapColumns === null ? rowHeight : rowHeight * Math.max(1, Math.ceil(columns[i]! / wrapColumns));
    offsets[i + 1] = offsets[i]! + (measured?.get(i) ?? estimate);
  }
  return offsets;
}

/** The line that holds vertical position `y` (clamped to the first and last line). */
export function lineAt(offsets: Float64Array, y: number): number {
  const n = offsets.length - 1;
  if (n <= 0 || y <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The lines `[start, end)` that cover positions `from` to `to`. */
export function lineRange(offsets: Float64Array, from: number, to: number): { start: number; end: number } {
  const n = offsets.length - 1;
  if (n <= 0) return { start: 0, end: 0 };
  return { start: lineAt(offsets, from), end: Math.min(n, lineAt(offsets, to) + 1) };
}
