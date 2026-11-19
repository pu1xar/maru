import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RenameSession, ServerMessage } from "@maru/shared";
import { SessionIndex } from "../index/store.ts";
import { ProjectStore } from "../projects/store.ts";
import { ChosenStore } from "../state/chosen.ts";
import { SessionChoiceStore } from "../state/sessionChoices.ts";
import { CodexHeldStore } from "../state/codexHeld.ts";
import { DaemonError, FakeDaemon, makeThread, waitFor } from "../codex/fake-daemon.ts";
import type { Thread } from "../codex/protocol/v2/Thread.ts";
import { CodexRuns, askResult, askView } from "./codexRuns.ts";

type Pending = Extract<ServerMessage, { type: "session.pending" }>;

/**
 * A FakeDaemon that runs threads and turns the way the real one answers them (measured on
 * codex-cli 0.169.0): turn/start on a thread with an active turn joins that turn, turn/steer
 * checks expectedTurnId, turn/interrupt ends the turn as interrupted.
 */
async function rig(t: { after: (fn: () => Promise<void>) => void }) {
  const d = FakeDaemon.create();
  await d.listen();
  const account = { id: "cx", home: d.home };
  const index = new SessionIndex();
  const chosen = new ChosenStore(":memory:");
  const projects = new ProjectStore(":memory:");
  const owned = new Set<string>();
  const ownerChanges: string[] = [];
  const sent: ServerMessage[] = [];
  let openFiles = new Set<string>();
  const renamed: RenameSession[] = [];
  const held = new CodexHeldStore(":memory:");
  /** A CodexRuns on this daemon; a second one with its own `owned` and `held` stands for this server after a restart. */
  const make = (o: { owned: Set<string>; held: CodexHeldStore }) => new CodexRuns({
    accounts: [account], index, chosen, projects, owned: o.owned, choices: new SessionChoiceStore(":memory:"), held: o.held,
    ownerChanged: (_a, id) => ownerChanges.push(id),
    broadcast: (m) => sent.push(m),
    rename: async (req) => {
      renamed.push(req);
      return { ok: true, name: req.name.trim(), stored: "daemon" };
    },
    codexOpenFiles: async () => openFiles,
    readyPollMs: 5,
  });
  const runs = make({ owned, held });
  const others: CodexRuns[] = [];
  t.after(async () => {
    await runs.closeAll();
    for (const o of others) await o.closeAll();
    await d.cleanup();
  });

  let seq = 0;
  const active = new Map<string, string>();
  /** thread -> the root turn of the review running on it. */
  const reviewRoot = new Map<string, string>();
  const turn = (id: string, status: string) => ({ id, rootTurnId: id, items: [], itemsView: "notLoaded", status, error: null, startedAt: null, completedAt: null, durationMs: null });
  const setStatus = (threadId: string, status: Thread["status"]) => {
    const th = d.threads.get(threadId);
    if (th) th.status = status;
    d.notify("thread/status/changed", { threadId, status });
  };
  const begin = (threadId: string, prefix: string): string => {
    const id = `${prefix}-${++seq}`;
    active.set(threadId, id);
    setImmediate(() => {
      setStatus(threadId, { type: "active", activeFlags: [] });
      d.notify("turn/started", { threadId, turn: turn(id, "inProgress") });
    });
    return id;
  };
  d.handlers.set("thread/start", (p) => {
    const th = makeThread(crypto.randomUUID(), { cwd: String(p.cwd), status: { type: "idle" } });
    d.threads.set(th.id, th);
    setImmediate(() => d.notify("thread/started", { thread: th }));
    return { thread: th, model: String(p.model ?? "m"), modelProvider: "openai", serviceTier: null, disabledPluginIds: [], cwd: th.cwd, instructionSources: [], approvalPolicy: p.approvalPolicy, approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, reasoningEffort: null };
  });
  d.handlers.set("thread/resume", (p) => {
    const th = d.threads.get(String(p.threadId));
    if (!th) throw new DaemonError(-32600, `no rollout found for thread id ${String(p.threadId)}`);
    if (th.status.type === "notLoaded") th.status = { type: "idle" };
    snapshotOwed.add(th.id);
    return { thread: th };
  });
  d.handlers.set("turn/start", (p) => {
    const threadId = String(p.threadId);
    const cur = active.get(threadId);
    return { turn: turn(cur ?? begin(threadId, "turn"), "inProgress") };
  });
  d.handlers.set("turn/steer", (p) => {
    const cur = active.get(String(p.threadId));
    if (!cur) throw new DaemonError(-32600, "no active turn to steer");
    // During a review the daemon compares with the review's root turn (measured 2026-11-16).
    const steerable = reviewRoot.get(String(p.threadId)) ?? cur;
    if (steerable !== p.expectedTurnId) throw new DaemonError(-32600, `expected active turn id \`${String(p.expectedTurnId)}\` but found \`${steerable}\``);
    if (reviewRoot.has(String(p.threadId))) throw new DaemonError(-32600, "cannot steer a review turn");
    return { turnId: cur };
  });
  d.handlers.set("turn/interrupt", (p) => {
    if (!active.has(String(p.threadId))) throw new DaemonError(-32600, "no active turn to interrupt");
    setImmediate(() => complete(String(p.threadId), "interrupted"));
    return {};
  });
  d.handlers.set("thread/unsubscribe", () => ({ status: "unsubscribed" }));
  d.handlers.set("thread/turns/list", () => ({ data: [], nextCursor: null, backwardsCursor: null }));
  // Slash command methods, shaped as measured on codex-cli 0.169.0 (2026-11-16).
  d.handlers.set("thread/compact/start", (p) => {
    // The answer names no turn; the compaction turn starts right after.
    begin(String(p.threadId), "compact");
    return {};
  });
  d.handlers.set("review/start", (p) => {
    // The answer names the review turn; the work runs in an inner turn under it.
    const threadId = String(p.threadId);
    const root = `review-${++seq}`;
    const inner = `inner-${seq}`;
    active.set(threadId, inner);
    reviewRoot.set(threadId, root);
    // The inner turn's start can reach the client before the answer (seen on the real daemon).
    setStatus(threadId, { type: "active", activeFlags: [] });
    d.notify("turn/started", { threadId, turn: { ...turn(inner, "inProgress"), rootTurnId: root } });
    return { turn: { ...turn(root, "inProgress"), rootTurnId: null }, reviewThreadId: threadId };
  });
  const goals = new Map<string, Record<string, unknown>>();
  const snapshotOwed = new Set<string>();
  d.handlers.set("thread/goal/get", (p) => ({ goal: goals.get(String(p.threadId)) ?? null }));
  d.handlers.set("thread/goal/set", (p) => {
    const threadId = String(p.threadId);
    const prev = goals.get(threadId);
    // A resume makes the real daemon send a snapshot of the goal (thread/goal/cleared when there is
    // none), queued ahead of anything a later request causes: it reaches the client after the resume's
    // answer and before this request's answer (measured 2026-11-16, 0.169.0).
    if (snapshotOwed.delete(threadId)) {
      if (prev) d.notify("thread/goal/updated", { threadId, turnId: null, goal: prev });
      else d.notify("thread/goal/cleared", { threadId });
    }
    // The real daemon (0.169.0, measured): a status change with no objective needs a goal.
    if (!prev && p.objective == null) throw new DaemonError(-32600, `cannot update goal for thread ${threadId}: no goal exists`);
    const goal = {
      threadId, objective: p.objective ?? prev?.objective ?? "", status: p.status ?? "active",
      tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2,
    };
    goals.set(threadId, goal);
    d.notify("thread/goal/updated", { threadId, turnId: null, goal });
    // An active goal on an idle thread: the daemon starts a turn of its own to pursue it.
    if (goal.status === "active" && !active.has(threadId)) begin(threadId, "goalturn");
    return { goal };
  });
  d.handlers.set("thread/goal/clear", (p) => {
    const threadId = String(p.threadId);
    const had = goals.delete(threadId);
    d.notify("thread/goal/cleared", { threadId });
    return { cleared: had };
  });
  d.handlers.set("thread/fork", (p) => {
    const src = d.threads.get(String(p.threadId))!;
    const th = makeThread(crypto.randomUUID(), { cwd: src.cwd, status: { type: "idle" }, forkedFromId: src.id });
    d.threads.set(th.id, th);
    setImmediate(() => d.notify("thread/started", { thread: th }));
    return { thread: th, model: "m", modelProvider: "openai", serviceTier: null, disabledPluginIds: [], cwd: th.cwd, instructionSources: [], approvalPolicy: p.approvalPolicy, approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, reasoningEffort: null };
  });
  // model/list in two pages, as the daemon pages it.
  const model = (id: string, isDefault: boolean) => ({
    id, model: id, upgrade: null, upgradeInfo: null, availabilityNux: null, displayName: id.toUpperCase(), description: "d", modelSpecialty: null,
    hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "high", description: "" }],
    defaultReasoningEffort: "high", inputModalities: [], supportsPersonality: false, multiAgentVersion: null, additionalSpeedTiers: [],
    serviceTiers: [], defaultServiceTier: null, availableAccessPrograms: null, isDefault,
  });
  d.handlers.set("model/list", (p) => (p.cursor === "2"
    ? { data: [model("gpt-small", false)], nextCursor: null }
    : { data: [model("gpt-big", true)], nextCursor: "2" }));
  d.handlers.set("skills/list", (p) => ({
    data: (p.cwds as string[]).map((cwd) => ({
      cwd,
      skills: [
        { name: "on", description: "long", shortDescription: "short", path: "/s/on/SKILL.md", scope: "user", enabled: true, pluginId: null },
        { name: "off", description: "x", path: "/s/off/SKILL.md", scope: "user", enabled: false, pluginId: null },
      ],
      errors: [],
    })),
  }));
  /** A turn the daemon starts on its own (a goal's next turn, or one no client of this rig asked for). */
  const daemonTurn = (threadId: string) => begin(threadId, "daemon");
  const complete = (threadId: string, status = "completed") => {
    const id = active.get(threadId);
    if (!id) return;
    active.delete(threadId);
    // A review ends with the turn/completed of its root turn.
    const root = reviewRoot.get(threadId);
    reviewRoot.delete(threadId);
    d.notify("turn/completed", { threadId, turn: turn(root ?? id, status) });
    setStatus(threadId, { type: "idle" });
  };
  /** A turn another client starts (a TUI typing into the thread). */
  const foreignTurn = (threadId: string) => begin(threadId, "foreign");
  const pendings = () => sent.filter((m): m is Pending => m.type === "session.pending");
  const lastPending = () => pendings().at(-1);

  const create = async (prompt = "hi") => {
    const key = await runs.create({ account: "cx", cwd: os.tmpdir(), prompt, projectId: null });
    const threadId = key.split(":")[2]!;
    await waitFor(() => active.has(threadId), "turn started");
    return { key, threadId, turnId: active.get(threadId)! };
  };
  /** This server restarted: a new CodexRuns over `store` (the same state file read again). */
  const restarted = (store: CodexHeldStore) => {
    const o = { owned: new Set<string>(), held: store };
    const next = make(o);
    others.push(next);
    return { runs: next, owned: o.owned };
  };
  return {
    d, runs, index, chosen, projects, owned, ownerChanges, sent, active, complete, foreignTurn, daemonTurn, create, pendings, lastPending,
    goals, renamed, held, restarted,
    setOpenFiles: (s: Set<string>) => { openFiles = s; },
    setStatus,
  };
}

const question = (threadId: string, turnId: string | null) => ({
  threadId, turnId, itemId: "call-1",
  questions: [{ id: "color", header: "Color", question: "Which color?", isOther: true, isSecret: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }],
  isBlocking: false, autoResolutionMs: null,
});

test("create starts a bypass thread and turn, joins the list and the project, and answers once the history can be listed", async (t) => {
  const r = await rig(t);
  let listCalls = 0;
  r.d.handlers.set("thread/turns/list", () => {
    // A new thread answers -32601 for a moment after its first turn/start (measured).
    if (++listCalls < 3) throw new DaemonError(-32601, "list_turns is not supported yet");
    return { data: [], nextCursor: null, backwardsCursor: null };
  });
  const p = r.projects.create({ name: "P" });
  const key = await r.runs.create({ account: "cx", cwd: os.tmpdir(), prompt: "hello", projectId: p.id, model: "gpt-6-luna" });
  const threadId = key.split(":")[2]!;
  assert.match(key, /^codex:cx:[0-9a-f-]{36}$/);
  const start = r.d.calls("thread/start")[0]!.params;
  assert.deepEqual(start, {
    cwd: os.tmpdir(), model: "gpt-6-luna", approvalPolicy: "never", sandbox: "danger-full-access",
    config: { "features.default_mode_request_user_input": true },
  });
  const turnStart = r.d.calls("turn/start")[0]!.params;
  assert.deepEqual(turnStart, {
    threadId, input: [{ type: "text", text: "hello", text_elements: [] }],
    approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
  });
  assert.equal(listCalls, 3, "waited until the history could be listed");
  assert.equal(r.chosen.has("codex", threadId), true);
  assert.equal(r.projects.projectOf("codex", threadId), p.id);
  assert.equal(r.owned.has(threadId), true);
  assert.ok(r.ownerChanges.includes(threadId));
  await assert.rejects(r.runs.create({ account: "nope", cwd: os.tmpdir(), prompt: "x", projectId: null }), /Unknown account/);
  await assert.rejects(r.runs.create({ account: "cx", cwd: "/no/such/dir", prompt: "x", projectId: null }), /[Ww]orking folder/);
});

test("a question of this server's turn goes to the UI, and the answer goes back in the daemon's shape", async (t) => {
  const r = await rig(t);
  const { key, threadId, turnId } = await r.create();
  const { id, reply } = r.d.serverRequest("item/tool/requestUserInput", question(threadId, turnId));
  await waitFor(() => (r.lastPending()?.questions.length ?? 0) === 1, "question published");
  const view = r.lastPending()!.questions[0]!;
  assert.equal(r.lastPending()!.key, key);
  assert.equal(view.requestId, id);
  assert.equal(view.kind, "question");
  assert.equal(view.toolName, "request_user_input");
  assert.deepEqual((view.input as { questions: unknown[] }).questions, [
    { question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }], isOther: true, isSecret: false },
  ]);
  assert.deepEqual(r.runs.allPending().map((x) => x.key), [key]);
  r.runs.answer(key, id, { "Which color?": "Blue" });
  assert.deepEqual((await reply).result, { answers: { color: { answers: ["Blue"] } } });
  assert.equal(r.lastPending()!.questions.length, 0);
  assert.throws(() => r.runs.answer(key, id, {}), /already ended/);
});

test("requests of turns this server did not start get no answer and never reach the UI", async (t) => {
  const r = await rig(t);
  const { key, threadId, turnId } = await r.create();
  // Another turn id on a driven thread, and a thread this server does not drive at all.
  const other = makeThread(crypto.randomUUID(), { status: { type: "active", activeFlags: [] } });
  r.d.threads.set(other.id, other);
  const foreignTurn = r.d.serverRequest("item/tool/requestUserInput", question(threadId, "turn-of-a-tui"));
  const foreignThread = r.d.serverRequest("item/commandExecution/requestApproval", {
    kind: "command", threadId: other.id, turnId: "t9", itemId: "i9", startedAtMs: 0, environmentId: null, command: "rm -rf x",
  });
  const toolCall = r.d.serverRequest("item/tool/call", { threadId: other.id, turnId: "t9", callId: "c", namespace: null, tool: "x", arguments: {} });
  // Then one of this server's own: once it is published, the earlier ones have been decided.
  const own = r.d.serverRequest("item/tool/requestUserInput", question(threadId, turnId));
  await waitFor(() => (r.lastPending()?.questions.length ?? 0) === 1, "own question published");
  assert.deepEqual(r.lastPending()!.questions.map((q) => q.requestId), [own.id]);
  r.runs.answer(key, own.id, { "Which color?": "Red" });
  await own.reply;
  assert.deepEqual(r.d.repliesTo(foreignTurn.id), []);
  assert.deepEqual(r.d.repliesTo(foreignThread.id), []);
  assert.deepEqual(r.d.repliesTo(toolCall.id), []);
  assert.ok(r.pendings().every((m) => m.key === key && m.questions.every((q) => q.requestId === own.id)));
});

test("a turn another client starts on a driven thread ends this server's hold on it", async (t) => {
  const r = await rig(t);
  const { key, threadId } = await r.create();
  r.complete(threadId);
  const foreign = r.foreignTurn(threadId);
  await waitFor(() => !r.owned.has(threadId), "ownership released");
  assert.equal(r.ownerChanges.filter((x) => x === threadId).length >= 2, true);
  await waitFor(() => r.d.calls("thread/unsubscribe").some((c) => c.params.threadId === threadId), "unsubscribed");
  // While that turn runs the UI may only watch.
  await assert.rejects(r.runs.send(key, "mine"), /another client/);
  await assert.rejects(r.runs.interrupt(key), /not run by this server/);
  assert.equal(r.d.calls("turn/start").length, 1);
  assert.equal(r.d.calls("turn/steer").length, 0);
  const req = r.d.serverRequest("item/tool/requestUserInput", question(threadId, foreign));
  // After that turn ends, a send takes the thread over again.
  r.complete(threadId);
  await waitFor(() => r.d.threads.get(threadId)!.status.type === "idle", "idle");
  await r.runs.send(key, "mine now");
  assert.equal(r.owned.has(threadId), true);
  assert.equal(r.d.calls("turn/start").length, 2);
  assert.deepEqual(r.d.repliesTo(req.id), []);
});

test("a send during this server's turn steers it; after the turn it starts the next one", async (t) => {
  const r = await rig(t);
  const { key, threadId, turnId } = await r.create();
  await r.runs.send(key, "more");
  assert.deepEqual(r.d.calls("turn/steer")[0]!.params, { threadId, input: [{ type: "text", text: "more", text_elements: [] }], expectedTurnId: turnId });
  assert.equal(r.d.calls("turn/start").length, 1);
  // Whether or not the end reached this connection yet, the next message opens a new turn.
  r.complete(threadId);
  await r.runs.send(key, "next");
  assert.equal(r.d.calls("turn/start").length, 2);
  // The turn ended in the daemon before this connection heard of it: the steer fails, a turn starts.
  const second = r.active.get(threadId)!;
  r.active.delete(threadId);
  await r.runs.send(key, "late");
  assert.equal(r.d.calls("turn/steer").at(-1)!.params.expectedTurnId, second);
  assert.equal(r.d.calls("turn/start").length, 3);
  await assert.rejects(r.runs.send(key, "  "), /empty message/);
});

test("onTurnEnd reports the turn/completed of driven threads with their status and error, and only those", async (t) => {
  const r = await rig(t);
  const heard: Array<[string, string, string | null]> = [];
  const off = r.runs.onTurnEnd((key, turn) => heard.push([key, turn.status, turn.error?.message ?? null]));
  const { key, threadId, turnId } = await r.create();
  r.complete(threadId);
  await waitFor(() => heard.length === 1, "completed turn");
  assert.deepEqual(heard[0], [key, "completed", null]);
  const error = { message: "stream disconnected before completion", codexErrorInfo: null, additionalDetails: null, misalignment: null };
  r.d.notify("turn/completed", { threadId, turn: { id: turnId, rootTurnId: turnId, items: [], itemsView: "notLoaded", status: "failed", error, startedAt: null, completedAt: null, durationMs: null } });
  await waitFor(() => heard.length === 2, "failed turn");
  assert.deepEqual(heard[1], [key, "failed", "stream disconnected before completion"]);
  // A thread this server does not drive: its turn ends are not this server's to report.
  const other = crypto.randomUUID();
  r.d.notify("turn/completed", { threadId: other, turn: { id: "x", rootTurnId: "x", items: [], itemsView: "notLoaded", status: "failed", error, startedAt: null, completedAt: null, durationMs: null } });
  off();
  r.d.notify("turn/completed", { threadId, turn: { id: turnId, rootTurnId: turnId, items: [], itemsView: "notLoaded", status: "interrupted", error: null, startedAt: null, completedAt: null, durationMs: null } });
  // A later notification on the same connection arrives after both of the above.
  r.setStatus(threadId, { type: "idle" });
  await new Promise((x) => setTimeout(x, 50));
  assert.equal(heard.length, 2);
});

test("onThreadStatus passes the driver connection's statuses of driven threads, in order with their turn ends", async (t) => {
  const r = await rig(t);
  const heard: string[] = [];
  r.runs.onThreadStatus((key, status) => heard.push(`${key.split(":")[2]!.slice(-4)} status ${status.type}`));
  r.runs.onTurnEnd((key, turn) => heard.push(`${key.split(":")[2]!.slice(-4)} turn ${turn.status}`));
  const { threadId } = await r.create();
  const id = threadId.slice(-4);
  await waitFor(() => heard.includes(`${id} status active`), "active");
  r.complete(threadId);
  await waitFor(() => heard.includes(`${id} status idle`), "idle");
  // The rig's daemon sends turn/completed, then the idle status.
  assert.deepEqual(heard.filter((h) => h.startsWith(id)), [`${id} status active`, `${id} turn completed`, `${id} status idle`]);
  // Not driven: nothing. notLoaded lets the thread go, so it is not passed on either.
  r.setStatus(crypto.randomUUID(), { type: "active", activeFlags: [] });
  r.setStatus(threadId, { type: "notLoaded" });
  r.setStatus(threadId, { type: "idle" });
  await new Promise((x) => setTimeout(x, 50));
  assert.equal(heard.length, 3);
});

test("interrupt stops this server's turn; a session it does not drive is refused", async (t) => {
  const r = await rig(t);
  const { key, threadId, turnId } = await r.create();
  await r.runs.interrupt(key);
  assert.deepEqual(r.d.calls("turn/interrupt")[0]!.params, { threadId, turnId });
  await waitFor(() => !r.active.has(threadId), "interrupted");
  await assert.rejects(r.runs.interrupt(key), /No turn is running/);
  await assert.rejects(r.runs.interrupt(`codex:cx:${crypto.randomUUID()}`), /not run by this server/);
});

test("close lets a driven thread go: its running turn is interrupted, its questions end, the driver unsubscribes", async (t) => {
  const r = await rig(t);
  const { key, threadId, turnId } = await r.create();
  const ask = r.d.serverRequest("item/tool/requestUserInput", question(threadId, turnId));
  await waitFor(() => (r.lastPending()?.questions.length ?? 0) === 1, "question published");
  await r.runs.close(key);
  assert.deepEqual(r.d.calls("turn/interrupt").map((c) => c.params), [{ threadId, turnId }]);
  assert.deepEqual(r.d.calls("thread/unsubscribe").map((c) => c.params), [{ threadId }]);
  assert.equal(r.runs.isDriven(key), false);
  assert.equal(r.owned.has(threadId), false);
  assert.ok(r.ownerChanges.filter((x) => x === threadId).length >= 2, "the index hears the owner change");
  assert.equal(r.lastPending()!.questions.length, 0);
  assert.deepEqual(r.d.repliesTo(ask.id), [], "the question stays for another client");
  await assert.rejects(r.runs.close(key), /not run by this server/);

  // A later send takes it over again. A turn that ended before the driver heard of it closes too:
  // the daemon's "no active turn" answer to the interrupt is no failure.
  await waitFor(() => !r.active.has(threadId), "interrupted");
  await r.runs.send(key, "again");
  r.complete(threadId);
  await waitFor(() => r.d.threads.get(threadId)!.status.type === "idle", "idle");
  await r.runs.close(key);
  assert.equal(r.d.calls("thread/unsubscribe").length, 2);
  assert.equal(r.runs.isDriven(key), false);
});

test("a subagent thread under a driven thread: its running turn is interrupted; others are refused", async (t) => {
  const r = await rig(t);
  const { key } = await r.create();
  const child = crypto.randomUUID();
  const turnRow = (id: string, status: string) => ({ id, rootTurnId: id, items: [], itemsView: "notLoaded", status, error: null, startedAt: null, completedAt: null, durationMs: null });
  let childTurn: { id: string; status: string } | null = { id: "child-turn-1", status: "inProgress" };
  r.d.handlers.set("thread/turns/list", (p) => ({
    data: p.threadId === child && childTurn ? [turnRow(childTurn.id, childTurn.status)] : [], nextCursor: null, backwardsCursor: null,
  }));
  const under = (k: string) => k === `codex:cx:${child}`;
  r.active.set(child, "child-turn-1");
  await r.runs.interruptSubagent(key, child, under);
  assert.deepEqual(r.d.calls("turn/interrupt").at(-1)!.params, { threadId: child, turnId: "child-turn-1" });
  childTurn = { id: "child-turn-1", status: "interrupted" };
  await assert.rejects(r.runs.interruptSubagent(key, child, under), /No turn is running/);
  await assert.rejects(r.runs.interruptSubagent(key, crypto.randomUUID(), under), /Not a subagent thread/);
  await assert.rejects(r.runs.interruptSubagent(`codex:cx:${crypto.randomUUID()}`, child, under), /not run by this server/);
  assert.equal(r.runs.isDriven(key), true);
});

test("taking a thread over: idle or closed ones are resumed with a bypass turn; running, subagent and externally open ones are refused", async (t) => {
  const r = await rig(t);
  const mk = (over: Partial<Thread>) => {
    const th = makeThread(crypto.randomUUID(), over);
    r.d.threads.set(th.id, th);
    return { th, key: `codex:cx:${th.id}` };
  };
  const idle = mk({ status: { type: "idle" } });
  await r.runs.send(idle.key, "take it");
  assert.deepEqual(r.d.calls("thread/resume").map((c) => c.params.threadId), [idle.th.id]);
  assert.deepEqual(r.d.calls("turn/start")[0]!.params, {
    threadId: idle.th.id, input: [{ type: "text", text: "take it", text_elements: [] }],
    approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
  });
  assert.equal(r.owned.has(idle.th.id), true);

  const running = mk({ status: { type: "active", activeFlags: [] } });
  await assert.rejects(r.runs.send(running.key, "x"), /another client/);
  const child = mk({ status: { type: "idle" }, parentThreadId: idle.th.id });
  await assert.rejects(r.runs.send(child.key, "x"), /subagent/);
  const exec = mk({ status: { type: "notLoaded" }, path: "/rollouts/exec.jsonl" });
  r.setOpenFiles(new Set(["/rollouts/exec.jsonl"]));
  await assert.rejects(r.runs.send(exec.key, "x"), /codex process outside the daemon/);
  for (const k of [running, child, exec]) assert.equal(r.owned.has(k.th.id), false);
  assert.deepEqual(r.d.calls("thread/resume").map((c) => c.params.threadId), [idle.th.id], "refused threads were never resumed");

  const closed = mk({ status: { type: "notLoaded" }, path: "/rollouts/closed.jsonl" });
  await r.runs.send(closed.key, "resume me");
  assert.equal(r.d.calls("thread/resume").at(-1)!.params.threadId, closed.th.id);
  assert.equal(r.d.calls("turn/start").at(-1)!.params.threadId, closed.th.id);
  assert.equal(r.owned.has(closed.th.id), true);
});

test("a question answered elsewhere or cleared by the daemon leaves the UI without an answer from here", async (t) => {
  const r = await rig(t);
  const { key, threadId, turnId } = await r.create();
  const q = r.d.serverRequest("item/tool/requestUserInput", question(threadId, turnId));
  await waitFor(() => (r.lastPending()?.questions.length ?? 0) === 1, "question published");
  r.d.notify("serverRequest/resolved", { threadId, requestId: q.id });
  await waitFor(() => r.lastPending()!.questions.length === 0, "question withdrawn");
  assert.throws(() => r.runs.answer(key, q.id, { "Which color?": "Red" }), /already ended/);
  await new Promise((x) => setTimeout(x, 20));
  assert.deepEqual(r.d.repliesTo(q.id), []);
});

test("approvals of this server's turn are answered approve or reject; a malformed decision is refused", async (t) => {
  const r = await rig(t);
  const { key, threadId, turnId } = await r.create();
  const cmd = r.d.serverRequest("item/commandExecution/requestApproval", {
    kind: "command", threadId, turnId, itemId: "exec-1", startedAtMs: 0, environmentId: null, command: "touch a", cwd: "/w", reason: "needs write",
  });
  await waitFor(() => (r.lastPending()?.questions.length ?? 0) === 1, "approval published");
  const view = r.lastPending()!.questions[0]!;
  assert.equal(view.kind, "approval");
  assert.equal(view.title, "Allow running the command?");
  assert.equal(view.description, "touch a\ncwd: /w\nneeds write");
  assert.throws(() => r.runs.answer(key, cmd.id, { decision: "maybe" }), /approve.*reject/);
  r.runs.answer(key, cmd.id, { decision: "approve" });
  assert.deepEqual((await cmd.reply).result, { decision: "accept" });
  const patch = r.d.serverRequest("item/fileChange/requestApproval", { threadId, turnId, itemId: "p-1", startedAtMs: 0 });
  await waitFor(() => (r.lastPending()?.questions.length ?? 0) === 1, "file approval published");
  r.runs.answer(key, patch.id, { decision: "reject", feedback: "no" });
  assert.deepEqual((await patch.reply).result, { decision: "decline" });
  // A dynamic tool call of this server's turn is refused at once (no tools are provided here).
  const call = r.d.serverRequest("item/tool/call", { threadId, turnId, callId: "c1", namespace: "ns", tool: "read_thread_terminal", arguments: {} });
  assert.deepEqual((await call.reply).result, { contentItems: [{ type: "inputText", text: "maru does not provide the dynamic tool ns.read_thread_terminal." }], success: false });
});

test("after a dropped connection the driver resumes its threads, and the daemon's replayed question comes back", async (t) => {
  const r = await rig(t);
  const { key, threadId, turnId } = await r.create();
  const first = r.d.serverRequest("item/tool/requestUserInput", question(threadId, turnId));
  await waitFor(() => (r.lastPending()?.questions.length ?? 0) === 1, "question published");
  const conns = r.d.connections;
  r.d.handlers.set("thread/turns/list", () => ({ data: [{ id: turnId, status: "inProgress" }], nextCursor: null, backwardsCursor: null }));
  r.d.dropConnections();
  await waitFor(() => r.lastPending()!.questions.length === 0, "question dropped with the connection");
  await waitFor(() => r.d.calls("thread/resume").some((c) => c.conn > conns && c.params.threadId === threadId), "resumed on the new connection", 10_000);
  assert.equal(r.owned.has(threadId), true);
  // The daemon sends a pending request again to a connection that resumes the thread (measured).
  const again = r.d.serverRequest("item/tool/requestUserInput", question(threadId, turnId));
  await waitFor(() => (r.lastPending()?.questions.length ?? 0) === 1, "question back");
  r.runs.answer(key, again.id, { "Which color?": "Red" });
  assert.deepEqual((await again.reply).result, { answers: { color: { answers: ["Red"] } } });
  assert.deepEqual(r.d.repliesTo(first.id), []);
});

test("a restart keeps the threads this server drove: the running turn stays its own and the replayed question can be answered", async (t) => {
  const r = await rig(t);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-held-")), "state.sqlite");
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const before = new CodexHeldStore(file);
  const first = r.restarted(before);
  const key = await first.runs.create({ account: "cx", cwd: os.tmpdir(), prompt: "hi", projectId: null });
  const threadId = key.split(":")[2]!;
  await waitFor(() => r.active.has(threadId), "turn started");
  const turnId = r.active.get(threadId)!;
  r.d.serverRequest("item/tool/requestUserInput", question(threadId, turnId));
  await waitFor(() => (r.lastPending()?.questions.length ?? 0) === 1, "question published");
  assert.deepEqual(before.list().map((h) => [h.key, h.turns, h.goalByUs]), [[key, [turnId], false]]);

  // The web server stops (a deploy): its connections close, the turn runs on in the daemon.
  await first.runs.closeAll();
  before.close();
  const after = new CodexHeldStore(file);
  t.after(() => after.close());
  r.d.handlers.set("thread/turns/list", () => ({ data: [{ id: turnId, status: "inProgress", rootTurnId: turnId }], nextCursor: null, backwardsCursor: null }));
  const conns = r.d.connections;
  const next = r.restarted(after);
  const restoring = next.runs.restore();
  assert.equal(next.owned.has(threadId), true, "owned here before the daemon answers, so the index's first look says ui");
  assert.deepEqual(await restoring, { kept: 1, released: 0 });
  assert.ok(r.d.calls("thread/resume").some((c) => c.conn > conns && c.params.threadId === threadId), "resumed on the new connection");
  assert.equal(next.runs.isDriven(key), true);

  // The daemon sends the open request again to a connection that resumes the thread (measured).
  const again = r.d.serverRequest("item/tool/requestUserInput", question(threadId, turnId));
  await waitFor(() => (r.lastPending()?.questions.length ?? 0) === 1 && r.lastPending()!.questions[0]!.requestId === again.id, "question back");
  next.runs.answer(key, again.id, { "Which color?": "Blue" });
  assert.deepEqual((await again.reply).result, { answers: { color: { answers: ["Blue"] } } });
  // A send during the turn steers it: the turn is still this server's.
  await next.runs.send(key, "and more");
  assert.equal(r.d.calls("turn/steer").at(-1)!.params.expectedTurnId, turnId);
  r.complete(threadId);
  await waitFor(() => after.list()[0]?.turns.length === 0, "the ended turn leaves the row");
  await next.runs.close(key);
  assert.deepEqual(after.list(), [], "letting the thread go drops its row");
});

test("restore lets go of a thread the daemon unloaded, cannot read, or runs another client's turn on; a goal set here keeps its turns", async (t) => {
  const r = await rig(t);
  const store = new CodexHeldStore(":memory:");
  t.after(() => store.close());
  const thread = (status: Thread["status"]) => {
    const th = makeThread(crypto.randomUUID(), { status });
    r.d.threads.set(th.id, th);
    return th.id;
  };
  const unloaded = thread({ type: "notLoaded" });
  const missing = crypto.randomUUID();
  const foreign = thread({ type: "active", activeFlags: [] });
  const idle = thread({ type: "idle" });
  const goal = thread({ type: "active", activeFlags: [] });
  const newest = new Map([[foreign, { id: "tui-turn", status: "inProgress", rootTurnId: "tui-turn" }], [goal, { id: "goal-turn", status: "inProgress", rootTurnId: "goal-turn" }], [idle, { id: "old", status: "completed", rootTurnId: "old" }]]);
  r.d.handlers.set("thread/turns/list", (p) => ({ data: newest.has(String(p.threadId)) ? [newest.get(String(p.threadId))] : [], nextCursor: null, backwardsCursor: null }));
  for (const id of [unloaded, missing, foreign, idle, goal]) store.hold(`codex:cx:${id}`);
  store.addTurn(`codex:cx:${foreign}`, "my-earlier-turn");
  store.setGoal(`codex:cx:${goal}`, true);
  store.hold(`codex:gone-account:${crypto.randomUUID()}`);

  const next = r.restarted(store);
  assert.deepEqual(await next.runs.restore(), { kept: 2, released: 3 });
  assert.deepEqual([...next.owned].sort(), [idle, goal].sort());
  assert.deepEqual(store.list().map((h) => h.key).sort(), [`codex:cx:${idle}`, `codex:cx:${goal}`].sort());
  assert.deepEqual(store.list().find((h) => h.key.endsWith(goal))?.turns, ["goal-turn"], "the daemon's turn for a goal set here is this server's");
  assert.ok(!r.d.calls("thread/resume").some((c) => c.params.threadId === unloaded), "an unloaded thread is not loaded again");
  await waitFor(() => r.d.calls("thread/unsubscribe").some((c) => c.params.threadId === foreign), "the thread another client runs is left to it");
  await assert.rejects(next.runs.send(`codex:cx:${foreign}`, "x"), /another client/);
});

test("requests the daemon sends again while answering thread/resume wait for the restore's decision (a goal's new turn, no turn); ended turns leave the row", async (t) => {
  const r = await rig(t);
  const store = new CodexHeldStore(":memory:");
  t.after(() => store.close());
  const goalThread = makeThread(crypto.randomUUID(), { status: { type: "active", activeFlags: [] } });
  const ownThread = makeThread(crypto.randomUUID(), { status: { type: "active", activeFlags: [] } });
  r.d.threads.set(goalThread.id, goalThread);
  r.d.threads.set(ownThread.id, ownThread);
  store.hold(`codex:cx:${goalThread.id}`);
  store.setGoal(`codex:cx:${goalThread.id}`, true);
  store.hold(`codex:cx:${ownThread.id}`);
  store.addTurn(`codex:cx:${ownThread.id}`, "ended-while-down");
  store.addTurn(`codex:cx:${ownThread.id}`, "my-turn");
  const running = new Map([[goalThread.id, "goal-turn-2"], [ownThread.id, "my-turn"]]);
  const replays: Array<{ id: string; reply: Promise<Record<string, unknown>> }> = [];
  r.d.handlers.set("thread/resume", (p) => {
    const threadId = String(p.threadId);
    // The real daemon sends a pending request again to a connection that resumes the thread (measured).
    replays.push(r.d.serverRequest("item/tool/requestUserInput", question(threadId, threadId === goalThread.id ? "goal-turn-2" : null)));
    return { thread: r.d.threads.get(threadId)! };
  });
  r.d.handlers.set("thread/turns/list", (p) => {
    const id = running.get(String(p.threadId))!;
    return { data: [{ id, status: "inProgress", rootTurnId: id }], nextCursor: null, backwardsCursor: null };
  });
  const next = r.restarted(store);
  assert.deepEqual(await next.runs.restore(), { kept: 2, released: 0 });
  await waitFor(() => next.runs.allPending().length === 2, "both requests reach the UI");
  assert.deepEqual(store.list().find((h) => h.key.endsWith(goalThread.id))?.turns, ["goal-turn-2"]);
  assert.deepEqual(store.list().find((h) => h.key.endsWith(ownThread.id))?.turns, ["my-turn"], "a turn that ended while this server was down leaves the row");
  next.runs.answer(`codex:cx:${goalThread.id}`, replays[0]!.id, { "Which color?": "Red" });
  assert.deepEqual((await replays[0]!.reply).result, { answers: { color: { answers: ["Red"] } } });
});

test("permission and MCP elicitation requests become approvals with the daemon's result shapes", () => {
  const perm = askView("item/permissions/requestApproval", {
    threadId: "t", turnId: "u", itemId: "i", environmentId: null, startedAtMs: 0, cwd: "/w", reason: "net",
    permissions: { network: { enabled: true }, fileSystem: null },
  }, "1");
  assert.equal(perm.view.kind, "approval");
  assert.deepEqual(askResult(perm, { decision: "approve" }), { permissions: { network: { enabled: true } }, scope: "turn" });
  assert.deepEqual(askResult(perm, { decision: "reject" }), { permissions: {}, scope: "turn" });
  const url = askView("mcpServer/elicitation/request", {
    threadId: "t", turnId: null, serverName: "docs", mode: "url", _meta: null, message: "Sign in", url: "https://x", elicitationId: "e1",
  }, "2");
  assert.equal(url.view.title, "Allow the docs request?");
  assert.equal(url.view.description, "Sign in\nhttps://x");
  assert.deepEqual(askResult(url, { decision: "approve" }), { action: "accept", content: null, _meta: null });
  assert.deepEqual(askResult(url, { decision: "reject" }), { action: "decline", content: null, _meta: null });
});

test("question views keep equal question texts apart and map answers back to the question ids", () => {
  const a = askView("item/tool/requestUserInput", {
    threadId: "t", turnId: "u", itemId: "i", isBlocking: true, autoResolutionMs: null,
    questions: [
      { id: "q1", header: "A", question: "Pick one?", isOther: false, isSecret: false, options: null },
      { id: "q2", header: "B", question: "Pick one?", isOther: true, isSecret: false, options: [] },
      { id: "q3", header: "", question: "Pick one?", isOther: true, isSecret: false, options: null },
    ],
  }, "7");
  const texts = (a.view.input as { questions: Array<{ question: string }> }).questions.map((q) => q.question);
  assert.deepEqual(texts, ["Pick one?", "B: Pick one?", "Pick one? (2)"]);
  assert.deepEqual(askResult(a, { "Pick one?": "x", "B: Pick one?": " y ", "Pick one? (2)": "" }), {
    answers: { q1: { answers: ["x"] }, q2: { answers: ["y"] }, q3: { answers: [] } },
  });
});

// ---- slash commands ----

/**
 * A round trip on the driver connection. The daemon's notifications sent before it arrive before
 * its answer, so after it the driver has seen every turn start and end the rig caused so far.
 */
const barrier = (r: Awaited<ReturnType<typeof rig>>, key: string) => r.runs.send(key, "/goal");
const COMMAND_METHODS = ["thread/compact/start", "review/start", "thread/goal/set", "thread/goal/clear", "thread/fork"];

test("a path, a word after the start or a leading space goes to the model as text; another /name is refused as the TUI does", async (t) => {
  const r = await rig(t);
  const { key } = await r.create();
  const texts = ["/Users/me/notes.md 이 파일 봐 줘", "say /compact", "/review/x", " /compact"];
  for (const text of texts) assert.equal(await r.runs.send(key, text), undefined);
  // The turn this server runs takes each one as a steer, word for word.
  assert.deepEqual(r.d.calls("turn/steer").map((c) => (c.params.input as Array<{ text: string }>)[0]!.text), texts);
  // 0.169.0 answers these "Unrecognized command" and keeps the draft (chat_composer.rs).
  for (const text of ["/compactx", "/goalie", "/forks", "/renamed x", "/models gpt", "/statusx", "/memory", "/approvals", "/prompts:draft"]) {
    const res = (await r.runs.send(key, text)) as { notice: string; unsent: string };
    assert.match(res.notice, /not a Codex command/, text);
    assert.equal(res.unsent, text);
  }
  assert.equal(r.d.calls("turn/steer").length, texts.length, "none of them reached the model");
  for (const m of COMMAND_METHODS) assert.equal(r.d.calls(m).length, 0, `${m} not called`);
  assert.equal(r.d.calls("thread/goal/get").length, 0);
});

test("/model waits for this server's next turn/start, which carries the model and effort once", async (t) => {
  const r = await rig(t);
  const { key, threadId } = await r.create();
  const seen: string[] = [];
  r.runs.onChosen((k) => seen.push(k));
  const list = await r.runs.send(key, "/model");
  assert.match((list as { notice: string }).notice, /\* gpt-big: GPT-BIG, effort low\|high\n {2}gpt-small/, "both pages of model/list");
  await assert.rejects(r.runs.send(key, "/model gpt-none"), /Unknown model: gpt-none/);
  await assert.rejects(r.runs.send(key, "/model gpt-small max"), /must be one of low, high/);
  const res = await r.runs.send(key, "/model gpt-small low");
  assert.match((res as { notice: string }).notice, /Set model GPT-SMALL, effort low, applies from the next turn this server sends/);
  assert.deepEqual(r.runs.chosenOf(key), { model: "gpt-small", effort: "low", pending: true });
  assert.deepEqual(seen, [key]);
  // "auto" (null) is the model's own effort, which turn/start takes as a value.
  await r.runs.configure(key, { effort: null });
  assert.deepEqual(r.runs.chosenOf(key), { model: "gpt-small", effort: "high", pending: true });
  r.complete(threadId);
  await barrier(r, key);
  const before = r.d.calls("turn/start").length;
  await r.runs.send(key, "next");
  const start = r.d.calls("turn/start")[before]!.params;
  assert.equal(start.model, "gpt-small");
  assert.equal(start.effort, "high");
  assert.equal(r.runs.chosenOf(key), null, "used once");
  r.complete(threadId);
  await barrier(r, key);
  await r.runs.send(key, "again");
  assert.equal("model" in r.d.calls("turn/start").at(-1)!.params, false, "the daemon keeps it for the thread from then on");
  await assert.rejects(r.runs.configure(key, { permissionMode: "plan" }), /only allow changing the model and effort/);
});

test("/effort alone is checked against the model the next turn runs: the waiting pick, else the thread's own", async (t) => {
  const r = await rig(t);
  const { key, threadId } = await r.create();
  const th = r.d.threads.get(threadId)!;
  th.model = "gpt-small";
  await assert.rejects(r.runs.send(key, "/effort max"), /effort for GPT-SMALL must be one of low, high/);
  assert.equal(r.runs.chosenOf(key), null, "nothing kept");
  assert.match((await r.runs.send(key, "/effort low") as { notice: string }).notice, /^Set effort low, applies from the next turn this server sends/);
  assert.deepEqual(r.runs.chosenOf(key), { effort: "low", pending: true });
  assert.match((await r.runs.send(key, "/effort default") as { notice: string }).notice, /^Set effort high \(default\)/, "the model's own effort, which turn/start takes as a value");
  assert.match((await r.runs.send(key, "/effort") as { notice: string }).notice, /^Next turn effort: high/);
  th.model = "gpt-gone";
  await assert.rejects(r.runs.configure(key, { effort: "low" }), /model is unknown/, "an effort it cannot check is not kept");
  await r.runs.configure(key, { model: "gpt-big" });
  th.model = "gpt-gone";
  await r.runs.configure(key, { effort: "low" });
  assert.deepEqual(r.runs.chosenOf(key), { model: "gpt-big", effort: "low", pending: true }, "checked against the waiting pick");
  await assert.rejects(r.runs.configure(key, { effort: 3 as never }), /Invalid effort value/);
});

test("a pick made while turn/start is on its way stays for the next turn; what the turn carried is used up", async (t) => {
  const r = await rig(t);
  const { key, threadId } = await r.create();
  await r.runs.configure(key, { model: "gpt-small" });
  r.complete(threadId);
  await barrier(r, key);
  let release!: () => void;
  const gate = new Promise<void>((x) => (release = x));
  const start = r.d.handlers.get("turn/start")!;
  r.d.handlers.set("turn/start", async (p, conn) => {
    await gate;
    return start(p, conn);
  });
  const before = r.d.calls("turn/start").length;
  const sending = r.runs.send(key, "next");
  await waitFor(() => r.d.calls("turn/start").length > before, "turn/start sent");
  await r.runs.configure(key, { model: "gpt-big", effort: "low" });
  release();
  await sending;
  assert.equal(r.d.calls("turn/start")[before]!.params.model, "gpt-small");
  assert.deepEqual(r.runs.chosenOf(key), { model: "gpt-big", effort: "low", pending: true }, "the new pick waits for the next turn");
});

test("a TUI screen maru does not have answers a notice and reaches neither the daemon nor the model", async (t) => {
  const r = await rig(t);
  const { key } = await r.create();
  const steers = r.d.calls("turn/steer").length;
  assert.deepEqual(await r.runs.send(key, "/status"), { command: "status", notice: "/status: Not supported in maru", unsent: "/status" });
  assert.match((await r.runs.send(key, "/permissions") as { notice: string }).notice, /always bypass/);
  assert.deepEqual(await r.runs.send(key, "/clear 처음부터"), {
    command: "clear", notice: "/clear: Not supported in maru: use New session in the sidebar", unsent: "/clear 처음부터",
  });
  assert.equal((await r.runs.send(key, "/cwd") as { command: string }).command, "cwd", "an alias of /pwd");
  assert.equal(r.d.calls("turn/steer").length, steers);
});

test("/compact compacts an idle thread, and the compaction turn the daemon starts is this server's", async (t) => {
  const r = await rig(t);
  const { key, threadId } = await r.create();
  await assert.rejects(r.runs.send(key, "/compact"), /Send \/compact after/);
  await assert.rejects(r.runs.send(key, "/compact now"), /takes no arguments/);
  r.complete(threadId);
  await barrier(r, key);
  assert.deepEqual(await r.runs.send(key, "/compact  "), { command: "compact" });
  assert.deepEqual(r.d.calls("thread/compact/start").map((c) => c.params), [{ threadId }]);
  await waitFor(() => r.active.get(threadId)?.startsWith("compact-") === true, "compaction runs");
  await barrier(r, key);
  assert.equal(r.owned.has(threadId), true, "still held");
  assert.equal(r.d.calls("thread/unsubscribe").length, 0);
  // The stop button reaches it.
  const compactTurn = r.active.get(threadId)!;
  await r.runs.interrupt(key);
  assert.equal(r.d.calls("turn/interrupt").at(-1)!.params.turnId, compactTurn);
  assert.equal(r.d.calls("turn/start").length, 1, "no turn/start for the command");

  // A thread no client runs is taken over first; one another client runs is refused.
  const idle = makeThread(crypto.randomUUID(), { status: { type: "idle" } });
  r.d.threads.set(idle.id, idle);
  await r.runs.send(`codex:cx:${idle.id}`, "/compact");
  assert.equal(r.d.calls("thread/resume").at(-1)!.params.threadId, idle.id);
  assert.equal(r.d.calls("thread/compact/start").at(-1)!.params.threadId, idle.id);
  const busy = makeThread(crypto.randomUUID(), { status: { type: "active", activeFlags: [] } });
  r.d.threads.set(busy.id, busy);
  await assert.rejects(r.runs.send(`codex:cx:${busy.id}`, "/compact"), /another client/);
  assert.equal(r.d.calls("thread/compact/start").length, 2);
});

test("/review reviews the uncommitted changes, or follows its instructions; its inner turn is this server's and takes no steer", async (t) => {
  const r = await rig(t);
  const { key, threadId } = await r.create();
  r.complete(threadId);
  await barrier(r, key);
  assert.deepEqual(await r.runs.send(key, "/review"), { command: "review" });
  assert.deepEqual(r.d.calls("review/start")[0]!.params, { threadId, target: { type: "uncommittedChanges" }, delivery: "inline" });
  await waitFor(() => r.active.get(threadId)?.startsWith("inner-") === true, "review runs");
  await barrier(r, key);
  assert.equal(r.owned.has(threadId), true, "the inner turn did not end the hold");
  await assert.rejects(r.runs.send(key, "also check the tests"), /during a review/);
  assert.match(String(r.d.calls("turn/steer").at(-1)!.params.expectedTurnId), /^review-/, "a steer names the review's root turn");
  await assert.rejects(r.runs.send(key, "/review again"), /Send \/review after/);
  // The stop button names the inner turn, which the daemon takes (measured).
  await r.runs.interrupt(key);
  assert.match(String(r.d.calls("turn/interrupt").at(-1)!.params.turnId), /^inner-/);
  await waitFor(() => !r.active.has(threadId), "review stopped");
  r.complete(threadId);
  await barrier(r, key);
  await r.runs.send(key, "/review  focus on error handling\nand logging ");
  assert.deepEqual(r.d.calls("review/start")[1]!.params.target, { type: "custom", instructions: "focus on error handling\nand logging" });
});

test("/goal reads, sets, pauses and clears; the daemon's turns for a goal set here are this server's until it stops", async (t) => {
  const r = await rig(t);
  const { key, threadId } = await r.create();
  r.complete(threadId);
  await barrier(r, key);
  assert.match((await r.runs.send(key, "/goal"))!.notice!, /No goal is set/);
  await assert.rejects(r.runs.send(key, "/goal edit"), /new goal/);
  const set = await r.runs.send(key, "/goal ship the release notes");
  assert.deepEqual(r.d.calls("thread/goal/set")[0]!.params, { threadId, origin: "user", objective: "ship the release notes", status: "active" });
  assert.equal(set!.command, "goal");
  assert.match(set!.notice!, /Goal: ship the release notes\nStatus: active, tokens 0, time 0s\nCommand: \/goal pause, \/goal clear/);
  // The daemon pursues the goal with a turn of its own.
  await waitFor(() => r.active.get(threadId)?.startsWith("goalturn-") === true, "goal turn runs");
  await barrier(r, key);
  assert.equal(r.owned.has(threadId), true, "the goal's turn did not end the hold");
  await r.runs.interrupt(key);
  await waitFor(() => !r.active.has(threadId), "goal turn stopped");
  await barrier(r, key);
  assert.match((await r.runs.send(key, "/goal pause"))!.notice!, /Status: paused/);
  assert.deepEqual(r.d.calls("thread/goal/set")[1]!.params, { threadId, origin: "user", status: "paused" });
  // Not pursuing a goal set here any more: a turn the daemon starts now is another client's.
  r.daemonTurn(threadId);
  await waitFor(() => !r.owned.has(threadId), "released");
  await assert.rejects(r.runs.send(key, "/goal clear"), /another client/);
  r.complete(threadId);
  await waitFor(() => r.d.threads.get(threadId)!.status.type === "idle", "idle");
  assert.equal((await r.runs.send(key, "/goal clear"))!.notice, "Goal cleared");
  assert.deepEqual(r.d.calls("thread/goal/clear")[0]!.params, { threadId, origin: "user" });
  assert.equal((await r.runs.send(key, "/goal clear"))!.notice, "No goal to clear");
  // /goal resume holds the thread again before the daemon's next turn.
  r.goals.set(threadId, { threadId, objective: "x", status: "paused", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 });
  await r.runs.send(key, "/goal resume");
  assert.deepEqual(r.d.calls("thread/goal/set").at(-1)!.params, { threadId, origin: "user", status: "active" });
  await waitFor(() => r.active.get(threadId)?.startsWith("goalturn-") === true, "goal turn runs again");
  await barrier(r, key);
  assert.equal(r.owned.has(threadId), true);
});

test("/goal <objective> replaces the goal there is in any state by clear then set, and says so when pause or resume has no goal", async (t) => {
  const r = await rig(t);
  const { key, threadId } = await r.create();
  r.complete(threadId);
  await barrier(r, key);
  await assert.rejects(r.runs.send(key, "/goal pause"), /No goal is set/);
  await assert.rejects(r.runs.send(key, "/goal resume"), /No goal is set/);
  const goal = (status: string) => ({ threadId, objective: "old", status, tokenBudget: null, tokensUsed: 900, timeUsedSeconds: 30, createdAt: 1, updatedAt: 2 });
  let clears = 0;
  for (const status of ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]) {
    r.goals.set(threadId, goal(status));
    const res = await r.runs.send(key, `/goal new objective ${status}`);
    clears += 1;
    // Cleared first, so the old goal's usage does not carry over.
    assert.equal(r.d.calls("thread/goal/clear").length, clears, status);
    assert.deepEqual(r.d.calls("thread/goal/set").at(-1)!.params, { threadId, origin: "user", objective: `new objective ${status}`, status: "active" }, status);
    assert.match(res!.notice!, new RegExp(`Goal: new objective ${status}`), status);
  }
});

test("/goal on a thread this server does not hold yet: the goal snapshot the resume brings does not take the goal from this server", async (t) => {
  const r = await rig(t);
  const idle = makeThread(crypto.randomUUID(), { status: { type: "idle" } });
  r.d.threads.set(idle.id, idle);
  const key = `codex:cx:${idle.id}`;
  // No goal: the snapshot is thread/goal/cleared, which used to end goalByUs before the daemon's turn started.
  await r.runs.send(key, "/goal first");
  await waitFor(() => r.active.get(idle.id)?.startsWith("goalturn-") === true, "goal turn runs");
  await barrier(r, key);
  assert.equal(r.owned.has(idle.id), true, "the goal's turn is this server's, the thread stays held");
  await r.runs.interrupt(key);
  await waitFor(() => !r.active.has(idle.id), "goal turn stopped");
  // A paused goal: the snapshot is goal/updated paused; /goal resume still takes the daemon's turn.
  const other = makeThread(crypto.randomUUID(), { status: { type: "idle" } });
  r.d.threads.set(other.id, other);
  r.goals.set(other.id, { threadId: other.id, objective: "x", status: "paused", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 });
  const otherKey = `codex:cx:${other.id}`;
  await r.runs.send(otherKey, "/goal resume");
  await waitFor(() => r.active.get(other.id)?.startsWith("goalturn-") === true, "goal turn runs after resume");
  await barrier(r, otherKey);
  assert.equal(r.owned.has(other.id), true);
});

test("/fork copies an idle thread into a session this server drives, in the source's project, for the UI to open", async (t) => {
  const r = await rig(t);
  const p = r.projects.create({ name: "P" });
  const { key, threadId } = await r.create();
  r.projects.assign("codex", threadId, p.id);
  await assert.rejects(r.runs.send(key, "/fork"), /Send \/fork after/);
  r.complete(threadId);
  const res = await r.runs.send(key, "/fork");
  assert.deepEqual(r.d.calls("thread/fork")[0]!.params, {
    threadId, excludeTurns: true, approvalPolicy: "never", sandbox: "danger-full-access",
    config: { "features.default_mode_request_user_input": true },
  });
  const forkId = res!.open!.split(":")[2]!;
  assert.deepEqual(res, { command: "fork", open: `codex:cx:${forkId}` });
  assert.notEqual(forkId, threadId);
  assert.equal(r.chosen.has("codex", forkId), true);
  assert.equal(r.projects.projectOf("codex", forkId), p.id);
  assert.equal(r.owned.has(forkId), true);
  // thread/fork subscribed the driver connection: a message to the fork needs no resume.
  await r.runs.send(res!.open!, "carry on");
  assert.equal(r.d.calls("turn/start").at(-1)!.params.threadId, forkId);
  assert.equal(r.d.calls("thread/resume").some((c) => c.params.threadId === forkId), false);
});

test("forkAt copies the thread through one turn, also while a later turn runs, and joins the project", async (t) => {
  const r = await rig(t);
  const p = r.projects.create({ name: "P" });
  const { key, threadId } = await r.create();
  r.projects.assign("codex", threadId, p.id);
  // The turn is running: /fork refuses, a fork through a turn does not look at it.
  const forkKey = await r.runs.forkAt(key, "turn-1");
  assert.deepEqual(r.d.calls("thread/fork")[0]!.params, {
    threadId, lastTurnId: "turn-1", excludeTurns: true, approvalPolicy: "never", sandbox: "danger-full-access",
    config: { "features.default_mode_request_user_input": true },
  });
  const forkId = forkKey.split(":")[2]!;
  assert.notEqual(forkId, threadId);
  assert.equal(r.chosen.has("codex", forkId), true);
  assert.equal(r.projects.projectOf("codex", forkId), p.id);
  assert.equal(r.owned.has(forkId), true);
  await assert.rejects(r.runs.forkAt("claude:x:y", "turn-1"), /Not a Codex session key/);
});

test("/rename goes to the session renamer; a missing name and a subagent thread are refused", async (t) => {
  const r = await rig(t);
  const { key, threadId } = await r.create();
  const res = await r.runs.send(key, "/rename  release notes ");
  assert.deepEqual(r.renamed, [{ provider: "codex", account: "cx", id: threadId, name: "release notes" }]);
  assert.deepEqual(res, { command: "rename", notice: 'Renamed to "release notes"' });
  await assert.rejects(r.runs.send(key, "/rename"), /new name/);
  const child = `codex:cx:${crypto.randomUUID()}`;
  r.index.apply({ type: "upsert", session: { ...codexSummary(child), parentKey: key } });
  await assert.rejects(r.runs.send(child, "/rename x"), /subagent/);
  assert.equal(r.renamed.length, 1);
});

test("skills lists the enabled skills the daemon finds for the session's folder", async (t) => {
  const r = await rig(t);
  const { key } = await r.create();
  await assert.rejects(r.runs.skills(key), /[Ww]orking folder/);
  r.index.apply({ type: "upsert", session: { ...codexSummary(key), cwd: "/work/here" } });
  assert.deepEqual((await r.runs.skills(key)).map((s) => s.name), ["on"]);
  assert.deepEqual(r.d.calls("skills/list")[0]!.params, { cwds: ["/work/here"] });
  await r.runs.skills(key, { reload: true });
  assert.deepEqual(r.d.calls("skills/list")[1]!.params, { cwds: ["/work/here"], forceReload: true });
});

function codexSummary(key: string) {
  const [, account, id] = key.split(":") as [string, string, string];
  return {
    key, provider: "codex" as const, account, id, cwd: null, name: null, title: null, preview: null,
    status: "closed" as const, owner: "none" as const, pid: null, tmuxPane: null, parentKey: null,
    updatedAt: 1, createdAt: null, sizeBytes: null, entrypoint: null,
  };
}

test("a thread whose resume answers active with no turn running (a thread with a goal) is still taken over", async (t) => {
  const r = await rig(t);
  // Measured 2026-11-16: thread/resume of a thread that has a goal answers status active while
  // thread/read says idle and every turn has ended.
  const goalThread = makeThread(crypto.randomUUID(), { status: { type: "idle" } });
  r.d.threads.set(goalThread.id, goalThread);
  r.d.handlers.set("thread/resume", (p) => {
    const th = r.d.threads.get(String(p.threadId))!;
    return { thread: { ...th, status: { type: "active", activeFlags: [] } } };
  });
  r.d.handlers.set("thread/turns/list", () => ({ data: [{ id: "old", rootTurnId: "old", items: [], itemsView: "notLoaded", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null }], nextCursor: null, backwardsCursor: null }));
  await r.runs.send(`codex:cx:${goalThread.id}`, "/compact");
  assert.equal(r.d.calls("thread/compact/start").at(-1)!.params.threadId, goalThread.id);
  assert.equal(r.owned.has(goalThread.id), true);
  // A turn that really started between the read and the resume is another client's.
  const raced = makeThread(crypto.randomUUID(), { status: { type: "idle" } });
  r.d.threads.set(raced.id, raced);
  r.d.handlers.set("thread/turns/list", () => ({ data: [{ id: "tui", rootTurnId: "tui", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null }], nextCursor: null, backwardsCursor: null }));
  await assert.rejects(r.runs.send(`codex:cx:${raced.id}`, "hi"), /another client/);
  assert.equal(r.owned.has(raced.id), false);
});

test("attachments: turn/start and turn/steer carry the notes and a localImage per picture; maru's commands refuse them", async (t) => {
  const r = await rig(t);
  const { key, threadId } = await r.create();
  const image = {
    id: "20261116-00000000-0000-4000-8000-000000000001", kind: "image" as const, name: "IMG.HEIC", mimeType: "image/heic", sizeBytes: 9,
    path: "/s/1/IMG.HEIC", imagePath: "/s/1/image.jpg", imageMime: "image/jpeg", createdAt: 0,
  };
  // The created turn still runs: the message steers it.
  await r.runs.send(key, "", [image]);
  assert.deepEqual(r.d.calls("turn/steer").at(-1)!.params.input, [
    { type: "text", text: '[Attached image "IMG.HEIC" is saved at: /s/1/IMG.HEIC]', text_elements: [] },
    { type: "localImage", path: "/s/1/image.jpg" },
  ]);
  r.complete(threadId);
  await r.runs.send(key, "and this", [image]);
  assert.deepEqual(r.d.calls("turn/start").at(-1)!.params.input, [
    { type: "text", text: 'and this\n\n[Attached image "IMG.HEIC" is saved at: /s/1/IMG.HEIC]', text_elements: [] },
    { type: "localImage", path: "/s/1/image.jpg" },
  ]);
  // Every `/name` is a command (one this server runs, a TUI screen, or one the TUI refuses).
  for (const word of ["/compact", "/hooks", "/no-such-command now"]) {
    await assert.rejects(r.runs.send(key, word, [image]), /Send the command and the attachment separately/);
  }
  // A `$skill` is text the daemon reads, and a leading space makes any message text: both go.
  await r.runs.send(key, "$on look", [image]);
  await r.runs.send(key, " /compact is a word here", [image]);
  assert.deepEqual(r.d.calls("turn/steer").slice(-2).map((c) => (c.params.input as Array<{ type: string; text?: string }>)[0]!.text!.split("\n")[0]), ["$on look", " /compact is a word here"]);
});
