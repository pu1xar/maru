import { test } from "node:test";
import assert from "node:assert/strict";
import { apkHasPush, pushDataOf } from "./pushData.ts";

test("the APK's own config says whether it was built with FCM", () => {
  assert.equal(apkHasPush(JSON.stringify({ name: "maru", extra: { maruPush: true } })), true);
  assert.equal(apkHasPush({ extra: { maruPush: true } }), true);
  for (const config of [JSON.stringify({ extra: { maruPush: false } }), JSON.stringify({ name: "maru" }), "{not json", null, undefined, { extra: { maruPush: "true" } }]) {
    assert.equal(apkHasPush(config), false, String(config));
  }
});

test("a notification opens a session only when it carries the server's push data", () => {
  assert.deepEqual(pushDataOf({ kind: "question", sessionKey: "claude:a:1" }), { kind: "question", sessionKey: "claude:a:1" });
  assert.deepEqual(pushDataOf({ kind: "turn.failed", sessionKey: "codex:b:2", extra: "x" }), { kind: "turn.failed", sessionKey: "codex:b:2" });
  for (const data of [null, "x", {}, { kind: "other", sessionKey: "k" }, { kind: "question", sessionKey: "" }, { kind: "question" }]) {
    assert.equal(pushDataOf(data), null, JSON.stringify(data));
  }
});
