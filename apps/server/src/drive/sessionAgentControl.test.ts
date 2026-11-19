import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionAgentView, SessionSummary, SessionTaskOutput } from "@maru/shared";
import { ACTION_REASON } from "../claude/agentControl.ts";
import { HostDownError } from "../claude/hostLink.ts";
import { SessionIndex } from "../index/store.ts";
import { DriveError } from "./claudeRuns.ts";
import { AgentControlError, SessionAgentControl, codexAgentRows } from "./sessionAgentControl.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ctl-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const KEY = `claude:acct:${SID}`;
const CX = "11111111-2222-4333-8444-555555555555";
const CX_KEY = `codex:cx:${CX}`;

function summary(over: Partial<SessionSummary>): SessionSummary {
  return {
    key: KEY, provider: "claude", account: "acct", id: SID, cwd: "/w", name: null, title: null,
    preview: null, status: "open-idle", owner: "ui", pid: 1, tmuxPane: null, parentKey: null,
    updatedAt: 1, createdAt: null, sizeBytes: null, entrypoint: "maru", ...over,
  };
}

function codex(id: string, over: Partial<SessionSummary>): SessionSummary {
  return summary({ key: `codex:cx:${id}`, provider: "codex", account: "cx", id, entrypoint: "codex", ...over });
}

function row(over: Partial<SessionAgentView>): SessionAgentView {
  return {
    id: "a1", kind: "agent", title: "t", status: "running", agentType: null, model: null, parentAgentId: null,
    childThreadId: null, startedAt: null, updatedAt: null, completedAt: null, ...over,
  };
}

// A config dir with the session's transcript, a stopped workflow's final record, and a launch of a
// running workflow that happened before this server connected.
const cfg = path.join(root, "cfg");
const proj = path.join(cfg, "projects", "-w");
fs.mkdirSync(path.join(proj, SID, "workflows"), { recursive: true });
fs.writeFileSync(path.join(proj, `${SID}.jsonl`), [
  { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Workflow", input: { scriptPath: "/w/live.js" } }] } },
  {
    type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "launched" }] },
    toolUseResult: { status: "async_launched", taskId: "w-from-transcript", taskType: "local_workflow", runId: "wf_live-2", scriptPath: "/w/live.js" },
  },
].map((l) => JSON.stringify(l)).join("\n") + "\n");
fs.writeFileSync(path.join(proj, SID, "workflows", "wf_stop-1.json"), JSON.stringify({ runId: "wf_stop-1", status: "killed", scriptPath: "/w/s.js", args: [1] }));

function rig(opts: { driven?: boolean; codexDriven?: boolean; owner?: SessionSummary["owner"]; hostUp?: boolean } = {}) {
  const index = new SessionIndex();
  index.apply({ type: "upsert", session: summary({ status: "running", owner: opts.owner ?? "ui" }) });
  index.apply({ type: "upsert", session: codex(CX, { status: "open-idle" }) });
  index.apply({ type: "upsert", session: codex("c1", { parentKey: CX_KEY, status: "running", title: "child one", createdAt: 1000 }) });
  index.apply({ type: "upsert", session: codex("c2", { parentKey: "codex:cx:c1", status: "closed", preview: "grandchild" }) });
  index.apply({ type: "upsert", session: codex("x9", { parentKey: "codex:cx:other", status: "running" }) });
  const calls: string[] = [];
  const runs = {
    isDriven: () => opts.driven ?? true,
    async stopTask(key: string, taskId: string) { calls.push(`stop ${key} ${taskId}`); },
    workflowTaskId: (_key: string, runId: string) => (runId === "wf_seen-3" ? "w-seen" : null),
    async send(key: string, text: string) { calls.push(`send ${key} ${text}`); },
  };
  const codexRuns = {
    isDriven: () => opts.codexDriven ?? true,
    async interruptSubagent(key: string, child: string, isUnder: (k: string) => boolean) {
      calls.push(`interrupt ${key} ${child} under=${isUnder(`codex:cx:${child}`)}`);
    },
  };
  const ctl = new SessionAgentControl({
    claudeAccounts: [{ id: "acct", dir: cfg }],
    index, runs, codexRuns,
    hostUp: () => opts.hostUp ?? true,
    claudeRows: () => [
      row({ id: "a1" }),
      row({ id: "a2", status: "completed" }),
      row({ id: "wf_stop-1", kind: "workflow", status: "cancelled" }),
      row({ id: "wf_live-2", kind: "workflow", status: "running" }),
      row({ id: "wf_seen-3", kind: "workflow", status: "running" }),
      row({ id: "wf_gone-4", kind: "workflow", status: "interrupted" }),
    ],
  });
  return { ctl, calls, index };
}

async function rejectsWith(p: Promise<unknown>, status: number, re: RegExp): Promise<void> {
  await assert.rejects(p, (err: unknown) => err instanceof AgentControlError && err.status === status && re.test(err.message));
}

test("stop: an agent by its id, a workflow by the task its newest launch named", async () => {
  const r = rig();
  await r.ctl.stop({ key: KEY, kind: "agent", id: "a1" });
  await r.ctl.stop({ key: KEY, kind: "workflow", id: "wf_seen-3" });
  await r.ctl.stop({ key: KEY, kind: "workflow", id: "wf_live-2" });
  assert.deepEqual(r.calls, [`stop ${KEY} a1`, `stop ${KEY} w-seen`, `stop ${KEY} w-from-transcript`]);
});

test("stop is refused for rows that are not running or not reachable, and checks the row exists", async () => {
  const r = rig();
  await rejectsWith(r.ctl.stop({ key: KEY, kind: "agent", id: "a2" }), 409, /Not running/);
  await rejectsWith(r.ctl.stop({ key: KEY, kind: "agent", id: "nope" }), 404, /Not a subagent/);
  await rejectsWith(r.ctl.stop({ key: KEY, kind: "nope" as never, id: "a1" }), 400, /key, kind, and id/);
  const t = rig({ owner: "terminal", driven: false });
  await rejectsWith(t.ctl.stop({ key: KEY, kind: "agent", id: "a1" }), 409, new RegExp(ACTION_REASON.terminalStop));
  assert.deepEqual([...r.calls, ...t.calls], []);
});

test("resume sends the CLI's resume message built from the workflow's record", async () => {
  const r = rig();
  const res = await r.ctl.resume({ key: KEY, id: "wf_stop-1" });
  assert.equal(res.prompt, "I want this workflow to continue. Resume the paused workflow by calling: Workflow({scriptPath: '/w/s.js', resumeFromRunId: 'wf_stop-1', args: [1]}). Completed agents return cached results.");
  assert.deepEqual(r.calls, [`send ${KEY} ${res.prompt}`]);
  await rejectsWith(r.ctl.resume({ key: KEY, id: "wf_live-2" }), 409, /can be resumed/);
  await rejectsWith(r.ctl.resume({ key: KEY, id: "wf_gone-4" }), 404, /Could not find the script path/);
});

test("errors of the drive layer become HTTP statuses", async () => {
  const r = rig();
  const fail = (err: Error) => new SessionAgentControl({
    claudeAccounts: [{ id: "acct", dir: cfg }], index: r.index, hostUp: () => true,
    runs: { isDriven: () => true, workflowTaskId: () => null, async send() { throw err; }, async stopTask() { throw err; } },
    claudeRows: () => [row({ id: "a1" })],
  });
  await rejectsWith(fail(new HostDownError()).stop({ key: KEY, kind: "agent", id: "a1" }), 503, /host/);
  await rejectsWith(fail(new DriveError("This session is not run by this server")).stop({ key: KEY, kind: "agent", id: "a1" }), 409, /not run/);
});

test("Codex: subagent threads from the index, nested, with Stop on running ones of a thread this server drives", async () => {
  const r = rig();
  const rows = r.ctl.list(CX_KEY);
  assert.deepEqual(rows.map((x) => [x.id, x.title, x.status, x.parentAgentId, x.childThreadId, x.stop?.enabled ?? null]), [
    ["c1", "child one", "running", null, "codex:cx:c1", true],
    ["c2", "grandchild", "idle", "c1", "codex:cx:c2", null],
  ]);
  await r.ctl.stop({ key: CX_KEY, kind: "agent", id: "c1" });
  assert.deepEqual(r.calls, [`interrupt ${CX_KEY} c1 under=true`]);
  await rejectsWith(r.ctl.stop({ key: CX_KEY, kind: "agent", id: "c2" }), 409, /Not running/);
  await rejectsWith(r.ctl.stop({ key: CX_KEY, kind: "agent", id: "x9" }), 404, /Not a subagent/);

  const other = rig({ codexDriven: false }).ctl.list(CX_KEY);
  assert.deepEqual(other[0]!.stop, { enabled: false, reason: ACTION_REASON.notDriven });
  const root = codex(CX, { owner: "terminal", status: "running" });
  assert.deepEqual(codexAgentRows(root, [codex("c1", { parentKey: CX_KEY, status: "running" })], false)[0]!.stop, {
    enabled: false, reason: ACTION_REASON.terminalStop,
  });
});

// Rows the test changes as the files would, and a send or stop the test lets finish.
function settlingRig() {
  const index = new SessionIndex();
  index.apply({ type: "upsert", session: summary({ status: "open-idle", owner: "ui" }) });
  const rows: SessionAgentView[] = [
    row({ id: "a1" }),
    row({ id: "wf_stop-1", kind: "workflow", status: "cancelled" }),
  ];
  const calls: string[] = [];
  let release: (() => void) | null = null;
  let fail: Error | null = null;
  const gate = () => new Promise<void>((resolve, reject) => {
    release = () => (fail ? reject(fail) : resolve());
  });
  const ctl = new SessionAgentControl({
    claudeAccounts: [{ id: "acct", dir: cfg }],
    index, hostUp: () => true,
    runs: {
      isDriven: () => true,
      workflowTaskId: () => null,
      async stopTask(key: string, taskId: string) { calls.push(`stop ${taskId}`); await gate(); },
      async send(key: string, text: string) { calls.push(`send ${text.slice(0, 12)}`); await gate(); },
    },
    claudeRows: (_key, opts) => rows.map((r) => (opts?.light ? { ...r, workflow: undefined } : { ...r })),
  });
  const view = (id: string) => {
    const r = ctl.list(KEY).find((x) => x.id === id)!;
    return { status: r.status, settling: r.settling ?? null, stop: r.stop ?? null, resume: r.resume ?? null };
  };
  const setStatus = (id: string, status: SessionAgentView["status"]) => {
    rows.splice(rows.findIndex((r) => r.id === id), 1, { ...rows.find((r) => r.id === id)!, status });
  };
  return {
    ctl, index, calls, view, setStatus,
    finish: () => release?.(),
    failNext: (err: Error) => { fail = err; },
  };
}

test("Resume is sent once: the row says so and refuses it until the run starts again", async () => {
  const r = settlingRig();
  const first = r.ctl.resume({ key: KEY, id: "wf_stop-1" });
  // A second click while the first is on its way, and after it was sent.
  await rejectsWith(r.ctl.resume({ key: KEY, id: "wf_stop-1" }), 409, new RegExp(ACTION_REASON.resuming));
  await new Promise((res) => setImmediate(res));
  r.finish();
  await first;
  assert.deepEqual(r.view("wf_stop-1"), {
    status: "cancelled", settling: "resuming", stop: null, resume: { enabled: false, reason: ACTION_REASON.resuming },
  });
  await rejectsWith(r.ctl.resume({ key: KEY, id: "wf_stop-1" }), 409, new RegExp(ACTION_REASON.resuming));
  assert.equal(r.calls.filter((c) => c.startsWith("send")).length, 1);
  // The journal is written again: the run is running and the mark is gone.
  r.setStatus("wf_stop-1", "running");
  assert.deepEqual(r.view("wf_stop-1").settling, null);
  r.setStatus("wf_stop-1", "cancelled");
  assert.deepEqual(r.view("wf_stop-1").resume, { enabled: true, reason: null });
});

test("Resume waits only for the turn that got the message: when it ends without starting the run, it can be sent again", async () => {
  const r = settlingRig();
  const sent = r.ctl.resume({ key: KEY, id: "wf_stop-1" });
  await new Promise((res) => setImmediate(res));
  r.finish();
  await sent;
  r.index.apply({ type: "upsert", session: summary({ status: "running", owner: "ui", updatedAt: 2 }) });
  assert.equal(r.view("wf_stop-1").settling, "resuming", "still the turn that got the message");
  r.index.apply({ type: "upsert", session: summary({ status: "open-idle", owner: "ui", updatedAt: 3 }) });
  assert.deepEqual(r.view("wf_stop-1"), { status: "cancelled", settling: null, stop: null, resume: { enabled: true, reason: null } });
});

test("a failed Resume or Stop leaves no mark", async () => {
  const r = settlingRig();
  r.failNext(new DriveError("Claude CLI refused"));
  const sent = r.ctl.resume({ key: KEY, id: "wf_stop-1" });
  await new Promise((res) => setImmediate(res));
  r.finish();
  await rejectsWith(sent, 502, /refused/);
  assert.equal(r.view("wf_stop-1").settling, null);
  const stopped = r.ctl.stop({ key: KEY, kind: "agent", id: "a1" });
  await new Promise((res) => setImmediate(res));
  r.finish();
  await rejectsWith(stopped, 502, /refused/);
  assert.deepEqual(r.view("a1").stop, { enabled: true, reason: null });
});

test("Stop shows on the row until its files say it stopped, and is not sent twice", async () => {
  const r = settlingRig();
  const first = r.ctl.stop({ key: KEY, kind: "agent", id: "a1" });
  await rejectsWith(r.ctl.stop({ key: KEY, kind: "agent", id: "a1" }), 409, new RegExp(ACTION_REASON.stopping));
  await new Promise((res) => setImmediate(res));
  r.finish();
  await first;
  // The CLI has not written stoppedByUser yet: the row still runs, and says it is stopping.
  assert.deepEqual(r.view("a1"), { status: "running", settling: "stopping", stop: { enabled: false, reason: ACTION_REASON.stopping }, resume: null });
  r.setStatus("a1", "cancelled");
  assert.deepEqual(r.view("a1"), { status: "cancelled", settling: null, stop: null, resume: null });
  assert.deepEqual(r.calls, ["stop a1"]);
});

test("count: the running rows, read light; a Codex session's from the index", async () => {
  const r = settlingRig();
  assert.equal(await r.ctl.count(KEY), 1);
  assert.equal(await rig().ctl.count(CX_KEY), 1);
  await assert.rejects(rig().ctl.count("codex:cx:99999999-2222-4333-8444-555555555555"), (err: unknown) => err instanceof AgentControlError && err.status === 404);
});

// Background shell commands and Monitors (claude/sessionBackgroundTasks.ts) sit in the tab's list
// beside the agents, with Stop and their output, and stay out of `list` (the dashboard's read).
function tasksRig(opts: { driven?: boolean; output?: SessionTaskOutput | null } = {}) {
  const index = new SessionIndex();
  index.apply({ type: "upsert", session: summary({ status: "open-idle", owner: "ui" }) });
  const taskRows: SessionAgentView[] = [
    row({ id: "bsh1", kind: "shell", status: "running", command: "python3 x.py" }),
    row({ id: "bsh2", kind: "shell", status: "completed", exitCode: 0 }),
    row({ id: "bmon1", kind: "monitor", status: "running" }),
  ];
  const calls: string[] = [];
  const ctl = new SessionAgentControl({
    claudeAccounts: [{ id: "acct", dir: cfg }],
    index, hostUp: () => true,
    runs: {
      isDriven: () => opts.driven ?? true,
      workflowTaskId: () => null,
      async stopTask(key: string, taskId: string) { calls.push(`stop ${taskId}`); },
      async send() {},
    },
    claudeRows: () => [row({ id: "a1" })],
    claudeTasks: {
      rows: () => taskRows.map((r) => ({ ...r })),
      output: (key, id) => { calls.push(`output ${id}`); return opts.output === undefined ? { output: "tick 0\n", totalBytes: 7, truncated: false } : opts.output; },
    },
  });
  return { ctl, calls, taskRows };
}

test("listAll adds the background tasks after the agents with Stop on running ones; list leaves them out", async () => {
  const { ctl } = tasksRig();
  assert.deepEqual(ctl.list(KEY).map((r) => r.id), ["a1"]);
  const all = (await ctl.listAll(KEY)).agents;
  assert.deepEqual(all.map((r) => [r.kind, r.id, r.stop?.enabled ?? null]), [["agent", "a1", true], ["shell", "bsh1", true], ["shell", "bsh2", null], ["monitor", "bmon1", true]]);
  assert.equal((await tasksRig({ driven: false }).ctl.listAll(KEY)).agents[1]!.stop?.reason, ACTION_REASON.notDriven);
  assert.equal(await ctl.count(KEY), 3, "the running agent, shell command and Monitor");
});

test("stop sends a background task's id to the process, checks its row and marks it", async () => {
  const { ctl, calls } = tasksRig();
  await ctl.stop({ key: KEY, kind: "shell", id: "bsh1" });
  await ctl.stop({ key: KEY, kind: "monitor", id: "bmon1" });
  assert.deepEqual(calls, ["stop bsh1", "stop bmon1"]);
  const shell = (await ctl.listAll(KEY)).agents.find((r) => r.id === "bsh1")!;
  assert.deepEqual([shell.settling, shell.stop], ["stopping", { enabled: false, reason: ACTION_REASON.stopping }]);
  // Reading the agents alone does not clear a task's mark.
  ctl.list(KEY);
  assert.equal((await ctl.listAll(KEY)).agents.find((r) => r.id === "bsh1")!.settling, "stopping");
  await rejectsWith(ctl.stop({ key: KEY, kind: "shell", id: "bsh2" }), 409, /Not running/);
  await rejectsWith(ctl.stop({ key: KEY, kind: "shell", id: "nope" }), 404, /Not a background task/);
  await rejectsWith(ctl.stop({ key: KEY, kind: "agent", id: "bsh1" }), 404, /Not a subagent/);
});

test("taskOutput reads a listed task's output; unknown tasks are refused", async () => {
  const { ctl, calls } = tasksRig();
  assert.deepEqual(await ctl.taskOutput(KEY, "shell", "bsh1"), { output: "tick 0\n", totalBytes: 7, truncated: false });
  assert.deepEqual(calls, ["output bsh1"]);
  await assert.rejects(ctl.taskOutput(KEY, "shell", "nope"), (e: unknown) => e instanceof AgentControlError && e.status === 404);
  await assert.rejects(ctl.taskOutput(KEY, "agent", "a1"), (e: unknown) => e instanceof AgentControlError && e.status === 400);
  await assert.rejects(ctl.taskOutput(CX_KEY, "shell", "x"), (e: unknown) => e instanceof AgentControlError && e.status === 404, "a Codex session without terminal reading");
  await assert.rejects(tasksRig({ output: null }).ctl.taskOutput(KEY, "shell", "bsh1"), (e: unknown) => e instanceof AgentControlError && e.status === 404 && /No output file/.test(e.message));
  assert.equal(calls.length, 1, "no read for a task that is not listed");
});

// A Codex session's background terminals (codex/backgroundTerminals.ts) join its list after the
// subagent threads, with Stop on a running one, and `list` leaves them out.
function terminalsRig(opts: { driven?: boolean; owner?: SessionSummary["owner"]; fail?: boolean } = {}) {
  const index = new SessionIndex();
  index.apply({ type: "upsert", session: codex(CX, { status: "open-idle", owner: opts.owner ?? "ui" }) });
  const calls: string[] = [];
  const rows: SessionAgentView[] = [
    row({ id: "exec-1", kind: "shell", status: "running", command: "sleep 100", cwd: "/w" }),
    row({ id: "exec-2", kind: "shell", status: "completed", exitCode: 0 }),
  ];
  const ctl = new SessionAgentControl({
    claudeAccounts: [],
    index, hostUp: () => true,
    runs: { isDriven: () => false, workflowTaskId: () => null, async stopTask() {}, async send() {} },
    codexRuns: { isDriven: () => opts.driven ?? true, async interruptSubagent() {} },
    claudeRows: () => [],
    codexTerminals: {
      rows: async () => {
        if (opts.fail) throw new Error("daemon away");
        return rows.map((r) => ({ ...r }));
      },
      output: (_key, id) => (id === "exec-2" ? { output: "done\n", totalBytes: 5, truncated: false } : null),
      knows: (_key, id) => rows.some((r) => r.id === id),
      terminate: async (_key, id) => {
        calls.push(`terminate ${id}`);
        return id === "exec-1";
      },
    },
  });
  return { ctl, calls };
}

test("a Codex session's list holds its terminals with Stop on the running one; list leaves them out", async () => {
  const { ctl } = terminalsRig();
  assert.deepEqual(ctl.list(CX_KEY).map((r) => r.id), []);
  const { agents, warnings } = await ctl.listAll(CX_KEY);
  assert.deepEqual(agents.map((r) => [r.kind, r.id, r.stop?.enabled ?? null]), [["shell", "exec-1", true], ["shell", "exec-2", null]]);
  assert.deepEqual(warnings, []);
  assert.equal(await ctl.count(CX_KEY), 1, "the running terminal");
});

test("a Codex terminal's Stop follows the subagent rule: this server's run, else the reason", async () => {
  const notDriven = (await terminalsRig({ driven: false }).ctl.listAll(CX_KEY)).agents[0]!;
  assert.deepEqual(notDriven.stop, { enabled: false, reason: ACTION_REASON.notDriven });
  const terminal = (await terminalsRig({ driven: false, owner: "terminal" }).ctl.listAll(CX_KEY)).agents[0]!;
  assert.deepEqual(terminal.stop, { enabled: false, reason: ACTION_REASON.terminalStop });
});

test("stop ends the terminal by its row id, marks the row, and refuses a finished one", async () => {
  const { ctl, calls } = terminalsRig();
  await ctl.stop({ key: CX_KEY, kind: "shell", id: "exec-1" });
  assert.deepEqual(calls, ["terminate exec-1"]);
  const stopping = (await ctl.listAll(CX_KEY)).agents.find((r) => r.id === "exec-1")!;
  assert.deepEqual([stopping.settling, stopping.stop], ["stopping", { enabled: false, reason: ACTION_REASON.stopping }]);
  await rejectsWith(ctl.stop({ key: CX_KEY, kind: "shell", id: "exec-2" }), 409, /Not running/);
  await rejectsWith(ctl.stop({ key: CX_KEY, kind: "shell", id: "nope" }), 404, /Not a background task/);
  await rejectsWith(terminalsRig({ driven: false }).ctl.stop({ key: CX_KEY, kind: "shell", id: "exec-1" }), 409, new RegExp(ACTION_REASON.notDriven));
});

test("a Codex terminal's output is its item's; an unknown row is 404", async () => {
  const { ctl } = terminalsRig();
  assert.deepEqual(await ctl.taskOutput(CX_KEY, "shell", "exec-2"), { output: "done\n", totalBytes: 5, truncated: false });
  assert.deepEqual(await ctl.taskOutput(CX_KEY, "shell", "exec-1"), { output: "", totalBytes: 0, truncated: false }, "running: the daemon gives none");
  await assert.rejects(ctl.taskOutput(CX_KEY, "shell", "nope"), (e: unknown) => e instanceof AgentControlError && e.status === 404);
  await assert.rejects(ctl.taskOutput(CX_KEY, "monitor", "exec-1"), (e: unknown) => e instanceof AgentControlError && e.status === 404);
});

test("terminals that cannot be read leave the subagent rows and a warning; the count ignores them", async () => {
  const { ctl } = terminalsRig({ fail: true });
  const { agents, warnings } = await ctl.listAll(CX_KEY);
  assert.deepEqual(agents, []);
  assert.match(warnings[0]!, /Could not read background terminals: daemon away/);
  assert.equal(await ctl.count(CX_KEY), 0);
});
