import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrchestrationV2ProjectedTurnItem, ThreadLiveEvent } from "@maru/shared";
import { DaemonError, FakeDaemon, makeThread, waitFor } from "../fake-daemon.ts";
import type { ThreadItem } from "../protocol/v2/ThreadItem.ts";
import type { ThreadStatus } from "../protocol/v2/ThreadStatus.ts";
import type { Turn } from "../protocol/v2/Turn.ts";
import { connect } from "../rpc.ts";
import type { CodexRpc } from "../rpc.ts";
import { createCodexThreadView } from "./threadView.ts";
import type { CodexThreadView } from "./threadView.ts";

const ACCOUNT = "acct";
const TID = "th1";
const KEY = `codex:${ACCOUNT}:${TID}`;
/** The calls a view may make; everything else would change daemon state. */
const ALLOWED = new Set(["initialize", "thread/read", "thread/goal/get", "thread/resume", "thread/turns/list", "thread/unsubscribe"]);

const rowId = (itemId: string): string => `${KEY}:item:${itemId}`;

function user(id: string, text: string): ThreadItem {
  return { type: "userMessage", id, clientId: null, content: [{ type: "text", text, text_elements: [] }] };
}
function agent(id: string, text: string): ThreadItem {
  return { type: "agentMessage", id, text, phase: "final_answer", moderation: null, memoryCitation: null, delivery: null, questions: null };
}
function turn(id: string, items: ThreadItem[], status: Turn["status"] = "completed", startedAt = 1_794_000_000): Turn {
  return {
    id,
    rootTurnId: id,
    items,
    itemsView: "full",
    status,
    error: null,
    startedAt,
    completedAt: status === "inProgress" ? null : startedAt + 5,
    durationMs: status === "inProgress" ? null : 5000,
  };
}

interface Rig {
  d: FakeDaemon;
  rpc: CodexRpc;
  /** Turns oldest first; thread/turns/list pages them newest first. */
  turns: Turn[];
  view: CodexThreadView;
  events: ThreadLiveEvent[];
}

async function rig(
  t: { after: (fn: () => Promise<void>) => void },
  opts: { status: ThreadStatus; turns: Turn[]; readonly?: boolean; thread?: Parameters<typeof makeThread>[1] },
): Promise<Rig> {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  d.threads.set(TID, makeThread(TID, { status: opts.status, ...opts.thread }));
  const r = { turns: opts.turns } as Rig;
  d.handlers.set("thread/turns/list", (p) => {
    const desc = [...r.turns].reverse();
    const start = typeof p.cursor === "string" ? Number(p.cursor) : 0;
    const size = typeof p.limit === "number" ? p.limit : 25;
    const data = desc.slice(start, start + size);
    const end = start + data.length;
    return { data, nextCursor: end < desc.length ? String(end) : null, backwardsCursor: null };
  });
  d.handlers.set("thread/resume", (p) => {
    const th = d.threads.get(String(p.threadId))!;
    return { thread: th, model: "m", modelProvider: "openai", cwd: th.cwd, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
  });
  d.handlers.set("thread/unsubscribe", () => ({ status: "unsubscribed" }));
  await d.listen();
  const rpc = await connect(d.home, { backoff: { initialMs: 10, maxMs: 40 }, connectTimeoutMs: 2000 });
  t.after(() => rpc.close());
  const view = createCodexThreadView({ rpc, account: ACCOUNT, threadId: TID, readonly: opts.readonly ?? true, requestTimeoutMs: 2000 });
  t.after(() => view.close());
  const events: ThreadLiveEvent[] = [];
  view.onEvent((e) => events.push(e));
  Object.assign(r, { d, rpc, view, events });
  return r;
}

function assertOnlyAllowedCalls(d: FakeDaemon): void {
  for (const r of d.received) {
    if (r.method === null || r.id === null) continue;
    assert.ok(ALLOWED.has(r.method), `the view called ${r.method}`);
  }
}

function assertInvariant(view: CodexThreadView): void {
  const s = view.stats().records;
  const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);
  assert.equal(s.linesRead, s.parseFailures + sum(s.displayedByKey) + sum(s.hiddenByKey) + sum(s.unknownByKey));
  assert.equal(s.linesRead, sum(s.byKey));
}

function texts(rows: OrchestrationV2ProjectedTurnItem[]): string[] {
  return rows.map((r) => {
    const i = r.item;
    if (i.type === "user_message" || i.type === "assistant_message" || i.type === "reasoning") return `${i.type}:${i.text}`;
    return i.type;
  });
}

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("a notLoaded thread reads pages of turns without resuming, and pages older turns on request", async (t) => {
  const turns = [1, 2, 3, 4, 5].map((n) => turn(`t${n}`, [user(`u${n}`, `q${n}`), agent(`a${n}`, `r${n}`)], "completed", 1_794_000_000 + n * 10));
  const { d, view, events } = await rig(t, { status: { type: "notLoaded" }, turns, thread: { name: "named" } });

  const snap = await view.load({ pageSize: 2 });
  assert.deepEqual(d.calls("thread/turns/list").map((c) => c.params), [
    { threadId: TID, cursor: null, limit: 2, sortDirection: "desc", itemsView: "full" },
  ]);
  assert.equal(d.calls("thread/resume").length, 0, "notLoaded: no resume");
  assert.deepEqual(d.calls("thread/read").map((c) => c.params), [{ threadId: TID, includeTurns: false }]);
  assert.equal(snap.threadId, KEY);
  assert.equal(snap.title, "named");
  assert.equal(snap.state.nameSource, "codex-name");
  assert.equal(snap.state.control, "readonly");
  assert.equal(snap.state.ownership, "codex-daemon");
  assert.deepEqual(texts(snap.visibleTurnItems), ["user_message:q4", "assistant_message:r4", "user_message:q5", "assistant_message:r5"]);
  assert.deepEqual(snap.visibleTurnItems.map((r) => [r.position, r.item.ordinal]), [[0, 0], [1, 1], [2, 2], [3, 3]]);
  assert.deepEqual(snap.runs.map((r) => [r.runId, r.status, r.assistantMessageId]), [
    [`${KEY}:run:t4`, "completed", rowId("a4")],
    [`${KEY}:run:t5`, "completed", rowId("a5")],
  ]);
  assert.equal(snap.runtime?.status, "idle");
  assert.equal(snap.hasMoreBefore, true);
  assert.deepEqual(snap.lineage, { parentThreadId: null, relationshipToParent: null, rootThreadId: KEY });

  const older = await view.loadOlder();
  assert.equal(older[0]?.t, "turnItems.replaced");
  const replaced = older[0]!.t === "turnItems.replaced" ? older[0].visibleTurnItems : [];
  assert.deepEqual(texts(replaced).filter((s) => s.startsWith("user")), ["user_message:q2", "user_message:q3", "user_message:q4", "user_message:q5"]);
  assert.deepEqual(replaced.map((r) => r.position), [...replaced.keys()]);
  assert.deepEqual(older.slice(1).map((e) => (e.t === "run.upserted" ? e.run.runId : e.t)), [`${KEY}:run:t2`, `${KEY}:run:t3`]);
  assert.deepEqual(events, older, "loadOlder also tells the listeners");
  assert.equal(view.hasMoreBefore, true);

  await view.loadOlder();
  assert.equal(view.hasMoreBefore, false);
  assert.deepEqual(await view.loadOlder(), []);
  assert.equal(view.snapshot().visibleTurnItems.length, 10);
  assert.equal(d.calls("thread/turns/list").length, 3);

  await view.close();
  assert.equal(d.calls("thread/unsubscribe").length, 0, "nothing to unsubscribe");
  assertOnlyAllowedCalls(d);
  assertInvariant(view);
  const st = view.stats().records;
  assert.equal(st.displayedByKey["codex|item|type=userMessage"], 5);
  assert.equal(st.hiddenByKey["codex|turn|status=completed"], 5);
});

test("thread state: effort and rollout path; a subagent thread is titled by its nickname", async (t) => {
  const turns = [turn("t1", [user("u1", "q1"), agent("a1", "r1")])];
  const { view } = await rig(t, {
    status: { type: "notLoaded" },
    turns,
    thread: { parentThreadId: "parent", preview: "", agentNickname: "Kierkegaard the 2nd", reasoningEffort: "high", model: "gpt-6-luna", path: "/h/sessions/rollout-th1.jsonl" },
  });
  const snap = await view.load({ pageSize: 5 });
  assert.equal(snap.title, "Kierkegaard the 2nd");
  assert.equal(snap.state.nameSource, "subagent-meta");
  assert.equal(snap.state.effort, "high");
  assert.equal(snap.state.transcriptPath, "/h/sessions/rollout-th1.jsonl");
  assert.equal(snap.state.model, "gpt-6-luna");

  const { view: plain } = await rig(t, { status: { type: "notLoaded" }, turns });
  const s2 = await plain.load({ pageSize: 5 });
  assert.equal(s2.title, "preview th1");
  assert.equal(s2.state.nameSource, "codex-preview");
  assert.ok(!("effort" in s2.state) && !("transcriptPath" in s2.state), "a thread record without them adds no keys");
});

test("an active thread is resumed; deltas append and item/completed replaces the streamed text", async (t) => {
  const turns = [turn("t1", [user("u1", "first"), agent("a1", "done")]), turn("t2", [user("u2", "second")], "inProgress", 1_794_000_100)];
  const { d, view, events } = await rig(t, { status: { type: "active", activeFlags: [] }, turns });

  const snap = await view.load({ pageSize: 10 });
  assert.deepEqual(d.calls("thread/resume").map((c) => c.params), [{ threadId: TID, excludeTurns: true }]);
  assert.equal(snap.runtime?.status, "running");
  assert.equal(snap.runtime?.activeRunId, `${KEY}:run:t2`);
  assert.equal(snap.runs.at(-1)?.status, "running");
  assert.deepEqual(texts(snap.visibleTurnItems), ["user_message:first", "assistant_message:done", "user_message:second"]);

  // Steer: a second user message in the running turn.
  d.notify("item/completed", { threadId: TID, turnId: "t2", item: user("u3", "also this"), completedAtMs: 1 });
  // Agent message: started, two deltas, completed with the authoritative text.
  d.notify("item/started", { threadId: TID, turnId: "t2", item: { ...agent("a2", ""), startedAtMs: 1_794_000_101_000 }, startedAtMs: 1_794_000_101_000 });
  d.notify("item/agentMessage/delta", { threadId: TID, turnId: "t2", itemId: "a2", delta: "Hel" });
  d.notify("item/agentMessage/delta", { threadId: TID, turnId: "t2", itemId: "a2", delta: "lo" });
  // Another thread's delta on the same connection is not ours.
  d.notify("item/agentMessage/delta", { threadId: "other", turnId: "x", itemId: "a2", delta: "NO" });
  d.notify("item/completed", { threadId: TID, turnId: "t2", item: { ...agent("a2", "Hello!"), completedAtMs: 1_794_000_102_000 }, completedAtMs: 1_794_000_102_000 });
  d.notify("item/agentMessage/delta", { threadId: TID, turnId: "t2", itemId: "a2", delta: "late" });
  await waitFor(() => view.stats().droppedDeltas === 1, "late delta");

  const forA2 = events.filter((e) => (e.t === "turnItem.upserted" && e.row.item.id === rowId("a2")) || (e.t === "turnItem.textAppended" && e.itemId === rowId("a2")));
  assert.deepEqual(
    forA2.map((e) => (e.t === "turnItem.textAppended" ? `+${e.value}` : e.t === "turnItem.upserted" && e.row.item.type === "assistant_message" ? `=${e.row.item.text}|${e.row.item.status}|${e.row.item.streaming}` : e.t)),
    ["=|running|true", "+Hel", "+lo", "=Hello!|completed|false"],
  );
  const steer = events.find((e) => e.t === "turnItem.upserted" && e.row.item.id === rowId("u3"));
  assert.ok(steer?.t === "turnItem.upserted" && steer.row.item.type === "user_message" && steer.row.item.inputIntent === "steer");
  assert.equal(steer.row.position, 3);
  const run = events.filter((e) => e.t === "run.upserted").at(-1);
  assert.ok(run?.t === "run.upserted" && run.run.assistantMessageId === rowId("a2"));

  // Reasoning summary parts and command output.
  d.notify("item/started", { threadId: TID, turnId: "t2", item: { type: "reasoning", id: "r1", summary: [], content: [] }, startedAtMs: 1 });
  d.notify("item/reasoning/summaryTextDelta", { threadId: TID, turnId: "t2", itemId: "r1", delta: "**A**", summaryIndex: 0 });
  d.notify("item/reasoning/summaryPartAdded", { threadId: TID, turnId: "t2", itemId: "r1", summaryIndex: 1 });
  d.notify("item/reasoning/summaryTextDelta", { threadId: TID, turnId: "t2", itemId: "r1", delta: "B", summaryIndex: 1 });
  d.notify("item/reasoning/textDelta", { threadId: TID, turnId: "t2", itemId: "r1", delta: "raw", contentIndex: 0 });
  d.notify("item/commandExecution/outputDelta", { threadId: TID, turnId: "t2", itemId: "c1", delta: "line1\n" });
  d.notify("item/commandExecution/outputDelta", { threadId: TID, turnId: "t2", itemId: "c1", delta: "line2\n" });
  d.notify("thread/tokenUsage/updated", {
    threadId: TID,
    turnId: "t2",
    tokenUsage: {
      total: { totalTokens: 900, inputTokens: 800, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 10 },
      last: { totalTokens: 300, inputTokens: 280, cachedInputTokens: 200, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 2 },
      modelContextWindow: 258_400,
    },
  });
  await waitFor(() => events.some((e) => e.t === "tokenUsage.updated"), "token usage");
  const appended = (id: string): string[] => events.filter((e) => e.t === "turnItem.textAppended" && e.itemId === rowId(id)).map((e) => (e.t === "turnItem.textAppended" ? `${e.field}:${e.value}` : ""));
  assert.deepEqual(appended("r1"), ["text:**A**", "text:\n\n", "text:B"]);
  assert.deepEqual(appended("c1"), ["output:line2\n"], "the first delta created the row (missed item/started)");
  assert.equal(view.stats().rowsFromDeltas, 1);
  const snapNow = view.snapshot();
  const r1 = snapNow.visibleTurnItems.find((r) => r.item.id === rowId("r1"))!;
  assert.ok(r1.item.type === "reasoning" && r1.item.text === "**A**\n\nB");
  assert.equal(r1.x?.body, undefined, "raw reasoning deltas have no append event, so the row waits for item/completed");
  const c1 = snapNow.visibleTurnItems.find((r) => r.item.id === rowId("c1"))!;
  assert.ok(c1.item.type === "command_execution" && c1.item.output === "line1\nline2\n");
  assert.equal(snapNow.tokenUsage?.usedTokens, 300);
  assert.equal(snapNow.tokenUsage?.maxTokens, 258_400);

  // The turn ends: running rows settle, the run completes, the thread goes idle.
  const n = events.length;
  d.notify("turn/completed", { threadId: TID, turn: { ...turn("t2", [agent("a2", "Hello!")], "completed", 1_794_000_100), itemsView: "summary" } });
  d.notify("thread/status/changed", { threadId: TID, status: { type: "idle" } });
  await waitFor(() => events.some((e) => e.t === "runtime.updated" && e.runtime?.status === "idle"), "idle");
  const after = events.slice(n);
  assert.ok(after.some((e) => e.t === "run.upserted" && e.run.runId === `${KEY}:run:t2` && e.run.status === "completed"));
  assert.ok(after.some((e) => e.t === "turnItem.upserted" && e.row.item.id === rowId("r1") && e.row.item.status === "completed"));
  assert.ok(after.some((e) => e.t === "turnItem.upserted" && e.row.item.id === rowId("c1") && e.row.item.status === "running") === false);

  await view.close();
  assert.deepEqual(d.calls("thread/unsubscribe").map((c) => c.params), [{ threadId: TID }]);
  assertOnlyAllowedCalls(d);
  assertInvariant(view);
  // Notifications for another thread are not this thread's records.
  assert.equal(view.stats().records.byKey["codex|notif|method=item/agentMessage/delta"], 3);
});

test("notifications during load wait for the snapshot without repeating text the page holds", async (t) => {
  const turns = [
    turn(
      "t1",
      [
        user("u1", "go"),
        { ...agent("a0", "done"), completedAtMs: 1_794_000_001_000 },
        // In a running turn and without completedAtMs: still streaming when the page was read.
        agent("a1", "partial"),
        agent("a2", ""),
        // The page was read after " two" went out but before " three".
        agent("a3", "one two"),
      ],
      "inProgress",
    ),
  ];
  const { d, rpc, view, events } = await rig(t, { status: { type: "active", activeFlags: [] }, turns });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const list = d.handlers.get("thread/turns/list")!;
  d.handlers.set("thread/turns/list", async (p, c) => {
    await gate;
    return list(p, c);
  });

  const loading = view.load({ pageSize: 5 });
  await waitFor(() => d.calls("thread/turns/list").length === 1, "page requested");
  // Sent after the subscription and before the page answer.
  d.notify("item/started", { threadId: TID, turnId: "t1", item: agent("a1", ""), startedAtMs: 1 });
  d.notify("item/agentMessage/delta", { threadId: TID, turnId: "t1", itemId: "a1", delta: "partial" });
  d.notify("item/agentMessage/delta", { threadId: TID, turnId: "t1", itemId: "a2", delta: "abc" });
  d.notify("item/agentMessage/delta", { threadId: TID, turnId: "t1", itemId: "a0", delta: "x" });
  d.notify("item/agentMessage/delta", { threadId: TID, turnId: "t1", itemId: "a3", delta: " two" });
  d.notify("item/agentMessage/delta", { threadId: TID, turnId: "t1", itemId: "a3", delta: " three" });
  d.notify("item/completed", { threadId: TID, turnId: "t1", item: { type: "plan", id: "p1", text: "# P" }, completedAtMs: 1 });
  await waitFor(() => rpc.stats().notifications["item/completed"] === 1, "notifications arrived");
  release();
  const snap = await loading;

  assert.deepEqual(texts(snap.visibleTurnItems), [
    "user_message:go",
    "assistant_message:done",
    "assistant_message:partial",
    "assistant_message:abc",
    "assistant_message:one two three",
    "proposed_plan",
  ]);
  assert.equal(events.length, 0, "the snapshot already holds what waited");
  assert.equal(view.stats().buffered, 7);
  assert.equal(view.stats().droppedDeltas, 3, "a1 and a3's first (the page has their text) and a0 (finished)");

  // After the snapshot, deltas for the same running item append again.
  d.notify("item/agentMessage/delta", { threadId: TID, turnId: "t1", itemId: "a1", delta: " more" });
  await waitFor(() => events.some((e) => e.t === "turnItem.textAppended" && e.itemId === rowId("a1")), "live delta");
  const a1 = view.snapshot().visibleTurnItems.find((r) => r.item.id === rowId("a1"))!;
  assert.ok(a1.item.type === "assistant_message" && a1.item.text === "partial more");
  assertInvariant(view);
});

test("a notLoaded thread is resumed when another client starts a turn, and re-read", async (t) => {
  const turns = [turn("t1", [user("u1", "old"), agent("a1", "answer")])];
  const r = await rig(t, { status: { type: "notLoaded" }, turns });
  const { d, view, events } = r;
  await view.load({ pageSize: 5 });
  assert.equal(d.calls("thread/resume").length, 0);

  // Another client starts a turn; the daemon loads the thread.
  r.turns = [...turns, turn("t2", [user("u2", "new prompt")], "inProgress", 1_794_000_200)];
  d.threads.set(TID, makeThread(TID, { status: { type: "active", activeFlags: [] } }));
  d.notify("thread/status/changed", { threadId: TID, status: { type: "active", activeFlags: [] } });
  await waitFor(() => events.some((e) => e.t === "turnItems.replaced"), "re-read after resume");
  assert.deepEqual(d.calls("thread/resume").map((c) => c.params), [{ threadId: TID, excludeTurns: true }]);
  const rep = events.find((e) => e.t === "turnItems.replaced")!;
  assert.ok(rep.t === "turnItems.replaced");
  assert.equal(rep.reason, "resync");
  assert.deepEqual(texts(rep.visibleTurnItems), ["user_message:old", "assistant_message:answer", "user_message:new prompt"]);
  assert.ok(events.some((e) => e.t === "runtime.updated" && e.runtime?.status === "running" && e.runtime.activeRunId === `${KEY}:run:t2`));

  // Live from here on.
  d.notify("item/started", { threadId: TID, turnId: "t2", item: agent("a2", ""), startedAtMs: 1 });
  d.notify("item/agentMessage/delta", { threadId: TID, turnId: "t2", itemId: "a2", delta: "hi" });
  await waitFor(() => events.some((e) => e.t === "turnItem.textAppended" && e.value === "hi"), "delta");

  // The connection drops: the new connection subscribes again and re-reads.
  const resumes = d.calls("thread/resume").length;
  r.turns = [...turns, turn("t2", [user("u2", "new prompt"), agent("a2", "hi there")], "completed", 1_794_000_200)];
  d.threads.set(TID, makeThread(TID, { status: { type: "idle" } }));
  d.dropConnections();
  await waitFor(() => d.calls("thread/resume").length === resumes + 1, "resume on the new connection");
  await waitFor(() => events.filter((e) => e.t === "turnItems.replaced").length === 2, "second re-read");
  const last = events.filter((e) => e.t === "turnItems.replaced").at(-1)!;
  assert.ok(last.t === "turnItems.replaced");
  assert.deepEqual(texts(last.visibleTurnItems), ["user_message:old", "assistant_message:answer", "user_message:new prompt", "assistant_message:hi there"]);

  await view.close();
  assert.equal(d.calls("thread/unsubscribe").length, 1);
  assertOnlyAllowedCalls(d);
  assertInvariant(view);
});

test("unknown item types are counted and kept as notices, in history and live", async (t) => {
  const odd = { type: "hologram", id: "h1", payload: 1 } as unknown as ThreadItem;
  const turns = [turn("t1", [user("u1", "x"), odd, { type: "sleep", id: "s1", durationMs: 10 }, agent("a1", "y")], "inProgress")];
  const { d, view, events } = await rig(t, { status: { type: "active", activeFlags: [] }, turns });
  const snap = await view.load({ pageSize: 5 });
  const notice = snap.visibleTurnItems.find((r) => r.item.id === rowId("h1"));
  assert.ok(notice?.item.type === "system_notice" && notice.x?.unknown === true);
  assert.equal(snap.visibleTurnItems.length, 3, "sleep is hidden");
  assert.equal(snap.state.stats.unknownByKey["codex|item|type=hologram"], 1);
  assert.equal(snap.state.stats.hiddenByKey["codex|item|type=sleep"], 1);

  d.notify("item/completed", { threadId: TID, turnId: "t1", item: { type: "hologram", id: "h2" }, completedAtMs: 1 });
  await waitFor(() => events.some((e) => e.t === "turnItem.upserted" && e.row.item.id === rowId("h2")), "live unknown");
  assert.equal(view.stats().records.unknownByKey["codex|notif|method=item/completed|type=hologram"], 1);
  assertInvariant(view);
});

test("turn outcomes: interrupted, failed, and an error notification that the failed turn replaces", async (t) => {
  const failed = { ...turn("t2", [user("u2", "b")], "failed"), error: { message: "quota", codexErrorInfo: "usageLimitExceeded" as const, additionalDetails: null, misalignment: null } };
  const turns = [turn("t1", [user("u1", "a"), { type: "commandExecution", id: "c1", pluginId: null, scriptPath: null, command: "sleep 9", cwd: "/", processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null }], "interrupted"), failed, turn("t3", [user("u3", "c")], "inProgress")];
  const { d, view, events } = await rig(t, { status: { type: "active", activeFlags: ["waitingOnApproval"] }, turns, readonly: false });
  const snap = await view.load({ pageSize: 5 });
  assert.equal(snap.state.control, "codex-rpc");
  assert.deepEqual(
    snap.visibleTurnItems.map((r) => `${r.item.type}:${r.item.status}`),
    ["user_message:completed", "command_execution:interrupted", "run_interrupt_result:completed", "user_message:completed", "error:failed", "user_message:completed"],
  );
  assert.deepEqual(snap.runs.map((r) => r.status), ["interrupted", "failed", "waiting"]);
  assert.equal(snap.runtime?.status, "waiting");
  assert.equal(snap.runtime?.lastError, "quota");

  d.notify("error", { threadId: TID, turnId: "t3", willRetry: true, error: { message: "reconnecting", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: null, misalignment: null } });
  d.notify("error", { threadId: TID, turnId: "t3", willRetry: false, error: { message: "gave up", codexErrorInfo: "internalServerError", additionalDetails: null, misalignment: null } });
  d.notify("turn/completed", { threadId: TID, turn: { ...turn("t3", [], "failed"), error: { message: "gave up", codexErrorInfo: "internalServerError", additionalDetails: null, misalignment: null } } });
  await waitFor(() => events.some((e) => e.t === "run.upserted" && e.run.runId === `${KEY}:run:t3` && e.run.status === "failed"), "t3 failed");
  const errs = view.snapshot().visibleTurnItems.filter((r) => r.item.type === "error" && r.item.runId === `${KEY}:run:t3`);
  assert.equal(errs.length, 2, "one retry notice and one turn error");
  assert.ok(errs[0]?.item.type === "error" && errs[0].item.retry?.attempt === 1 && errs[0].item.failure.class === "transport_error");
  assert.ok(errs[1]?.item.type === "error" && errs[1].item.id === `${KEY}:turn-error:t3`);
  assert.equal(events.filter((e) => e.t === "pending.updated").length, 0, "no pending lists without request handlers");
  assertInvariant(view);
});

test("live turn notifications: plan, diff, patch updates, compaction, hooks, and a notice for a turn not held", async (t) => {
  const { d, view, events } = await rig(t, { status: { type: "active", activeFlags: [] }, turns: [turn("t1", [user("u1", "go")], "inProgress")] });
  await view.load({ pageSize: 5 });
  const before = view.stats().records.linesRead;
  let sent = 0;
  const send = (method: string, params: Record<string, unknown>): void => {
    sent++;
    d.notify(method, { threadId: TID, ...params });
  };

  const change = (diff: string) => [{ path: "a.ts", kind: { type: "update", move_path: null }, diff }];
  send("item/fileChange/patchUpdated", { turnId: "t1", itemId: "f1", changes: change("@@ -1 +1 @@\n-a\n+b") });
  send("item/fileChange/patchUpdated", { turnId: "t1", itemId: "f1", changes: change("@@ -1 +1,2 @@\n-a\n+b\n+c") });
  send("turn/plan/updated", { turnId: "t1", explanation: "why", plan: [{ step: "one", status: "completed" }, { step: "two", status: "inProgress" }] });
  send("turn/plan/updated", { turnId: "t1", explanation: null, plan: [{ step: "one", status: "completed" }, { step: "two", status: "completed" }] });
  send("turn/diff/updated", { turnId: "t1", diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-a\n+b\n+c\n" });
  send("thread/compacted", { turnId: "t1" });
  send("item/completed", { turnId: "t1", item: { type: "contextCompaction", id: "cc1" }, completedAtMs: 1 });
  send("hook/completed", {
    turnId: "t1",
    run: { id: "stop:1", eventName: "stop", handlerType: "command", executionMode: "sync", scope: "turn", sourcePath: "/h.json", source: "user", displayOrder: 1, status: "failed", statusMessage: "exit 2", startedAt: 1, completedAt: 2, durationMs: 1, entries: [{ kind: "stderr", text: "boom" }] },
  });
  // thread/goal/updated reaches unsubscribed connections too; its turn may be one this view never loaded.
  send("thread/goal/updated", { turnId: "t-old", goal: { threadId: TID, objective: "ship", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } });
  send("turn/completed", { turn: turn("t1", [], "completed") });
  await waitFor(() => events.some((e) => e.t === "run.upserted" && e.run.status === "completed"), "turn end");

  const snap = view.snapshot();
  const types = snap.visibleTurnItems.map((r) => r.item.type);
  assert.deepEqual(types, ["user_message", "file_change", "todo_list", "file_change", "compaction", "system_notice", "system_notice"]);
  const f1 = snap.visibleTurnItems.find((r) => r.item.id === rowId("f1"))!;
  assert.ok(f1.item.type === "file_change" && f1.item.additions === 2 && f1.item.deletions === 1);
  const plan = snap.visibleTurnItems.find((r) => r.item.id === `${KEY}:plan:t1`)!;
  assert.ok(plan.item.type === "todo_list");
  assert.deepEqual(plan.item.steps.map((s) => [s.text, s.status]), [["one", "completed"], ["two", "completed"]]);
  assert.equal(events.filter((e) => e.t === "turnItem.upserted" && e.row.item.id === plan.item.id).every((e) => e.t === "turnItem.upserted" && e.row.position === plan.position), true);
  const diff = snap.visibleTurnItems.find((r) => r.item.id === `${KEY}:diff:t1`)!;
  assert.ok(diff.item.type === "file_change" && diff.item.fileName === "turn diff" && diff.item.additions === 2 && diff.item.deletions === 1);
  assert.deepEqual(diff.item.type === "file_change" && diff.item.changes, [{ operation: "update", path: "a.ts" }]);
  assert.equal(types.filter((x) => x === "compaction").length, 1, "thread/compacted does not add a second row");
  const hook = snap.visibleTurnItems.find((r) => r.item.id === `${KEY}:hook:t1:stop:1`)!;
  assert.ok(hook.item.type === "system_notice" && hook.item.level === "warning" && hook.x?.body === "boom");
  const goal = snap.visibleTurnItems.at(-1)!;
  assert.ok(goal.item.type === "system_notice" && goal.item.runId === null && goal.x?.noticeKind === "goal");
  assert.deepEqual(snap.runs.map((r) => r.runId), [`${KEY}:run:t1`], "no run for the turn the view does not hold");
  // Every record counted once, under its own key.
  assert.equal(view.stats().records.linesRead - before, sent);
  assertInvariant(view);
});

test("revert: a reverted notification re-reads, and a revert missed while disconnected drops the removed turns", async (t) => {
  const t1 = turn("t1", [user("u1", "one")]);
  const t2 = turn("t2", [user("u2", "two")]);
  const t3 = turn("t3", [user("u3", "three")]);
  const r = await rig(t, { status: { type: "idle" }, turns: [t1, t2, t3] });
  const { d, view, events } = r;
  await view.load({ pageSize: 10 });

  r.turns = [t1, t3];
  d.notify("thread/reverted", { threadId: TID });
  await waitFor(() => events.some((e) => e.t === "turnItems.replaced" && e.reason === "reverted"), "reverted");
  assert.deepEqual(texts(view.snapshot().visibleTurnItems), ["user_message:one", "user_message:three"]);

  // While disconnected: t3 is reverted away and t4 is added.
  const t4 = turn("t4", [user("u4", "four")]);
  r.turns = [t1, t4];
  d.dropConnections();
  await waitFor(() => events.filter((e) => e.t === "turnItems.replaced" && e.reason === "resync").length === 1, "re-read after reconnect");
  const snap = view.snapshot();
  assert.deepEqual(texts(snap.visibleTurnItems), ["user_message:one", "user_message:four"]);
  assert.deepEqual(snap.runs.map((x) => x.runId), [`${KEY}:run:t1`, `${KEY}:run:t4`]);
  assertInvariant(view);
});

test("loadOlder: an older failure does not replace the newest error; older subagents and questions settle", async (t) => {
  const err = (message: string) => ({ message, codexErrorInfo: "other" as const, additionalDetails: null, misalignment: null });
  const spawn: ThreadItem = {
    type: "collabAgentToolCall",
    id: "sp1",
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: TID,
    receiverThreadIds: ["child1"],
    prompt: "go",
    model: null,
    reasoningEffort: null,
    agentsStates: {},
  };
  const ask = { ...agent("q1", "pick one"), delivery: "async", questions: [{ title: "A or B?", options: ["A", "B"] }] } as ThreadItem;
  const turns = [
    { ...turn("t1", [user("u1", "a"), spawn, ask], "failed"), error: err("OLD") },
    turn("t2", [user("u2", "b"), { type: "subAgentActivity", id: "sa1", kind: "completed", agentThreadId: "child1", agentPath: "/root/w", model: null, reasoningEffort: null }]),
    { ...turn("t3", [user("u3", "c")], "failed"), error: err("NEW") },
  ];
  const { view, events } = await rig(t, { status: { type: "notLoaded" }, turns });
  const snap = await view.load({ pageSize: 2 });
  assert.equal(snap.runtime?.lastError, "NEW");

  const older = await view.loadOlder();
  assert.ok(!older.some((e) => e.t === "runtime.updated"), "lastError is still the newest error");
  const now = view.snapshot();
  assert.equal(now.runtime?.lastError, "NEW");
  const row = now.visibleTurnItems.find((r) => r.item.id === rowId("sp1"))!;
  assert.equal(row.item.status, "completed", "the newer subAgentActivity wins on the row");
  assert.equal(now.subagents[0]?.status, "completed");
  const q = now.visibleTurnItems.find((r) => r.item.id === `${rowId("q1")}:questions`)!;
  assert.equal(q.item.status, "completed", "a later turn exists");
  assert.equal(events.length, older.length, "loadOlder also told the listeners");
});

test("a question in the newest turn waits until another turn starts", async (t) => {
  const { d, view, events } = await rig(t, { status: { type: "active", activeFlags: [] }, turns: [turn("t1", [user("u1", "go")], "inProgress")] });
  await view.load({ pageSize: 5 });
  d.notify("item/completed", { threadId: TID, turnId: "t1", item: { ...agent("q1", "?"), delivery: "async", questions: [{ title: "A?", options: null }] }, completedAtMs: 1 });
  d.notify("turn/completed", { threadId: TID, turn: turn("t1", [], "completed") });
  await waitFor(() => events.some((e) => e.t === "run.upserted" && e.run.status === "completed"), "turn end");
  const qid = `${rowId("q1")}:questions`;
  assert.equal(view.snapshot().visibleTurnItems.find((r) => r.item.id === qid)?.item.status, "waiting");
  d.notify("turn/started", { threadId: TID, turn: turn("t2", [], "inProgress") });
  await waitFor(() => events.some((e) => e.t === "turnItem.upserted" && e.row.item.id === qid && e.row.item.status === "completed"), "settled");
});

test("a turn start re-reads the thread: a model or effort a turn/start changed is patched (the daemon sends no settings notice)", async (t) => {
  const { d, view, events } = await rig(t, {
    status: { type: "active", activeFlags: [] }, turns: [turn("t1", [user("u1", "go")], "inProgress")],
    thread: { model: "gpt-6-luna", reasoningEffort: "high" },
  });
  await view.load({ pageSize: 5 });
  const th = d.threads.get(TID)!;
  th.model = "gpt-6.1-sol";
  th.reasoningEffort = "low";
  d.notify("turn/started", { threadId: TID, turn: turn("t2", [], "inProgress") });
  await waitFor(() => events.some((e) => e.t === "thread.patched" && e.state?.model === "gpt-6.1-sol"), "patched");
  const patch = events.find((e) => e.t === "thread.patched" && e.state?.model);
  assert.deepEqual(patch && patch.t === "thread.patched" ? patch.state : null, { model: "gpt-6.1-sol", effort: "low" });
  assert.equal(view.snapshot().state.model, "gpt-6.1-sol");
  const before = events.length;
  d.notify("turn/started", { threadId: TID, turn: turn("t3", [], "inProgress") });
  await settle(60);
  assert.equal(events.slice(before).filter((e) => e.t === "thread.patched").length, 0, "no patch when nothing moved");
  assertOnlyAllowedCalls(d);
});

test("thread/settings/updated patches model and effort once, and not again when they did not move", async (t) => {
  const { d, view, events } = await rig(t, { status: { type: "idle" }, turns: [turn("t1", [user("u1", "go")])], thread: { model: "gpt-6-luna", reasoningEffort: "high" } });
  await view.load({ pageSize: 5 });
  d.notify("thread/settings/updated", { threadId: TID, threadSettings: { model: "gpt-6.1-sol", effort: "low" } });
  await waitFor(() => events.some((e) => e.t === "thread.patched" && e.state?.model === "gpt-6.1-sol"), "patched");
  assert.equal(view.snapshot().state.effort, "low");
  const before = events.length;
  d.notify("thread/settings/updated", { threadId: TID, threadSettings: { model: "gpt-6.1-sol", effort: "low" } });
  await settle(60);
  assert.equal(events.slice(before).filter((e) => e.t === "thread.patched").length, 0);
  assertOnlyAllowedCalls(d);
});

test("an archive that arrives during load is sent after the snapshot", async (t) => {
  const { d, rpc, view, events } = await rig(t, { status: { type: "idle" }, turns: [turn("t1", [user("u1", "x")])] });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const list = d.handlers.get("thread/turns/list")!;
  d.handlers.set("thread/turns/list", async (p, c) => {
    await gate;
    return list(p, c);
  });
  const loading = view.load({ pageSize: 5 });
  await waitFor(() => d.calls("thread/turns/list").length === 1, "page requested");
  d.notify("thread/archived", { threadId: TID });
  await waitFor(() => rpc.stats().notifications["thread/archived"] === 1, "archived arrived");
  release();
  await loading;
  assert.equal(events.length, 0, "nothing before the caller has the snapshot");
  await waitFor(() => events.some((e) => e.t === "thread.removed" && e.reason === "archived"), "removed after");
});

test("close during a re-read sends no resume; a failed load releases its subscription", async (t) => {
  const r = await rig(t, { status: { type: "notLoaded" }, turns: [turn("t1", [user("u1", "x")])] });
  const { d, view } = r;
  await view.load({ pageSize: 5 });
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  d.handlers.set("thread/read", async (p) => {
    await gate;
    return { thread: d.threads.get(String(p.threadId)) };
  });
  d.threads.set(TID, makeThread(TID, { status: { type: "active", activeFlags: [] } }));
  d.notify("thread/status/changed", { threadId: TID, status: { type: "active", activeFlags: [] } });
  await waitFor(() => d.calls("thread/read").length === 2, "re-read started");
  const closing = view.close();
  release();
  await closing;
  await settle(50);
  assert.equal(d.calls("thread/resume").length, 0);
  assert.equal(d.calls("thread/unsubscribe").length, 0);
  assertOnlyAllowedCalls(d);

  // A second daemon whose page read fails after the resume.
  const r2 = await rig(t, { status: { type: "active", activeFlags: [] }, turns: [] });
  r2.d.handlers.set("thread/turns/list", () => {
    throw new DaemonError(-32600, "invalid paginated history lineage");
  });
  await assert.rejects(r2.view.load({ pageSize: 5 }), /invalid paginated history lineage/);
  assert.equal(r2.d.calls("thread/resume").length, 1);
  assert.deepEqual(r2.d.calls("thread/unsubscribe").map((c) => c.params), [{ threadId: TID }]);
  assert.equal(r2.view.stats().subscribed, false);
});

test("a failed re-read is tried again", async (t) => {
  const r = await rig(t, { status: { type: "notLoaded" }, turns: [turn("t1", [user("u1", "x")])] });
  const { d, view, events } = r;
  await view.load({ pageSize: 5 });
  const list = d.handlers.get("thread/turns/list")!;
  let fail = true;
  d.handlers.set("thread/turns/list", (p, c) => {
    if (fail) {
      fail = false;
      throw new DaemonError(-32603, "busy");
    }
    return list(p, c);
  });
  r.turns = [turn("t1", [user("u1", "x")]), turn("t2", [user("u2", "y")], "inProgress")];
  d.threads.set(TID, makeThread(TID, { status: { type: "active", activeFlags: [] } }));
  d.notify("thread/status/changed", { threadId: TID, status: { type: "active", activeFlags: [] } });
  await waitFor(() => events.some((e) => e.t === "turnItems.replaced"), "re-read after the retry", 5000);
  assert.equal(view.stats().resyncs, 2);
  assert.equal(d.calls("thread/resume").length, 1, "the first attempt subscribed; the retry only re-reads");
  assert.deepEqual(texts(view.snapshot().visibleTurnItems), ["user_message:x", "user_message:y"]);
});

test("server requests are left for the driving client, not the view (pending lists stay empty)", async (t) => {
  const { d, view, events } = await rig(t, { status: { type: "active", activeFlags: ["waitingOnApproval"] }, turns: [turn("t1", [user("u1", "x")], "inProgress")] });
  await view.load({ pageSize: 5 });
  const reply = d.request("item/commandExecution/requestApproval", { threadId: TID, turnId: "t1", itemId: "c1", command: "rm -rf /", reason: null });
  // The watcher stays silent: answering (even with an error) would decide the request for the TUI.
  const raced = await Promise.race([reply.then(() => "answered"), new Promise((r) => setTimeout(() => r("silent"), 150))]);
  assert.equal(raced, "silent");
  assert.equal(events.filter((e) => e.t === "pending.updated").length, 0);
  assert.equal(view.snapshot().runtime?.status, "waiting");
});

test("state.goal comes from thread/goal/get, follows every goal update and clear, and stays unread when the daemon refuses the read", async (t) => {
  const goal = (status: string, tokensUsed: number, timeUsedSeconds: number) => ({
    threadId: TID, objective: "ship", status, tokenBudget: null, tokensUsed, timeUsedSeconds, createdAt: 1, updatedAt: 2,
  });
  const r = await rig(t, { status: { type: "idle" }, turns: [turn("t1", [user("u1", "x")])] });
  const { d, view, events } = r;
  d.handlers.set("thread/goal/get", () => ({ goal: goal("active", 10, 3) }));
  const snap = await view.load({ pageSize: 5 });
  assert.deepEqual(snap.state.goal, { objective: "ship", status: "active", tokenBudget: null, tokensUsed: 10, timeUsedSeconds: 3 });
  // Tokens and time move under the same objective and status: state follows, the notice row does not repeat.
  d.notify("thread/goal/updated", { threadId: TID, turnId: null, goal: goal("active", 10, 3) });
  d.notify("thread/goal/updated", { threadId: TID, turnId: "t1", goal: goal("active", 500, 21) });
  d.notify("thread/goal/updated", { threadId: TID, turnId: "t1", goal: goal("complete", 900, 34) });
  await waitFor(() => view.snapshot().state.goal?.status === "complete", "complete");
  const patches = events.filter((e) => e.t === "thread.patched").map((e) => (e.t === "thread.patched" ? e.state?.goal : undefined));
  assert.deepEqual(patches.map((g) => g && [g.status, g.tokensUsed, g.timeUsedSeconds]), [["active", 10, 3], ["active", 500, 21], ["complete", 900, 34]]);
  const notices = view.snapshot().visibleTurnItems.filter((x) => x.x?.noticeKind === "goal").map((x) => (x.item.type === "system_notice" ? x.item.message : ""));
  assert.deepEqual(notices, ["Goal active: ship", "Goal met: ship"]);
  d.notify("thread/goal/cleared", { threadId: TID });
  await waitFor(() => view.snapshot().state.goal === null, "cleared");
  assert.deepEqual(events.filter((e) => e.t === "thread.patched").at(-1), { t: "thread.patched", threadId: KEY, state: { goal: null } });
  assert.equal(view.stats().goalReadFailures, 0);

  // A daemon that refuses the read (a temporary thread): the state has no goal key, and the failure is counted.
  const r2 = await rig(t, { status: { type: "idle" }, turns: [turn("t1", [user("u1", "x")])] });
  r2.d.handlers.set("thread/goal/get", () => {
    throw new DaemonError(-32600, `ephemeral thread does not support goals: ${TID}`);
  });
  const snap2 = await r2.view.load({ pageSize: 5 });
  assert.equal("goal" in snap2.state, false);
  assert.equal(r2.view.stats().goalReadFailures, 1);
});
