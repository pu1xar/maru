import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerMessage, SessionCommand, SessionSummary } from "@maru/shared";
import { SessionIndex } from "../index/store.ts";
import { ProjectStore } from "../projects/store.ts";
import { ChosenStore } from "../state/chosen.ts";
import { SessionChoiceStore } from "../state/sessionChoices.ts";
import type { AdoptedRun, ClaudeDriver, DriverEvents, PendingQuestion, RunHandle, RunState, StartOpts } from "../claude/driver.ts";
import { HostRequestError } from "../host/client.ts";
import { ClaudeRuns, decideSendNow, sendNowNotice } from "./claudeRuns.ts";
import { lastModelOf } from "./transcriptFacts.ts";

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NEW = "11111111-2222-4333-8444-555555555555";
const KEY = `claude:acct:${SID}`;

function summary(over: Partial<SessionSummary>): SessionSummary {
  return {
    key: KEY, provider: "claude", account: "acct", id: SID, cwd: os.tmpdir(), name: null, title: null,
    preview: null, status: "closed", owner: "none", pid: null, tmuxPane: null, parentKey: null,
    updatedAt: 1, createdAt: null, sizeBytes: null, entrypoint: "cli", ...over,
  };
}

type FakeHandle = RunHandle & { sent: string[]; answered: unknown[]; stopped: string[]; calls: unknown[][]; now: RunState };

function fakeHandle(sid: string | null, onClose: () => void, commandName: string): FakeHandle {
  return {
    sent: [] as string[],
    answered: [] as unknown[],
    stopped: [] as string[],
    calls: [] as unknown[][],
    now: { busy: true, tasks: [] } as RunState,
    async stopTask(taskId: string) { this.stopped.push(taskId); },
    workflowTaskId: (runId: string) => (runId === "wf_seen-1" ? "wtask1" : null),
    sessionId: () => sid,
    pid: () => null,
    state() { return this.now; },
    async send(text: string) { this.sent.push(text); },
    async interrupt() {},
    answer(requestId: string, answers: Record<string, string>) { this.answered.push({ requestId, answers }); },
    async close() { onClose(); },
    fileCheckpointing: () => false,
    async commands() { return [{ name: commandName, description: "", argumentHint: "" }]; },
    async call<T>(method: string, ...args: unknown[]) { this.calls.push([method, ...args]); return undefined as T; },
  };
}

function fakeDriver() {
  const starts: Array<{ opts: StartOpts; ev: DriverEvents; handle: FakeHandle }> = [];
  let pid: number | null = null;
  let adopter: ((handle: RunHandle, run: AdoptedRun) => DriverEvents) | null = null;
  const driver: ClaudeDriver = {
    async start(opts, ev) {
      const handle = fakeHandle(opts.resume ?? null, () => ev.onExit({ code: "done" }), `run-of-${opts.resume ?? "new"}`);
      Object.assign(handle, { pid: () => pid });
      starts.push({ opts, ev, handle });
      return handle;
    },
    ownPids: () => new Set(pid === null ? [] : [pid]),
    holds: (sid) => starts.some((s) => s.opts.resume === sid),
    async probe() { return { commands: [], models: [], outputStyles: [] }; },
    onAdopt(handler) { adopter = handler; },
    async ready() {},
    hostStatus: () => ({ state: "up", error: null, waitingFor: [] }),
    onHostStatus: () => () => {},
  };
  /** A run the host had before this server started, as the driver hands it over. */
  const adopt = (sid: string | null, accountDir: string) => {
    let ev: DriverEvents | null = null;
    const handle = fakeHandle(sid, () => ev?.onExit({ code: "done" }), `adopted-${sid}`);
    ev = adopter!(handle, { accountDir, cwd: os.tmpdir() });
    return { handle, ev };
  };
  return { driver, starts, adopt, setPid: (p: number) => { pid = p; } };
}

function rig(accountDir = "/cfg") {
  const index = new SessionIndex();
  const chosen = new ChosenStore(":memory:");
  const projects = new ProjectStore(":memory:");
  const sent: ServerMessage[] = [];
  const changed: string[] = [];
  let resweeps = 0;
  const fake = fakeDriver();
  const choices = new SessionChoiceStore(":memory:");
  let listed: SessionCommand[] | null = null;
  let listedReads = 0;
  const runs = new ClaudeRuns({
    driver: fake.driver,
    accounts: [{ id: "acct", dir: accountDir }],
    index, chosen, projects, choices,
    resweep: async () => { resweeps++; },
    broadcast: (m) => sent.push(m),
    stateChanged: (key) => changed.push(key),
    pidWaitMs: 2000,
    models: async (key) => ({
      key, from: "cache", options: [
        { value: "default", resolved: "claude-opus-5-5", label: "Default (recommended)", description: "Opus 5.5", efforts: ["low", "high"], defaultEffort: null, isDefault: true },
        { value: "sonnet", resolved: "claude-sonnet-5-5", label: "Sonnet 5.5", description: "", efforts: ["low", "high"], defaultEffort: null, isDefault: false },
      ],
      outputStyles: ["default", "Concise"],
    }),
    listed: async () => {
      listedReads++;
      return listed;
    },
  });
  return {
    index, chosen, projects, sent, runs, fake, changed, choices, resweeps: () => resweeps,
    setListed: (l: SessionCommand[] | null) => { listed = l; }, listedReads: () => listedReads,
  };
}

test("a terminal-held session is refused; a closed one is resumed, then fed in the same process", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({ owner: "terminal", status: "open-idle" }) });
  await assert.rejects(r.runs.send(KEY, "hi"), /terminal/);
  assert.equal(r.fake.starts.length, 0);

  r.index.apply({ type: "upsert", session: summary({ owner: "none", status: "closed" }) });
  await r.runs.send(KEY, "first");
  assert.equal(r.fake.starts.length, 1);
  assert.deepEqual(r.fake.starts[0]!.opts, { accountDir: "/cfg", cwd: os.tmpdir(), prompt: "first", resume: SID });
  await r.runs.send(KEY, "second");
  assert.equal(r.fake.starts.length, 1, "no second process");
  assert.deepEqual(r.fake.starts[0]!.handle.sent, ["second"]);

  // The index learns the pid soon after the start.
  r.fake.setPid(4242);
  const end = Date.now() + 2000;
  while (r.resweeps() === 0 && Date.now() < end) await new Promise((x) => setTimeout(x, 20));
  assert.ok(r.resweeps() >= 1);
});

test("a new session joins the list and its project once the CLI reports its id", async () => {
  const r = rig();
  const p = r.projects.create({ name: "P" });
  const created = r.runs.create({ account: "acct", cwd: os.tmpdir(), prompt: "start", projectId: p.id });
  await new Promise((x) => setTimeout(x, 10));
  const { opts, ev } = r.fake.starts[0]!;
  assert.equal(opts.resume, undefined);
  ev.onMessage({ type: "system", subtype: "init", session_id: NEW } as never);
  assert.equal(await created, `claude:acct:${NEW}`);
  assert.equal(r.chosen.has("claude", NEW), true);
  assert.equal(r.projects.projectOf("claude", NEW), p.id);
});

test("/clear: the run follows the CLI into the new session, which joins the list and the Group; the sender opens it", async () => {
  const r = rig();
  const p = r.projects.create({ name: "P" });
  r.projects.assign("claude", SID, p.id);
  r.chosen.set("claude", SID, true);
  r.index.apply({ type: "upsert", session: summary({}) });
  await r.runs.send(KEY, "first");
  const { ev, handle } = r.fake.starts[0]!;
  ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-haiku-4-5-20251001" } as never);
  ev.onMessage({ type: "result", session_id: SID, user_message_uuids: ["u1"] } as never);
  const q: PendingQuestion = {
    requestId: "req1", toolUseId: "tu1", toolName: "AskUserQuestion", kind: "question",
    input: { questions: [] }, title: null, description: null, decisionReason: null, agentId: null,
  };
  ev.onQuestion(q);

  const cleared = r.runs.send(KEY, "/clear");
  await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(handle.sent, ["/clear"], "/clear goes to the CLI as typed");
  // As measured on 2.1.325: conversation_reset under the old id, then every message under the new one.
  ev.onMessage({ type: "conversation_reset", session_id: SID } as never);
  ev.onMessage({ type: "system", subtype: "init", session_id: NEW } as never);
  const newKey = `claude:acct:${NEW}`;
  assert.equal(r.runs.isDriven(newKey), true);
  assert.equal(r.runs.isDriven(KEY), false, "the old session is no longer this server's");
  assert.equal(r.chosen.has("claude", NEW), true);
  assert.equal(r.projects.projectOf("claude", NEW), p.id);
  assert.deepEqual(r.runs.pendingOf(newKey).map((x) => x.requestId), ["req1"], "the process's open question follows it");
  const lastFor = (key: string) => r.sent.filter((m) => m.type === "session.pending" && m.key === key).at(-1);
  assert.deepEqual(lastFor(KEY), { type: "session.pending", key: KEY, questions: [] });
  // The answer waits until the index lists the new session, so the UI does not open a missing one.
  let answered = false;
  void cleared.then(() => { answered = true; });
  await new Promise((x) => setTimeout(x, 10));
  assert.equal(answered, false);
  r.index.apply({ type: "upsert", session: summary({ key: newKey, id: NEW, status: "open-idle", owner: "ui" }) });
  assert.deepEqual(await cleared, { command: "clear", open: newKey });
  ev.onMessage({ type: "result", session_id: NEW, user_message_uuids: ["u2"] } as never);
  assert.deepEqual(r.runs.turnInfo(newKey).ends.map((e) => e.userMessageUuids), [["u2"]]);

  // Later sends go to the new key's run; the old key starts nothing while the process lives.
  await r.runs.send(newKey, "next");
  assert.deepEqual(handle.sent, ["/clear", "next"]);
  assert.equal(r.fake.starts.length, 1);
});

test("a /clear sent while the process is ending waits past that exit and opens the session its new process goes on in", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await r.runs.send(KEY, "go");
  const { ev, handle } = r.fake.starts[0]!;
  let finishExit!: () => void;
  handle.close = () => new Promise<void>((resolve) => {
    finishExit = () => {
      ev.onExit({ code: "done" });
      resolve();
    };
  });
  const closing = r.runs.close(KEY);
  const cleared = r.runs.send(KEY, "/clear");
  await new Promise((x) => setTimeout(x, 20));
  finishExit();
  await closing;
  await new Promise((x) => setTimeout(x, 20));
  assert.equal(r.fake.starts.length, 2, "the /clear resumes the session in a new process");
  assert.equal(r.fake.starts[1]!.opts.prompt, "/clear");
  const next = r.fake.starts[1]!.ev;
  next.onMessage({ type: "system", subtype: "init", session_id: SID } as never);
  next.onMessage({ type: "conversation_reset", session_id: SID } as never);
  next.onMessage({ type: "system", subtype: "init", session_id: NEW } as never);
  r.index.apply({ type: "upsert", session: summary({ key: `claude:acct:${NEW}`, id: NEW, status: "open-idle", owner: "ui" }) });
  assert.deepEqual(await cleared, { command: "clear", open: `claude:acct:${NEW}` }, "the ending process's exit did not answer it");
});

test("a /clear whose turn ends without a new session (a user command named clear) answers nothing", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await r.runs.send(KEY, "first");
  const { ev } = r.fake.starts[0]!;
  ev.onMessage({ type: "system", subtype: "init", session_id: SID } as never);
  const cleared = r.runs.send(KEY, "/clear");
  await new Promise((x) => setTimeout(x, 10));
  ev.onMessage({ type: "result", session_id: SID, user_message_uuids: ["u1"] } as never);
  assert.equal(await cleared, undefined);
  assert.equal(r.runs.isDriven(KEY), true);
});

test("a new session that dies before reporting an id rejects the create", async () => {
  const r = rig();
  const created = r.runs.create({ account: "acct", cwd: os.tmpdir(), prompt: "start", projectId: null });
  await new Promise((x) => setTimeout(x, 10));
  r.fake.starts[0]!.ev.onExit({ code: "error", error: "login failed" });
  await assert.rejects(created, /login failed/);
  await assert.rejects(r.runs.create({ account: "nope", cwd: os.tmpdir(), prompt: "x", projectId: null }), /Unknown account/);
  await assert.rejects(r.runs.create({ account: "acct", cwd: "/no/such/dir", prompt: "x", projectId: null }), /[Ww]orking folder/);
});

test("questions are published per session and cleared by an answer or the exit", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await r.runs.send(KEY, "go");
  const { ev, handle } = r.fake.starts[0]!;
  const q: PendingQuestion = {
    requestId: "req1", toolUseId: "tu1", toolName: "AskUserQuestion", kind: "question",
    input: { questions: [] }, title: null, description: null, decisionReason: null, agentId: null,
  };
  ev.onQuestion(q);
  assert.deepEqual(r.runs.pendingOf(KEY).map((x) => x.requestId), ["req1"]);
  assert.deepEqual(r.runs.allPending().map((x) => x.key), [KEY]);
  r.runs.answer(KEY, "req1", { "Color?": "Red" });
  assert.deepEqual(handle.answered, [{ requestId: "req1", answers: { "Color?": "Red" } }]);
  const pend = r.sent.filter((m) => m.type === "session.pending");
  assert.deepEqual(pend.map((m) => (m.type === "session.pending" ? m.questions.length : -1)), [1, 0]);

  ev.onQuestion({ ...q, requestId: "req2" });
  ev.onExit({ code: "error", error: "boom" });
  assert.deepEqual(r.runs.pendingOf(KEY), []);
  assert.ok(r.sent.some((m) => m.type === "command.error" && m.error === "boom"));
  await assert.rejects(r.runs.interrupt(KEY), /not run by this server/);
});

test("close ends the run, so the session is no longer driven here", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  assert.equal(r.runs.commandsOf(KEY), null, "no run, no live command list");
  await r.runs.send(KEY, "go");
  assert.deepEqual((await r.runs.commandsOf(KEY))?.map((c) => c.name), [`run-of-${SID}`], "the run's own list");
  await r.runs.interrupt(KEY);
  await r.runs.close(KEY);
  assert.equal(r.runs.commandsOf(KEY), null);
  await assert.rejects(r.runs.interrupt(KEY), /not run by this server/);
  await assert.rejects(r.runs.close(KEY), /not run by this server/);
  // The next message starts a new process.
  await r.runs.send(KEY, "again");
  assert.equal(r.fake.starts.length, 2);
});

test("a send right after close waits for the process to exit, then resumes the session in a new one", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await r.runs.send(KEY, "go");
  const { ev, handle } = r.fake.starts[0]!;
  let finishExit!: () => void;
  handle.close = () => new Promise<void>((resolve) => {
    finishExit = () => {
      ev.onExit({ code: "done" });
      resolve();
    };
  });
  const closing = r.runs.close(KEY);
  const sending = r.runs.send(KEY, "after close");
  await new Promise((x) => setTimeout(x, 20));
  assert.deepEqual(handle.sent, [], "the ending process takes no message");
  assert.equal(r.fake.starts.length, 1);
  const sweepsBefore = r.resweeps();
  finishExit();
  await closing;
  await sending;
  assert.ok(r.resweeps() > sweepsBefore, "the index looked again before the resume");
  assert.equal(r.fake.starts.length, 2);
  assert.deepEqual([r.fake.starts[1]!.opts.resume, r.fake.starts[1]!.opts.prompt], [SID, "after close"]);
});

test("a task of a session this server drives can be stopped; any other session is refused", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  assert.equal(r.runs.isDriven(KEY), false);
  await assert.rejects(r.runs.stopTask(KEY, "a1"), /not run by this server/);
  assert.equal(r.runs.workflowTaskId(KEY, "wf_seen-1"), null, "no run, no task");
  await r.runs.send(KEY, "go");
  assert.equal(r.runs.isDriven(KEY), true);
  await r.runs.stopTask(KEY, "a1");
  assert.deepEqual(r.fake.starts[0]!.handle.stopped, ["a1"]);
  assert.equal(r.runs.workflowTaskId(KEY, "wf_seen-1"), "wtask1");
  assert.equal(r.runs.workflowTaskId(KEY, "wf_other-2"), null);
});

test("runs the session host kept across a restart are adopted with their questions", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({ owner: "ui", status: "waiting-input" }) });
  // The fake driver hands over a run of /cfg (the account "acct") that waits on a question.
  const { handle, ev } = r.fake.adopt(SID, "/cfg");
  const q: PendingQuestion = {
    requestId: "req9", toolUseId: "tu9", toolName: "AskUserQuestion", kind: "question",
    input: { questions: [] }, title: null, description: null, decisionReason: null, agentId: null,
  };
  ev.onQuestion(q);
  assert.deepEqual(r.runs.liveKeys(), [KEY], "the adopted run is driven here");
  assert.deepEqual(r.runs.pendingOf(KEY).map((x) => x.requestId), ["req9"]);
  assert.ok(r.sent.some((m) => m.type === "session.pending" && m.key === KEY && m.questions.length === 1));
  r.runs.answer(KEY, "req9", { "Color?": "Blue" });
  assert.deepEqual(handle.answered, [{ requestId: "req9", answers: { "Color?": "Blue" } }]);
  await r.runs.send(KEY, "next");
  assert.deepEqual(handle.sent, ["next"], "a send goes to the adopted process, not a new one");
  assert.equal(r.fake.starts.length, 0);

  // A new session that had not reported its id yet joins once it does.
  const late = r.fake.adopt(null, "/cfg");
  late.ev.onMessage({ type: "system", subtype: "init", session_id: NEW } as never);
  assert.ok(r.runs.liveKeys().includes(`claude:acct:${NEW}`));
  await r.runs.close(KEY);
  assert.equal(r.runs.liveKeys().includes(KEY), false);
});

const task = (taskId: string, over: Partial<RunState["tasks"][number]> = {}): RunState["tasks"][number] => ({
  taskId, type: "local_agent", description: "", background: true, ambient: false, ...over,
});

test("annotate: the host's state replaces the registration's for a session this server runs", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  const ui = summary({ owner: "ui", status: "running" });
  assert.equal(r.runs.annotate(ui), ui, "no run, no change");
  await r.runs.send(KEY, "go");
  const { ev, handle } = r.fake.starts[0]!;
  assert.deepEqual(r.changed, [KEY], "a run that starts is announced");
  assert.deepEqual([r.runs.annotate(ui).status, r.runs.annotate(ui).backgroundTasks], ["running", 0]);

  // The turn ended; a background agent and an ambient watcher go on, and the registration still says busy.
  handle.now = { busy: false, tasks: [task("a1"), task("w1", { ambient: true }), task("b1", { background: false })] };
  ev.onState!(handle.now);
  assert.equal(r.changed.at(-1), KEY);
  const after = r.runs.annotate(ui);
  assert.deepEqual([after.status, after.backgroundTasks], ["open-idle", 2], "a foreground task outlives no turn: it counts once the turn ended");

  handle.now = { busy: true, tasks: [task("a1"), task("b1", { background: false })] };
  ev.onState!(handle.now);
  assert.deepEqual([r.runs.annotate(ui).status, r.runs.annotate(ui).backgroundTasks], ["running", 1], "the foreground task belongs to the running turn");

  ev.onQuestion({ requestId: "q1", toolUseId: "t", toolName: "AskUserQuestion", kind: "question", input: {}, title: null, description: null, decisionReason: null, agentId: null });
  assert.equal(r.runs.annotate(ui).status, "waiting-input");
  assert.equal(r.runs.annotate(summary({ owner: "terminal", status: "running" })).status, "running", "another process's session keeps its registration");
  ev.onExit({ code: "done" });
  assert.equal(r.runs.annotate(ui), ui);
});

test("a result is a turn end naming its user messages; init and status messages carry the mode", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  const heard: string[] = [];
  r.runs.onTurns((k) => heard.push(k));
  await r.runs.send(KEY, "go");
  const { ev, handle } = r.fake.starts[0]!;
  let info = r.runs.turnInfo(KEY);
  assert.deepEqual(info.run && [info.run.busy, info.run.permissionMode], [true, "bypassPermissions"], "the mode the driver starts with");
  assert.ok(info.run?.busySince);

  ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-haiku-4-5", permissionMode: "default" } as never);
  ev.onMessage({ type: "result", subtype: "success", session_id: SID, user_message_uuids: ["u-1", "u-2"] } as never);
  handle.now = { busy: false, tasks: [] };
  ev.onState!(handle.now);
  info = r.runs.turnInfo(KEY);
  assert.deepEqual(info.ends.map((e) => e.userMessageUuids), [["u-1", "u-2"]]);
  assert.ok(Date.now() - Date.parse(info.ends[0]!.at) < 5000);
  assert.deepEqual(info.run && [info.run.busy, info.run.busySince, info.run.permissionMode], [false, null, "default"]);

  ev.onMessage({ type: "result", subtype: "success", session_id: SID, user_message_uuid: "u-3" } as never);
  ev.onMessage({ type: "result", subtype: "success", session_id: SID } as never);
  ev.onMessage({ type: "system", subtype: "status", session_id: SID, status: null, permissionMode: "plan" } as never);
  info = r.runs.turnInfo(KEY);
  assert.deepEqual(info.ends.map((e) => e.userMessageUuids), [["u-1", "u-2"], ["u-3"], []]);
  assert.equal(info.run?.permissionMode, "plan", "the CLI entered plan mode");
  // Start, init (model), init (mode), three results, the state change, the status (mode): one notice each.
  assert.deepEqual(heard, Array(8).fill(KEY));

  ev.onExit({ code: "done" });
  info = r.runs.turnInfo(KEY);
  assert.equal(info.run, null);
  assert.equal(info.ends.length, 3, "the ends outlive the process");
});

test("an active_goal message of the process is kept for the thread's goal and tells the turn listeners; the process's end drops it", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  const heard: string[] = [];
  await r.runs.send(KEY, "go");
  r.runs.onTurns((k) => heard.push(k));
  const { ev } = r.fake.starts[0]!;
  assert.equal(r.runs.turnInfo(KEY).run?.activeGoal, undefined, "none before the process sends one");

  const before = Date.now();
  ev.onMessage({ type: "active_goal", session_id: SID, value: { condition: "tests pass", iterations: 2, set_at: 1000, tokens_at_start: 5, last_reason: "one fails" } } as never);
  const g = r.runs.turnInfo(KEY).run?.activeGoal;
  assert.deepEqual(g?.value, { condition: "tests pass", setAt: 1000, iterations: 2, lastReason: "one fails" });
  assert.ok(g!.receivedAt >= before);
  assert.deepEqual(heard, [KEY]);

  ev.onMessage({ type: "active_goal", session_id: SID, value: null } as never);
  assert.equal(r.runs.turnInfo(KEY).run?.activeGoal?.value, null, "a cleared goal is kept as a clear");

  ev.onExit({ code: "done" });
  assert.equal(r.runs.turnInfo(KEY).run, null);
});

test("onResult hands each result to its listeners before the host reports the run idle; a throwing listener spoils nothing", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({ owner: "ui" }) });
  const heard: Array<[string, unknown, string]> = [];
  r.runs.onResult(() => {
    throw new Error("listener bug");
  });
  const off = r.runs.onResult((key, result) => heard.push([key, result.terminal_reason, r.runs.annotate(summary({ owner: "ui" })).status]));
  await r.runs.send(KEY, "go");
  const { ev, handle } = r.fake.starts[0]!;
  const result = { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", result: "Not logged in", session_id: SID };
  ev.onMessage(result as never);
  assert.deepEqual(heard, [[KEY, "api_error", "running"]], "the run is still busy: run.message comes before run.state");
  assert.equal(r.runs.turnInfo(KEY).ends.length, 1, "the turn end is recorded as before");
  handle.now = { busy: false, tasks: [] };
  ev.onState!(handle.now);
  off();
  ev.onMessage({ ...result, terminal_reason: "completed" } as never);
  assert.equal(heard.length, 1, "unsubscribed");
});

test("onRunExit hands a process's exit to its listeners before the index hears of it; a throwing listener spoils nothing", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({ owner: "ui" }) });
  const heard: Array<[string, string, string | undefined, boolean]> = [];
  r.runs.onRunExit(() => {
    throw new Error("listener bug");
  });
  const off = r.runs.onRunExit((key, info) => heard.push([key, info.code, info.error, r.runs.isDriven(key)]));
  await r.runs.send(KEY, "go");
  const { ev } = r.fake.starts[0]!;
  ev.onExit({ code: "error", error: "boom" });
  // The run is gone from this server (isDriven false) when the listener hears it; the index has not reannotated yet.
  assert.deepEqual(heard, [[KEY, "error", "boom", false]]);
  off();
});

test("setPermissionMode calls the process and shows the mode at once; other sessions are refused", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await assert.rejects(r.runs.setPermissionMode(KEY, "plan"), /not run by this server/);
  await r.runs.send(KEY, "go");
  const { handle } = r.fake.starts[0]!;
  await assert.rejects(r.runs.setPermissionMode(KEY, "dontAsk"), /permission mode/);
  await r.runs.setPermissionMode(KEY, "plan");
  assert.deepEqual(handle.calls, [["setPermissionMode", "plan"]]);
  assert.equal(r.runs.turnInfo(KEY).run?.permissionMode, "plan");
});

test("a closed session resumes on the model its transcript last ran on", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-runs-model-"));
  try {
    const proj = path.join(dir, "projects", "-work");
    fs.mkdirSync(proj, { recursive: true });
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    fs.writeFileSync(path.join(proj, `${SID}.jsonl`), [
      line({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } }),
      line({ type: "assistant", uuid: "a1", message: { model: "claude-haiku-4-5-20251001", content: [] } }),
      line({ type: "assistant", uuid: "a2", isSidechain: true, message: { model: "claude-opus-5-5", content: [] } }),
      line({ type: "assistant", uuid: "a3", message: { model: "<synthetic>", content: [] } }),
      line({ type: "queue-operation", operation: "enqueue" }),
    ].join(""));
    const r = rig(dir);
    r.index.apply({ type: "upsert", session: summary({}) });
    await r.runs.send(KEY, "again");
    assert.equal(r.fake.starts[0]!.opts.model, "claude-haiku-4-5-20251001");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a run taken over after a restart starts with the mode its newest turn started in, until the CLI reports one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-runs-mode-"));
  try {
    const proj = path.join(dir, "projects", "-work");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, `${SID}.jsonl`), `${JSON.stringify({ type: "user", permissionMode: "plan", message: { role: "user", content: "hi" } })}\n`);
    const r = rig(dir);
    const heard: string[] = [];
    r.runs.onTurns((k) => heard.push(k));
    const { ev } = r.fake.adopt(SID, dir);
    assert.equal(r.runs.turnInfo(KEY).run?.permissionMode, null, "unknown at first");
    const end = Date.now() + 2000;
    while (r.runs.turnInfo(KEY).run?.permissionMode !== "plan" && Date.now() < end) await new Promise((x) => setTimeout(x, 10));
    assert.equal(r.runs.turnInfo(KEY).run?.permissionMode, "plan");
    assert.ok(heard.includes(KEY));
    ev.onMessage({ type: "system", subtype: "status", session_id: SID, status: null, permissionMode: "acceptEdits" } as never);
    assert.equal(r.runs.turnInfo(KEY).run?.permissionMode, "acceptEdits", "the CLI's own report wins");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("/model on a closed session is kept for its next start, which wins over the transcript; a response on it drops the model", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-runs-choice-"));
  try {
    const proj = path.join(dir, "projects", "-work");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, `${SID}.jsonl`), `${JSON.stringify({ type: "assistant", uuid: "a1", message: { model: "claude-haiku-4-5-20251001", content: [] } })}\n`);
    const r = rig(dir);
    r.index.apply({ type: "upsert", session: summary({}) });
    await assert.rejects(r.runs.send(KEY, "/model nonsense"), /Unknown model: nonsense/);
    const res = await r.runs.send(KEY, "/model sonnet");
    assert.deepEqual(res, { command: "model", notice: "Model Sonnet 5.5, applies the next time the session opens" });
    assert.deepEqual(r.runs.turnInfo(KEY).chosen, { model: "sonnet", pending: true });
    await r.runs.configure(KEY, { effort: "low" });
    await r.runs.configure(KEY, { permissionMode: "plan" });
    assert.equal(r.fake.starts.length, 0, "no process for a choice");
    await r.runs.send(KEY, "go");
    const opts = r.fake.starts[0]!.opts;
    assert.deepEqual([opts.model, opts.effort, opts.permissionMode], ["sonnet", "low", "plan"]);
    assert.equal(r.runs.turnInfo(KEY).run?.permissionMode, "plan", "the run starts in the chosen mode");
    assert.deepEqual(r.runs.turnInfo(KEY).chosen, { model: "sonnet", effort: "low" }, "the process runs with them now");
    assert.deepEqual(r.choices.get("claude", SID), { model: "sonnet", effort: "low" }, "the mode was used up; model and effort stay");
    const { ev } = r.fake.starts[0]!;
    ev.onMessage({ type: "system", subtype: "status", session_id: SID, status: null, permissionMode: "default" } as never);
    ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-sonnet-5-5-20260901" } as never);
    ev.onMessage({ type: "assistant", session_id: SID, parent_tool_use_id: null, message: { model: "claude-sonnet-5-5-20260901", content: [] } } as never);
    assert.deepEqual(r.choices.get("claude", SID), { effort: "low" }, "the transcript names the model now; effort stays the session's");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("on a running process /model, /effort, /fast, /output-style and /mcp call the SDK; state.chosen shows them at once", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await r.runs.send(KEY, "go");
  const { ev, handle } = r.fake.starts[0]!;
  ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-haiku-4-5", output_style: "default", fast_mode_state: "off" } as never);
  assert.deepEqual(r.runs.turnInfo(KEY).chosen, { model: "claude-haiku-4-5", fast: false, outputStyle: "default" }, "what the process reported");
  const heard: string[] = [];
  r.runs.onTurns((k) => heard.push(k));
  assert.deepEqual(await r.runs.send(KEY, "/model sonnet"), { command: "model", notice: "Model Sonnet 5.5" });
  await r.runs.send(KEY, "/effort auto");
  await r.runs.send(KEY, "/fast on");
  await r.runs.send(KEY, "/output-style Concise");
  await r.runs.send(KEY, "/mcp disable docs");
  await r.runs.send(KEY, "/permissions acceptEdits");
  assert.deepEqual(handle.calls, [
    ["setModel", "sonnet"],
    ["applyFlagSettings", { effortLevel: null }],
    ["applyFlagSettings", { fastMode: true }],
    ["applyFlagSettings", { outputStyle: "Concise" }],
    ["toggleMcpServer", "docs", false],
    ["setPermissionMode", "acceptEdits"],
  ]);
  assert.deepEqual(handle.sent, [], "none of them went to the model");
  assert.deepEqual(r.runs.turnInfo(KEY).chosen, { model: "sonnet", effort: null, fast: true, outputStyle: "Concise" });
  assert.equal(r.runs.turnInfo(KEY).run?.permissionMode, "acceptEdits");
  // One per command, and setPermissionMode adds its own for the mode it shows at once.
  assert.deepEqual(heard, Array(7).fill(KEY));
  assert.deepEqual(r.choices.get("claude", SID), { model: "sonnet", fast: true }, "a close before the next response keeps them");
  // "/mcp reconnect all" is the CLI's own form: it goes as text.
  await r.runs.send(KEY, "/mcp reconnect all");
  assert.deepEqual(handle.sent, ["/mcp reconnect all"]);
});

const assistant = (model: string, over: Record<string, unknown> = {}) =>
  ({ type: "assistant", session_id: SID, parent_tool_use_id: null, message: { model, content: [] }, ...over }) as never;

test("a model picked while a response streams is kept until a response on that model: the rest of the old one does not drop it", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await r.runs.send(KEY, "go");
  const { ev } = r.fake.starts[0]!;
  ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-opus-5-5" } as never);
  ev.onMessage(assistant("claude-opus-5-5"));
  await r.runs.configure(KEY, { model: "sonnet" });
  assert.deepEqual(r.choices.get("claude", SID), { model: "sonnet" });
  ev.onMessage(assistant("claude-opus-5-5"));
  ev.onMessage(assistant("claude-opus-5-5", { parent_tool_use_id: "tu1" }));
  assert.deepEqual(r.choices.get("claude", SID), { model: "sonnet" }, "the response under way is on the model before");
  // The next turn starts on the picked model: its system/init names the id.
  ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-sonnet-5-5" } as never);
  ev.onMessage(assistant("claude-sonnet-5-5-20260901"));
  assert.equal(r.choices.get("claude", SID), null, "a response on the picked model in a turn begun after the pick");
});

test("a response on the picked model inside the turn it was picked in keeps the choice: a resume would take that turn's first model", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-runs-turn-"));
  try {
    const proj = path.join(dir, "projects", "-work");
    fs.mkdirSync(proj, { recursive: true });
    const file = path.join(proj, `${SID}.jsonl`);
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    fs.writeFileSync(file, line({ type: "user", uuid: "u1", message: { role: "user", content: "long task" } })
      + line({ type: "assistant", uuid: "a1", message: { model: "claude-opus-5-5", content: [] } }));
    const r = rig(dir);
    r.index.apply({ type: "upsert", session: summary({}) });
    await r.runs.send(KEY, "go on");
    assert.equal(r.fake.starts[0]!.opts.model, "claude-opus-5-5", "resumed on the transcript's model");
    const { ev } = r.fake.starts[0]!;
    ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-opus-5-5" } as never);
    await r.runs.configure(KEY, { model: "sonnet" });
    // A tool turn: the next request of the same turn already runs on sonnet.
    ev.onMessage(assistant("claude-sonnet-5-5"));
    fs.appendFileSync(file, line({ type: "assistant", uuid: "a2", message: { model: "claude-sonnet-5-5", content: [] } }));
    assert.deepEqual(r.choices.get("claude", SID), { model: "sonnet" }, "no system/init since the pick: the turn began on opus");
    assert.equal(await lastModelOf(file), "claude-opus-5-5", "the turn's first main line names opus");
    ev.onExit({ code: "done" });
    await r.runs.send(KEY, "again");
    assert.equal(r.fake.starts[1]!.opts.model, "sonnet", "the next process runs the picked model, not the turn's first");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a turn begun in plan mode drops no choice, even after its plan was approved: a resume skips that turn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-runs-plan-"));
  try {
    const proj = path.join(dir, "projects", "-work");
    fs.mkdirSync(proj, { recursive: true });
    const file = path.join(proj, `${SID}.jsonl`);
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    fs.writeFileSync(file, line({ type: "user", uuid: "u1", permissionMode: "default", message: { role: "user", content: "hi" } })
      + line({ type: "assistant", uuid: "a1", message: { model: "claude-opus-5-5", content: [] } }));
    const r = rig(dir);
    r.index.apply({ type: "upsert", session: summary({}) });
    r.setListed([]);
    await r.runs.send(KEY, "first");
    const { ev, handle } = r.fake.starts[0]!;
    ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-opus-5-5", permissionMode: "bypassPermissions" } as never);
    handle.now = { busy: false, tasks: [] };
    await r.runs.configure(KEY, { model: "sonnet" });
    assert.deepEqual(await r.runs.send(KEY, "/plan 설계해줘"), { command: "plan", notice: "permission mode plan" });
    // The planning turn starts in plan mode on the picked model; the approval leaves plan mode inside it.
    ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-sonnet-5-5", permissionMode: "plan" } as never);
    ev.onMessage({ type: "system", subtype: "status", session_id: SID, status: null, permissionMode: "acceptEdits" } as never);
    ev.onMessage(assistant("claude-sonnet-5-5"));
    fs.appendFileSync(file, line({ type: "user", uuid: "u2", permissionMode: "plan", message: { role: "user", content: "설계해줘" } })
      + line({ type: "assistant", uuid: "a2", message: { model: "claude-sonnet-5-5", content: [] } }));
    assert.deepEqual(r.choices.get("claude", SID), { model: "sonnet" }, "the turn began in plan mode");
    assert.equal(await lastModelOf(file), "claude-opus-5-5", "a resume would skip it");
    // The next turn begins outside plan mode on sonnet: its response drops the choice.
    ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-sonnet-5-5", permissionMode: "acceptEdits" } as never);
    ev.onMessage(assistant("claude-sonnet-5-5"));
    assert.equal(r.choices.get("claude", SID), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a 1M-context choice stays: transcripts write the model without [1m]", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await r.runs.send(KEY, "go");
  const { ev } = r.fake.starts[0]!;
  ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-opus-5-5" } as never);
  await r.runs.configure(KEY, { model: "claude-opus-5-5[1m]" });
  ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-opus-5-5[1m]" } as never);
  ev.onMessage(assistant("claude-opus-5-5"));
  assert.deepEqual(r.choices.get("claude", SID), { model: "claude-opus-5-5[1m]" });
  await r.runs.configure(KEY, { model: "sonnet[1m]" });
  ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-sonnet-5-5" } as never);
  ev.onMessage(assistant("claude-sonnet-5-5"));
  assert.deepEqual(r.choices.get("claude", SID), { model: "sonnet[1m]" }, "even when the process reports the id without the suffix");
});

test("a run adopted after a restart keeps a model chosen before it until the process reports and answers on it", async () => {
  const r = rig();
  r.choices.merge("claude", SID, { model: "sonnet" });
  const { ev } = r.fake.adopt(SID, "/cfg");
  ev.onMessage(assistant("claude-opus-5-5"));
  assert.deepEqual(r.choices.get("claude", SID), { model: "sonnet" }, "a response before the next init does not tell");
  ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-sonnet-5-5" } as never);
  ev.onMessage(assistant("claude-sonnet-5-5"));
  assert.equal(r.choices.get("claude", SID), null);
});

test("/output-style default on a running process sets the style named default, as a start does", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await r.runs.send(KEY, "go");
  const { ev, handle } = r.fake.starts[0]!;
  ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-opus-5-5", output_style: "Explanatory" } as never);
  await r.runs.send(KEY, "/output-style default");
  await r.runs.configure(KEY, { outputStyle: null });
  assert.deepEqual(handle.calls, [
    ["applyFlagSettings", { outputStyle: "default" }],
    ["applyFlagSettings", { outputStyle: "default" }],
  ], "null in the flag layer would fall back to the settings files' Explanatory");
  assert.equal(r.runs.turnInfo(KEY).chosen?.outputStyle, "default");
});

test("a start carries fast and the output style as flag settings; the style is used up, fast stays", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await r.runs.configure(KEY, { fast: true });
  await r.runs.configure(KEY, { outputStyle: "concise" });
  await r.runs.send(KEY, "go");
  assert.deepEqual(r.fake.starts[0]!.opts.flagSettings, { fastMode: true, outputStyle: "Concise" }, "the style as the session names it");
  assert.deepEqual(r.choices.get("claude", SID), { fast: true });
  assert.deepEqual(r.runs.turnInfo(KEY).chosen, { fast: true }, "the new process runs with it");
});

test("a CLI screen maru does not have answers a notice with the text, when the session's list lacks a command of that name", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  r.setListed([{ name: "review", sigil: "/", description: "", argumentHint: "", aliases: [], source: "builtin" }]);
  assert.deepEqual(await r.runs.send(KEY, "/hooks 이 설정 봐줘"), {
    command: "hooks", notice: "/hooks: Not supported in maru", unsent: "/hooks 이 설정 봐줘",
  }, "the composer gets the text back");
  assert.match((await r.runs.send(KEY, "/help") as { notice: string }).notice, /\/ menu/);
  assert.equal(r.fake.starts.length, 0);
  r.setListed([{ name: "hooks", sigil: "/", description: "my hooks skill", argumentHint: "", aliases: [], source: "custom" }]);
  assert.equal(await r.runs.send(KEY, "/hooks"), undefined);
  assert.equal(r.fake.starts[0]!.opts.prompt, "/hooks", "the user's own /hooks ran as a message");
  await assert.rejects(r.runs.send(KEY, "/effort huge"), /effort must be/);
  await assert.rejects(r.runs.send(KEY, "/permissions dontAsk"), /permission mode must be/);
});

test("when the session's list cannot be read a CLI screen goes to the CLI, which answers it; the list is read only for those names", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  r.setListed(null);
  assert.equal(await r.runs.send(KEY, "/usage-credits"), undefined);
  assert.equal(r.fake.starts[0]!.opts.prompt, "/usage-credits");
  assert.equal(r.listedReads(), 1);
  await r.runs.send(KEY, "/model");
  await r.runs.send(KEY, "plain text");
  await r.runs.send(KEY, "/my-skill go");
  assert.equal(r.listedReads(), 1, "the list is read only for a command whose handling it decides");
});

test("/plan sets plan mode and sends the rest in it; /status and /exit run here; a custom /plan runs as itself", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  r.setListed([]);
  // Closed: plan waits for the start, which the text then opens in plan mode.
  assert.deepEqual(await r.runs.send(KEY, "/plan 캐시 계층 설계"), { command: "plan", notice: "permission mode plan" });
  assert.deepEqual([r.fake.starts[0]!.opts.prompt, r.fake.starts[0]!.opts.permissionMode], ["캐시 계층 설계", "plan"]);
  const { ev, handle } = r.fake.starts[0]!;
  ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-opus-5-5", permissionMode: "plan" } as never);
  await r.runs.send(KEY, "/permissions default");
  assert.deepEqual(await r.runs.send(KEY, "/plan"), { command: "plan", notice: "permission mode plan" });
  assert.deepEqual(handle.calls.filter((c) => c[0] === "setPermissionMode"), [["setPermissionMode", "default"], ["setPermissionMode", "plan"]]);
  // During a turn the mode would take the turn under way: the text is not sent and comes back.
  assert.deepEqual(await r.runs.send(KEY, "/plan 다음 단계"), {
    command: "plan", notice: "/plan: not sent because a turn is in progress. Plan mode would apply to the current turn right away. Send again after it ends", unsent: "/plan 다음 단계",
  });
  assert.equal(handle.calls.filter((c) => c[0] === "setPermissionMode").length, 2, "the mode did not change");
  handle.now = { busy: false, tasks: [] };
  await r.runs.send(KEY, "/plan 다음 단계");
  assert.deepEqual(handle.sent, ["다음 단계"]);
  handle.now = { busy: true, tasks: [] };
  // A leading space makes it a message, as the composers read it.
  await r.runs.send(KEY, " /plan 그냥 글");
  assert.deepEqual(handle.sent, ["다음 단계", " /plan 그냥 글"]);
  const status = (await r.runs.send(KEY, "/status")) as { notice: string };
  assert.match(status.notice, /^Session: running/);
  assert.match(status.notice, /permission mode: plan/);
  assert.match(status.notice, /Working folder: /);
  await assert.rejects(r.runs.send(KEY, "/status now"), /takes no arguments/);
  // /exit waits as the header's 닫기 does: not while a turn, a question or a background task runs.
  assert.match((await r.runs.send(KEY, "/exit") as { notice: string }).notice, /^\/exit: not closed because a turn is in progress/);
  handle.now = { busy: false, tasks: [task("wf1"), task("w1", { ambient: true })] };
  ev.onState!(handle.now);
  assert.match((await r.runs.send(KEY, "/exit") as { notice: string }).notice, /1 background task is running/, "an ambient watcher does not count");
  handle.now = { busy: false, tasks: [] };
  ev.onState!(handle.now);
  ev.onQuestion({ requestId: "q1", toolUseId: "t", toolName: "AskUserQuestion", kind: "question", input: {}, title: null, description: null, decisionReason: null, agentId: null });
  assert.match((await r.runs.send(KEY, "/exit") as { notice: string }).notice, /a question is waiting for an answer/);
  assert.equal(r.runs.isDriven(KEY), true, "still running");
  r.runs.answer(KEY, "q1", { decision: "approve" });
  assert.deepEqual(await r.runs.send(KEY, "/exit"), { command: "exit", notice: "Session closed" });
  assert.equal(r.runs.isDriven(KEY), false);
  assert.deepEqual(await r.runs.send(KEY, "/exit"), { command: "exit", notice: "Session is not open" });
  const closed = (await r.runs.send(KEY, "/status")) as { notice: string };
  assert.match(closed.notice, /^Session: closed\nModel: .* \(next start\)/);
  r.setListed([{ name: "plan", sigil: "/", description: "", argumentHint: "", aliases: [], source: "custom" }]);
  assert.equal(await r.runs.send(KEY, "/plan 이번엔 내 skill"), undefined);
  assert.equal(r.fake.starts.at(-1)!.opts.prompt, "/plan 이번엔 내 skill");
});

test("a configure is checked as a start would take it: model, effort, mode, style and the field types", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await assert.rejects(r.runs.configure(KEY, { model: "sonet" }), /Unknown model: sonet/, "an alias must be a row of the list");
  await assert.rejects(r.runs.configure(KEY, { effort: "huge" }), /effort must be/);
  await assert.rejects(r.runs.configure(KEY, { permissionMode: "dontAsk" as never }), /permission mode must be/);
  await assert.rejects(r.runs.configure(KEY, { outputStyle: "Pirate" }), /Unknown output style: Pirate/);
  await assert.rejects(r.runs.configure(KEY, { fast: "yes" as never }), /Invalid value for fast/);
  await assert.rejects(r.runs.configure(KEY, { mcp: { server: "docs", action: "wipe" as never } }), /Invalid value for mcp/);
  assert.equal(r.choices.get("claude", SID), null, "nothing was kept");
  await r.runs.configure(KEY, { model: "claude-sonnet-5-5-20260901" });
  await r.runs.configure(KEY, { model: "sonnet[1m]" });
  assert.deepEqual(r.choices.get("claude", SID), { model: "sonnet[1m]" }, "a listed id with its date, a listed row's 1M run");
  // The CLI takes model ids the picker does not list (claude-opus-4-6 runs here often): kept, and the notice says it is off the list.
  assert.deepEqual(await r.runs.configure(KEY, { model: "claude-opus-4-6" }), {
    command: "model", notice: "Model claude-opus-4-6 (ID not in the picker list), applies the next time the session opens",
  });
  assert.deepEqual(r.choices.get("claude", SID), { model: "claude-opus-4-6" });
  await r.runs.send(KEY, "go");
  assert.equal(r.fake.starts[0]!.opts.model, "claude-opus-4-6");
  await r.runs.configure(KEY, { model: "claude-opus-4-8[1m]" });
  assert.deepEqual(r.fake.starts[0]!.handle.calls, [["setModel", "claude-opus-4-8[1m]"]], "and on a running process");
});

test("a send or configure while a closed session starts waits for that start: no second process, the choice reaches it", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  let release!: () => void;
  const gate = new Promise<void>((x) => (release = x));
  const start = r.fake.driver.start.bind(r.fake.driver);
  r.fake.driver.start = async (opts, ev) => {
    await gate;
    return start(opts, ev);
  };
  const first = r.runs.send(KEY, "first");
  await new Promise((x) => setTimeout(x, 10));
  const second = r.runs.send(KEY, "second");
  const pick = r.runs.configure(KEY, { model: "sonnet" });
  const mode = r.runs.configure(KEY, { permissionMode: "acceptEdits" });
  await new Promise((x) => setTimeout(x, 10));
  release();
  await Promise.all([first, second, pick, mode]);
  assert.equal(r.fake.starts.length, 1, "one process");
  const { handle, opts } = r.fake.starts[0]!;
  assert.equal(opts.prompt, "first");
  assert.deepEqual(handle.sent, ["second"]);
  assert.deepEqual(handle.calls.map((c) => JSON.stringify(c)).sort(), [`["setModel","sonnet"]`, `["setPermissionMode","acceptEdits"]`], "applied to the new process");
  assert.equal(r.runs.turnInfo(KEY).run?.permissionMode, "acceptEdits", "not wiped by the start's clean-up");
});

test("a value set here gives way to a later system/init; fast cooldown shows as on with its note; /permissions names the mode a closed session starts in", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await r.runs.configure(KEY, { permissionMode: "plan" });
  assert.match((await r.runs.send(KEY, "/permissions") as { notice: string }).notice, /^permission mode: plan \(next start\)/);
  await r.runs.send(KEY, "go");
  const { ev } = r.fake.starts[0]!;
  ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-opus-5-5", fast_mode_state: "off", output_style: "default" } as never);
  await r.runs.configure(KEY, { fast: true });
  await r.runs.configure(KEY, { model: "sonnet" });
  assert.deepEqual(r.runs.turnInfo(KEY).chosen, { model: "sonnet", fast: true, outputStyle: "default" });
  ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-sonnet-5-5", fast_mode_state: "cooldown", output_style: "default" } as never);
  assert.deepEqual(r.runs.turnInfo(KEY).chosen, { model: "sonnet", fast: true, fastCooldown: true, outputStyle: "default" }, "the picked value stays while the process runs it");
  assert.match((await r.runs.send(KEY, "/fast") as { notice: string }).notice, /^fast mode: on, standard speed for a while after a rate limit/);
  // The process moved on its own (another model, fast off): its report wins.
  ev.onMessage({ type: "system", subtype: "init", session_id: SID, model: "claude-opus-5-5", fast_mode_state: "off", output_style: "default" } as never);
  assert.deepEqual(r.runs.turnInfo(KEY).chosen, { model: "claude-opus-5-5", fast: false, outputStyle: "default" });
  assert.match((await r.runs.send(KEY, "/permissions") as { notice: string }).notice, /^permission mode: plan\n/);
});

test("/mcp on a closed session is refused; /model alone lists the rows with the current one", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await assert.rejects(r.runs.send(KEY, "/mcp"), /Only possible while the session is running/);
  await r.runs.configure(KEY, { model: "default" });
  const res = (await r.runs.send(KEY, "/model")) as { notice: string };
  assert.equal(res.notice, "Model: Default (recommended)\n* default: Default (recommended), Opus 5.5\n  sonnet: Sonnet 5.5\nChange with: /model <name>");
});

test("attachments: a picture goes as an image block before the text with the notes, also with no words; maru's commands refuse them", async (t) => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runs-att-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pic = path.join(dir, "shot.png");
  fs.writeFileSync(pic, "PNGDATA");
  const image = {
    id: "20261116-00000000-0000-4000-8000-000000000001", kind: "image" as const, name: "shot.png", mimeType: "image/png", sizeBytes: 7,
    path: pic, imagePath: pic, imageMime: "image/png", createdAt: 0,
  };
  const file = { id: "20261116-00000000-0000-4000-8000-000000000002", kind: "file" as const, name: "a.pdf", mimeType: "application/pdf", sizeBytes: 1, path: "/s/a.pdf", createdAt: 0 };
  await r.runs.send(KEY, "", [image]);
  assert.deepEqual(r.fake.starts[0]!.opts.prompt, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("PNGDATA").toString("base64") } },
    { type: "text", text: `[Attached image "shot.png" is saved at: ${pic}]` },
  ]);
  await r.runs.send(KEY, "read this", [file]);
  assert.deepEqual(r.fake.starts[0]!.handle.sent, [[{ type: "text", text: "read this\n\n[Attached file \"a.pdf\" is saved at: /s/a.pdf]" }]]);
  await assert.rejects(r.runs.send(KEY, "/model opus", [file]), /Send the command and the attachment separately/);
  await assert.rejects(r.runs.send(KEY, "  ", []), /empty message/);
});

test("attachments: a CLI command refuses them; a skill (the user's or the CLI's own) takes them; an unknown list lets them go", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  const file = { id: "20261116-00000000-0000-4000-8000-000000000002", kind: "file" as const, name: "a.pdf", mimeType: "application/pdf", sizeBytes: 1, path: "/s/a.pdf", createdAt: 0 };
  const row = (name: string, source: "builtin" | "custom", aliases: string[] = []): SessionCommand => ({ name, sigil: "/", description: "", argumentHint: "", aliases, source });
  // The list unknown (no process, no cache): it may be the user's command, so it goes.
  r.setListed(null);
  await r.runs.send(KEY, "/compact", [file]);
  assert.equal(r.fake.starts.length, 1);
  r.setListed([
    row("compact", "builtin"), row("context", "builtin"), row("usage", "builtin", ["cost"]), row("clear", "builtin", ["reset", "new"]),
    row("my-skill", "custom"), row("deploy", "custom", ["ship"]), row("dataviz", "builtin"), row("init", "builtin"),
    // The user's /context is shadowed: the CLI's runs (the SDK's rule).
    row("context", "custom"),
  ]);
  const sent = r.fake.starts[0]!.handle.sent;
  for (const text of ["/compact", "/context now", "/cost", "/reset"]) {
    await assert.rejects(r.runs.send(KEY, text, [file]), /Send the command and the attachment separately/, text);
  }
  assert.equal(sent.length, 0, "none of them reached the CLI");
  // The user's own command or skill and its alias, the CLI's own skill and prompt command, and a
  // name the list lacks take the attachments.
  const goes = ["/my-skill look", "/ship it", "/dataviz chart this", "/init", "/not-listed x"];
  for (const text of goes) await r.runs.send(KEY, text, [file]);
  assert.deepEqual(sent.map((c) => (c as unknown as Array<{ text: string }>)[0]!.text.split("\n")[0]), goes);
  // Without attachments a built-in goes as before.
  await r.runs.send(KEY, "/compact");
  assert.equal(sent.at(-1), "/compact");
});

test("a rewind (DESIGN.md 6o): sends wait for exclusive(); a waiting rewind cuts the next resume short unless fullResume; a start without a message keeps the choices", async () => {
  const index = new SessionIndex();
  const fake = fakeDriver();
  const choices = new SessionChoiceStore(":memory:");
  const runs = new ClaudeRuns({
    driver: fake.driver, accounts: [{ id: "acct", dir: "/cfg" }], index, chosen: new ChosenStore(":memory:"), projects: new ProjectStore(":memory:"), choices,
    resweep: async () => {}, broadcast: () => {}, pidWaitMs: 50,
    rewind: { resumeAt: async () => "line-7", markerOf: () => null },
    fileCheckpointing: () => true,
  });
  index.apply({ type: "upsert", session: summary({ owner: "none", status: "closed" }) });
  choices.merge("claude", SID, { permissionMode: "plan" });
  // Inside exclusive(): a send waits; open() starts the whole conversation without a message.
  let sent: Promise<unknown> | null = null;
  await runs.exclusive(KEY, async () => {
    sent = runs.send(KEY, "after the rewind");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fake.starts.length, 0, "the send waits for the rewind");
    await runs.open(KEY, { fullResume: true });
    assert.equal(fake.starts.length, 1);
    assert.equal(fake.starts[0]!.opts.prompt, undefined);
    assert.equal(fake.starts[0]!.opts.resumeSessionAt, undefined, "fullResume ignores the waiting rewind");
    assert.equal(fake.starts[0]!.opts.fileCheckpointing, true);
    assert.equal(choices.get("claude", SID)?.permissionMode, "plan", "kept for the next send's start");
    await runs.close(KEY);
  });
  await sent;
  assert.equal(fake.starts.length, 2);
  assert.equal(fake.starts[1]!.opts.prompt, "after the rewind");
  assert.equal(fake.starts[1]!.opts.resumeSessionAt, "line-7");
  assert.equal(fake.starts[1]!.opts.permissionMode, "plan");
  assert.equal(choices.get("claude", SID)?.permissionMode, undefined, "a start with a message uses it up");
});

test("rewindState counts a start under way as a turn", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({ owner: "none", status: "closed" }) });
  assert.equal(r.runs.rewindState(KEY), null);
  const sending = r.runs.send(KEY, "hi");
  await new Promise((res) => setImmediate(res));
  assert.equal(r.runs.rewindState(KEY)?.busy, true, "before or as the run exists");
  await sending;
  await r.runs.close(KEY);
});

test("backgroundTasks sends the foreground tasks to the process and says what moved", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await assert.rejects(r.runs.backgroundTasks(KEY), /not run by this server/, "no process of this server");
  await r.runs.send(KEY, "go");
  const { handle } = r.fake.starts[0]!;
  handle.call = async function <T>(this: typeof handle, method: string, ...args: unknown[]) { this.calls.push([method, ...args]); return true as T; };
  handle.now = { busy: true, tasks: [task("b1", { type: "local_bash", background: false }), task("a1", { background: false }), task("a2"), task("w1", { background: false, ambient: true })] };
  assert.equal(await r.runs.backgroundTasks(KEY), "Sent 2 foreground tasks to background", "background and ambient tasks are not counted");
  assert.equal(await r.runs.backgroundTasks(KEY, "toolu_1"), "Sent the task to background");
  assert.deepEqual(handle.calls, [["backgroundTasks"], ["backgroundTasks", "toolu_1"]], "one call for all, one with the tool_use id");
});

test("backgroundTasks refuses with a reason when nothing can move", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await r.runs.send(KEY, "go");
  const { handle } = r.fake.starts[0]!;
  handle.now = { busy: false, tasks: [] };
  await assert.rejects(r.runs.backgroundTasks(KEY), /No turn is in progress/);
  handle.now = { busy: true, tasks: [task("a2")] };
  await assert.rejects(r.runs.backgroundTasks(KEY), /No work is running in the foreground/, "a background task is not foreground");
  assert.deepEqual(handle.calls, [], "nothing was asked of the process");
  // A call named by id goes to the process even without a task in the state (the id is the check); false means no match.
  handle.now = { busy: true, tasks: [] };
  await assert.rejects(r.runs.backgroundTasks(KEY, "toolu_x"), /not running in the foreground/);
  assert.deepEqual(handle.calls, [["backgroundTasks", "toolu_x"]]);
  // The CLI refuses when background tasks are disabled for the session.
  handle.call = async () => { throw new HostRequestError("failed", "Background tasks are disabled in this session."); };
  await assert.rejects(r.runs.backgroundTasks(KEY, "toolu_y"), /Background tasks are disabled/);
  handle.call = async () => { throw new HostRequestError("not-allowed", "Query.backgroundTasks is not callable through the host"); };
  await assert.rejects(r.runs.backgroundTasks(KEY, "toolu_y"), /Restart the host/);
});

test("decideSendNow: the first step that applies, from what the server knows", () => {
  assert.equal(decideSendNow({ busy: false, foreground: 2, queued: 1 }), "no-turn");
  assert.equal(decideSendNow({ busy: true, foreground: 2, queued: 0 }), "no-message", "no waiting message: nothing is backgrounded for it");
  assert.equal(decideSendNow({ busy: true, foreground: 0, queued: 1 }), "resend", "the model writes or a call that is no task runs: the message goes in with priority now");
  assert.equal(decideSendNow({ busy: true, foreground: 1, queued: 1 }), "background-resend", "foreground tasks go to the background first: priority now would not move them");
});

/** A run in a turn, with a scripted Query control surface, and the hooks of a sendNow recorded in order. */
async function sendNowRig(over: { cancel?: (id: string) => boolean | Error; background?: boolean | Error; sendFails?: string[] } = {}) {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await r.runs.send(KEY, "go");
  const { handle } = r.fake.starts[0]!;
  const log: string[] = [];
  const sends: Array<{ id: string | undefined; text: string; priority: string | undefined }> = [];
  let interrupted = 0;
  handle.interrupt = async () => { interrupted += 1; };
  handle.call = async function <T>(this: typeof handle, method: string, ...args: unknown[]) {
    this.calls.push([method, ...args]);
    log.push(`call ${method}${args.length ? " " + String(args[0]) : ""}`);
    const v = method === "backgroundTasks" ? (over.background ?? true) : (over.cancel ?? (() => true))(String(args[0]));
    if (v instanceof Error) throw v;
    return v as T;
  };
  handle.send = async function (content: unknown, id?: string, priority?: string) {
    sends.push({ id, text: String(content), priority });
    log.push(`send ${String(content)} ${priority ?? "-"}`);
    if (over.sendFails?.includes(String(content))) throw new Error(`send of ${String(content)} failed`);
  } as typeof handle.send;
  const hookedTo: string[] = [];
  const hooks = {
    replacing: (from: string, to: string) => log.push(`replacing ${from}>${to === from ? "same" : "new"}`),
    kept: (from: string) => log.push(`kept ${from}`),
    replaced: (from: string, to: string) => { log.push(`replaced ${from}`); hookedTo.push(to); },
    handed: () => log.push("handed"),
    lost: (_to: string, error: string) => log.push(`lost ${error}`),
  };
  return { r, handle, log, sends, hooks, hookedTo, interrupted: () => interrupted };
}

const waiting = (...ids: string[]) => ids.map((id) => ({ id, content: `text ${id}` as string | null }));

test("sendNow with foreground tasks: background first, then every waiting message is taken out and sent again with priority now, in order", async () => {
  const x = await sendNowRig();
  x.handle.now = { busy: true, tasks: [task("b1", { type: "local_bash", background: false }), task("a1", { background: false }), task("a2"), task("w1", { background: false, ambient: true })] };
  const res = await x.r.runs.sendNow(KEY, waiting("m1", "m2"), x.hooks);
  assert.deepEqual([res.outcome, res.moved, res.sent], ["sent", 2, 2], "background and ambient tasks are not counted");
  assert.equal(res.notice, "Sent 2 foreground tasks to background, sent 2 queued messages now");
  assert.deepEqual(x.log, [
    "call backgroundTasks",
    "replacing m1>new", "call cancelAsyncMessage m1", "replaced m1",
    "replacing m2>new", "call cancelAsyncMessage m2", "replaced m2",
    "send text m1 now", "send text m2 now",
    "handed", "handed",
  ], "the take-outs come first, then both sends leave in order, so the CLI gets them together");
  const ids = x.sends.map((s) => s.id!);
  assert.equal(new Set([...ids, "m1", "m2"]).size, 4, "a new uuid each: the CLI drops one it has seen");
  assert.deepEqual(ids, x.hookedTo, "the id the record was renamed to is the id sent");
  assert.equal(x.interrupted(), 0, "the turn is not stopped");
});

test("sendNow with nothing in the foreground asks nothing of the background and sends the messages again with priority now", async () => {
  const x = await sendNowRig();
  x.handle.now = { busy: true, tasks: [task("a2")] };
  const res = await x.r.runs.sendNow(KEY, waiting("m1"), x.hooks);
  assert.deepEqual([res.outcome, res.moved, res.sent], ["sent", 0, 1]);
  assert.equal(res.notice, "Sent 1 queued message now");
  assert.deepEqual(x.handle.calls, [["cancelAsyncMessage", "m1"]], "no backgroundTasks call");
  assert.deepEqual(x.sends.map((s) => [s.text, s.priority]), [["text m1", "now"]]);
});

test("sendNow does nothing without a turn or without a waiting message", async () => {
  const x = await sendNowRig();
  await assert.rejects(x.r.runs.sendNow("claude:acct:00000000-0000-4000-8000-000000000000", waiting("m1"), x.hooks), /not run by this server/);
  x.handle.now = { busy: false, tasks: [task("b1", { background: false })] };
  let res = await x.r.runs.sendNow(KEY, waiting("m1"), x.hooks);
  assert.deepEqual([res.outcome, res.notice], ["nothing", "No turn is running, so there is nothing to send now"]);
  x.handle.now = { busy: true, tasks: [task("b1", { background: false })] };
  res = await x.r.runs.sendNow(KEY, [], x.hooks);
  assert.deepEqual([res.outcome, res.notice], ["nothing", "No queued message is waiting"]);
  assert.deepEqual(x.log, [], "nothing was asked of the process");
  assert.equal(x.interrupted(), 0);
});

test("sendNow leaves a message the model already has: no resend, the record keeps its id", async () => {
  const x = await sendNowRig({ cancel: (id) => id !== "m2" });
  x.handle.now = { busy: true, tasks: [] };
  const res = await x.r.runs.sendNow(KEY, waiting("m1", "m2", "m3"), x.hooks);
  assert.deepEqual([res.outcome, res.sent], ["sent", 2]);
  assert.match(res.notice, /^Sent 2 queued messages now, 1 message was left as they were \(the model already has it\)$/);
  assert.deepEqual(x.log.filter((l) => l.startsWith("kept") || l.startsWith("replaced")), ["replaced m1", "kept m2", "replaced m3"]);
  assert.deepEqual(x.sends.map((s) => s.text), ["text m1", "text m3"], "m2 is not sent again");
  // The only message was the model's already: nothing to send now.
  const y = await sendNowRig({ cancel: () => false });
  y.handle.now = { busy: true, tasks: [] };
  const none = await y.r.runs.sendNow(KEY, waiting("m1"), y.hooks);
  assert.deepEqual([none.outcome, none.sent, y.sends.length], ["nothing", 0, 0]);
});

test("sendNow: a send that fails after its take-out is reported as lost, the others still go", async () => {
  const x = await sendNowRig({ sendFails: ["text m1"] });
  x.handle.now = { busy: true, tasks: [] };
  const res = await x.r.runs.sendNow(KEY, waiting("m1", "m2"), x.hooks);
  assert.deepEqual([res.outcome, res.sent], ["sent", 1]);
  assert.match(res.notice, /1 message could not be sent again and now show as failed in the queue, take back to edit/);
  assert.deepEqual(x.log.filter((l) => l.startsWith("lost") || l === "handed"), ["lost send of text m1 failed", "handed"]);
  // Every send fails: still a result (not an error), nothing is dropped silently.
  const y = await sendNowRig({ sendFails: ["text m1"] });
  y.handle.now = { busy: true, tasks: [] };
  const all = await y.r.runs.sendNow(KEY, waiting("m1"), y.hooks);
  assert.deepEqual([all.outcome, all.sent], ["nothing", 0]);
  assert.deepEqual(y.log.filter((l) => l.startsWith("lost")), ["lost send of text m1 failed"]);
});

test("sendNow keeps a message whose content cannot be rebuilt queued, without taking it out", async () => {
  const x = await sendNowRig();
  x.handle.now = { busy: true, tasks: [] };
  const res = await x.r.runs.sendNow(KEY, [{ id: "m1", content: null }, { id: "m2", content: "text m2" }], x.hooks);
  assert.equal(res.sent, 1);
  assert.deepEqual(x.handle.calls, [["cancelAsyncMessage", "m2"]], "m1 was not asked about");
  assert.match(res.notice, /1 message was left as they were/);
});

test("sendNow on a host without the take-out call: foreground tasks still move, the messages stay queued, the notice says to restart the host", async () => {
  const x = await sendNowRig({ cancel: () => new HostRequestError("not-allowed", "Query.cancelAsyncMessage is not callable through the host") });
  x.handle.now = { busy: true, tasks: [task("b1", { background: false })] };
  const res = await x.r.runs.sendNow(KEY, waiting("m1", "m2"), x.hooks);
  assert.deepEqual([res.outcome, res.moved, res.sent], ["moved", 1, 0]);
  assert.match(res.notice, /^Sent 1 foreground task to background, the session host cannot take queued messages back \(restart it to send them now\)/);
  assert.deepEqual(x.log.filter((l) => l.startsWith("call")), ["call backgroundTasks", "call cancelAsyncMessage m1"], "the second message is not tried after the first refusal");
  assert.deepEqual(x.log.filter((l) => l.startsWith("kept")), ["kept m1"]);
  assert.equal(x.sends.length, 0);
});

test("sendNow stops the turn only when foreground work could not move", async () => {
  const x = await sendNowRig({ background: new HostRequestError("failed", "Background tasks are disabled in this session.") });
  x.handle.now = { busy: true, tasks: [task("b1", { type: "local_bash", background: false })] };
  let res = await x.r.runs.sendNow(KEY, waiting("m1"), x.hooks);
  assert.deepEqual([res.outcome, res.moved, res.sent, x.interrupted()], ["stopped", 0, 0, 1]);
  assert.match(res.notice, /disabled for this session.*the turn was stopped and the queued message runs next/);
  assert.deepEqual(x.handle.calls.map((c) => c[0]), ["backgroundTasks"], "no message is taken out: the interrupt keeps the CLI's queue and the next turn runs it");
  // A host that predates the call.
  const y = await sendNowRig({ background: new HostRequestError("not-allowed", "Query.backgroundTasks is not callable through the host") });
  y.handle.now = { busy: true, tasks: [task("b1", { background: false })] };
  res = await y.r.runs.sendNow(KEY, waiting("m1", "m2"), y.hooks);
  assert.deepEqual([res.outcome, y.interrupted()], ["stopped", 1]);
  assert.match(res.notice, /Restart the host.*queued messages run next/);
});

test("sendNow: a false answer from backgroundTasks (the work left the foreground meanwhile) goes on to the resend, not to an interrupt", async () => {
  const x = await sendNowRig({ background: false });
  x.handle.now = { busy: true, tasks: [task("b1", { background: false })] };
  const res = await x.r.runs.sendNow(KEY, waiting("m1"), x.hooks);
  assert.deepEqual([res.outcome, res.moved, res.sent, x.interrupted()], ["sent", 0, 1, 0]);
});

test("sendNow: a take-out that fails for another reason is thrown when nothing went, and the record keeps the message", async () => {
  const x = await sendNowRig({ cancel: () => new HostRequestError("unknown-run", "host connection lost") });
  x.handle.now = { busy: true, tasks: [] };
  await assert.rejects(x.r.runs.sendNow(KEY, waiting("m1"), x.hooks), /host connection lost/);
  assert.deepEqual(x.log.filter((l) => l.startsWith("kept")), ["kept m1"]);
  assert.equal(x.sends.length, 0);
  // With another message that did go, the failure is not thrown (that message is taken care of) and the other stays.
  const y = await sendNowRig({ cancel: (id) => (id === "m1" ? new HostRequestError("unknown-run", "host connection lost") : true) });
  y.handle.now = { busy: true, tasks: [] };
  const res = await y.r.runs.sendNow(KEY, waiting("m1", "m2"), y.hooks);
  assert.deepEqual([res.outcome, res.sent], ["sent", 1]);
  assert.deepEqual(y.sends.map((s) => s.text), ["text m2"]);
});

test("sendNowNotice words what happened", () => {
  const base = { moved: 0, messages: 1, sent: 0, kept: 0, lost: 0, unsupported: false };
  assert.equal(sendNowNotice({ ...base, sent: 1 }), "Sent 1 queued message now");
  assert.equal(sendNowNotice({ ...base, moved: 1, sent: 3 }), "Sent 1 foreground task to background, sent 3 queued messages now");
  assert.equal(sendNowNotice({ ...base, moved: 1, kept: 1 }), "Sent 1 foreground task to background, the queued messages go in next");
  assert.equal(sendNowNotice({ ...base, kept: 1 }), "The model already has the queued messages or they could not be taken out, nothing to send now");
  assert.equal(sendNowNotice(base), "Nothing to send now");
});

test("session.foreground names the calls the CLI holds in the foreground, on change, for a new client and at the end", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  await r.runs.send(KEY, "go");
  const { ev, handle } = r.fake.starts[0]!;
  const foreground = () => r.sent.filter((m) => m.type === "session.foreground");
  const started = (taskId: string, toolUseId: string | undefined) =>
    ev.onMessage({ type: "system", subtype: "task_started", task_id: taskId, ...(toolUseId ? { tool_use_id: toolUseId } : {}), session_id: SID } as never);
  // The message comes first, then the host's state with the task.
  started("b1", "toolu_b1");
  assert.equal(foreground().length, 0, "a task the state does not hold is not announced");
  handle.now = { busy: true, tasks: [task("b1", { type: "local_bash", background: false })] };
  ev.onState!(handle.now);
  assert.deepEqual(foreground().map((m) => (m as { toolUseIds: string[] }).toolUseIds), [["toolu_b1"]]);
  ev.onState!(handle.now);
  assert.equal(foreground().length, 1, "an unchanged list is not sent again");
  assert.deepEqual(r.runs.allForeground(), [{ key: KEY, toolUseIds: ["toolu_b1"] }], "a client that connects now hears it");
  // A task without a call id (an adopted run's) and a background one are left out.
  handle.now = { busy: true, tasks: [task("b1", { type: "local_bash", background: false }), task("x1", { background: false }), task("b2", { type: "local_bash", background: true })] };
  started("b2", "toolu_b2");
  ev.onState!(handle.now);
  assert.equal(foreground().length, 1);
  // The call moved to the background.
  handle.now = { busy: true, tasks: [task("b1", { type: "local_bash", background: true })] };
  ev.onState!(handle.now);
  assert.deepEqual(foreground().at(-1), { type: "session.foreground", key: KEY, toolUseIds: [] });
  assert.deepEqual(r.runs.allForeground(), []);
  // A list that is still non-empty when the process ends is cleared.
  handle.now = { busy: true, tasks: [task("b3", { type: "local_bash", background: false })] };
  started("b3", "toolu_b3");
  ev.onState!(handle.now);
  assert.deepEqual(foreground().at(-1), { type: "session.foreground", key: KEY, toolUseIds: ["toolu_b3"] });
  ev.onExit({ code: "done" });
  assert.deepEqual(foreground().at(-1), { type: "session.foreground", key: KEY, toolUseIds: [] });
});

test("liveTaskIds: the process's running task ids, null when this server runs no process for the session", async () => {
  const r = rig();
  r.index.apply({ type: "upsert", session: summary({}) });
  assert.equal(r.runs.liveTaskIds(KEY), null);
  await r.runs.send(KEY, "go");
  r.fake.starts[0]!.handle.now = { busy: false, tasks: [task("b1", { type: "local_bash" }), task("m1", { type: "local_monitor" })] };
  assert.deepEqual([...r.runs.liveTaskIds(KEY)!].sort(), ["b1", "m1"]);
  r.fake.starts[0]!.handle.now = { busy: false, tasks: [] };
  assert.deepEqual([...r.runs.liveTaskIds(KEY)!], [], "a process with no tasks is an empty set, not null");
});
