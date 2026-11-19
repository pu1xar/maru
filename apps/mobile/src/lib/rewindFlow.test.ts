import { test } from "node:test";
import assert from "node:assert/strict";
import type { RewindTarget, SessionRewindList } from "@maru/shared";
import { choose, CLOSED, listed, previewed, runnableMode, wantsPreview } from "./rewindFlow.ts";

const ON = { enabled: true, reason: null };
const target = (over: Partial<RewindTarget> = {}): RewindTarget => ({
  id: "u2", text: "Edit it", createdAt: "2026-11-16T00:00:00Z", checkpoint: true,
  turnChanges: { files: ["/w/a.txt"], insertions: 1, deletions: 0 },
  restore: { files: ["/w/a.txt"], insertions: 3, deletions: 1 },
  conversation: ON, code: ON, ...over,
});
const list = (targets: RewindTarget[], over: Partial<SessionRewindList> = {}): SessionRewindList => ({ key: "claude:a:s", blocked: null, codeNote: null, targets, ...over });

test("the sheet opens at the pressed message with code and conversation picked", () => {
  const f = listed(list([target({ id: "u1" }), target()]), "u2");
  assert.equal(f.open, true);
  assert.equal(f.target?.id, "u2");
  assert.deepEqual(f.options.map((o) => o.value), ["both", "conversation", "code"], "cancel is the sheet's own button");
  assert.equal(f.choice, "both");
  assert.equal(runnableMode(f), "both");
  assert.equal(wantsPreview(f), true);
});

test("a message that left the conversation shows why instead of options", () => {
  const f = listed(list([target({ id: "u1" })]), "gone");
  assert.equal(f.open, true);
  assert.equal(f.target, null);
  assert.equal(f.error, "This message is not in the conversation now");
  assert.equal(runnableMode(f), null);
});

test("Codex: code options are off with the reason, the conversation is picked", () => {
  const reason = "Codex는 파일을 되돌리지 않음 (thread/revert는 대화 기록만 바꿈)";
  const f = listed(list([target({ code: { enabled: false, reason }, restore: null, turnChanges: null })]), "u2");
  assert.deepEqual(f.options.map((o) => o.enabled), [false, true, false]);
  assert.equal(f.options[0]!.reason, reason);
  assert.equal(f.choice, "conversation");
  assert.equal(wantsPreview(f), false, "no dry run where code never goes back");
});

test("a blocked session turns every option off, picks none and asks for no dry run", () => {
  const f = listed(list([target()], { blocked: "turn이 도는 중이라 되돌릴 수 없음" }), "u2");
  assert.deepEqual(f.options.map((o) => o.enabled), [false, false, false]);
  assert.equal(f.options[1]!.reason, "turn이 도는 중이라 되돌릴 수 없음");
  assert.equal(f.choice, null);
  assert.equal(runnableMode(f), null);
  assert.equal(wantsPreview(f), false);
});

test("tapping an option picks it; one that cannot run says why and keeps the pick", () => {
  const f = listed(list([target({ code: { enabled: false, reason: "이 메시지의 file checkpoint가 없음" } })]), "u2");
  assert.equal(f.choice, "conversation");
  const off = choose(f, "code");
  assert.equal(off.choice, "conversation");
  assert.equal(off.error, "이 메시지의 file checkpoint가 없음");
  const on = choose(off, "conversation");
  assert.equal(on.error, null);
  assert.equal(choose(listed(list([target()]), "u2"), "conversation").choice, "conversation");
  assert.equal(choose(f, "nevermind").choice, "conversation", "cancel is not a choice");
});

test("the dry run can turn the code off, and the pick moves to what can run", () => {
  const f = listed(list([target()]), "u2");
  const none = previewed(f, { restore: { files: [], insertions: 0, deletions: 0 }, error: null });
  assert.deepEqual(none.options.map((o) => [o.value, o.enabled]), [["both", false], ["conversation", true], ["code", false]]);
  assert.equal(none.options[0]!.reason, "No code changes to rewind");
  assert.equal(none.choice, "conversation");
  const refused = previewed(f, { restore: null, error: "File rewinding is not enabled." });
  assert.equal(refused.options[2]!.reason, "File rewinding is not enabled.");
  // A dry run that finds files keeps the pick and carries the numbers for the code line.
  const some = previewed(choose(f, "code"), { restore: { files: ["/w/a.txt"], insertions: 0, deletions: 2 }, error: null });
  assert.equal(some.choice, "code");
  assert.deepEqual(some.preview?.restore?.deletions, 2);
});

test("nothing is sent while a request runs or the sheet has no target", () => {
  const f = listed(list([target()]), "u2");
  assert.equal(runnableMode({ ...f, running: "both" }), null);
  assert.equal(choose({ ...f, running: "both" }, "code").choice, "both");
  assert.equal(runnableMode(CLOSED), null);
});
