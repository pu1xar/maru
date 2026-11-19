import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionAgentView, SessionSummary } from "@maru/shared";
import { ACTION_REASON, findWorkflowLaunch, readWorkflowRecord, withActions, workflowResumePrompt } from "./agentControl.ts";
import { listSessionAgents } from "./sessionAgents.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-control-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const KEY = `claude:acct:${SID}`;

function summary(over: Partial<SessionSummary>): SessionSummary {
  return {
    key: KEY, provider: "claude", account: "acct", id: SID, cwd: "/w", name: null, title: null,
    preview: null, status: "open-idle", owner: "ui", pid: 1, tmuxPane: null, parentKey: null,
    updatedAt: 1, createdAt: null, sizeBytes: null, entrypoint: "maru", ...over,
  };
}

function row(over: Partial<SessionAgentView>): SessionAgentView {
  return {
    id: "a1", kind: "agent", title: "t", status: "running", agentType: null, model: null, parentAgentId: null,
    childThreadId: null, startedAt: null, updatedAt: null, completedAt: null, ...over,
  };
}

const ROWS = [
  row({ id: "a1" }),
  row({ id: "a2", status: "completed" }),
  row({ id: "wf_run-1", kind: "workflow", status: "running" }),
  row({ id: "wf_stop-2", kind: "workflow", status: "cancelled" }),
  row({ id: "wf_gone-3", kind: "workflow", status: "interrupted" }),
  row({ id: "wf_fail-4", kind: "workflow", status: "failed" }),
  row({ id: "wf_done-5", kind: "workflow", status: "completed" }),
  row({ id: "a3", status: "interrupted" }),
];

const actions = (rows: SessionAgentView[]) =>
  Object.fromEntries(rows.map((r) => [r.id, { stop: r.stop ? (r.stop.reason ?? "ok") : null, resume: r.resume ? (r.resume.reason ?? "ok") : null }]));

test("a session this server drives: running rows stop, stopped workflows resume, the rest offer nothing", () => {
  const got = actions(withActions(ROWS, { session: summary({ status: "running" }), driven: true, hostUp: true }));
  assert.deepEqual(got, {
    a1: { stop: "ok", resume: null },
    a2: { stop: null, resume: null },
    "wf_run-1": { stop: "ok", resume: null },
    "wf_stop-2": { stop: null, resume: "ok" },
    "wf_gone-3": { stop: null, resume: "ok" },
    "wf_fail-4": { stop: null, resume: "ok" },
    "wf_done-5": { stop: null, resume: null },
    a3: { stop: null, resume: null },
  });
});

test("a terminal holds the session: both actions show disabled with the reason", () => {
  const rows = withActions(ROWS, { session: summary({ owner: "terminal", status: "running" }), driven: false, hostUp: true });
  assert.deepEqual(rows.find((r) => r.id === "a1")!.stop, { enabled: false, reason: ACTION_REASON.terminalStop });
  assert.deepEqual(rows.find((r) => r.id === "wf_stop-2")!.resume, { enabled: false, reason: ACTION_REASON.terminalResume });
});

test("before the index has read the session (just after a restart): only a session this server runs offers actions", () => {
  const unread = withActions(ROWS, { session: undefined, driven: false, hostUp: true });
  assert.deepEqual(unread.find((r) => r.id === "a1")!.stop, { enabled: false, reason: ACTION_REASON.unread });
  assert.deepEqual(unread.find((r) => r.id === "wf_gone-3")!.resume, { enabled: false, reason: ACTION_REASON.unread });
  const ours = withActions(ROWS, { session: undefined, driven: true, hostUp: true });
  assert.deepEqual(ours.find((r) => r.id === "a1")!.stop, { enabled: true, reason: null });
});

test("a closed session can resume a workflow (the send resumes it); the host being away disables both", () => {
  const closed = withActions(ROWS, { session: summary({ owner: "none", status: "closed" }), driven: false, hostUp: true });
  assert.deepEqual(closed.find((r) => r.id === "wf_gone-3")!.resume, { enabled: true, reason: null });
  const down = withActions(ROWS, { session: summary({}), driven: true, hostUp: false });
  assert.deepEqual(down.find((r) => r.id === "a1")!.stop, { enabled: false, reason: ACTION_REASON.hostDown });
  assert.deepEqual(down.find((r) => r.id === "wf_gone-3")!.resume, { enabled: false, reason: ACTION_REASON.hostDown });
  // Open but run by another process that is not a terminal's (another server's host).
  const other = withActions(ROWS, { session: summary({ owner: "ui" }), driven: false, hostUp: true });
  assert.deepEqual(other.find((r) => r.id === "a1")!.stop, { enabled: false, reason: ACTION_REASON.notDriven });
});

test("the resume message is the CLI's, with the args as JSON when the launch had them", () => {
  assert.equal(
    workflowResumePrompt({ scriptPath: "/w/a.workflow.js", runId: "wf_32aaed88-412" }),
    "I want this workflow to continue. Resume the paused workflow by calling: Workflow({scriptPath: '/w/a.workflow.js', resumeFromRunId: 'wf_32aaed88-412'}). Completed agents return cached results.",
  );
  assert.equal(
    workflowResumePrompt({ scriptPath: "/s.js", runId: "wf_x-1", args: { files: ["a.ts"], n: 2 } }),
    "I want this workflow to continue. Resume the paused workflow by calling: Workflow({scriptPath: '/s.js', resumeFromRunId: 'wf_x-1', args: {\"files\":[\"a.ts\"],\"n\":2}}). Completed agents return cached results.",
  );
  // Neither an em dash nor a middle dot (the CLI's own prompt has a dash).
  const banned = new RegExp(`[${String.fromCharCode(0x2014, 0x00b7)}]`);
  assert.doesNotMatch(workflowResumePrompt({ scriptPath: "/s.js", runId: "wf_x-1" }), banned);
});

// A transcript as the CLI writes it: the Workflow call, its async_launched result, a resume.
function writeTranscript(file: string): void {
  const lines = [
    { type: "user", message: { role: "user", content: "go" } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Workflow", input: { scriptPath: "/w/s.js", args: ["x"] } }] } },
    {
      type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "launched" }] },
      toolUseResult: { status: "async_launched", taskId: "w-first", taskType: "local_workflow", runId: "wf_run-1", scriptPath: "/w/s.js" },
    },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu9", name: "Workflow", input: { script: "export const meta = {}" } }] } },
    {
      type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu9", content: "launched" }] },
      toolUseResult: { status: "async_launched", taskId: "w-other", taskType: "local_workflow", runId: "wf_other-9", scriptPath: "/x/other.js" },
    },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "Workflow", input: { scriptPath: "/w/s.js", resumeFromRunId: "wf_run-1", args: ["x"] } }] } },
    {
      type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: "launched" }] },
      toolUseResult: { status: "async_launched", taskId: "w-second", taskType: "local_workflow", runId: "wf_run-1", scriptPath: "/w/s.js" },
    },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n{torn");
}

test("findWorkflowLaunch takes the newest launch of the run with the args of its call", async () => {
  const tx = path.join(root, "launch.jsonl");
  writeTranscript(tx);
  assert.deepEqual(await findWorkflowLaunch(tx, "wf_run-1"), { runId: "wf_run-1", taskId: "w-second", scriptPath: "/w/s.js", args: ["x"] });
  assert.deepEqual(await findWorkflowLaunch(tx, "wf_other-9"), { runId: "wf_other-9", taskId: "w-other", scriptPath: "/x/other.js" });
  assert.equal(await findWorkflowLaunch(tx, "wf_none-0"), null);
  assert.equal(await findWorkflowLaunch(path.join(root, "missing.jsonl"), "wf_run-1"), null);
  assert.equal(await findWorkflowLaunch(tx, "../etc"), null, "not a run id");
});

test("readWorkflowRecord: the final record first, then the transcript, then the CLI's copy of an inline script", async () => {
  const a = path.join(root, "rec-a", SID);
  const b = path.join(root, "rec-b", SID);
  fs.mkdirSync(path.join(a, "workflows"), { recursive: true });
  fs.mkdirSync(path.join(b, "workflows", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(b, "workflows", "wf_final-1.json"), JSON.stringify({ runId: "wf_final-1", status: "killed", scriptPath: "/p/f.js", args: { k: 1 }, taskId: "w1" }));
  fs.writeFileSync(path.join(b, "workflows", "scripts", "my-flow-wf_inline-2.js"), "export const meta = {}");
  const tx = path.join(root, "rec.jsonl");
  writeTranscript(tx);
  assert.deepEqual(await readWorkflowRecord([a, b], tx, "wf_final-1"), { runId: "wf_final-1", scriptPath: "/p/f.js", args: { k: 1 } });
  assert.deepEqual(await readWorkflowRecord([a, b], tx, "wf_run-1"), { runId: "wf_run-1", scriptPath: "/w/s.js", args: ["x"] });
  assert.deepEqual(await readWorkflowRecord([a, b], tx, "wf_inline-2"), { runId: "wf_inline-2", scriptPath: path.join(b, "workflows", "scripts", "my-flow-wf_inline-2.js") });
  assert.equal(await readWorkflowRecord([a, b], null, "wf_run-1"), null);
});

// ---- the rows' states from the files (sessionAgents.ts) ----

function setMtime(file: string, ms: number): void {
  fs.utimesSync(file, new Date(ms), new Date(ms));
}

test("listSessionAgents: stoppedByUser is cancelled, and a stopped workflow resumed after its final record runs again", () => {
  const cfg = path.join(root, "cfg");
  const proj = path.join(cfg, "projects", "-w");
  const sub = path.join(proj, SID, "subagents");
  fs.mkdirSync(path.join(sub, "workflows", "wf_k-1"), { recursive: true });
  fs.mkdirSync(path.join(proj, SID, "workflows"), { recursive: true });
  fs.writeFileSync(path.join(proj, `${SID}.jsonl`), "{}\n");
  const agent = (id: string, meta: object) => {
    fs.writeFileSync(path.join(sub, `agent-${id}.meta.json`), JSON.stringify({ description: id, ...meta }));
    fs.writeFileSync(path.join(sub, `agent-${id}.jsonl`), "{}\n");
  };
  agent("done", { finished: true });
  agent("stopped", { stoppedByUser: true });
  agent("live", {});
  agent("old", {});
  const now = Date.now();
  setMtime(path.join(sub, "agent-old.jsonl"), now - 600_000);
  const journal = path.join(sub, "workflows", "wf_k-1", "journal.jsonl");
  const final = path.join(proj, SID, "workflows", "wf_k-1.json");
  const rec = (o: object) => JSON.stringify(o);
  fs.writeFileSync(journal, [
    rec({ type: "launched" }),
    rec({ type: "started", key: "v2:q", agentId: "q1", label: "quick", phase: "Quick" }),
    rec({ type: "result", key: "v2:q", agentId: "q1", result: "one" }),
    rec({ type: "started", key: "v2:s", agentId: "s1", label: "slow", phase: "Slow" }),
  ].join("\n") + "\n");
  fs.writeFileSync(final, JSON.stringify({ runId: "wf_k-1", status: "killed", workflowName: "probe", scriptPath: "/s.js", workflowProgress: [] }));
  setMtime(journal, now - 20_000);
  setMtime(final, now - 10_000);
  const accounts = [{ id: "acct", dir: cfg }];
  const open = true;
  const byId = (rows: SessionAgentView[]) => Object.fromEntries(rows.map((r) => [r.id, r]));

  let rows = byId(listSessionAgents(KEY, accounts, open, now - 300_000));
  assert.equal(rows.done!.status, "completed");
  assert.equal(rows.stopped!.status, "cancelled");
  assert.equal(rows.live!.status, "running");
  assert.equal(rows.old!.status, "interrupted", "written before the current process started");
  assert.equal(rows["wf_k-1"]!.status, "cancelled", "the final record says killed");
  assert.equal(rows["wf_k-1"]!.title, "probe");

  // Resumed: the slow agent starts again under the same key, after the final record.
  fs.appendFileSync(journal, rec({ type: "started", key: "v2:s", agentId: "s2", label: "slow", phase: "Slow" }) + "\n");
  setMtime(journal, now - 1000);
  rows = byId(listSessionAgents(KEY, accounts, open, now - 300_000));
  const wf = rows["wf_k-1"]!;
  assert.equal(wf.status, "running");
  assert.equal(wf.title, "probe", "the name stays from the final record");
  assert.deepEqual(wf.workflow!.agents.map((a) => [a.label, a.agentId, a.state]), [["quick", "q1", "completed"], ["slow", "s2", "running"]]);
  assert.equal(wf.completedAt, null);

  // The same files with the session closed: the resumed run did not finish.
  rows = byId(listSessionAgents(KEY, accounts, false, null));
  assert.equal(rows["wf_k-1"]!.status, "interrupted");
  assert.equal(rows.live!.status, "interrupted");
});

test("listSessionAgents: a first run is named by its launch, a resumed run keeps the finished agents' numbers", () => {
  const SID2 = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const key = `claude:acct:${SID2}`;
  const cfg = path.join(root, "cfg-metrics");
  const proj = path.join(cfg, "projects", "-w");
  const runs = path.join(proj, SID2, "subagents", "workflows");
  fs.mkdirSync(path.join(runs, "wf_m-1"), { recursive: true });
  fs.mkdirSync(path.join(runs, "wf_inline-2"), { recursive: true });
  fs.mkdirSync(path.join(proj, SID2, "workflows", "scripts"), { recursive: true });
  const tx = path.join(proj, `${SID2}.jsonl`);
  const rec = (o: object) => JSON.stringify(o);
  fs.writeFileSync(tx, rec({ type: "user", message: { content: "go" } }) + "\n");
  fs.writeFileSync(path.join(proj, SID2, "workflows", "scripts", "inline-flow-wf_inline-2.js"), "export const meta = {}");
  const journal = path.join(runs, "wf_m-1", "journal.jsonl");
  fs.writeFileSync(journal, [
    rec({ type: "launched" }),
    rec({ type: "started", key: "v2:q", agentId: "q1", label: "quick", phase: "P" }),
    rec({ type: "result", key: "v2:q", agentId: "q1", result: "one" }),
    rec({ type: "started", key: "v2:s", agentId: "s1", label: "slow", phase: "P" }),
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(runs, "wf_inline-2", "journal.jsonl"), rec({ type: "launched" }) + "\n");
  const accounts = [{ id: "acct", dir: cfg }];
  const byId = (rows: SessionAgentView[]) => Object.fromEntries(rows.map((r) => [r.id, r]));

  // Running with no final record, before its launch is in the transcript: the run id, or the name
  // of the CLI's copy of an inline script.
  let rows = byId(listSessionAgents(key, accounts, true, null));
  assert.equal(rows["wf_m-1"]!.title, "wf_m-1");
  assert.equal(rows["wf_inline-2"]!.title, "inline-flow");
  // The launch is appended to the transcript: its workflowName names the run.
  fs.appendFileSync(tx, rec({
    type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "launched" }] },
    toolUseResult: { status: "async_launched", taskId: "w1", runId: "wf_m-1", workflowName: "metrics-probe", scriptPath: "/s.js" },
  }) + "\n");
  rows = byId(listSessionAgents(key, accounts, true, null));
  assert.equal(rows["wf_m-1"]!.title, "metrics-probe");
  assert.equal(rows["wf_m-1"]!.workflow!.name, "metrics-probe");
  assert.equal(rows["wf_m-1"]!.status, "running");
  const light = listSessionAgents(key, accounts, true, null, { light: true }).find((r) => r.id === "wf_m-1")!;
  assert.deepEqual([light.status, light.workflow], ["running", undefined], "light rows carry the state only");

  // Stopped: the final record has the numbers of the agents.
  const now = Date.now();
  const final = path.join(proj, SID2, "workflows", "wf_m-1.json");
  const agentEntry = (o: object) => ({ type: "workflow_agent", phaseIndex: 1, phaseTitle: "P", ...o });
  fs.writeFileSync(final, JSON.stringify({
    runId: "wf_m-1", status: "killed", workflowName: "metrics-probe", scriptPath: "/s.js",
    workflowProgress: [
      { type: "workflow_phase", index: 1, title: "P" },
      agentEntry({ index: 1, label: "quick", agentId: "q1", state: "done", tokens: 21000, toolCalls: 0, durationMs: 5000 }),
      agentEntry({ index: 2, label: "slow", agentId: "s1", state: "killed", tokens: 900, toolCalls: 1, durationMs: 9000 }),
    ],
  }));
  fs.utimesSync(journal, new Date(now - 20_000), new Date(now - 20_000));
  fs.utimesSync(final, new Date(now - 10_000), new Date(now - 10_000));
  const quick = () => byId(listSessionAgents(key, accounts, true, null))["wf_m-1"]!.workflow!.agents.find((a) => a.label === "quick")!;
  assert.deepEqual([quick().totalTokens, quick().toolCalls, quick().durationMs], [21000, 0, 5000]);

  // Resumed: the journal runs again without numbers; the finished agent keeps the final record's.
  fs.appendFileSync(journal, rec({ type: "started", key: "v2:s", agentId: "s2", label: "slow", phase: "P" }) + "\n");
  fs.utimesSync(journal, new Date(now - 1000), new Date(now - 1000));
  const resumed = byId(listSessionAgents(key, accounts, true, null))["wf_m-1"]!;
  assert.equal(resumed.status, "running");
  assert.deepEqual(resumed.workflow!.agents.map((a) => [a.label, a.agentId, a.state, a.totalTokens ?? null, a.toolCalls ?? null, a.durationMs ?? null]), [
    ["quick", "q1", "completed", 21000, 0, 5000],
    ["slow", "s2", "running", null, null, null],
  ]);

  // The resumed run's own final record gives the cached agent no numbers: the ones seen before stay.
  fs.writeFileSync(final, JSON.stringify({
    runId: "wf_m-1", status: "completed", workflowName: "metrics-probe", scriptPath: "/s.js",
    workflowProgress: [
      agentEntry({ index: 1, label: "quick", agentId: "q1", state: "done", cached: true }),
      agentEntry({ index: 2, label: "slow", agentId: "s2", state: "done", tokens: 1200, toolCalls: 2, durationMs: 7000 }),
    ],
  }));
  assert.deepEqual([quick().totalTokens, quick().toolCalls, quick().durationMs], [21000, 0, 5000]);
});
