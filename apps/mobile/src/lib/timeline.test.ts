import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2TurnItem, ThreadRunSummary, ThreadSnapshot } from "@maru/shared";
import { CLOSED, timelineRows, toggled, type MessagesTimelineRow } from "./timeline.ts";

const threadId = "claude:acct:s1";
const time = (s: number) => new Date(Date.UTC(2026, 10, 16, 1, 0, s)).toISOString();
const base = (id: string, runId: string, s: number) => ({
  id,
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: s,
  status: "completed" as const,
  title: null,
  startedAt: time(s),
  completedAt: time(s),
  updatedAt: time(s),
});
const user = (id: string, runId: string, s: number, text: string): OrchestrationV2TurnItem => ({
  ...base(id, runId, s),
  type: "user_message",
  messageId: `${id}-m`,
  text,
  attachments: [],
  inputIntent: "turn_start",
  createdBy: "user",
  creationSource: "web",
});
const command = (id: string, runId: string, s: number, input: string, status: "completed" | "running" = "completed"): OrchestrationV2TurnItem => ({
  ...base(id, runId, s),
  type: "command_execution",
  status,
  input,
  output: status === "completed" ? "ok" : "",
  exitCode: status === "completed" ? 0 : undefined,
  ...(status === "running" ? { completedAt: null } : {}),
});
const answer = (id: string, runId: string, s: number, text: string, streaming = false): OrchestrationV2TurnItem => ({
  ...base(id, runId, s),
  type: "assistant_message",
  messageId: `${id}-m`,
  text,
  streaming,
  ...(streaming ? { status: "running" as const, completedAt: null } : {}),
});
const rows = (items: OrchestrationV2TurnItem[]): OrchestrationV2ProjectedTurnItem[] =>
  items.map((item, position) => ({ position, visibility: "local", sourceThreadId: threadId, sourceItemId: item.id, item }));
const run = (runId: string, status: ThreadRunSummary["status"], start: number, end: number | null): ThreadRunSummary => ({
  runId,
  status,
  requestedAt: time(start),
  startedAt: time(start),
  completedAt: end === null ? null : time(end),
  assistantMessageId: null,
});

/** Two turns: a finished one with three commands, and one still running a command. */
function snapshot(liveText = "", liveStreaming = true): ThreadSnapshot {
  const items = [
    user("u1", "r1", 0, "Check the build"),
    command("c1", "r1", 2, "pnpm install"),
    command("c2", "r1", 4, "pnpm typecheck"),
    command("c3", "r1", 6, "pnpm test"),
    answer("a1", "r1", 8, "All green"),
    user("u2", "r2", 10, "Deploy it"),
    command("c4", "r2", 11, "scripts/release.sh build", "running"),
    ...(liveText || liveStreaming ? [answer("a2", "r2", 12, liveText, liveStreaming)] : []),
  ];
  return {
    threadId,
    runs: [run("r1", "completed", 0, 8), run("r2", "running", 10, null)],
    runtime: { status: "running", activeRunId: "r2", activityStartedAt: time(10), providerInstanceId: "claude", providerName: null, lastError: null },
    visibleTurnItems: rows(items),
    subagents: [],
    hasMoreBefore: false,
  } as unknown as ThreadSnapshot;
}

const kinds = (list: MessagesTimelineRow[]) => list.map((r) => r.kind);
const entryIds = (list: MessagesTimelineRow[]) =>
  list.flatMap((r) => (r.kind === "work" || r.kind === "work-live" ? r.groupedEntries.map((e) => e.id) : []));

test("a finished turn shows its work by default under one toggle row; the running turn stays open", () => {
  const r = timelineRows(snapshot(), CLOSED);
  const fold = r.rows.find((row) => row.kind === "turn-fold");
  assert.ok(fold && fold.kind === "turn-fold", `rows: ${kinds(r.rows).join(", ")}`);
  assert.equal(fold.runId, "r1");
  assert.equal(fold.label, "Worked for 8s");
  assert.equal(fold.expanded, true);
  // The finished turn's commands show (grouped behind a summary row), and so do its answer and the prompts.
  assert.ok(kinds(r.rows).includes("work-toggle"), `rows: ${kinds(r.rows).join(", ")}`);
  const messages = r.rows.flatMap((row) => (row.kind === "message" ? [row.message.text] : []));
  assert.deepEqual(messages.slice(0, 3), ["Check the build", "All green", "Deploy it"]);
  // The running turn: the working row after its prompt and the running command as live activity.
  assert.ok(r.isWorking);
  assert.ok(kinds(r.rows).includes("working"));
  assert.ok(entryIds(r.rows).includes("c4"));
});

test("closing the fold hides the turn's work and keeps its answer; the toggle opens it again", () => {
  const closed = { ...CLOSED, collapsedRunIds: toggled(CLOSED.collapsedRunIds, "r1") };
  const r = timelineRows(snapshot(), closed);
  const fold = r.rows.find((row) => row.kind === "turn-fold");
  assert.ok(fold?.kind === "turn-fold" && !fold.expanded);
  for (const id of ["c1", "c2", "c3"]) assert.ok(!entryIds(r.rows).includes(id), id);
  assert.ok(!kinds(r.rows).includes("work-toggle"));
  const messages = r.rows.flatMap((row) => (row.kind === "message" ? [row.message.text] : []));
  assert.deepEqual(messages.slice(0, 3), ["Check the build", "All green", "Deploy it"]);
  assert.equal(r.foldRunIdOf("c1"), "r1");
  const reopened = { ...closed, collapsedRunIds: toggled(closed.collapsedRunIds, "r1") };
  assert.ok(kinds(timelineRows(snapshot(), reopened).rows).includes("work-toggle"));
});

test("the open fold's work groups open into their commands, as on the web", () => {
  const r = timelineRows(snapshot(), CLOSED);
  // Three commands of one run in a row form one group behind a summary row.
  const toggle = r.rows.find((row) => row.kind === "work-toggle");
  assert.ok(toggle?.kind === "work-toggle", `rows: ${kinds(r.rows).join(", ")}`);
  assert.equal(toggle.hiddenCount, 3);
  const grouped = timelineRows(snapshot(), { ...CLOSED, expandedWorkGroupIds: toggled(CLOSED.expandedWorkGroupIds, toggle.groupId) });
  const details = grouped.rows.find((row) => row.kind === "work" && row.isExpandedToolGroup);
  assert.ok(details?.kind === "work");
  assert.deepEqual(details.groupedEntries.map((e) => e.id), ["c1", "c2", "c3"]);
});

test("a streamed text update keeps the identity of the rows it did not change", () => {
  const before = snapshot("Dep");
  // The thread reducer (web threadState.ts) replaces only the row a text delta touched.
  const last = before.visibleTurnItems.at(-1)!;
  const after = {
    ...before,
    visibleTurnItems: [...before.visibleTurnItems.slice(0, -1), { ...last, item: { ...last.item, text: "Deploying" } as OrchestrationV2TurnItem }],
  };
  const first = timelineRows(before, CLOSED);
  const second = timelineRows(after, CLOSED, first.memo);
  assert.equal(second.rows.length, first.rows.length);
  const changed = second.rows.filter((row, i) => row !== first.rows[i]).map((row) => row.id);
  assert.deepEqual(changed, ["a2-m"]);
  // Another thread does not reuse the memo.
  const other = timelineRows({ ...snapshot("Deploying"), threadId: "claude:acct:s2" }, CLOSED, first.memo);
  assert.equal(other.memo.threadId, "claude:acct:s2");
});
