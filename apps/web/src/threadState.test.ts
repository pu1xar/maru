import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  ThreadLiveEvent,
  ThreadSnapshot,
} from "@maru/shared";
import { threadHave } from "@maru/shared";
import { applyThreadEvents, initialThreadState, keptThreadState, threadReducer } from "./threadState.ts";

const T = "claude:a:00000000-0000-0000-0000-000000000001";

function assistant(id: string, text: string, position: number): OrchestrationV2ProjectedTurnItem {
  const item = {
    id, threadId: T, runId: `${T}:run:r1`, nodeId: null, providerThreadId: null, providerTurnId: null,
    nativeItemRef: null, parentItemId: null, ordinal: position * 100, status: "running", title: null,
    startedAt: "2026-11-15T00:00:00.000Z", completedAt: null, updatedAt: "2026-11-15T00:00:00.000Z",
    type: "assistant_message", messageId: id, text, streaming: true,
  } satisfies OrchestrationV2TurnItem;
  return { position, visibility: "local", sourceThreadId: T, sourceItemId: id, item };
}

function snapshot(rows: OrchestrationV2ProjectedTurnItem[]): ThreadSnapshot {
  return {
    threadId: T,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: T },
    providerInstanceId: "claude:.claude",
    title: "t",
    state: {
      ownership: "terminal", control: "readonly", nameSource: "id",
      stats: { linesRead: 0, parseFailures: 0, partialTail: 0, byKey: {}, displayedByKey: {}, hiddenByKey: {}, unknownByKey: {} },
    },
    runtime: null,
    runs: [],
    visibleTurnItems: rows,
    branches: { lanes: [] },
    subagents: [],
    tokenUsage: null,
    hasMoreBefore: true,
  };
}

const text = (s: ThreadSnapshot, i: number) => (s.visibleTurnItems[i]!.item as { text: string }).text;

test("turnItem.upserted replaces by item id, then by position, else appends in position order", () => {
  const base = snapshot([assistant("a", "one", 0), assistant("b", "two", 1)]);
  const out = applyThreadEvents(base, [
    { t: "turnItem.upserted", threadId: T, row: assistant("b", "two!", 1) },
    { t: "turnItem.upserted", threadId: T, row: assistant("a2", "replaced at 0", 0) },
    { t: "turnItem.upserted", threadId: T, row: assistant("d", "four", 3) },
    { t: "turnItem.upserted", threadId: T, row: assistant("c", "three", 2) },
  ]);
  assert.deepEqual(out.visibleTurnItems.map((r) => r.item.id), ["a2", "b", "c", "d"]);
  assert.equal(text(out, 1), "two!");
  // The input snapshot is untouched.
  assert.deepEqual(base.visibleTurnItems.map((r) => r.item.id), ["a", "b"]);
});

test("turnItem.textAppended appends to the named field and only renews that item", () => {
  const base = snapshot([assistant("a", "Hel", 0), assistant("b", "x", 1)]);
  const out = applyThreadEvents(base, [
    { t: "turnItem.textAppended", threadId: T, itemId: "a", field: "text", value: "lo" },
    { t: "turnItem.textAppended", threadId: T, itemId: "a", field: "text", value: " world" },
    { t: "turnItem.textAppended", threadId: T, itemId: "missing", field: "text", value: "?" },
  ]);
  assert.equal(text(out, 0), "Hello world");
  assert.notEqual(out.visibleTurnItems[0], base.visibleTurnItems[0]);
  assert.equal(out.visibleTurnItems[1], base.visibleTurnItems[1]);
});

test("textAppended on an absent field starts from empty (command output)", () => {
  const row = assistant("cmd", "", 0);
  const command = {
    ...row,
    item: { ...row.item, type: "command_execution", input: "ls" } as unknown as OrchestrationV2TurnItem,
  };
  const out = applyThreadEvents(snapshot([command]), [
    { t: "turnItem.textAppended", threadId: T, itemId: "cmd", field: "output", value: "a.txt\n" },
  ]);
  assert.equal((out.visibleTurnItems[0]!.item as { output?: string }).output, "a.txt\n");
});

test("turnItems.replaced swaps rows and branches; later upserts in the batch apply on top", () => {
  const base = snapshot([assistant("a", "one", 0)]);
  const out = applyThreadEvents(base, [
    {
      t: "turnItems.replaced", threadId: T, reason: "resync",
      visibleTurnItems: [assistant("x", "x", 0), assistant("y", "y", 1)],
      branches: { lanes: [{ laneId: "l1", forkPointUuid: "u", items: [] }] },
    },
    { t: "turnItem.textAppended", threadId: T, itemId: "y", field: "text", value: "!" },
  ]);
  assert.deepEqual(out.visibleTurnItems.map((r) => r.item.id), ["x", "y"]);
  assert.equal(text(out, 1), "y!");
  assert.equal(out.branches.lanes.length, 1);
});

test("records: run, subagent, runtime, patch, token usage", () => {
  const base = snapshot([]);
  const run = { runId: "r1", status: "running", requestedAt: null, startedAt: null, completedAt: null, assistantMessageId: null } as const;
  const sub = {
    id: "s1", threadId: T, runId: null, parentNodeId: "p", origin: "provider_native", createdBy: "agent", driver: "claude",
    providerInstanceId: "claude:.claude", providerThreadId: null, childThreadId: `${T}:agent-x`, nativeTaskRef: null,
    prompt: "p", title: null, model: null, status: "running", result: null, startedAt: null, completedAt: null, updatedAt: "z",
  } as const;
  const events: ThreadLiveEvent[] = [
    { t: "run.upserted", threadId: T, run },
    { t: "run.upserted", threadId: T, run: { ...run, status: "completed" } },
    { t: "subagent.upserted", threadId: T, subagent: sub },
    { t: "runtime.updated", threadId: T, runtime: { status: "running", activeRunId: "r1", providerInstanceId: "claude:.claude", providerName: null, lastError: null } },
    { t: "thread.patched", threadId: T, title: "new", state: { model: "opus" } },
    { t: "tokenUsage.updated", threadId: T, usage: { usedTokens: 5 } },
    { t: "usageLimits.updated", providerInstanceId: "claude:.claude", limits: { checkedAt: "z", windows: [] } },
    { t: "run.upserted", threadId: "someone-else", run: { ...run, runId: "other" } },
  ];
  const out = applyThreadEvents(base, events);
  assert.deepEqual(out.runs.map((r) => [r.runId, r.status]), [["r1", "completed"]]);
  assert.equal(out.subagents.length, 1);
  assert.equal(out.runtime?.activeRunId, "r1");
  assert.equal(out.title, "new");
  assert.equal(out.state.model, "opus");
  assert.equal(out.state.ownership, "terminal");
  assert.equal(out.tokenUsage?.usedTokens, 5);
  assert.equal(out.visibleTurnItems, base.visibleTurnItems);
});

test("reducer: snapshot clears error and loadingOlder; other threads are ignored", () => {
  let s = initialThreadState(T);
  s = threadReducer(s, { type: "loadOlderRequested", threadId: T });
  assert.equal(s.loadingOlder, true);
  s = threadReducer(s, { type: "error", threadId: T, error: "boom" });
  assert.equal(s.loadingOlder, false);
  assert.equal(s.error, "boom");
  s = threadReducer(s, { type: "snapshot", snapshot: { ...snapshot([]), threadId: "other" } });
  assert.equal(s.snapshot, null);
  s = threadReducer(s, { type: "snapshot", snapshot: snapshot([assistant("a", "x", 0)]) });
  assert.equal(s.error, null);
  assert.equal(s.snapshot?.visibleTurnItems.length, 1);
  const same = threadReducer(s, { type: "events", threadId: "other", events: [] });
  assert.equal(same, s);
});

test("reducer: events before the first snapshot only track removal", () => {
  let s = initialThreadState(T);
  s = threadReducer(s, { type: "events", threadId: T, events: [{ t: "thread.removed", threadId: T, reason: "deleted" }] });
  assert.equal(s.removed, "deleted");
  assert.equal(s.snapshot, null);
});

test("reducer: an unchanged batch keeps the same state object", () => {
  let s = threadReducer(initialThreadState(T), { type: "snapshot", snapshot: snapshot([assistant("a", "x", 0)]) });
  const before = s;
  s = threadReducer(s, { type: "events", threadId: T, events: [{ t: "pending.updated", threadId: T, approvals: [], userInputs: [] }] });
  assert.equal(s, before);
});

test("reducer: thread.older puts older rows in front, moves the held positions, and ends only this view's request", () => {
  // The window holds rows the server numbered 0 and 1; the server read 2 older rows.
  let s = threadReducer(initialThreadState(T), { type: "snapshot", snapshot: snapshot([assistant("c", "three", 0), assistant("d", "four", 1)]) });
  s = threadReducer(s, { type: "loadOlderRequested", threadId: T });
  const { visibleTurnItems: _rows, ...fields } = snapshot([]);
  // Another reader's request: positions move, this view still waits.
  s = threadReducer(s, { type: "older", older: { ...fields, visibleTurnItems: [], positionShift: 2, requested: false, hasMoreBefore: true } });
  assert.equal(s.loadingOlder, true);
  assert.deepEqual(s.snapshot!.visibleTurnItems.map((r) => [r.item.id, r.position]), [["c", 2], ["d", 3]]);
  // This view's answer: the older rows in front, the request ends, nothing older remains.
  s = threadReducer(s, {
    type: "older",
    older: { ...fields, visibleTurnItems: [assistant("a", "one", 0), assistant("b", "two", 1)], positionShift: 0, requested: true, hasMoreBefore: false, title: "renamed" },
  });
  assert.equal(s.loadingOlder, false);
  assert.deepEqual(s.snapshot!.visibleTurnItems.map((r) => [r.item.id, r.position]), [["a", 0], ["b", 1], ["c", 2], ["d", 3]]);
  assert.equal(s.snapshot!.hasMoreBefore, false);
  assert.equal(s.snapshot!.title, "renamed");
  // A live row after it lands at the end in order.
  const next = applyThreadEvents(s.snapshot!, [{ t: "turnItem.upserted", threadId: T, row: assistant("e", "five", 4) }]);
  assert.deepEqual(next.visibleTurnItems.map((r) => r.item.id), ["a", "b", "c", "d", "e"]);
});

test("reducer: a windowed replacement says whether older rows exist", () => {
  const base = snapshot([assistant("a", "x", 0)]);
  const out = applyThreadEvents(base, [{ t: "turnItems.replaced", threadId: T, reason: "branch", visibleTurnItems: [assistant("b", "y", 7)], branches: { lanes: [] }, hasMoreBefore: false }]);
  assert.equal(out.hasMoreBefore, false);
  // A plain subscription's replacement has no field and leaves it.
  const plain = applyThreadEvents(base, [{ t: "turnItems.replaced", threadId: T, reason: "resync", visibleTurnItems: [assistant("b", "y", 0)], branches: { lanes: [] } }]);
  assert.equal(plain.hasMoreBefore, true);
});

/** What the server answers a client that holds `held` while the thread is now `now` (no leading ids shared). */
function resumedFrom(held: ThreadSnapshot, now: ThreadSnapshot) {
  const known = new Set(threadHave(held.visibleTurnItems).digests);
  const { visibleTurnItems: items, ...fields } = now;
  return {
    threadId: T, snapshot: fields, keep: 0, idPrefix: "", ids: items.map((r) => r.item.id), positions: items.map((r) => r.position),
    rows: items.filter((r) => !known.has(threadHave([r]).digests[0]!)),
  };
}

test("reducer: a kept snapshot waits for the resumed answer, ignoring live messages until then", () => {
  const kept = snapshot([assistant("a", "one", 0), assistant("b", "two", 1)]);
  let state = threadReducer(keptThreadState(kept), { type: "resuming", threadId: T });
  assert.deepEqual([state.resuming, state.loadingOlder], [true, true], "waiting counts as loading, so no older request goes out and a restore waits");
  assert.equal(state.snapshot, kept, "the kept rows stay on screen");
  // An event or older page from before the answer is not applied: the answer is computed after them.
  const stale = threadReducer(state, { type: "events", threadId: T, events: [{ t: "turnItem.textAppended", threadId: T, itemId: "b", field: "text", value: "!" }] });
  assert.equal(stale, state);
  // The answer: b changed and c came; a keeps its object.
  const now = snapshot([assistant("a", "one", 0), assistant("b", "two!!", 1), assistant("c", "three", 2)]);
  state = threadReducer(state, { type: "resumed", resumed: resumedFrom(kept, now) });
  assert.deepEqual([state.resuming, state.loadingOlder, state.needsFull], [false, false, false]);
  assert.deepEqual(state.snapshot!.visibleTurnItems, now.visibleTurnItems);
  assert.equal(state.snapshot!.visibleTurnItems[0], kept.visibleTurnItems[0]);
  // Live events apply again.
  const live = threadReducer(state, { type: "events", threadId: T, events: [{ t: "turnItem.textAppended", threadId: T, itemId: "c", field: "text", value: "?" }] });
  assert.equal(text(live.snapshot!, 2), "three?");
});

test("reducer: a resumed answer that does not fit the kept rows asks for a plain snapshot", () => {
  const kept = snapshot([assistant("a", "one", 0)]);
  let state = threadReducer(keptThreadState(kept), { type: "resuming", threadId: T });
  // The server left out row "a" as held, but this state no longer has it.
  const other = snapshot([assistant("z", "zed", 0)]);
  state = threadReducer({ ...state, snapshot: other }, { type: "resumed", resumed: resumedFrom(kept, kept) });
  assert.equal(state.needsFull, true);
  assert.equal(state.snapshot, null);
  state = threadReducer(state, { type: "fullRequested", threadId: T });
  assert.equal(state.needsFull, false);
  // The plain snapshot that follows is taken as it is.
  state = threadReducer(state, { type: "snapshot", snapshot: kept });
  assert.equal(state.snapshot, kept);
  assert.equal(state.resuming, false);
});

test("reducer: a snapshot or an error ends the wait for a resumed answer; resuming needs a held snapshot", () => {
  const kept = snapshot([assistant("a", "one", 0)]);
  const waiting = threadReducer(keptThreadState(kept), { type: "resuming", threadId: T });
  assert.equal(threadReducer(waiting, { type: "snapshot", snapshot: kept }).resuming, false);
  const failed = threadReducer(waiting, { type: "error", threadId: T, error: "gone" });
  assert.deepEqual([failed.resuming, failed.error, failed.snapshot], [false, "gone", kept]);
  const empty = initialThreadState(T);
  assert.equal(threadReducer(empty, { type: "resuming", threadId: T }), empty, "nothing held, nothing to wait for");
});
