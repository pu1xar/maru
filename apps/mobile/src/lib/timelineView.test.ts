import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assistantStatusPill,
  diffDisplayRows,
  diffLineTint,
  failedToolIconColor,
  groupEntryOpacity,
  JUMP_TO_END_OFFSET,
  messageTimeLabel,
  sendMovedList,
  showJumpToEnd,
  subagentCardTexts,
  subagentDotRole,
  subagentElapsedText,
  subagentGroupTiming,
  subagentProviderLabel,
  userMessageFolds,
  userMessageMarkdown,
  userMessageParts,
  userStatusPill,
  workLogGap,
} from "./timelineView.ts";

test("a subagent's time reads like the web: seconds, minutes with seconds, hours with minutes", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 17, 0, 0, 0) + s * 1000).toISOString();
  const done = (s: number) => ({ status: "completed" as const, startedAt: at(0), completedAt: at(s) });
  assert.equal(subagentElapsedText(done(45), 0), "45s");
  assert.equal(subagentElapsedText(done(185), 0), "3m 05s");
  assert.equal(subagentElapsedText(done(5040), 0), "1h 24m");
  // A running one counts up to now; one that has not started has no time; a settled one without an end has none.
  assert.equal(subagentElapsedText({ status: "running", startedAt: at(0), completedAt: null }, Date.parse(at(75))), "1m 15s");
  assert.equal(subagentElapsedText({ status: "pending", startedAt: null, completedAt: null }, 0), null);
  assert.equal(subagentElapsedText({ status: "completed", startedAt: at(0), completedAt: null }, 0), null);
});

test("a group of subagents runs from the earliest start to the latest end, and is live while one runs", () => {
  const t = subagentGroupTiming([
    { status: "completed", startedAt: "2026-11-17T00:00:10.000Z", completedAt: "2026-11-17T00:01:00.000Z" },
    { status: "completed", startedAt: "2026-11-17T00:00:00.000Z", completedAt: "2026-11-17T00:02:00.000Z" },
  ]);
  assert.equal(subagentElapsedText(t, 0), "2m 00s");
  assert.equal(subagentGroupTiming([{ status: "running", startedAt: "2026-11-17T00:00:00.000Z", completedAt: null }]).status, "running");
});

test("a card names an unfinished status beside the time and a finished one only under the title", () => {
  assert.deepEqual(subagentCardTexts({ statusLabel: "Running", detail: "Reading files", status: "running" }), { sub: "Reading files", word: "Running" });
  assert.deepEqual(subagentCardTexts({ statusLabel: "Completed", detail: "Result summary", status: "completed" }), { sub: "Result summary", word: null });
  assert.deepEqual(subagentCardTexts({ statusLabel: "Failed", detail: null, status: "failed" }), { sub: "Failed", word: null });
});

test("provider words and dot roles", () => {
  assert.equal(subagentProviderLabel("claude"), "Claude");
  assert.equal(subagentProviderLabel("codex"), "Codex");
  assert.equal(subagentProviderLabel("other"), null);
  assert.equal(subagentDotRole("running"), "info");
  assert.equal(subagentDotRole("waiting"), "info");
  assert.equal(subagentDotRole("completed"), "ok");
  assert.equal(subagentDotRole("failed"), "danger");
  assert.equal(subagentDotRole("interrupted"), "muted");
  assert.equal(subagentDotRole("cancelled"), "muted");
});

test("work log spacing: 8 alone, 0 when the log continues or heads an open group, 4 under its content", () => {
  assert.equal(workLogGap({ layout: "standalone" }), 8);
  assert.equal(workLogGap({ layout: "standalone", continuesWorkLog: true }), 0);
  assert.equal(workLogGap({ layout: "group-header" }), 0);
  assert.equal(workLogGap({ layout: "group-content" }), 4);
  assert.equal(workLogGap({ layout: "group-content", continuesWorkLog: true }), 0);
});

test("a nested work row recedes to 0.75 in the dark and 0.85 in the light", () => {
  assert.equal(groupEntryOpacity("dark"), 0.75);
  assert.equal(groupEntryOpacity("light"), 0.85);
  assert.equal(groupEntryOpacity(null), 0.75);
});

test("a failed tool's icon is the error color at 40%", () => {
  assert.equal(failedToolIconColor("#fb414a"), "rgba(251, 65, 74, 0.4)");
});

test("a diff line is numbered, classified and washed 10% in its color", () => {
  const { rows, numberDigits } = diffDisplayRows("@@ -9,3 +9,3 @@\n keep\n-old\n+new\n tail");
  assert.deepEqual(rows, [
    { kind: "note", text: "@@ -9,3 +9,3 @@" },
    { kind: "line", type: "context", oldNumber: 9, newNumber: 9, text: "keep" },
    { kind: "line", type: "del", oldNumber: 10, newNumber: null, text: "old" },
    { kind: "line", type: "add", oldNumber: null, newNumber: 10, text: "new" },
    { kind: "line", type: "context", oldNumber: 11, newNumber: 11, text: "tail" },
  ]);
  assert.equal(numberDigits, 2);
  const colors = { ok: "#00bc7d", danger: "#fb414a" };
  assert.equal(diffLineTint("add", colors), "rgba(0, 188, 125, 0.1)");
  assert.equal(diffLineTint("del", colors), "rgba(251, 65, 74, 0.1)");
  assert.equal(diffLineTint("context", colors), undefined);
});

test("a diff of many files names each file, and widens its number columns with the line count", () => {
  const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/y.ts\n+++ b/y.ts\n@@ -1000 +1000 @@\n-c\n+d";
  const { rows, numberDigits } = diffDisplayRows(diff);
  assert.deepEqual(rows.filter((r) => r.kind === "note" && !r.text.startsWith("@@")).map((r) => r.text), ["x.ts", "y.ts"]);
  assert.equal(numberDigits, 4);
});

test("the attachment notes leave a sent message's text and come back as attachments", () => {
  const text = '이거 봐줘\n\n[Attached image "shot.png" is saved at: /Users/me/.maru/uploads/s1/shot.png]';
  const withNote = userMessageParts({ text, attachments: [] }, text, undefined);
  assert.equal(withNote.text.trim(), "이거 봐줘");
  assert.equal(withNote.attachments.length, 1);
  assert.equal(withNote.attachments[0]?.name, "shot.png");
  assert.equal(withNote.attachments[0]?.kind, "image");
  const plain = userMessageParts({ text: "그냥 글", attachments: [] }, "그냥 글", undefined);
  assert.deepEqual(plain, { text: "그냥 글", attachments: [] });
});

test("a long message folds only when opening it at least doubles what shows", () => {
  assert.equal(userMessageFolds(351), false);
  assert.equal(userMessageFolds(352), true);
  assert.equal(userMessageFolds(0), false);
});

test("a user's bubble keeps single line breaks and leaves fenced code alone", () => {
  assert.equal(userMessageMarkdown("a\nb"), "a  \nb");
  assert.equal(userMessageMarkdown("a\n\nb"), "a\n\nb");
  assert.equal(userMessageMarkdown("x\n```ts\nconst a = 1;\nconst b = 2;\n```\ny"), "x  \n```ts\nconst a = 1;\nconst b = 2;\n```\ny");
  assert.equal(userMessageMarkdown("last"), "last");
});

test("status pills: a finished answer has none, a stopped one names it; the user's shows failure and stop", () => {
  assert.equal(assistantStatusPill("completed"), null);
  assert.equal(assistantStatusPill(undefined), null);
  assert.equal(assistantStatusPill("interrupted"), "Interrupted");
  assert.equal(assistantStatusPill("failed"), "Failed");
  assert.equal(userStatusPill("completed"), null);
  assert.equal(userStatusPill("pending"), null);
  assert.equal(userStatusPill("failed"), "Failed");
  assert.equal(userStatusPill("cancelled"), "Cancelled");
  assert.equal(userStatusPill("interrupted"), "Interrupted");
});

test("an answer's time carries the day once it is not today", () => {
  const now = Date.parse("2026-11-17T12:00:00");
  const clock = messageTimeLabel("2026-11-17T09:05:00", now);
  assert.match(clock, /^\d{1,2}:\d{2}$/);
  assert.ok(messageTimeLabel("2026-11-16T09:05:00", now).startsWith("Yesterday "));
  assert.ok(messageTimeLabel("2026-11-10T09:05:00", now).startsWith("11/10 "));
});

test("sending moves the list to its end only when the counter changes", () => {
  assert.equal(sendMovedList(0, 1), true);
  assert.equal(sendMovedList(3, 3), false);
  assert.equal(sendMovedList(undefined, 1), false);
  assert.equal(sendMovedList(1, undefined), false);
});

test("the jump-to-end button shows once the reader is more than a screen's worth above the end", () => {
  assert.equal(showJumpToEnd(0), false);
  assert.equal(showJumpToEnd(JUMP_TO_END_OFFSET), false);
  assert.equal(showJumpToEnd(JUMP_TO_END_OFFSET + 1), true);
});
