import assert from "node:assert/strict";
import { test } from "node:test";

import { codeBody, displayColumns, lineAt, lineOffsets, lineRange, splitLines, widestLine } from "./codeLines.ts";

test("a final newline ends the last line", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\n\nb"), ["a", "", "b"]);
  assert.deepEqual(splitLines(""), [""]);
});

test("columns count tab stops, wide characters and surrogate pairs", () => {
  assert.equal(displayColumns("abc"), 3);
  assert.equal(displayColumns("\tx"), 9);
  assert.equal(displayColumns("ab\tx"), 9);
  assert.equal(displayColumns("한글"), 4);
  assert.equal(displayColumns("a😀"), 3);
  assert.equal(widestLine([3, 9, 4, 9]), 1);
});

test("offsets are one row per line unwrapped, and wrapped lines take ceil(columns / width) rows", () => {
  assert.deepEqual([...lineOffsets([3, 0, 250], 20, null)], [0, 20, 40, 60]);
  assert.deepEqual([...lineOffsets([3, 0, 250], 20, 100)], [0, 20, 40, 100]);
  // A measured row replaces its estimate.
  assert.deepEqual([...lineOffsets([3, 0, 250], 20, 100, new Map([[0, 40]]))], [0, 40, 60, 120]);
});

test("a position maps to its line, and a span to the lines that cover it", () => {
  const offsets = lineOffsets(new Array(100).fill(1), 20, null);
  assert.equal(lineAt(offsets, -5), 0);
  assert.equal(lineAt(offsets, 0), 0);
  assert.equal(lineAt(offsets, 19.9), 0);
  assert.equal(lineAt(offsets, 20), 1);
  assert.equal(lineAt(offsets, 10_000), 99);
  assert.deepEqual(lineRange(offsets, 30, 75), { start: 1, end: 4 });
  assert.deepEqual(lineRange(offsets, 1990, 5000), { start: 99, end: 100 });
  assert.deepEqual(lineRange(lineOffsets([], 20, null), 0, 100), { start: 0, end: 0 });
});

test("codeBody drops one final newline and splitLines splits that body", () => {
  assert.equal(codeBody("a\nb\n"), "a\nb");
  assert.equal(codeBody("a\n\n"), "a\n");
  assert.equal(codeBody("a"), "a");
  assert.deepEqual(splitLines("a\nb\n"), codeBody("a\nb\n").split("\n"));
});
