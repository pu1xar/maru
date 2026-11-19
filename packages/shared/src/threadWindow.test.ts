import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrchestrationV2ProjectedTurnItem, ThreadSnapshot } from "./turnItems.ts";
import { conversationRowStarts, prependOlder, windowStartIndex, type ThreadOlder } from "./threadWindow.ts";

/** Rows from a type string: u user, a assistant, t tool call, r reasoning, n notice. */
function rows(spec: string, firstPosition = 0): OrchestrationV2ProjectedTurnItem[] {
  const types: Record<string, string> = { u: "user_message", a: "assistant_message", t: "command_execution", r: "reasoning", n: "system_notice" };
  return [...spec].map((c, i) => ({
    position: firstPosition + i,
    visibility: "local",
    sourceThreadId: "th",
    sourceItemId: `i${firstPosition + i}`,
    item: { id: `i${firstPosition + i}`, type: types[c] } as OrchestrationV2ProjectedTurnItem["item"],
    x: { raw: [], sourceKey: "test" },
  })) as unknown as OrchestrationV2ProjectedTurnItem[];
}

test("conversation rows: each message is one, the run of other items between messages is one", () => {
  assert.deepEqual(conversationRowStarts(rows("")), []);
  assert.deepEqual(conversationRowStarts(rows("u")), [0]);
  //            u  a  t r t  a  u  t
  // rows:      0  1  2----   5  6  7
  assert.deepEqual(conversationRowStarts(rows("uatrtaut")), [0, 1, 2, 5, 6, 7]);
  // A thread that starts with tool calls (a page cut): they are one row until the first message.
  assert.deepEqual(conversationRowStarts(rows("ttaua")), [0, 2, 3, 4]);
  assert.deepEqual(conversationRowStarts(rows("uaua")), [0, 1, 2, 3]);
});

test("window: fewer rows than asked takes everything at the thread's start", () => {
  // 3 rows, 30 asked, nothing before: all of it, and that is the whole request.
  assert.deepEqual(windowStartIndex(rows("uat"), 30, false), { start: 0, complete: true });
  assert.deepEqual(windowStartIndex(rows(""), 30, false), { start: 0, complete: true });
});

test("window: exactly as many rows as asked", () => {
  const items = rows("ua".repeat(15)); // 30 rows
  assert.deepEqual(windowStartIndex(items, 30, false), { start: 0, complete: true });
  // With lines before the first item, the first row may be cut: 29 whole rows are not enough.
  assert.deepEqual(windowStartIndex(items, 30, true), { start: 1, complete: false });
  // One more row read: the cut row drops out and 30 whole rows remain.
  assert.deepEqual(windowStartIndex(rows("t" + "ua".repeat(15)), 30, true), { start: 1, complete: true });
});

test("window: more rows than asked starts at the 30th newest row, never inside a tool run", () => {
  const items = rows("u" + "attta".repeat(10)); // u, then 10 x (a, ttt group, a)
  const starts = conversationRowStarts(items);
  assert.equal(starts.length, 31);
  const w = windowStartIndex(items, 30, false);
  assert.deepEqual(w, { start: starts[1], complete: true });
  // A start is a row start: the item before it is a message or the item is one.
  const before = items[w.start - 1]!.item.type;
  assert.ok(before === "user_message" || before === "assistant_message" || ["user_message", "assistant_message"].includes(items[w.start]!.item.type));
  // 5 rows from a long tool run: the run counts once.
  assert.deepEqual(windowStartIndex(rows("uattttttta"), 2, false), { start: 2, complete: true });
});

function snap(items: OrchestrationV2ProjectedTurnItem[], over: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    threadId: "th", lineage: {} as ThreadSnapshot["lineage"], providerInstanceId: "p", title: "t", state: {} as ThreadSnapshot["state"],
    runtime: null, runs: [], visibleTurnItems: items, branches: { lanes: [] }, subagents: [], tokenUsage: null, hasMoreBefore: true, ...over,
  };
}

test("prependOlder: older rows go in front and the held rows move by the shift", () => {
  // The client holds rows the server numbered 0..3; the server read 4 older rows and renumbered them 4..7.
  const held = snap(rows("uaua"));
  const older: ThreadOlder = { ...snap([]), visibleTurnItems: rows("tuat", 0).map((r) => ({ ...r, item: { ...r.item, id: `o${r.position}` } })), positionShift: 4, requested: true, hasMoreBefore: false, title: "new" };
  const next = prependOlder(held, older);
  assert.deepEqual(next.visibleTurnItems.map((r) => r.item.id), ["o0", "o1", "o2", "o3", "i0", "i1", "i2", "i3"]);
  assert.deepEqual(next.visibleTurnItems.map((r) => r.position), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(next.hasMoreBefore, false);
  assert.equal(next.title, "new");
  assert.equal("requested" in next, false);
  assert.equal("positionShift" in next, false);
});

test("prependOlder: no rows and no shift keeps the held array (no rerender of the rows)", () => {
  const held = snap(rows("uaua"));
  const next = prependOlder(held, { ...snap([]), positionShift: 0, requested: false, hasMoreBefore: true });
  assert.equal(next.visibleTurnItems, held.visibleTurnItems);
  // A shift alone renumbers.
  const moved = prependOlder(held, { ...snap([]), positionShift: 10, requested: false, hasMoreBefore: true });
  assert.deepEqual(moved.visibleTurnItems.map((r) => r.position), [10, 11, 12, 13]);
  // Another thread's message changes nothing.
  assert.equal(prependOlder(held, { ...snap([]), threadId: "other", positionShift: 3, requested: true, hasMoreBefore: false }), held);
});

// ---- resuming (DESIGN.md 6r) ----

import { applyResumed, commonPrefix, hashText, newestRows, rowDigest, threadHave, validHave, type ThreadHave, type ThreadResumed } from "./threadWindow.ts";

/** The server's side of a resume for the tests: the window from the client's first row, minus the rows it holds. */
function resumedFor(after: ThreadSnapshot, have: ThreadHave): ThreadResumed {
  const j = after.visibleTurnItems.findIndex((r) => r.item.id === have.first);
  const items = after.visibleTurnItems.slice(j);
  const digests = items.map(rowDigest);
  let keep = 0;
  while (keep < digests.length && keep < have.digests.length && digests[keep] === have.digests[keep]) keep++;
  const rest = items.slice(keep).map((r) => r.item.id);
  const prefix = commonPrefix(rest);
  const { visibleTurnItems: _v, ...fields } = after;
  return {
    threadId: "th", snapshot: fields, keep, idPrefix: prefix, ids: rest.map((id) => id.slice(prefix.length)),
    positions: items.map((r) => r.position), rows: items.filter((_, k) => !have.digests.includes(digests[k]!)),
  };
}

test("rowDigest ignores the position and an ordinal that follows it, and sees any other change", () => {
  const [a] = rows("a", 3);
  // Codex: an ordinal equal to the position moves with it.
  const codex = { ...a!, item: { ...a!.item, ordinal: 3 } } as OrchestrationV2ProjectedTurnItem;
  const codexMoved = { ...a!, position: 9, item: { ...a!.item, ordinal: 9 } } as OrchestrationV2ProjectedTurnItem;
  assert.equal(rowDigest(codex), rowDigest(codexMoved));
  // Claude: the ordinal comes from the line's offset, the position alone changes nothing.
  const claude = { ...a!, item: { ...a!.item, ordinal: 4096 } } as OrchestrationV2ProjectedTurnItem;
  assert.equal(rowDigest(claude), rowDigest({ ...claude, position: 9 }));
  assert.notEqual(rowDigest(claude), rowDigest({ ...claude, item: { ...claude.item, text: "changed" } as never }));
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
});

test("have: the first and last ids place the rows, the digests say which are held", () => {
  const items = rows("uatau");
  const have = threadHave(items);
  assert.equal(have.rows, 5);
  assert.deepEqual([have.first, have.last], ["i0", "i4"]);
  assert.deepEqual(have.digests, items.map(rowDigest));
  assert.equal(validHave(have), true);
  assert.equal(validHave({ ...have, fields: { title: "x" } }), true);
  assert.equal(validHave({ ...have, fields: { title: 3 } }), false);
  assert.equal(validHave({ ...have, digests: [] }), false);
  assert.equal(validHave({ ...have, digests: [3] }), false);
  assert.equal(validHave({ ...have, first: "" }), false);
  assert.equal(validHave({ ...have, rows: "5" }), false);
  assert.equal(validHave(null), false);
  assert.equal(commonPrefix([]), "");
  assert.equal(commonPrefix(["abc", "abd", "ab"]), "ab");
  assert.equal(commonPrefix(["x", "y"]), "");
});

test("applyResumed: held rows move to their new positions, changed and new rows come from the answer", () => {
  const held = snap(rows("uatau", 10));
  const have = threadHave(held.visibleTurnItems);
  // The server numbers from another start, row i12 changed, and two rows came after.
  const now = rows("uatauau", 6).map((r, k) => ({ ...r, item: { ...r.item, id: `i${10 + k}` }, sourceItemId: `i${10 + k}` })) as OrchestrationV2ProjectedTurnItem[];
  now[2] = { ...now[2]!, item: { ...now[2]!.item, text: "changed" } as never };
  const after = snap(now);
  const resumed = resumedFor(after, have);
  assert.deepEqual(resumed.rows.map((r) => r.item.id), ["i12", "i15", "i16"]);
  assert.equal(resumed.keep, 2, "the first two rows are the client's own, so their ids are not sent");
  assert.deepEqual(resumed.ids, ["2", "3", "4", "5", "6"]);
  const out = applyResumed(held, resumed)!;
  assert.deepEqual(out.visibleTurnItems, after.visibleTurnItems);
  assert.deepEqual(out.visibleTurnItems.map((r) => r.position), [6, 7, 8, 9, 10, 11, 12]);
  // A row left out that the client does not hold: the caller must ask for a plain snapshot.
  // A row the answer names without sending it, which the client does not hold: a plain snapshot is needed.
  assert.equal(applyResumed(snap([]), { ...resumed, keep: 0, idPrefix: "i1", ids: ["0", "1"], positions: [0, 1], rows: [] }), null);
  assert.equal(applyResumed(null, resumed), null);
  assert.equal(applyResumed(held, { ...resumed, threadId: "other" }), null);
  assert.equal(applyResumed(held, { ...resumed, keep: 99 }), null);
  assert.equal(applyResumed(held, { ...resumed, positions: resumed.positions.slice(1) }), null);
});

test("applyResumed keeps the object of a row whose position did not move", () => {
  const held = snap(rows("uat", 0));
  const resumed = resumedFor(held, threadHave(held.visibleTurnItems));
  assert.equal(resumed.rows.length, 0);
  const out = applyResumed(held, resumed)!;
  assert.ok(out.visibleTurnItems.every((r, i) => r === held.visibleTurnItems[i]), "same objects");
});

test("applyResumed moves a Codex ordinal with the position and leaves a Claude one", () => {
  const codex = rows("ua", 5).map((r) => ({ ...r, item: { ...r.item, ordinal: r.position } })) as OrchestrationV2ProjectedTurnItem[];
  const claude = rows("ua", 5).map((r) => ({ ...r, item: { ...r.item, ordinal: r.position * 1000 } })) as OrchestrationV2ProjectedTurnItem[];
  for (const [items, expected] of [[codex, [0, 1]], [claude, [5000, 6000]]] as const) {
    const held = snap(items);
    const { visibleTurnItems: _v, ...fields } = held;
    const resumed: ThreadResumed = { threadId: "th", snapshot: fields, keep: 1, idPrefix: "i", ids: ["6"], positions: [0, 1], rows: [] };
    const out = applyResumed(held, resumed)!;
    assert.deepEqual(out.visibleTurnItems.map((r) => r.item.ordinal), expected);
  }
});

test("newestRows keeps the newest conversation rows and marks older ones as unread", () => {
  const s = snap(rows("ua".repeat(10), 0), { hasMoreBefore: false });
  assert.equal(newestRows(s, 20), s);
  const cut = newestRows(s, 4);
  assert.deepEqual(cut.visibleTurnItems.map((r) => r.item.id), ["i16", "i17", "i18", "i19"]);
  assert.equal(cut.hasMoreBefore, true);
  // A run of tool calls counts as one row: the cut lands on the row's first item.
  const t = newestRows(snap(rows("uattta", 0), { hasMoreBefore: false }), 2);
  assert.deepEqual(t.visibleTurnItems.map((r) => r.item.id), ["i2", "i3", "i4", "i5"]);
});
