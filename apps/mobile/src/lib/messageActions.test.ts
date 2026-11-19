import { test } from "node:test";
import assert from "node:assert/strict";
import { menuItems, messageTarget, openMessageMenu, registerMessageActions } from "./messageActions.ts";
import { draftOf, putBackRewound, setDraft } from "./drafts.ts";
import { fetchRewindList, fetchRewindPreview, forkAt, rewindTo } from "./messageApi.ts";
import type { Pairing } from "./api.ts";

const user = (over: Record<string, unknown> = {}) => ({ type: "user_message", providerTurnId: "t7", nativeItemRef: { nativeId: "u-9" }, ...over }) as never;

test("the menu lists copy (when there is text), rewind and fork; fork waits while one runs", () => {
  assert.deepEqual(menuItems({ hasText: true, forking: false }).map((i) => [i.action, i.label, i.disabled]), [
    ["copy", "Copy message", null], ["rewind", "Rewind to here", null], ["fork", "Fork from here", null],
  ]);
  assert.deepEqual(menuItems({ hasText: false, forking: true }).map((i) => [i.action, i.disabled]), [["rewind", null], ["fork", "Forking"]]);
});

test("a row has a target only while a host serves its session: uuid for Claude, turn for Codex", () => {
  assert.equal(messageTarget(null, user()), null, "no host: no menu");
  assert.equal(messageTarget("claude:a:s", user()), "u-9");
  assert.equal(messageTarget("codex:a:s", user()), "t7");
  assert.equal(messageTarget("claude:a:s", user({ nativeItemRef: null })), null, "a queued message not written yet");
});

test("requests reach the registered host and stop when it leaves", () => {
  assert.equal(openMessageMenu({ text: "x", targetId: "u" }), false);
  const seen: string[] = [];
  const off = registerMessageActions({ key: "claude:a:s", open: (m) => seen.push(m.targetId) });
  assert.equal(openMessageMenu({ text: "x", targetId: "u1" }), true);
  off();
  assert.equal(openMessageMenu({ text: "x", targetId: "u2" }), false);
  assert.deepEqual(seen, ["u1"]);
});

test("the rewound message goes in front of the draft, once", () => {
  const key = "claude:a:draft-test";
  putBackRewound(key, "do it");
  assert.equal(draftOf(key), "do it");
  // The same message twice stays at the head of the draft (web draftAfterRewind).
  putBackRewound(key, "do it");
  assert.equal(draftOf(key), "do it");
  setDraft(key, "typed");
  putBackRewound(key, "do it");
  assert.equal(draftOf(key), "do it\n\ntyped", "text already typed stays after it");
  setDraft(key, "");
});

test("the four calls use the web's paths and bodies with the device token", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const p: Pairing = { server: "https://m.example", token: "maru_tok", device: { id: "d", name: "n" } as never };
    await fetchRewindList(p, "claude:a:s 1");
    await fetchRewindPreview(p, "claude:a:s", "u/1");
    await rewindTo(p, "claude:a:s", "u1", "conversation");
    await forkAt(p, "claude:a:s", "u1");
    assert.deepEqual(calls.map((c) => [c.init.method ?? "GET", c.url]), [
      ["GET", "https://m.example/api/session-rewind?key=claude%3Aa%3As%201"],
      ["GET", "https://m.example/api/session-rewind/preview?key=claude%3Aa%3As&id=u%2F1"],
      ["POST", "https://m.example/api/session-rewind"],
      ["POST", "https://m.example/api/session-fork"],
    ]);
    for (const c of calls) assert.equal((c.init.headers as Record<string, string>).authorization, "Bearer maru_tok");
    assert.deepEqual(JSON.parse(calls[2]!.init.body as string), { key: "claude:a:s", id: "u1", mode: "conversation" });
    assert.deepEqual(JSON.parse(calls[3]!.init.body as string), { key: "claude:a:s", id: "u1" });
    assert.equal((calls[3]!.init.headers as Record<string, string>)["content-type"], "application/json");
  } finally {
    globalThis.fetch = real;
  }
});
