import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkLogEntry } from "../../session-logic.ts";
import {
  subagentGroupSummary,
  summarizeSubagentStatuses,
} from "../../client-runtime/state/subagentDisplay.ts";
import { subagentGroupTiming } from "./TimelineV2EventRow.logic.ts";
import { workEntryDisplayLabel } from "./MessagesTimeline.logic.ts";
import {
  interruptDividerDetail,
  subagentDetailLine,
  subagentResumedSince,
} from "./V2LifecycleRow.logic.ts";
import {
  buildToolCallExpandedBody,
  thoughtPreviewText,
  workEntryIconName,
  workEntryRawCommand,
} from "./TimelineWorkEntryRow.logic.ts";
import { formatWorkingTimerNow } from "./TimelineWorkGroupRows.logic.ts";

function entry(over: Partial<WorkLogEntry>): WorkLogEntry {
  return { id: "e1", createdAt: "2026-11-15T00:00:00.000Z", label: "x", tone: "tool", ...over };
}

test("subagent group: timing spans the members and stays open while one runs", () => {
  const settled = subagentGroupTiming([
    { status: "completed", startedAt: "2026-11-15T00:00:10.000Z", completedAt: "2026-11-15T00:01:00.000Z" },
    { status: "failed", startedAt: "2026-11-15T00:00:05.000Z", completedAt: "2026-11-15T00:02:00.000Z" },
  ]);
  assert.deepEqual(settled, {
    status: "completed",
    startedAt: "2026-11-15T00:00:05.000Z",
    completedAt: "2026-11-15T00:02:00.000Z",
  });
  const live = subagentGroupTiming([
    { status: "running", startedAt: "2026-11-15T00:00:10.000Z", completedAt: null },
    { status: "completed", startedAt: "2026-11-15T00:00:00.000Z", completedAt: "2026-11-15T00:00:30.000Z" },
  ]);
  assert.equal(live.status, "running");
  assert.equal(live.completedAt, null);
});

test("subagent group: Korean summary puts each count first and joins them with commas", () => {
  assert.equal(
    summarizeSubagentStatuses(["running", "waiting", "completed", "failed", "interrupted"]),
    "2 working, 1 done, 1 failed, 1 stopped",
  );
  // A stopped agent reads as the cards name it, cancelled or interrupted alike.
  assert.equal(summarizeSubagentStatuses(["cancelled", "idle"]), "1 stopped, 1 idle");
  assert.deepEqual(subagentGroupSummary([{ status: "running" }, { status: "completed" }]), {
    label: "2 subagents started",
    active: true,
    failed: false,
  });
});

test("subagent card: detail shows progress while working and the result once settled", () => {
  assert.equal(
    subagentDetailLine({ status: "running", result: "done", progress: "reading `a.ts`" }),
    "reading a.ts",
  );
  assert.equal(
    subagentDetailLine({ status: "completed", result: "- [link](x) ok", progress: "p" }),
    "link ok",
  );
  assert.equal(
    subagentDetailLine({ status: "failed", result: "Child task ended with status failed", progress: undefined }),
    null,
  );
});

test("interrupt divider: only what the label does not already say", () => {
  assert.equal(interruptDividerDetail("[Request interrupted by user]"), null);
  assert.equal(interruptDividerDetail("[Request interrupted by user for tool use]"), "during tool use");
  assert.equal(interruptDividerDetail("턴이 중단됨"), null);
  assert.equal(interruptDividerDetail("턴이 중단됨: stream closed"), "stream closed");
  assert.equal(interruptDividerDetail("Turn interrupted"), null);
  assert.equal(interruptDividerDetail("Turn interrupted: stream closed"), "stream closed");
  assert.equal(interruptDividerDetail("something else"), "something else");
});

test("system notice row: the first line labels it, the rest waits in the open row", () => {
  const notice = entry({
    itemType: "system_notice",
    label: "목표 달성: 전부 workflow로 고쳐줘\nThe user requested a long reason",
  });
  assert.equal(workEntryDisplayLabel(notice, "/w"), "목표 달성: 전부 workflow로 고쳐줘");
});

test("subagent notification: a settled agent counts as resumed only if it started later", () => {
  assert.equal(subagentResumedSince({ status: "running", startedAt: null }, "2026-11-15T00:00:00Z"), true);
  assert.equal(
    subagentResumedSince({ status: "completed", startedAt: "2026-11-15T00:00:01Z" }, "2026-11-15T00:00:00Z"),
    true,
  );
  assert.equal(
    subagentResumedSince({ status: "completed", startedAt: "2026-11-14T23:59:59Z" }, "2026-11-15T00:00:00Z"),
    false,
  );
});

test("thought preview flattens markdown into one line and keeps identifiers", () => {
  assert.equal(
    thoughtPreviewText("## Plan\n\n- read **`snake_case`** file\n- [docs](https://x)", "Thought"),
    "Plan read snake_case file docs",
  );
  assert.equal(thoughtPreviewText("   ", "Thinking"), "Thinking");

  // Inline code keeps what it holds, markers included; tildes outside code are text too.
  assert.equal(
    thoughtPreviewText("제 plugin이 취소선을 `~~`로 바꾸는데, `**bold**`와 __굵게__ 와 3월~4월", "Thought"),
    "제 plugin이 취소선을 ~~로 바꾸는데, **bold**와 굵게 와 3월~4월",
  );
});

test("expanded tool body skips what the row label already shows", () => {
  const command = entry({ command: "ls -la", rawCommand: "bash -lc 'ls -la'" });
  assert.equal(workEntryRawCommand(command), "bash -lc 'ls -la'");
  // A row labeled with the command itself adds nothing; a verb label opens to the raw command.
  assert.equal(buildToolCallExpandedBody(command, "/w", "ls -la", null), null);
  assert.equal(buildToolCallExpandedBody(command, "/w", "Ran ls", null), "bash -lc 'ls -la'");
  // Paths read from the workspace folder name, once each.
  const changed = entry({ changedFiles: ["/w/src/a.ts", "/w/src/a.ts"] });
  assert.equal(buildToolCallExpandedBody(changed, "/w", "Changed a.ts", null), "w/src/a.ts");
});

test("work entry icons follow the item type", () => {
  assert.equal(workEntryIconName(entry({ itemType: "todo_list", tone: "info" })), "list-todo");
  assert.equal(
    workEntryIconName(entry({ itemType: "user_input_request", tone: "tool" })),
    "message-circle",
  );
  assert.equal(workEntryIconName(entry({ tone: "thinking", itemType: "reasoning" })), "brain");
});

test("working timer counts seconds, then switches to the duration format", () => {
  const start = "2026-11-15T00:00:00.000Z";
  assert.equal(formatWorkingTimerNow(start, Date.parse(start) + 42_000), "42s");
  assert.equal(formatWorkingTimerNow(start, Date.parse(start) + 125_000), "2m 5s");
  assert.equal(formatWorkingTimerNow("not a date", 0), "0s");
});
