import { test } from "node:test";
import assert from "node:assert/strict";
import type { RewindTarget } from "@maru/shared";
import {
  ageText, choiceEffect, defaultOption, draftAfterRewind, isDoublePress, oneLine, restoreFilesText, restoreShown, rewindOptions, rewindTargetOf, rowMeta,
} from "./rewind.logic.ts";

const ON = { enabled: true, reason: null };
const target = (over: Partial<RewindTarget> = {}): RewindTarget => ({
  id: "u1", text: "Create a.txt", createdAt: "2026-11-16T00:00:00Z", checkpoint: true,
  turnChanges: { files: ["/w/a.txt"], insertions: 1, deletions: 0 },
  restore: { files: ["/w/a.txt"], insertions: 3, deletions: 1 },
  conversation: ON, code: ON, ...over,
});

test("the double press window is the CLI's 800 ms", () => {
  assert.equal(isDoublePress(0, 500), false, "no first press yet");
  assert.equal(isDoublePress(1000, 1800), true);
  assert.equal(isDoublePress(1000, 1801), false);
});

test("options in the CLI's order; the focus starts on the first that can run", () => {
  const all = rewindOptions(target());
  assert.deepEqual(all.map((o) => [o.cli, o.enabled]), [["Restore code and conversation", true], ["Restore conversation", true], ["Restore code", true], ["Never mind", true]]);
  assert.equal(defaultOption(all), 0);
  const noCode = rewindOptions(target({ code: { enabled: false, reason: "이 메시지의 file checkpoint가 없음" } }));
  assert.deepEqual(noCode.map((o) => o.enabled), [false, true, false, true]);
  assert.equal(noCode[0]!.reason, "이 메시지의 file checkpoint가 없음", "both is off for the code's reason");
  assert.equal(defaultOption(noCode), 1);
  const blocked = rewindOptions(target(), "A turn is running, cannot rewind");
  assert.deepEqual(blocked.map((o) => o.enabled), [false, false, false, true]);
  assert.equal(defaultOption(blocked), 3, "only Never mind is left");
});

test("row line: changes, none, no checkpoint, Codex", () => {
  assert.deepEqual(rowMeta(target()), { text: "a.txt", kind: "changes" });
  assert.deepEqual(rowMeta(target({ turnChanges: { files: ["/a", "/b"], insertions: 1, deletions: 1 } })), { text: "2 files changed", kind: "changes" });
  assert.deepEqual(rowMeta(target({ turnChanges: { files: [], insertions: 0, deletions: 0 } })), { text: "No code changes", kind: "none" });
  assert.deepEqual(rowMeta(target({ checkpoint: false })), { text: "No code restore", kind: "no-restore" });
  assert.equal(rowMeta(target({ turnChanges: null, restore: null })), null);
});

test("what the focused option does", () => {
  const eff = (t: RewindTarget, c: Parameters<typeof choiceEffect>[1]) => choiceEffect(t, c, rewindOptions(t));
  assert.deepEqual(eff(target(), "both"), { goesBack: true, code: "restore" });
  assert.deepEqual(eff(target(), "conversation"), { goesBack: true, code: "unchanged" });
  assert.deepEqual(eff(target(), "code"), { goesBack: false, code: "restore" });
  assert.deepEqual(eff(target(), "nevermind"), { goesBack: false, code: "unchanged" });
  assert.deepEqual(eff(target({ code: { enabled: false, reason: "x" } }), "both"), { goesBack: true, code: "unchanged" });
  assert.deepEqual(eff(target({ restore: null }), "conversation"), { goesBack: true, code: null });
});

test("the dry run decides the code options and the numbers shown", () => {
  const t = target();
  const nothing = rewindOptions(t, null, { restore: { files: [], insertions: 0, deletions: 0 }, error: null });
  assert.deepEqual(nothing.map((o) => o.enabled), [false, true, false, true]);
  assert.equal(nothing[2]!.reason, "No code changes to rewind");
  const refused = rewindOptions(t, null, { restore: null, error: "No file checkpoint found for this message." });
  assert.equal(refused[2]!.reason, "No file checkpoint found for this message.");
  assert.deepEqual(restoreShown(t, { restore: { files: ["/w/a.txt"], insertions: 0, deletions: 1 }, error: null }), { files: ["/w/a.txt"], insertions: 0, deletions: 1, exact: true });
  assert.deepEqual(restoreShown(t, null), { files: ["/w/a.txt"], insertions: 0, deletions: 0, exact: false }, "without a dry run: the files, no counts");
  assert.equal(restoreShown(target({ restore: null }), null), null);
});

test("files as the CLI names them", () => {
  assert.equal(restoreFilesText(["/w/a.txt"]), "a.txt");
  assert.equal(restoreFilesText(["/w/a.txt", "/w/b.txt"]), "a.txt and b.txt");
  assert.equal(restoreFilesText(["/w/a.txt", "/w/b.txt", "/w/c"]), "a.txt and 2 other files");
});

test("the draft after a rewind keeps what was typed", () => {
  assert.equal(draftAfterRewind("", "hello"), "hello");
  assert.equal(draftAfterRewind("  ", "hello"), "hello");
  assert.equal(draftAfterRewind("typed", "hello"), "hello\n\ntyped");
  assert.equal(draftAfterRewind("hello\n\ntyped", "hello"), "hello\n\ntyped", "a second rewind to the same message adds nothing");
  assert.equal(draftAfterRewind("ok then", "ok"), "ok\n\nok then", "a short message found inside the draft still comes back");
});

test("age and one-line rows", () => {
  const now = Date.parse("2026-11-16T00:06:30Z");
  assert.equal(ageText("2026-11-16T00:00:00Z", now), "6m ago");
  assert.equal(ageText(null, now), null);
  assert.equal(oneLine("a\n  b\n"), "a b");
  assert.equal(oneLine("  \n "), "(empty message)");
});

test("a user message's rewind target is its transcript uuid (Claude) or its turn (Codex)", () => {
  const user = (over: Record<string, unknown>) => ({ type: "user_message", providerTurnId: "t7", nativeItemRef: { nativeId: "u-9" }, ...over }) as never;
  assert.equal(rewindTargetOf("claude:acct:s1", user({})), "u-9");
  assert.equal(rewindTargetOf("codex:acct:s1", user({})), "t7");
  assert.equal(rewindTargetOf("claude:acct:s1", user({ nativeItemRef: null })), null, "a queued entry not written yet");
  assert.equal(rewindTargetOf("codex:acct:s1", user({ providerTurnId: null })), null);
  assert.equal(rewindTargetOf("claude:acct:s1", { type: "assistant_message" } as never), null);
  assert.equal(rewindTargetOf("claude:acct:s1", undefined), null);
});
