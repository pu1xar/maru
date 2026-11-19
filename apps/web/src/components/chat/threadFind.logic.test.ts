import { test } from "node:test";
import assert from "node:assert/strict";
import type { FindTarget, ThreadSnapshot } from "@maru/shared";

import { requestFind, takePendingFind, type PendingFind } from "../../lib/pendingFind.ts";
import { entryIdForItem, findStep, itemOrder } from "./threadFind.logic.ts";

function snapshot(items: Array<{ id: string; type: string; messageId?: string }>, hasMoreBefore: boolean): ThreadSnapshot {
  return {
    threadId: "th",
    hasMoreBefore,
    visibleTurnItems: items.map((item, position) => ({ position, item })),
  } as unknown as ThreadSnapshot;
}

const target = (itemId: string): FindTarget => ({ itemId, occurrence: 0, role: "user", at: null });

test("a held message is drawn under its message id, another item under its own id", () => {
  const s = snapshot([{ id: "th:uuid:1", type: "user_message", messageId: "m1" }, { id: "th:notice", type: "system_notice" }], false);
  assert.equal(entryIdForItem(s, "th:uuid:1"), "m1");
  assert.equal(entryIdForItem(s, "th:notice"), "th:notice");
  assert.equal(entryIdForItem(s, "th:none"), null);
  assert.equal(entryIdForItem(null, "th:uuid:1"), null);
  const order = itemOrder(s);
  assert.equal(order.byItem.get("th:notice"), 1);
  assert.equal(order.byEntry.get("m1"), 0);
});

test("a step shows a held item, loads older rows for one not held, waits for a request, and ends missing at the start", () => {
  const held = snapshot([{ id: "a", type: "assistant_message", messageId: "ma" }], true);
  assert.deepEqual(findStep(held, target("a"), false), { kind: "show", entryId: "ma" });
  assert.deepEqual(findStep(held, target("old"), false), { kind: "load", itemId: "old" });
  assert.deepEqual(findStep(held, target("old"), true), { kind: "wait" });
  assert.deepEqual(findStep(null, target("old"), false), { kind: "wait" });
  const whole = snapshot([{ id: "a", type: "assistant_message", messageId: "ma" }], false);
  assert.deepEqual(findStep(whole, target("old"), false), { kind: "missing" });
  // Held wins over a request in flight.
  assert.deepEqual(findStep(held, target("a"), true), { kind: "show", entryId: "ma" });
});

test("a find left for a session is taken once by that session's own thread", () => {
  const got: PendingFind[] = [];
  const find: PendingFind = { query: "검색", hint: { itemId: "x", role: "user", at: null } };
  requestFind("claude:a:s1", find);
  // A view on a subagent thread of the session goes back to the session's own; that one takes it, once.
  let backToSession = 0;
  const stopChild = takePendingFind("claude:a:s1", "claude:a:s1:agent-1", (f) => got.push(f), () => backToSession++);
  assert.equal(got.length, 0);
  assert.equal(backToSession, 1);
  stopChild();
  const stop = takePendingFind("claude:a:s1", "claude:a:s1", (f) => got.push(f));
  assert.deepEqual(got, [find]);
  // A later request reaches the view that shows the session already.
  requestFind("claude:a:s1", { ...find, query: "다시" });
  assert.equal(got.at(-1)!.query, "다시");
  requestFind("claude:a:other", find);
  assert.equal(got.length, 2);
  stop();
  const late: PendingFind[] = [];
  const stop2 = takePendingFind("claude:a:other", "claude:a:other", (f) => late.push(f));
  assert.equal(late.length, 1, "a request made before the view mounted waits for it");
  stop2();
});
