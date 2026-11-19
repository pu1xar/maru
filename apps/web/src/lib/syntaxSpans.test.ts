import assert from "node:assert/strict";
import { test } from "node:test";

import { highlightSyntax } from "./syntaxHighlight.ts";
import { syntaxLanguageForPath } from "./syntaxLanguages.ts";
import { encodeSpans, lineStartOffsets, lineTokens, PLAIN_ROLE, tokensInRange } from "./syntaxSpans.ts";
import { splitSyntaxLines, type SyntaxToken } from "./syntaxTokens.ts";

function spanned(code: string, language: Parameters<typeof highlightSyntax>[1]) {
  const tokens = highlightSyntax(code, language);
  assert.ok(tokens);
  const spans = encodeSpans(tokens);
  const starts = lineStartOffsets(code);
  const lines = code.split("\n").map((_, i) => lineTokens(code, spans, starts, i));
  return { tokens, spans, lines };
}

const TS = [
  "/* a block",
  "   comment */ const a = 1;",
  "const s = `first",
  "second ${a}",
  "third`;",
  "",
  "function f() { return 'x'; }",
].join("\n");

test("file extensions pick the grammar, unknown ones stay plain", () => {
  assert.equal(syntaxLanguageForPath("/w/apps/web/src/App.tsx"), "typescript");
  assert.equal(syntaxLanguageForPath("/w/scripts/run.sh"), "bash");
  assert.equal(syntaxLanguageForPath("/w/Dockerfile"), "dockerfile");
  assert.equal(syntaxLanguageForPath("/w/data.bin"), null);
  assert.equal(syntaxLanguageForPath("/w/LICENSE"), null);
});

test("lineStartOffsets gives each line's start and an end sentinel", () => {
  assert.deepEqual([...lineStartOffsets("ab\n\ncd")], [0, 3, 4, 7]);
  assert.deepEqual([...lineStartOffsets("")], [0, 1]);
  assert.deepEqual([...lineStartOffsets("x")], [0, 2]);
});

test("a line's tokens equal the whole-file tokens split at line breaks", () => {
  const { tokens, lines } = spanned(TS, "typescript");
  assert.deepEqual(lines, splitSyntaxLines(tokens));
});

test("every line's tokens join back to the line", () => {
  const { lines } = spanned(TS, "typescript");
  assert.deepEqual(
    lines.map((line) => line.map((token) => token.text).join("")),
    TS.split("\n"),
  );
});

test("a block comment colors the lines it spans, not only its first", () => {
  const { lines } = spanned(TS, "typescript");
  assert.deepEqual(lines[0], [{ text: "/* a block", role: "comment" }]);
  assert.deepEqual(lines[1]![0], { text: "   comment */", role: "comment" });
});

test("a template string colors its middle lines and keeps ${} plain", () => {
  const { lines } = spanned(TS, "typescript");
  assert.equal(lines[2]!.at(-1)!.role, "string");
  const middle = lines[3]!;
  assert.deepEqual(middle[0], { text: "second ", role: "string" });
  assert.ok(middle.slice(1).some((token) => token.role === null), "the substitution drops to the code color");
  assert.equal(lines[4]![0]!.role, "string");
  assert.deepEqual(lines[5], []);
});

test("code after a multi-line token is colored as code again", () => {
  const { lines } = spanned(TS, "typescript");
  const keywords = lines[6]!.filter((token) => token.role === "keyword").map((token) => token.text);
  assert.deepEqual(keywords, ["function", "return"]);
});

test("tokensInRange cuts spans at the range edges", () => {
  const code = "const x = 1;";
  const tokens = highlightSyntax(code, "typescript")!;
  const spans = encodeSpans(tokens);
  const cut: SyntaxToken[] = tokensInRange(code, spans, 2, 8);
  assert.equal(cut.map((token) => token.text).join(""), "nst x ");
  assert.equal(cut[0]!.role, "keyword");
  assert.deepEqual(tokensInRange(code, spans, 5, 5), []);
});

test("plain tokens are stored as the plain role number", () => {
  const spans = encodeSpans([
    { text: "ab", role: null },
    { text: "c", role: "string" },
  ]);
  assert.deepEqual([...spans.starts], [0, 2]);
  assert.equal(spans.roles[0], PLAIN_ROLE);
  assert.notEqual(spans.roles[1], PLAIN_ROLE);
});
