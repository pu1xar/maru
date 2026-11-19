import { test } from "node:test";
import assert from "node:assert/strict";
import type { TermBlock } from "../../../web/src/components/terminal/terminalModel.ts";
import { columnsFor, linesBefore, sessionModeStoreKey, terminalGrid } from "./terminalView.logic.ts";

test("the grid is the web's iTerm cell: 15pt Bon is 20 high with 9 wide cells", () => {
  const g = terminalGrid("bon", 15);
  assert.equal(g.fontSize, 15);
  assert.equal(g.lineHeight, 20);
  // 'W' advance is 0.6em = 9 at 15pt, so no spacing is needed.
  assert.equal(g.letterSpacing, 0);
  const small = terminalGrid("bon", 13);
  // 7.8 advance rounds to a cell of 8, so each glyph takes 0.2 more.
  // ceil(16.276) = 17, x 1.01 = 17.17, ceil again = 18.
  assert.equal(small.lineHeight, 18);
  assert.equal(small.letterSpacing, 0.2);
});

test("a font without measured metrics keeps its advance and rows of 1.2 x 1.01", () => {
  const g = terminalGrid("system", 15);
  assert.equal(g.lineHeight, Math.ceil(15 * 1.2 * 1.01));
  assert.equal(g.letterSpacing, 0);
});

test("columns come from ten measured cells, at least 20", () => {
  assert.equal(columnsFor(360, 90), 40);
  assert.equal(columnsFor(100, 90), 20);
  assert.equal(columnsFor(0, 90), 120);
  assert.equal(columnsFor(360, 0), 120);
});

const block = (kind: TermBlock["kind"]) => ({ kind, id: kind }) as unknown as TermBlock;

test("one empty line between blocks, none after a stamp or before an interrupt or command output", () => {
  assert.equal(linesBefore(undefined, block("user")), 0);
  assert.equal(linesBefore(block("user"), block("assistant")), 1);
  assert.equal(linesBefore(block("stamp"), block("assistant")), 0);
  assert.equal(linesBefore(block("tool"), block("interrupted")), 0);
  assert.equal(linesBefore(block("user"), block("command-output")), 0);
});

test("a session mode's store key holds only characters the store accepts, and two sessions never share one", () => {
  const a = sessionModeStoreKey("claude:acct:abc-123");
  assert.match(a, /^[A-Za-z0-9._-]+$/);
  assert.ok(a.startsWith("maru_view_mode."));
  assert.notEqual(sessionModeStoreKey("a:b"), sessionModeStoreKey("a_b"));
  assert.notEqual(sessionModeStoreKey("a:b"), sessionModeStoreKey("a_003ab"));
  assert.match(sessionModeStoreKey("codex:한글/경로"), /^[A-Za-z0-9._-]+$/);
});
