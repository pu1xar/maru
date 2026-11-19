import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IndexEvent, PendingQuestionView, SessionAgentView, SessionSummary } from "@maru/shared";
import { DashboardWorkService } from "./work.ts";

type T = { after(fn: () => unknown): void };

const SID = {
  a: "aaaaaaaa-0000-4000-8000-000000000001",
  b: "bbbbbbbb-0000-4000-8000-000000000002",
  c: "cccccccc-0000-4000-8000-000000000003",
  x: "dddddddd-0000-4000-8000-000000000004",
};

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  const provider = over.provider ?? "claude";
  const account = over.account ?? (provider === "claude" ? "claude-a" : "codex-a");
  return {
    key: `${provider}:${account}:${id}`, provider, account, id, cwd: "/w", name: null, title: `title ${id.slice(0, 4)}`, preview: null,
    status: "closed", owner: "none", pid: null, tmuxPane: null, parentKey: null, updatedAt: 1000, createdAt: null,
    sizeBytes: null, entrypoint: null, ...over,
  };
}

function row(id: string, over: Partial<SessionAgentView> = {}): SessionAgentView {
  return {
    id, kind: "agent", title: id, status: "completed", agentType: null, model: null, parentAgentId: null, childThreadId: null,
    startedAt: null, updatedAt: null, completedAt: null, ...over,
  };
}

/** One Claude account with a project folder; the list's sessions and rows are set by the test. */
function setup(t: T, now = { t: 1_000_000 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, ".claude-a");
  const proj = path.join(dir, "projects", "-w");
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(dir, "sessions"));
  const list = new Map<string, SessionSummary>();
  const listeners = new Set<(e: IndexEvent) => void>();
  const rowsBy = new Map<string, SessionAgentView[]>();
  const reads = new Map<string, number>();
  const pending: Array<{ key: string; questions: PendingQuestionView[] }> = [];
  const driven = new Set<string>();
  const state = { hostUp: true };
  const put = (s: SessionSummary) => {
    list.set(s.key, s);
    for (const l of listeners) l({ type: "upsert", session: s });
  };
  const transcript = (id: string, lines: unknown[]) => {
    const file = path.join(proj, `${id}.jsonl`);
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return file;
  };
  const work = new DashboardWorkService({
    claudeAccounts: [{ id: "claude-a", dir }],
    sessions: () => [...list.values()],
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    get: (key) => list.get(key),
    rows: (key) => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return rowsBy.get(key) ?? [];
    },
    pending: () => pending,
    driven: (key) => driven.has(key),
    hostUp: () => state.hostUp,
    now: () => now.t,
  });
  t.after(() => work.close());
  return { work, put, list, rowsBy, reads, pending, driven, state, dir, proj, transcript, now };
}

const question: PendingQuestionView = {
  requestId: "r1", toolUseId: "tu1", toolName: "AskUserQuestion", kind: "question",
  input: { questions: [{ question: "Which color?", options: [{ label: "Blue" }] }] }, title: null, description: null,
};

test("attention: a question waiting here, input another client holds, a run whose question is on its way", async (t) => {
  const s = setup(t);
  s.put(session(SID.a, { status: "waiting-input", owner: "ui" }));
  s.put(session(SID.b, { status: "waiting-input", owner: "terminal" }));
  s.put(session(SID.c, { status: "waiting-input", owner: "ui" }));
  s.put(session(SID.x, { provider: "codex", status: "waiting-input", owner: "terminal" }));
  s.pending.push({ key: `claude:claude-a:${SID.a}`, questions: [question] });
  const w = await s.work.snapshot();
  assert.deepEqual(
    w.attention.map((a) => [a.kind, a.session.key, a.kind === "question" ? a.titles : a.kind === "waiting" ? a.reason : null]),
    [
      ["question", `claude:claude-a:${SID.a}`, ["Which color?"]],
      ["waiting", `claude:claude-a:${SID.b}`, "Must be answered in the terminal"],
      ["question", `claude:claude-a:${SID.c}`, []],
      ["waiting", `codex:codex-a:${SID.x}`, "Must be answered in another client (such as a terminal)"],
    ],
  );
  assert.equal(w.turns.length, 0);
});

test("a question of a run off the list still shows", async (t) => {
  const s = setup(t);
  const off = session(SID.a, { status: "waiting-input", owner: "ui" });
  s.pending.push({ key: off.key, questions: [question] });
  // Not on the list: the index still knows it.
  const work = new DashboardWorkService({
    claudeAccounts: [{ id: "claude-a", dir: s.dir }], sessions: () => [], subscribe: () => () => {}, get: (k) => (k === off.key ? off : undefined),
    rows: () => [], pending: () => s.pending, driven: () => true, hostUp: () => true,
  });
  t.after(() => work.close());
  assert.deepEqual((await work.snapshot()).attention.map((a) => a.kind), ["question"]);
});

test("turns: when each began, and who may stop it", async (t) => {
  const now = { t: 5_000_000 };
  const s = setup(t, now);
  // A Claude session already running before the dashboard saw it: its registration says since when.
  fs.writeFileSync(path.join(s.dir, "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: SID.a, status: "busy", statusUpdatedAt: 4_000_000 }));
  s.put(session(SID.a, { status: "running", owner: "ui", pid: 4242 }));
  // A session seen idle, then running: it began when the change came.
  s.put(session(SID.b, { status: "open-idle", owner: "terminal", pid: 1 }));
  now.t = 5_100_000;
  s.put(session(SID.b, { status: "running", owner: "terminal", pid: 1 }));
  // A Codex thread first seen running long after its last activity: unknown.
  s.put(session(SID.x, { provider: "codex", status: "running", owner: "ui", updatedAt: 1 }));
  const w = await s.work.snapshot();
  assert.deepEqual(
    w.turns.map((x) => [x.session.key.slice(-1), x.startedAt, x.stop.enabled, x.stop.reason]),
    [
      ["1", 4_000_000, true, null],
      ["2", 5_100_000, false, "Running in a terminal, so it cannot be stopped here"],
      ["4", null, true, null],
    ],
  );
  // Waiting for an answer keeps the span; idle ends it.
  now.t = 5_200_000;
  s.put(session(SID.b, { status: "waiting-input", owner: "terminal", pid: 1 }));
  s.put(session(SID.b, { status: "running", owner: "terminal", pid: 1 }));
  assert.equal((await s.work.snapshot()).turns.find((x) => x.session.key.endsWith("2"))?.startedAt, 5_100_000);
  s.put(session(SID.b, { status: "open-idle", owner: "terminal", pid: 1 }));
  now.t = 5_300_000;
  s.put(session(SID.b, { status: "running", owner: "terminal", pid: 1 }));
  assert.equal((await s.work.snapshot()).turns.find((x) => x.session.key.endsWith("2"))?.startedAt, 5_300_000);
  s.state.hostUp = false;
  assert.equal((await s.work.snapshot()).turns[0]?.stop.reason, "Claude session host is down");
});

test("tasks: running rows and resumable workflows of open sessions; closed sessions are not read", async (t) => {
  const s = setup(t);
  s.transcript(SID.a, [{ type: "user", message: { content: "hi" } }]);
  const open = session(SID.a, { status: "open-idle", owner: "ui", pid: 7 });
  s.put(open);
  s.put(session(SID.b, { status: "closed" }));
  s.rowsBy.set(open.key, [
    row("run1", { status: "running", stop: { enabled: true, reason: null } }),
    row("done1"),
    row("wf_1", { kind: "workflow", status: "cancelled", resume: { enabled: true, reason: null } }),
    row("int1", { status: "interrupted" }),
  ]);
  s.rowsBy.set(`claude:claude-a:${SID.b}`, [row("run2", { status: "running" })]);
  const w = await s.work.snapshot();
  assert.deepEqual(w.tasks.map((x) => x.agent.id), ["run1", "wf_1"]);
  assert.equal(s.reads.get(`claude:claude-a:${SID.b}`), undefined, "a closed session's files are not read");
  assert.deepEqual({ open: w.stats.open, reread: w.stats.reread }, { open: 1, reread: 1 });
});

test("an open session's files are read again only for running rows or a change", async (t) => {
  const s = setup(t);
  s.transcript(SID.a, [{ type: "user", message: { content: "hi" } }]);
  const sub = path.join(s.proj, SID.a, "subagents");
  fs.mkdirSync(sub, { recursive: true });
  const base = session(SID.a, { status: "open-idle", owner: "ui", pid: 7 });
  s.put(base);
  s.rowsBy.set(base.key, [row("done1")]);
  await s.work.snapshot();
  await s.work.snapshot();
  assert.equal(s.reads.get(base.key), 1, "nothing changed: the last read answers");
  assert.equal((await s.work.snapshot()).stats.reused, 1);

  // A new agent adds files to the session's folder.
  fs.writeFileSync(path.join(sub, "agent-n.meta.json"), "{}");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(sub, later, later);
  s.rowsBy.set(base.key, [row("n", { status: "running" })]);
  assert.deepEqual((await s.work.snapshot()).tasks.map((x) => x.agent.id), ["n"]);
  assert.equal(s.reads.get(base.key), 2);
  // While a row runs, every answer reads again.
  s.rowsBy.set(base.key, [row("n", { status: "completed" })]);
  assert.equal((await s.work.snapshot()).tasks.length, 0);
  assert.equal(s.reads.get(base.key), 3);
  await s.work.snapshot();
  assert.equal(s.reads.get(base.key), 3);
  // The session itself moved (a new turn, another process): read again.
  s.put({ ...base, updatedAt: 2000 });
  await s.work.snapshot();
  assert.equal(s.reads.get(base.key), 4);
  // This server's run took it over.
  s.driven.add(base.key);
  await s.work.snapshot();
  assert.equal(s.reads.get(base.key), 5);
});

test("errors: a Claude transcript that ends on an API error, until something follows it; the tail is read on change only", async (t) => {
  const s = setup(t);
  const file = s.transcript(SID.a, [
    { type: "user", message: { content: "go" } },
    { type: "assistant", isApiErrorMessage: true, error: "server_error", timestamp: "2026-11-16T01:00:00Z", message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 500" }] } },
    { type: "system", subtype: "turn_duration" },
  ]);
  s.put(session(SID.a, { status: "closed" }));
  s.put(session(SID.x, { provider: "codex", status: "error", owner: "terminal", updatedAt: 1234 }));
  const w = await s.work.snapshot();
  assert.deepEqual(
    w.attention.map((a) => (a.kind === "error" ? [a.session.key.slice(-1), a.code, a.message, a.at, a.send.enabled] : null)),
    [
      ["1", "server_error", "API Error: 500", Date.parse("2026-11-16T01:00:00Z"), true],
      ["4", "systemError", "Thread is in an error state (systemError)", 1234, true],
    ],
  );
  assert.equal(w.stats.tails, 1);
  assert.equal((await s.work.snapshot()).stats.tails, 0, "unchanged file: the last check answers");
  // A terminal holds the session: sending from here is off.
  s.put(session(SID.a, { status: "open-idle", owner: "terminal", pid: 3 }));
  const held = (await s.work.snapshot()).attention.find((a) => a.kind === "error" && a.session.key.endsWith("1"));
  assert.deepEqual(held?.kind === "error" ? held.send : null, { enabled: false, reason: "Open in a terminal, so you cannot send from here" });
  // The user continued it.
  fs.appendFileSync(file, JSON.stringify({ type: "user", message: { content: "retry" } }) + "\n");
  const after = await s.work.snapshot();
  assert.equal(after.attention.filter((a) => a.kind === "error" && a.session.provider === "claude").length, 0);
  assert.equal(after.stats.tails, 1);
  // A running session is not checked.
  s.put(session(SID.a, { status: "running", owner: "ui", pid: 3 }));
  assert.equal((await s.work.snapshot()).stats.tails, 0);
});

test("a task row leaves the workflow's phases and agents to the Activity tab and says how far its agents got", async (t) => {
  const s = setup(t);
  s.transcript(SID.a, [{ type: "user", message: { content: "hi" } }]);
  const open = session(SID.a, { status: "open-idle", owner: "ui", pid: 7 });
  s.put(open);
  type WorkflowAgent = NonNullable<SessionAgentView["workflow"]>["agents"][number];
  const agent = (label: string, state: WorkflowAgent["state"]) => ({ label, state }) as WorkflowAgent;
  s.rowsBy.set(open.key, [
    row("wf_1", {
      kind: "workflow", status: "running",
      workflow: { phases: [], agents: [agent("a", "completed"), agent("b", "running"), agent("c", "completed")] },
    }),
    row("sub", { status: "running" }),
  ]);
  const w = await s.work.snapshot();
  assert.deepEqual(w.tasks.map((x) => [x.agent.id, x.agent.progress, "workflow" in x.agent]), [
    ["wf_1", { done: 2, total: 3 }, false],
    ["sub", null, false],
  ]);
  assert.deepEqual(Object.keys(w.tasks[0]!.session).sort(), ["account", "cwd", "key", "label", "owner", "provider", "status"]);
});
