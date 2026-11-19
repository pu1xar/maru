import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrchestrationV2ProjectedTurnItem, ThreadSnapshot } from "@maru/shared";
import { CACHED_ROWS, CACHED_THREADS, cachedThreadIds, clearThreadCache, dropCachedThread, keepThread, peekCachedThread } from "./threadCache.ts";

function snap(threadId: string, messages: number): ThreadSnapshot {
  const items = Array.from({ length: messages }, (_, i) => ({
    position: i, visibility: "local", sourceThreadId: threadId, sourceItemId: `i${i}`,
    item: { id: `${threadId}:i${i}`, type: i % 2 === 0 ? "user_message" : "assistant_message" },
  })) as unknown as OrchestrationV2ProjectedTurnItem[];
  return {
    threadId, lineage: {} as ThreadSnapshot["lineage"], providerInstanceId: "p", title: "t", state: {} as ThreadSnapshot["state"],
    runtime: null, runs: [], visibleTurnItems: items, branches: { lanes: [] }, subagents: [], tokenUsage: null, hasMoreBefore: false,
  };
}

test("the cache keeps the newest rows of a snapshot and marks the cut as unread", () => {
  clearThreadCache();
  const s = snap("t", CACHED_ROWS + 20);
  keepThread(s);
  const kept = peekCachedThread("t")!;
  assert.equal(kept.visibleTurnItems.length, CACHED_ROWS);
  assert.equal(kept.visibleTurnItems.at(-1), s.visibleTurnItems.at(-1));
  assert.equal(kept.hasMoreBefore, true);
  keepThread(snap("small", 4));
  assert.equal(peekCachedThread("small")!.hasMoreBefore, false, "nothing was cut");
  clearThreadCache();
});

test("the cache drops the thread kept longest ago once past its limit, and keeping again renews", () => {
  clearThreadCache();
  for (let i = 0; i < CACHED_THREADS; i++) keepThread(snap(`t${i}`, 2));
  keepThread(snap("t0", 2));
  keepThread(snap("extra", 2));
  const ids = cachedThreadIds();
  assert.equal(ids.length, CACHED_THREADS);
  assert.equal(ids.includes("t1"), false, "t1 was the oldest");
  assert.equal(ids.at(-1), "extra");
  assert.equal(ids.includes("t0"), true, "t0 was renewed");
  dropCachedThread("t0");
  assert.equal(peekCachedThread("t0"), undefined);
  clearThreadCache();
});
