import assert from "node:assert/strict";
import { test } from "node:test";

import { highlightSyntax } from "../../lib/syntaxHighlight.ts";
import { diffHunkLanguages, highlightDiffRows, parseUnifiedDiff, type DiffRow } from "./diffView.logic.ts";

type LineRow = Extract<DiffRow, { kind: "line" }>;

function lineRows(diff: string): Array<[LineRow["type"], number | null, number | null, string]> {
  return parseUnifiedDiff(diff).rows.flatMap((row) =>
    row.kind === "line" ? [[row.type, row.oldNumber, row.newNumber, row.text]] : [],
  );
}

test("numbers old and new lines through a hunk (Claude's formatHunks)", () => {
  const diff = "--- /w/a.ts\n+++ /w/a.ts\n@@ -10,3 +10,4 @@\n a\n-b\n+B\n+C\n c\n";
  const parsed = parseUnifiedDiff(diff);
  assert.equal(parsed.fileCount, 1);
  assert.equal(parsed.maxLineNumber, 13);
  assert.deepEqual(lineRows(diff), [
    ["context", 10, 10, "a"],
    ["del", 11, null, "b"],
    ["add", null, 11, "B"],
    ["add", null, 12, "C"],
    ["context", 12, 13, "c"],
  ]);
});

test("a new file starts at line 1 and the no-newline note stays out of the counts", () => {
  const diff = "--- /dev/null\n+++ b/x.py\n@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n";
  const parsed = parseUnifiedDiff(diff);
  assert.deepEqual(parsed.hunks, [{ path: "x.py" }]);
  assert.deepEqual(lineRows(diff), [
    ["add", null, 1, "a"],
    ["add", null, 2, "b"],
  ]);
  assert.deepEqual(parsed.rows.at(-1), { kind: "note", text: "\\ No newline at end of file" });
});

test("the no-newline note between the two sides keeps the hunk open", () => {
  const diff = "@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file";
  assert.deepEqual(lineRows(diff), [
    ["del", 1, null, "old"],
    ["add", null, 1, "new"],
  ]);
});

test("a removed `-- comment` line inside a hunk is not a file header", () => {
  const diff = "--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,1 @@\n--- note\n select 1;\n";
  assert.deepEqual(lineRows(diff), [
    ["del", 1, null, "-- note"],
    ["context", 2, 1, "select 1;"],
  ]);
});

test("Codex diffs of several files keep each hunk's file and grammar", () => {
  const diff =
    "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n" +
    "--- a/run.sh\n+++ b/run.sh\n@@ -3,1 +3,1 @@\n-echo a\n+echo b\n";
  const parsed = parseUnifiedDiff(diff);
  assert.equal(parsed.fileCount, 2);
  assert.deepEqual(diffHunkLanguages(parsed, "fallback.md"), ["typescript", "bash"]);
  // A diff with no file headers takes the change's own file name.
  assert.deepEqual(diffHunkLanguages(parseUnifiedDiff("@@ -1,1 +1,1 @@\n-a\n+b"), "a.json"), ["json"]);
});

test("text that is no diff shows as notes", () => {
  const parsed = parseUnifiedDiff("     1\tconst a = 1\n     2\tconst b = 2");
  assert.deepEqual(
    parsed.rows.map((row) => row.kind),
    ["note", "note"],
  );
});

test("each side highlights as one text, so a comment spanning lines colors every line", () => {
  const diff = "@@ -1,3 +1,3 @@\n /* start\n-old line\n+new line\n end */";
  const parsed = parseUnifiedDiff(diff);
  const tokens = highlightDiffRows(parsed, ["typescript"], highlightSyntax);
  for (const [rowIndex, row] of parsed.rows.entries()) {
    if (row.kind !== "line") continue;
    assert.deepEqual(
      tokens.get(rowIndex)?.map((token) => token.role),
      ["comment"],
      `${row.type} ${row.text}`,
    );
  }
});
