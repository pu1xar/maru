import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { OrchestrationV2ProjectedTurnItem, PendingSend } from "@maru/shared";
import {
  addedQueuedIds, canSendNow, deliveredIds, hasQueuedForSendNow, isSendNowKey, mergeRecalled, queuedAttachments, queuedStateLabel, recallableIds, sendBringsEnd, shownQueued,
} from "./queuedMessages.logic.ts";

const send = (id: string, state: PendingSend["state"], recall = state === "queued"): PendingSend => ({
  id, text: `t-${id}`, attachments: [], sentAt: 1, state, error: null, recall: { enabled: recall, reason: recall ? null : "왜" },
});

const row = (type: string, clientId?: string): OrchestrationV2ProjectedTurnItem =>
  ({
    position: 0, visibility: "local", sourceThreadId: "T", sourceItemId: "i",
    item: { type } as OrchestrationV2ProjectedTurnItem["item"],
    ...(clientId ? { x: { raw: [], sourceKey: "k", data: { clientId } } } : {}),
  }) as OrchestrationV2ProjectedTurnItem;

describe("mergeRecalled (CLI 2.1.325 ↑ on queued messages)", () => {
  test("messages in the order sent, one per line, in front of the draft; the caret stays in the draft", () => {
    // Measured: "queued alpha", "queued beta" and the draft "draft text" give these three lines.
    assert.deepEqual(mergeRecalled(["queued alpha", "queued beta"], "draft text", 10), {
      text: "queued alpha\nqueued beta\ndraft text",
      caret: "queued alpha\nqueued beta\n".length + 10,
    });
    assert.deepEqual(mergeRecalled(["one"], "abc", 1), { text: "one\nabc", caret: 5 });
  });

  test("an empty draft: the caret goes to the end; nothing back: the draft as it was", () => {
    assert.deepEqual(mergeRecalled(["one", "two"], "", 0), { text: "one\ntwo", caret: 7 });
    assert.deepEqual(mergeRecalled([], "abc", 2), { text: "abc", caret: 2 });
    assert.deepEqual(mergeRecalled([""], "abc", 9), { text: "abc", caret: 9 });
  });

  test("a caret past the draft is held to its end", () => {
    assert.equal(mergeRecalled(["x"], "ab", 99).caret, 4);
  });
});

describe("rows to draw", () => {
  test("deliveredIds reads user_message rows only", () => {
    const ids = deliveredIds([row("user_message", "a"), row("assistant_message", "b"), row("user_message")]);
    assert.deepEqual([...ids], ["a"]);
  });

  test("a message the conversation already shows is not drawn again, whatever its state", () => {
    const sends = [send("a", "taken"), send("b", "queued"), send("c", "queued")];
    assert.deepEqual(shownQueued(sends, new Set(["a", "c"])).map((s) => s.id), ["b"]);
  });

  test("a taken message stays drawn until its conversation row arrives (never neither)", () => {
    const sends = [send("a", "taken"), send("b", "sending")];
    assert.deepEqual(shownQueued(sends, new Set()).map((s) => s.id), ["a", "b"]);
    assert.deepEqual(shownQueued(sends, deliveredIds([row("user_message", "a")])).map((s) => s.id), ["b"]);
  });

  test("sends the CLI folded into one line settle on that line", () => {
    const merged = { ...row("user_message", "m1"), x: { raw: [], sourceKey: "k", data: { clientId: "m1", mergedClientIds: ["m2", "m3", 7] } } } as OrchestrationV2ProjectedTurnItem;
    const ids = deliveredIds([merged]);
    assert.deepEqual([...ids].sort(), ["m1", "m2", "m3"]);
    assert.deepEqual(shownQueued([send("m1", "taken"), send("m2", "taken"), send("m3", "queued"), send("m4", "queued")], ids).map((s) => s.id), ["m4"]);
  });
});

test("recallableIds: what ↑ takes back, oldest first, without the ones already on their way", () => {
  const sends = [send("a", "queued"), send("b", "sending"), send("c", "failed", true), send("d", "queued")];
  assert.deepEqual(recallableIds(sends, new Set(["d"])), ["a", "c"]);
});

test("state labels", () => {
  assert.deepEqual((["sending", "queued", "taken", "failed"] as const).map((st) => queuedStateLabel(send("x", st))), ["Sending", "Queued", "Delivered", "Not sent"]);
});

test("queuedAttachments: a picture draws from the server's image, a file is a name row with its path", () => {
  assert.deepEqual(
    queuedAttachments([
      { id: "20261116-a", kind: "image", name: "a.png", mimeType: "image/png", sizeBytes: 3, path: "/s/a.png" },
      { id: "20261116-b", kind: "file", name: "b.txt", mimeType: "text/plain", sizeBytes: 3, path: "/s/b.txt" },
    ]),
    [
      { key: "20261116-a", kind: "image", name: "a.png", path: "/s/a.png", url: "/api/attachments/20261116-a/image" },
      { key: "20261116-b", kind: "file", name: "b.txt", path: "/s/b.txt", url: null },
    ],
  );
});

test("addedQueuedIds: only ids that were not in the list before", () => {
  const sends = [send("a", "queued"), send("b", "sending"), send("c", "queued")];
  assert.deepEqual(addedQueuedIds(new Set(["a"]), sends), ["b", "c"]);
  assert.deepEqual(addedQueuedIds(new Set(["a", "b", "c"]), sends), []);
  assert.deepEqual(addedQueuedIds(new Set(), []), []);
});

test("sendBringsEnd: a send made on this page brings the end into view, whatever the scroll position", () => {
  assert.equal(sendBringsEnd(0, 1), true);
  assert.equal(sendBringsEnd(3, 4), true);
  assert.equal(sendBringsEnd(2, 2), false);
});

test("canSendNow: a Claude session this server runs, its turn running, not a subagent's view", () => {
  const base = { provider: "claude", owner: "ui", status: "running" } as const;
  assert.equal(canSendNow(base, false), true);
  assert.equal(canSendNow({ ...base, provider: "codex" }, false), false, "Codex steers a sent message into the turn at once");
  assert.equal(canSendNow({ ...base, owner: "terminal" }, false), false);
  assert.equal(canSendNow({ ...base, status: "waiting-input" }, false), false);
  assert.equal(canSendNow({ ...base, status: "open-idle" }, false), false);
  assert.equal(canSendNow(base, true), false);
});

test("hasQueuedForSendNow: only a message in the CLI's queue counts", () => {
  assert.equal(hasQueuedForSendNow([send("a", "queued")]), true);
  assert.equal(hasQueuedForSendNow([send("a", "sending"), send("b", "taken"), send("c", "failed")]), false);
  assert.equal(hasQueuedForSendNow([]), false);
});

test("isSendNowKey: a plain Esc, not with a modifier and not one that ends an IME composition", () => {
  const key = (over: Partial<Parameters<typeof isSendNowKey>[0]> = {}) => ({ key: "Escape", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...over });
  assert.equal(isSendNowKey(key()), true);
  for (const mod of ["shiftKey", "metaKey", "ctrlKey", "altKey"] as const) assert.equal(isSendNowKey(key({ [mod]: true })), false, mod);
  assert.equal(isSendNowKey(key({ isComposing: true })), false);
  assert.equal(isSendNowKey(key({ keyCode: 229 })), false);
  assert.equal(isSendNowKey(key({ key: "Enter" })), false);
});
