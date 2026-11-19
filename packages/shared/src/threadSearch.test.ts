import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrchestrationV2ProjectedTurnItem } from "./turnItems.ts";
import {
  countOccurrences, findOccurrences, findTargets, formatFindCount, hintedFindIndex, initialFindIndex,
  searchDocsOf, snippetAt, stepFindIndex, threadSearchResult, type SearchDoc,
} from "./threadSearch.ts";
import { rowsThrough } from "./threadWindow.ts";

test("occurrences: case folded, Korean as typed, no overlap, whitespace-only finds nothing", () => {
  assert.deepEqual(findOccurrences("Hello hello HELLO", "hello"), [0, 6, 12]);
  assert.deepEqual(findOccurrences("대화 검색은 검색창에서", "검색"), [3, 7]);
  assert.deepEqual(findOccurrences("aaaa", "aa"), [0, 2]);
  assert.deepEqual(findOccurrences("abc", " "), []);
  assert.deepEqual(findOccurrences("abc", ""), []);
  assert.deepEqual(findOccurrences("", "a"), []);
  // A query with spaces inside matches as typed.
  assert.deepEqual(findOccurrences("run the dev server", "the dev"), [4]);
  assert.equal(countOccurrences("Hello hello HELLO", "HeLLo"), 3);
  assert.equal(countOccurrences("대화 검색은 검색창에서", "검색"), 2);
});

test("occurrences: offsets stay in the original text when folding changes a length", () => {
  // "İ" folds to two code units ("i̇"), which would shift every later offset.
  const text = "İstanbul and istanbul";
  const at = findOccurrences(text, "and");
  assert.deepEqual(at, [9]);
  assert.equal(text.slice(at[0], at[0]! + 3), "and");
  assert.deepEqual(findOccurrences(text, "stanbul"), [1, 14]);
});

/** Projected rows from a type string: u user, a assistant, t tool call, c command output, n other notice. */
function rows(spec: string, texts: string[]): OrchestrationV2ProjectedTurnItem[] {
  return [...spec].map((c, i) => {
    const base = { id: `th:i${i}`, startedAt: `2026-11-17T00:00:0${i}.000Z`, updatedAt: `2026-11-17T00:00:0${i}.000Z` };
    const item =
      c === "u" ? { ...base, type: "user_message", text: texts[i] ?? "" }
      : c === "a" ? { ...base, type: "assistant_message", text: texts[i] ?? "" }
      : c === "c" || c === "n" ? { ...base, type: "system_notice", message: texts[i] ?? "" }
      : { ...base, type: "command_execution" };
    return {
      position: i,
      item,
      x: { raw: [], sourceKey: "t", ...(c === "c" ? { noticeKind: "command_output" } : c === "n" ? { noticeKind: "info" } : {}) },
    };
  }) as unknown as OrchestrationV2ProjectedTurnItem[];
}

test("searchable rows: messages and command output; tool calls, other notices and empty texts are not", () => {
  const docs = searchDocsOf(rows("uatcna", ["질문", "답", "", "/context 표", "알림", ""]));
  assert.deepEqual(docs.map((d) => [d.id, d.role, d.text]), [
    ["th:i0", "user", "질문"],
    ["th:i1", "assistant", "답"],
    ["th:i3", "notice", "/context 표"],
  ]);
  assert.equal(docs[0]!.at, "2026-11-17T00:00:00.000Z");
});

test("result: matches in thread order with counts, ids without the shared prefix, the denominator", () => {
  const docs: SearchDoc[] = [
    { id: "claude:a:s:uuid:1", role: "user", text: "find me, Find me", at: null },
    { id: "claude:a:s:uuid:2", role: "assistant", text: "nothing", at: null },
    { id: "claude:a:s:blk:m:0", role: "assistant", text: "FIND", at: "t" },
  ];
  const r = threadSearchResult("claude:a:s", "r1", "find", docs);
  assert.equal(r.total, 3);
  assert.equal(r.searched, 3);
  assert.equal(r.idPrefix, "claude:a:s");
  assert.deepEqual(r.matches.map((m) => [m.id, m.count]), [[":uuid:1", 2], [":blk:m:0", 1]]);
  const targets = findTargets(r);
  assert.deepEqual(targets.map((t) => `${t.itemId}#${t.occurrence}`), [
    "claude:a:s:uuid:1#0", "claude:a:s:uuid:1#1", "claude:a:s:blk:m:0#0",
  ]);
  // One match: the prefix is the thread id and its separator part, the id keeps its own part.
  const one = threadSearchResult("claude:a:s", "r2", "nothing", docs);
  assert.equal(one.idPrefix + one.matches[0]!.id, "claude:a:s:uuid:2");
  const none = threadSearchResult("claude:a:s", "r3", "zzz", docs);
  assert.deepEqual([none.total, none.matches.length], [0, 0]);
});

test("stepping wraps at both ends; the count reads n/total", () => {
  assert.equal(stepFindIndex(0, 5, 1), 1);
  assert.equal(stepFindIndex(4, 5, 1), 0);
  assert.equal(stepFindIndex(0, 5, -1), 4);
  assert.equal(stepFindIndex(9, 5, -1), 3);
  assert.equal(stepFindIndex(0, 0, 1), 0);
  assert.equal(formatFindCount(2, 12), "3/12");
  assert.equal(formatFindCount(0, 0), "0/0");
  assert.equal(formatFindCount(40, 12), "12/12");
});

test("a new find starts at the newest occurrence at or above the reader's place", () => {
  const targets = ["old1", "old2", "h1", "h2", "h3"].map((itemId) => ({ itemId, occurrence: 0, role: "user" as const, at: null }));
  const order = new Map([["h1", 10], ["h2", 20], ["h3", 30]]);
  const orderOf = (id: string) => order.get(id);
  assert.equal(initialFindIndex(targets, orderOf, null), 4, "at the end: the newest");
  assert.equal(initialFindIndex(targets, orderOf, 25), 3);
  assert.equal(initialFindIndex(targets, orderOf, 10), 2);
  assert.equal(initialFindIndex(targets, orderOf, 5), 1, "above every held match: the newest unheld one");
  assert.equal(initialFindIndex([], orderOf, 5), 0);
});

test("a hint from the search over every session picks its item, else the same role nearest in time", () => {
  const t = (itemId: string, role: "user" | "assistant", at: string, occurrence = 0) => ({ itemId, occurrence, role, at });
  const targets = [
    t("a", "user", "2026-11-17T01:00:00Z"),
    t("a", "user", "2026-11-17T01:00:00Z", 1),
    t("b", "assistant", "2026-11-17T02:00:00Z"),
    t("c", "user", "2026-11-17T03:00:00Z"),
  ];
  assert.equal(hintedFindIndex(targets, { itemId: "c", role: "user", at: null }), 3);
  assert.equal(hintedFindIndex(targets, { itemId: null, role: "user", at: "2026-11-17T01:10:00Z" }), 0);
  assert.equal(hintedFindIndex(targets, { itemId: "gone", role: "assistant", at: "2026-11-17T09:00:00Z" }), 2);
  assert.equal(hintedFindIndex(targets, { itemId: null, role: "notice", at: "2026-11-17T09:00:00Z" }), 3, "no such role: the newest");
  assert.equal(hintedFindIndex([], { itemId: null, role: "user", at: null }), -1);
});

test("snippet: one line around the occurrence, cut at spaces, ellipses where text goes on", () => {
  const text = "first line\nsecond line has the word target in it and then much more text after that goes on";
  const at = text.indexOf("target");
  const s = snippetAt(text, at, 6, 20);
  assert.equal(s.match, "target");
  assert.ok(s.before.startsWith("..."));
  assert.ok(!s.before.includes("\n"));
  assert.ok(s.after.endsWith("..."));
  assert.equal(snippetAt("short target", 6, 6).before, "short ");
  assert.equal(snippetAt("short target", 6, 6).after, "");
});

test("rows through an item: the window that reaches it", () => {
  // u a t r t a u: rows start at 0 1 2 5 6
  const list = rows("uatntau", []);
  assert.equal(rowsThrough(list, "th:i6"), 1);
  assert.equal(rowsThrough(list, "th:i5"), 2);
  assert.equal(rowsThrough(list, "th:i3"), 3, "an item inside a tool run belongs to the run's row");
  assert.equal(rowsThrough(list, "th:i0"), 5);
  assert.equal(rowsThrough(list, "nope"), null);
});
