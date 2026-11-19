import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { OrchestrationV2ProjectedTurnItem } from "@maru/shared";
import { FakeDaemon, makeThread, waitFor } from "../fake-daemon.ts";
import type { Turn } from "../protocol/v2/Turn.ts";
import type { Thread } from "../protocol/v2/Thread.ts";
import { connect } from "../rpc.ts";
import { mapThreadItem } from "./mapItems.ts";
import { isRolloutCursor, openRolloutHistory, rolloutStatsLine } from "./rolloutFallback.ts";
import type { RolloutHistory } from "./rolloutFallback.ts";
import { createCodexThreadView } from "./threadView.ts";

const TID = "01a0cdf1-0000-7000-8000-000000000001";
const SEG = "01a19614-0000-7000-8000-000000000002";

// ---- synthetic rollout records (the 0.156 paginated layout; no real conversation content) ----

class Rollout {
  private ordinal: number;
  lines: string[] = [];
  constructor(firstOrdinal = 0) {
    this.ordinal = firstOrdinal;
  }
  rec(type: string, payload: Record<string, unknown>): this {
    this.lines.push(JSON.stringify({ timestamp: "2026-09-23T11:06:39.751Z", ordinal: this.ordinal++, type, payload }));
    return this;
  }
  meta(extra: Record<string, unknown> = {}): this {
    return this.rec("session_meta", { id: TID, session_id: TID, cwd: "/work/p", cli_version: "0.156.1", history_mode: "paginated", ...extra });
  }
  start(turn: string, at = 1_790_000_000): this {
    return this.rec("event_msg", { type: "task_started", turn_id: turn, root_turn_id: turn, started_at: at, model_context_window: 1, collaboration_mode_kind: "default" });
  }
  complete(turn: string, extra: Record<string, unknown> = {}): this {
    return this.rec("event_msg", { type: "task_complete", turn_id: turn, last_agent_message: null, started_at: 1_790_000_000, completed_at: 1_790_000_005, duration_ms: 5000, ...extra });
  }
  abort(turn: string): this {
    return this.rec("event_msg", { type: "turn_aborted", turn_id: turn, reason: "interrupted", completed_at: 1_790_000_001, duration_ms: 1000 });
  }
  item(turn: string | null, item: Record<string, unknown>): this {
    return this.rec("event_msg", { type: "item_completed", thread_id: TID, ...(turn ? { turn_id: turn } : {}), started_at_ms: 1_790_000_000_100, completed_at_ms: 1_790_000_000_200, item });
  }
  user(turn: string, id: string, text: string): this {
    return this.item(turn, { type: "UserMessage", id, client_id: null, content: [{ type: "text", text, text_elements: [] }] });
  }
  agent(turn: string, id: string, text: string): this {
    return this.item(turn, { type: "AgentMessage", id, content: [{ type: "Text", text }], phase: "final_answer" });
  }
  noise(): this {
    return this.rec("response_item", { type: "message", role: "assistant", content: [] }).rec("event_msg", { type: "token_count", info: null });
  }
  /** One plain turn: start, a question, an answer, the end. */
  turn(n: number): this {
    return this.start(`t${n}`, 1_790_000_000 + n).user(`t${n}`, `u${n}`, `q${n}`).noise().agent(`t${n}`, `a${n}`, `r${n}`).complete(`t${n}`);
  }
  text(): string {
    return this.lines.map((l) => `${l}\n`).join("");
  }
}

function tmpHome(t: { after: (fn: () => void) => void }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rollout-fb-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function write(home: string, day: string, name: string, text: string): string {
  const dir = path.join(home, "sessions", "2026", ...day.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, text);
  return f;
}

/** Every turn, oldest first, and how many pages it took. */
async function readAll(h: RolloutHistory, limit: number): Promise<{ turns: Turn[]; pages: number; cursors: Array<string | null> }> {
  const turns: Turn[] = [];
  const cursors: Array<string | null> = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await h.page(cursor, limit);
    assert.ok(page.data.length <= limit, "a page holds at most `limit` turns");
    turns.unshift(...[...page.data].reverse());
    cursor = page.nextCursor;
    cursors.push(cursor);
    pages++;
  } while (cursor);
  return { turns, pages, cursors };
}

const ids = (turns: Turn[]): string[] => turns.map((t) => t.id);
const itemIds = (t: Turn | undefined): string[] => (t ? t.items.map((i) => i.id) : []);

test("pages run newest first and reach every turn at any page size; the last page has no cursor", async (t) => {
  const home = tmpHome(t);
  const r = new Rollout().meta();
  for (let n = 1; n <= 5; n++) r.turn(n);
  const f = write(home, "09/23", `rollout-2026-09-23T20-06-19-${TID}.jsonl`, r.text());

  for (const [limit, pages] of [
    [1, 5],
    [2, 3],
    [5, 1],
    [50, 1],
  ] as const) {
    const all = await readAll(openRolloutHistory({ path: f, threadId: TID }), limit);
    assert.deepEqual(ids(all.turns), ["t1", "t2", "t3", "t4", "t5"], `limit ${limit}`);
    assert.equal(all.pages, pages, `limit ${limit}: no empty page at the start of the file`);
    assert.ok(all.cursors.slice(0, -1).every(isRolloutCursor));
  }

  const h = openRolloutHistory({ path: f, threadId: TID });
  const first = await h.page(null, 2);
  assert.deepEqual(ids(first.data), ["t5", "t4"], "newest first, like thread/turns/list desc");
  assert.ok(h.stats().unreadBytes > 0);
  const t5 = first.data[0]!;
  assert.deepEqual(
    { ...t5, items: itemIds(t5) },
    { id: "t5", rootTurnId: "t5", items: ["u5", "a5"], itemsView: "full", status: "completed", error: null, startedAt: 1_790_000_005, completedAt: 1_790_000_005, durationMs: 5000 },
  );
  let cursor = first.nextCursor;
  while (cursor) cursor = (await h.page(cursor, 2)).nextCursor;
  const s = h.stats();
  assert.equal(s.unreadBytes, 0);
  assert.equal(s.records, r.lines.length, "every record consumed once");
  assert.deepEqual(s.mappedItems, { UserMessage: 5, AgentMessage: 5 });
  assert.deepEqual(s.unknownItems, {});
  assert.deepEqual(s.droppedItems, {});
  assert.equal(s.ignoredRecords["response_item"], 5);
  assert.equal(s.ignoredRecords["event_msg/token_count"], 5);
  assert.deepEqual(s.usedRecords, { session_meta: 1, "event_msg/task_started": 5, "event_msg/item_completed": 10, "event_msg/task_complete": 5 });
  assert.match(rolloutStatsLine("codex:.codex:x", s), /items mapped .*ignored .*response_item/);

  // The newest page read again (a re-read after a reconnect) counts again.
  await h.page(null, 2);
  assert.equal(h.stats().mappedItems.UserMessage, 7);
});

test("turn status: completed, aborted and unended turns interrupted, a completion with an error failed", async (t) => {
  const home = tmpHome(t);
  const r = new Rollout()
    .meta()
    .turn(1)
    .start("t2")
    .user("t2", "u2", "q")
    .abort("t2")
    .start("t3")
    .user("t3", "u3", "q")
    .start("t4")
    .user("t4", "u4", "q")
    .complete("t4", { error: { message: "limit", codex_error_info: "usage_limit_exceeded" } });
  const f = write(home, "09/23", `rollout-x-${TID}.jsonl`, r.text());
  const { turns } = await readAll(openRolloutHistory({ path: f, threadId: TID }), 10);
  assert.deepEqual(
    turns.map((x) => [x.id, x.status, x.completedAt]),
    [
      ["t1", "completed", 1_790_000_005],
      ["t2", "interrupted", 1_790_000_001],
      ["t3", "interrupted", null],
      ["t4", "failed", 1_790_000_005],
    ],
  );
  assert.deepEqual(turns[3]!.error, { message: "limit", codexErrorInfo: "usageLimitExceeded", additionalDetails: null, misalignment: null });
});

test("an item of an older turn written after a newer turn started stays with its turn across a page cut", async (t) => {
  const home = tmpHome(t);
  const r = new Rollout().meta().start("t1").user("t1", "u1", "q1").complete("t1").start("t2").user("t2", "u2", "q2").agent("t1", "late1", "from t1").agent("t2", "a2", "r2").complete("t2");
  const f = write(home, "09/23", `rollout-x-${TID}.jsonl`, r.text());
  const h = openRolloutHistory({ path: f, threadId: TID });
  const p1 = await h.page(null, 1);
  assert.deepEqual(ids(p1.data), ["t2"]);
  assert.deepEqual(itemIds(p1.data[0]), ["u2", "a2"]);
  const p2 = await h.page(p1.nextCursor, 1);
  assert.deepEqual(ids(p2.data), ["t1"]);
  assert.deepEqual(itemIds(p2.data[0]), ["u1", "late1"], "file order within the turn");
  assert.equal(p2.nextCursor, null);
  // A cursor read again (a retried loadOlder) gives the same page from the same carried state.
  assert.deepEqual(itemIds((await h.page(p1.nextCursor, 1)).data[0]), ["u1", "late1"]);
  assert.deepEqual(h.stats().droppedItems, {}, "the retry did not meet records the first read left in the saved state");
});

test("thread_rolled_back drops that many turns before it", async (t) => {
  const home = tmpHome(t);
  const r = new Rollout().meta().turn(1).turn(2).turn(3).rec("event_msg", { type: "thread_rolled_back", num_turns: 2 }).turn(4);
  const f = write(home, "09/23", `rollout-x-${TID}.jsonl`, r.text());
  const h = openRolloutHistory({ path: f, threadId: TID });
  const { turns } = await readAll(h, 1);
  assert.deepEqual(ids(turns), ["t1", "t4"]);
  assert.deepEqual(h.stats().droppedItems, { "rolledBack|userMessage": 2, "rolledBack|agentMessage": 2 });
});

test("a later record of the same item wins, at the place of its first record", async (t) => {
  const home = tmpHome(t);
  const r = new Rollout().meta().start("t1").agent("t1", "a1", "draft").user("t1", "u1", "q").agent("t1", "a1", "final").complete("t1");
  const f = write(home, "09/23", `rollout-x-${TID}.jsonl`, r.text());
  const h = openRolloutHistory({ path: f, threadId: TID });
  const { turns } = await readAll(h, 5);
  const items = turns[0]!.items;
  assert.deepEqual(itemIds(turns[0]), ["a1", "u1"]);
  assert.equal(items[0]!.type === "agentMessage" && items[0]!.text, "final");
  assert.deepEqual(h.stats().droppedItems, { "superseded|AgentMessage": 1 });
});

test("unknown item types reach the projection as unknown rows; items before any turn start are dropped and counted", async (t) => {
  const home = tmpHome(t);
  const r = new Rollout().meta().user("t0", "orphan", "no start").item(null, { type: "UserMessage", id: "noturn", content: [] }).start("t1").item("t1", { type: "Hologram", id: "h1", glow: 3 }).complete("t1");
  const f = write(home, "09/23", `rollout-x-${TID}.jsonl`, r.text());
  const h = openRolloutHistory({ path: f, threadId: TID });
  const { turns } = await readAll(h, 5);
  assert.deepEqual(ids(turns), ["t1"]);
  const s = h.stats();
  assert.deepEqual(s.unknownItems, { Hologram: 1 });
  assert.deepEqual(s.droppedItems, { "noTurnId|UserMessage": 1, "noTurnStart|userMessage": 1 });
  const mapped = mapThreadItem(turns[0]!.items[0]!, {
    threadKey: "codex:a:t",
    account: "a",
    providerThreadId: "t",
    providerInstanceId: "codex:a",
    turnId: "t1",
    turnStatus: "completed",
    lifecycle: "history",
    userMessageIndex: 0,
    fallbackAt: "2026-01-01T00:00:00.000Z",
    raw: { source: "codex-rpc", key: "k" },
  });
  assert.equal(mapped.disposition, "unknown");
  assert.equal(mapped.rows[0]!.item.type, "system_notice");
});

test("an unterminated last line is a write in progress: read on a later newest page", async (t) => {
  const home = tmpHome(t);
  const r = new Rollout().meta().turn(1).start("t2").user("t2", "u2", "q");
  const done = new Rollout(r.lines.length).complete("t2").lines[0]!;
  const f = write(home, "09/23", `rollout-x-${TID}.jsonl`, r.text() + done.slice(0, 20));
  const h = openRolloutHistory({ path: f, threadId: TID });
  assert.equal((await h.page(null, 5)).data.at(0)?.status, "interrupted");
  assert.equal(h.stats().parseFailures, 0);
  fs.appendFileSync(f, `${done.slice(20)}\n`);
  assert.equal((await h.page(null, 5)).data.at(0)?.status, "completed");
});

test("history_base: the earlier rollout's records before end_ordinal_exclusive come first, also after its first line was rewritten", async (t) => {
  for (const rewritten of [false, true]) {
    const home = tmpHome(t);
    const base = new Rollout().meta().turn(1).turn(2);
    const cut = base.lines.length;
    base.start("tx").user("tx", "ux", "superseded");
    const baseText = base.text();
    const endByte = Buffer.byteLength(new Rollout().meta().turn(1).turn(2).text());
    const baseFile = write(home, "10/28", `rollout-2026-10-28T23-27-41-${TID}.jsonl`, baseText);
    if (rewritten) {
      // A cwd edit in the first line moves every later record.
      const lines = baseText.split("\n");
      lines[0] = lines[0]!.replace('"cwd":"/work/p"', '"cwd":"/work/extra/tools/p"');
      fs.writeFileSync(baseFile, lines.join("\n"));
    }
    const cur = new Rollout(cut + 3).meta({ history_base: { thread_id: TID, end_ordinal_exclusive: cut, end_byte_offset: endByte } }).turn(3).turn(4);
    const f = write(home, "11/01", `rollout-2026-11-01T16-48-03-${TID}_${SEG}.jsonl`, cur.text());
    const h = openRolloutHistory({ path: f, threadId: TID });
    const { turns } = await readAll(h, 1);
    assert.deepEqual(ids(turns), ["t1", "t2", "t3", "t4"], `rewritten=${rewritten}`);
    const s = h.stats();
    assert.equal(s.segments.length, 2);
    assert.equal(s.segments[0]!.path, baseFile);
    assert.equal(s.segments[0]!.recordedEndOffset, endByte);
    assert.equal(s.segments[0]!.endOffset, rewritten ? endByte + "extra/tools/".length : endByte);
    assert.equal(s.unresolvedBase, null);
  }
});

test("a history_base whose file is missing: the current rollout is served and the gap is reported", async (t) => {
  const home = tmpHome(t);
  const cur = new Rollout(100).meta({ history_base: { thread_id: "01a1ffff-0000-7000-8000-00000000ffff", end_ordinal_exclusive: 100, end_byte_offset: 5000 } }).turn(3);
  const f = write(home, "11/01", `rollout-x-${TID}_${SEG}.jsonl`, cur.text());
  const h = openRolloutHistory({ path: f, threadId: TID });
  assert.deepEqual(ids((await readAll(h, 5)).turns), ["t3"]);
  assert.equal(h.stats().unresolvedBase?.endOrdinalExclusive, 100);
  assert.match(rolloutStatsLine("k", h.stats()), /history_base not found/);
});

// ---- the thread view with a daemon that serves no turns ----

const ACCOUNT = "acct";
const KEY = `codex:${ACCOUNT}:${TID}`;
const ALLOWED = new Set(["initialize", "thread/read", "thread/goal/get", "thread/resume", "thread/turns/list", "thread/unsubscribe"]);

function texts(rows: OrchestrationV2ProjectedTurnItem[]): string[] {
  return rows.map((r) => (r.item.type === "user_message" || r.item.type === "assistant_message" ? r.item.text : r.item.type));
}

async function viewRig(
  t: { after: (fn: () => Promise<void> | void) => void },
  opts: { thread?: Partial<Thread>; daemonTurns?: () => Turn[]; rollout?: string },
) {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  d.threads.set(TID, makeThread(TID, { status: { type: "notLoaded" }, ...(opts.rollout ? { path: opts.rollout } : {}), ...opts.thread }));
  const turns = opts.daemonTurns ?? (() => []);
  d.handlers.set("thread/turns/list", (p) => {
    const desc = [...turns()].reverse();
    const start = typeof p.cursor === "string" ? Number(p.cursor) : 0;
    const size = typeof p.limit === "number" ? p.limit : 25;
    const data = desc.slice(start, start + size);
    return { data, nextCursor: start + data.length < desc.length ? String(start + data.length) : null, backwardsCursor: null };
  });
  d.handlers.set("thread/resume", (p) => {
    const th = d.threads.get(String(p.threadId))!;
    return { thread: th, model: "m", modelProvider: "openai", cwd: th.cwd, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
  });
  d.handlers.set("thread/unsubscribe", () => ({ status: "unsubscribed" }));
  await d.listen();
  const rpc = await connect(d.home, { backoff: { initialMs: 10, maxMs: 40 }, connectTimeoutMs: 2000 });
  t.after(() => rpc.close());
  const opened: string[] = [];
  const logged: number[] = [];
  const view = createCodexThreadView({
    rpc,
    account: ACCOUNT,
    threadId: TID,
    readonly: true,
    requestTimeoutMs: 2000,
    rolloutHistory: (th) => {
      opened.push(th.path ?? "");
      return th.path ? openRolloutHistory({ path: th.path, threadId: th.id }) : null;
    },
    onRolloutPage: (s) => logged.push(s.pages),
  });
  t.after(() => view.close());
  return { d, view, opened, logged };
}

function assertOnlyAllowedCalls(d: FakeDaemon): void {
  for (const r of d.received) {
    if (r.method === null || r.id === null) continue;
    assert.ok(ALLOWED.has(r.method), `the view called ${r.method}`);
  }
}

test("view: a paginated thread the daemon serves without turns is drawn from its rollout, older pages included", async (t) => {
  const home = tmpHome(t);
  const r = new Rollout().meta();
  for (let n = 1; n <= 3; n++) r.turn(n);
  const f = write(home, "09/23", `rollout-x-${TID}.jsonl`, r.text());
  const { d, view, opened, logged } = await viewRig(t, { rollout: f });

  const snap = await view.load({ pageSize: 2 });
  assert.deepEqual(opened, [f]);
  assert.deepEqual(texts(snap.visibleTurnItems), ["q2", "r2", "q3", "r3"]);
  assert.equal(snap.runs.length, 2);
  assert.equal(snap.hasMoreBefore, true);
  assert.ok(snap.visibleTurnItems.every((row) => row.x?.raw[0]?.conn === "rollout"), "rows say they came from the rollout");
  assert.equal(d.calls("thread/resume").length, 0, "a notLoaded thread is not resumed");

  await view.loadOlder();
  const after = view.snapshot();
  assert.deepEqual(texts(after.visibleTurnItems), ["q1", "r1", "q2", "r2", "q3", "r3"]);
  assert.equal(after.hasMoreBefore, false);
  assert.equal(d.calls("thread/turns/list").length, 1, "older pages come from the rollout");
  assert.deepEqual(logged, [1, 2]);
  const st = view.stats();
  assert.equal(st.rollout?.turns, 3);
  assert.equal(st.calls["rollout/page"], 2);
  assertOnlyAllowedCalls(d);
});

test("view: a thread the daemon serves with turns, a legacy thread and a thread without a path do not read a rollout", async (t) => {
  const home = tmpHome(t);
  const f = write(home, "09/23", `rollout-x-${TID}.jsonl`, new Rollout().meta().turn(1).text());
  const daemonTurn: Turn = { ...(await openRolloutHistory({ path: f, threadId: TID }).page(null, 5)).data[0]! };

  const served = await viewRig(t, { rollout: f, daemonTurns: () => [daemonTurn] });
  const s1 = await served.view.load({ pageSize: 5 });
  assert.deepEqual(served.opened, []);
  assert.ok(s1.visibleTurnItems.every((row) => row.x?.raw[0]?.conn === "thread/turns/list"));

  const legacy = await viewRig(t, { rollout: f, thread: { historyMode: "legacy" } });
  assert.equal((await legacy.view.load({ pageSize: 5 })).visibleTurnItems.length, 0);
  assert.deepEqual(legacy.opened, []);

  const noPath = await viewRig(t, {});
  assert.equal((await noPath.view.load({ pageSize: 5 })).visibleTurnItems.length, 0);
  assert.deepEqual(noPath.opened, []);
});

test("view: a missing rollout leaves the daemon's empty answer and records the error", async (t) => {
  const home = tmpHome(t);
  const { view } = await viewRig(t, { rollout: path.join(home, "gone.jsonl") });
  const snap = await view.load({ pageSize: 5 });
  assert.equal(snap.visibleTurnItems.length, 0);
  assert.equal(view.stats().errors, 1);
});

test("view: once the daemon holds the thread, the re-read takes its turns, new ones included, and older rollout pages still load", async (t) => {
  const home = tmpHome(t);
  const r = new Rollout().meta();
  for (let n = 1; n <= 3; n++) r.turn(n);
  const f = write(home, "09/23", `rollout-x-${TID}.jsonl`, r.text());
  // What the daemon serves after it loads the thread: the same turns (same ids) and a new one.
  const fromRollout = (await readAll(openRolloutHistory({ path: f, threadId: TID }), 10)).turns;
  const newTurn: Turn = { ...fromRollout[2]!, id: "t4", rootTurnId: "t4", items: [{ type: "userMessage", id: "u4", clientId: null, content: [{ type: "text", text: "q4", text_elements: [] }] }] };
  let daemonTurns: Turn[] = [];
  const { d, view } = await viewRig(t, { rollout: f, daemonTurns: () => daemonTurns });

  const snap = await view.load({ pageSize: 2 });
  assert.deepEqual(texts(snap.visibleTurnItems), ["q2", "r2", "q3", "r3"]);

  daemonTurns = [...fromRollout, newTurn];
  d.threads.get(TID)!.status = { type: "idle" };
  d.notify("thread/status/changed", { threadId: TID, status: { type: "idle" } });
  await waitFor(() => texts(view.snapshot().visibleTurnItems).includes("q4"), "the new turn");
  const now = view.snapshot();
  assert.deepEqual(texts(now.visibleTurnItems), ["q2", "r2", "q3", "r3", "q4"]);
  // The re-read pages back until it meets a held turn (t3); those rows now come from the daemon.
  assert.deepEqual(
    now.visibleTurnItems.map((row) => row.x?.raw.at(-1)?.conn),
    ["rollout", "rollout", "thread/turns/list", "thread/turns/list", "thread/turns/list"],
  );
  assert.equal(d.calls("thread/resume").length, 1, "subscribed once the daemon held the thread");

  await view.loadOlder();
  assert.deepEqual(texts(view.snapshot().visibleTurnItems), ["q1", "r1", "q2", "r2", "q3", "r3", "q4"]);
  assertOnlyAllowedCalls(d);
});
