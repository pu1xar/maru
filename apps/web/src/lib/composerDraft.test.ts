import assert from "node:assert/strict";
import { test } from "node:test";

// A browser-shaped global with localStorage and window events, set before the module loads.
const stored = new Map<string, string>();
const windowListeners = new Map<string, Set<(event: unknown) => void>>();
const localStorage = {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => void stored.set(k, v),
  removeItem: (k: string) => void stored.delete(k),
};
Object.assign(globalThis, {
  window: {
    localStorage,
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => windowListeners.get(type)?.delete(fn),
  },
  document: { hasFocus: () => false, activeElement: null },
});
const fire = (type: string, event: unknown) => {
  for (const fn of [...(windowListeners.get(type) ?? [])]) fn(event);
};

const draft = await import("./composerDraft.ts");
const KEY = "maru_composer_draft:claude:a:s1";

test("a draft is shared at once, saved after the typing settles, and removed at once when emptied", async () => {
  draft.setComposerDraft("claude:a:s1", "hello");
  assert.equal(draft.getComposerDraft("claude:a:s1"), "hello");
  assert.equal(stored.get(KEY), undefined);
  await new Promise((r) => setTimeout(r, draft.DRAFT_SAVE_DELAY_MS + 50));
  assert.equal(stored.get(KEY), "hello");
  draft.setComposerDraft("claude:a:s1", "");
  assert.equal(stored.has(KEY), false);
});

test("a reload reads the saved draft; pagehide writes what the timer still holds", () => {
  stored.set("maru_composer_draft:claude:a:s2", "kept");
  assert.equal(draft.getComposerDraft("claude:a:s2"), "kept");
  draft.setComposerDraft("claude:a:s2", "kept more");
  // Subscribing hooks the window events, as a mounted input does.
  const listener = () => {};
  draft.subscribeComposerDraft("claude:a:s2", listener);
  fire("pagehide", {});
  assert.equal(stored.get("maru_composer_draft:claude:a:s2"), "kept more");
});

test("another tab's change applies when no input here has the keyboard", () => {
  let calls = 0;
  draft.subscribeComposerDraft("claude:a:s3", () => calls++);
  draft.getComposerDraft("claude:a:s3");
  stored.set("maru_composer_draft:claude:a:s3", "from tab 2");
  fire("storage", { storageArea: localStorage, key: "maru_composer_draft:claude:a:s3", newValue: "from tab 2" });
  assert.equal(draft.getComposerDraft("claude:a:s3"), "from tab 2");
  assert.equal(calls, 1);
});

test("question answers so far join as the composer sends them", () => {
  draft.updateQuestionDraft("req-1", (d) => ({ ...d, picked: { "Color?": ["Blue", "Red"] }, other: { "Color?": " teal " } }));
  assert.equal(draft.questionAnswerOf(draft.getQuestionDraft("req-1"), "Color?"), "Blue, Red, teal");
  draft.clearQuestionDraft("req-1");
  assert.deepEqual(draft.getQuestionDraft("req-1"), { picked: {}, other: {} });
});

test("a message the server did not send comes back only into an empty draft", () => {
  draft.setComposerDraft("claude:a:s4", "");
  draft.restoreComposerDraft("claude:a:s4", "/plan 설계해줘");
  assert.equal(draft.getComposerDraft("claude:a:s4"), "/plan 설계해줘");
  draft.setComposerDraft("claude:a:s4", "typed since");
  draft.restoreComposerDraft("claude:a:s4", "/plan 설계해줘");
  assert.equal(draft.getComposerDraft("claude:a:s4"), "typed since", "text typed after the send is kept");
});
