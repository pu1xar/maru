import { test } from "node:test";
import assert from "node:assert/strict";
import { findTargets, hintedFindIndex, initialFindIndex, stepFindIndex } from "../../../../packages/shared/src/threadSearch.ts";
import {
  clampActive,
  findAnchor,
  findHasNoResult,
  findLabel,
  findStep,
  findStepDisabled,
  highlightSegments,
  itemOrder,
} from "./threadFind.ts";
import type { ThreadSnapshot } from "@maru/shared";

/** A snapshot of message items (`messageId` m<i>, item id i<i>) for the steps' tests. */
function snapshot(ids: string[], hasMoreBefore: boolean): ThreadSnapshot {
  return {
    hasMoreBefore,
    visibleTurnItems: ids.map((id, i) => ({
      position: i,
      item: { id, type: i % 2 === 0 ? "user_message" : "assistant_message", messageId: `m${id}`, text: "x" },
    })),
  } as unknown as ThreadSnapshot;
}

test("the bar's count text: nothing before a query, the wait, the failure, then 3/12", () => {
  assert.equal(findLabel("", "idle", 0, 0), "");
  assert.equal(findLabel("   ", "idle", 0, 0), "");
  assert.equal(findLabel("a", "searching", 0, 0), "Searching");
  assert.equal(findLabel("a", "error", 0, 0), "Not found");
  assert.equal(findLabel("a", "idle", 2, 12), "3/12");
  assert.equal(findLabel("a", "idle", 0, 0), "0/0");
  assert.equal(findHasNoResult("a", "idle", 0), true);
  assert.equal(findHasNoResult("a", "searching", 0), false);
  assert.equal(findHasNoResult("", "idle", 0), false);
  assert.equal(findStepDisabled("idle", 0), true);
  assert.equal(findStepDisabled("searching", 5), true);
  assert.equal(findStepDisabled("idle", 5), false);
});

test("stepping walks the occurrences and wraps at both ends", () => {
  assert.equal(stepFindIndex(2, 3, 1), 0);
  assert.equal(stepFindIndex(0, 3, -1), 2);
  assert.equal(stepFindIndex(1, 3, 1), 2);
});

test("a find starts at the newest occurrence at or above the lowest row on screen", () => {
  const result = {
    idPrefix: "t:",
    matches: [
      { id: "a", count: 2, role: "user" as const, at: null },
      { id: "c", count: 1, role: "assistant" as const, at: null },
    ],
  };
  const targets = findTargets(result);
  assert.deepEqual(targets.map((t) => `${t.itemId}#${t.occurrence}`), ["t:a#0", "t:a#1", "t:c#0"]);
  const order = new Map([["t:a", 0], ["t:b", 1], ["t:c", 2]]);
  const byEntry = new Map([["mt:a", 0], ["mt:b", 1], ["mt:c", 2]]);
  // At the end of the list: the newest occurrence.
  assert.equal(initialFindIndex(targets, (id) => order.get(id), findAnchor(["mt:c"], true, byEntry)), 2);
  // Reading above it: the lowest visible row is b, so the newest occurrence at or above b is a's last.
  const anchor = findAnchor(["mt:a", "mt:b"], false, byEntry);
  assert.equal(anchor, 1);
  assert.equal(initialFindIndex(targets, (id) => order.get(id), anchor), 1);
  // Rows the app does not know are skipped; none known leaves no anchor but the end rule.
  assert.equal(findAnchor(["unknown"], false, byEntry), null);
  assert.equal(findAnchor([], true, byEntry), null);
});

test("a hit from the search over every session starts the find at its item, else the nearest time", () => {
  const targets = findTargets({
    idPrefix: "",
    matches: [
      { id: "i1", count: 1, role: "user", at: "2026-11-17T01:00:00.000Z" },
      { id: "i2", count: 1, role: "assistant", at: "2026-11-17T02:00:00.000Z" },
      { id: "i3", count: 1, role: "user", at: "2026-11-17T03:00:00.000Z" },
    ],
  });
  assert.equal(hintedFindIndex(targets, { itemId: "i2", role: "assistant", at: null }), 1);
  assert.equal(hintedFindIndex(targets, { itemId: null, role: "user", at: "2026-11-17T02:50:00.000Z" }), 2);
});

test("a step shows a held item, asks for older rows for one not held, and gives up at the thread's start", () => {
  const held = snapshot(["i1", "i2"], true);
  const target = { itemId: "i2", occurrence: 0, role: "assistant" as const, at: null };
  assert.deepEqual(findStep(held, target, false), { kind: "show", entryId: "mi2" });
  const far = { ...target, itemId: "old" };
  assert.deepEqual(findStep(held, far, false), { kind: "load", itemId: "old" });
  assert.deepEqual(findStep(held, far, true), { kind: "wait" });
  assert.deepEqual(findStep(snapshot(["i1"], false), far, false), { kind: "missing" });
  assert.deepEqual(findStep(null, far, false), { kind: "wait" });
  const order = itemOrder(held);
  assert.equal(order.byItem.get("i2"), 1);
  assert.equal(order.byEntry.get("mi2"), 1);
});

test("a text is cut at the occurrences; the one numbered active is the active piece", () => {
  const segs = highlightSegments("Foo bar foo", "FOO", 3, 4);
  assert.deepEqual(segs, [
    { text: "Foo", hit: true, active: false },
    { text: " bar ", hit: false, active: false },
    { text: "foo", hit: true, active: true },
  ]);
  assert.deepEqual(highlightSegments("none", "x", 0, null), [{ text: "none", hit: false, active: false }]);
  assert.equal(segs.map((s) => s.text).join(""), "Foo bar foo", "the pieces make up the text");
  // Korean matches as typed, and a match at the very end leaves no empty tail.
  assert.deepEqual(highlightSegments("대화 검색", "검색", 0, 0), [
    { text: "대화 ", hit: false, active: false },
    { text: "검색", hit: true, active: true },
  ]);
});

test("a message that draws fewer matches than the server counted keeps its active one in range", () => {
  assert.equal(clampActive(5, 3), 2);
  assert.equal(clampActive(1, 3), 1);
  assert.equal(clampActive(null, 3), null);
  assert.equal(clampActive(2, 0), null);
});
