// The right panel's "작업" tab (DESIGN.md 6e, 6i): each session's subagents and workflows with what
// each row can do, and the two actions.
// - 중단: a Claude subagent or workflow goes to stopTask of the session's CLI process (the task id
//   of a subagent is its agent id; a workflow's comes from its newest launch, claude/agentControl.ts).
//   A Codex subagent thread gets turn/interrupt on its running turn (CodexRuns.interruptSubagent).
// - 이어서 실행: a stopped, interrupted or failed workflow; the session gets the CLI's resume
//   message, which resumes a closed session like any send.
// The server checks again what the UI offered: the row must exist and be in a state for the action.
// An action this server sent stays on its row as `settling` until the files show its effect, and
// the row refuses the same action meanwhile (two clicks send one resume message).
import type {
  AgentAction, IndexEvent, ResumeSessionWorkflow, ResumeSessionWorkflowResult, SessionAgentView, SessionSummary,
  SessionTaskOutput, StopSessionAgent,
} from "@maru/shared";
import { ACTION_REASON, findWorkflowLaunch, readWorkflowRecord, withActions, workflowResumePrompt } from "../claude/agentControl.ts";
import { claudeSessionFiles, type ListSessionAgentsOptions } from "../claude/sessionAgents.ts";
import type { CodexBackgroundTerminals } from "../codex/backgroundTerminals.ts";
import { RpcError } from "../codex/rpc.ts";
import { HostRequestError } from "../host/client.ts";
import { HostDownError } from "../claude/hostLink.ts";
import type { ClaudeAccount } from "../config.ts";
import type { SessionIndex } from "../index/store.ts";
import { DriveError, type ClaudeRuns } from "./claudeRuns.ts";
import type { CodexRuns } from "./codexRuns.ts";

export class AgentControlError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface SessionAgentControlDeps {
  claudeAccounts: ClaudeAccount[];
  /** `subscribe` lets a resume end its wait when the session's turn ends without starting the run. */
  index: Pick<SessionIndex, "get" | "snapshot"> & Partial<Pick<SessionIndex, "subscribe">>;
  runs: Pick<ClaudeRuns, "isDriven" | "stopTask" | "workflowTaskId" | "send">;
  codexRuns?: Pick<CodexRuns, "isDriven" | "interruptSubagent">;
  /** The Claude session host is connected. */
  hostUp: () => boolean;
  /** A Claude session's rows from its files (claude/sessionAgents.ts listSessionAgents). */
  claudeRows: (key: string, opts?: ListSessionAgentsOptions) => SessionAgentView[];
  /**
   * A Claude session's background shell commands and Monitors (claude/sessionBackgroundTasks.ts),
   * with their output. Left out, the list has agents and workflows only.
   */
  claudeTasks?: {
    rows: (key: string) => SessionAgentView[];
    output: (key: string, taskId: string) => SessionTaskOutput | null;
  };
  /**
   * A Codex session's background terminals (codex/backgroundTerminals.ts). Left out, a Codex
   * session's list has its subagents only.
   */
  codexTerminals?: Pick<CodexBackgroundTerminals, "rows" | "output" | "knows" | "terminate">;
}

const CODEX_KEY_RE = /^codex:[^:]+:[0-9a-f-]{36}$/;

/** The states the conversation header counts as running (t3 isOrchestrationV2WorkActive). */
const ACTIVE = new Set<SessionAgentView["status"]>(["running", "pending", "waiting"]);

function iso(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

const CODEX_STATUS: Record<SessionSummary["status"], SessionAgentView["status"]> = {
  running: "running",
  "waiting-input": "waiting",
  // A Codex subagent thread can take more work (resumeAgent), and the index cannot tell a finished
  // turn from an interrupted one.
  "open-idle": "idle",
  closed: "idle",
  error: "failed",
};

/**
 * A Codex session's subagent threads, from the index (each one's parentKey), nested under the
 * thread that spawned it. 중단 is offered on a running thread; it needs the root thread to be this
 * server's.
 */
export function codexAgentRows(root: SessionSummary, sessions: readonly SessionSummary[], driven: boolean): SessionAgentView[] {
  const children = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    if (s.provider !== "codex" || !s.parentKey) continue;
    const list = children.get(s.parentKey) ?? [];
    list.push(s);
    children.set(s.parentKey, list);
  }
  const stop: AgentAction = driven
    ? { enabled: true, reason: null }
    : { enabled: false, reason: root.owner === "terminal" && root.status !== "closed" ? ACTION_REASON.terminalStop : ACTION_REASON.notDriven };
  const out: SessionAgentView[] = [];
  const seen = new Set<string>([root.key]);
  const walk = (parent: SessionSummary) => {
    for (const s of children.get(parent.key) ?? []) {
      if (seen.has(s.key)) continue;
      seen.add(s.key);
      const status = CODEX_STATUS[s.status];
      out.push({
        id: s.id,
        kind: "agent",
        title: s.name ?? s.title ?? s.preview ?? "subagent",
        status,
        agentType: null,
        model: null,
        parentAgentId: parent.key === root.key ? null : parent.id,
        childThreadId: s.key,
        startedAt: iso(s.createdAt),
        updatedAt: iso(s.updatedAt),
        completedAt: null,
        ...(status === "running" || status === "waiting" ? { stop } : {}),
      });
      walk(s);
    }
  };
  walk(root);
  return out;
}

/** An action sent to one row that its files do not show yet. */
interface Settling {
  kind: NonNullable<SessionAgentView["settling"]>;
  /**
   * A resume: the index has shown the session's turn running since the message went out (or it
   * already ran then). The next time it shows the turn ended, the wait is over.
   */
  sawTurn: boolean;
}

/** The row kinds `list` holds, and those the background tasks hold (withSettling clears only its own). */
const AGENT_KINDS: ReadonlySet<string> = new Set(["agent", "workflow"]);
const TASK_KINDS: ReadonlySet<string> = new Set(["shell", "monitor"]);

const settlingKey = (key: string, kind: SessionAgentView["kind"], id: string) => `${key}\n${kind}\n${id}`;

const busy = (s: SessionSummary | undefined) => s?.status === "running" || s?.status === "waiting-input";

export class SessionAgentControl {
  private deps: SessionAgentControlDeps;
  private settling = new Map<string, Settling>();
  /** Codex terminal stops whose row is being read. */
  private checking = new Set<string>();

  constructor(deps: SessionAgentControlDeps) {
    this.deps = deps;
    deps.index.subscribe?.((e) => this.onIndex(e));
  }

  /**
   * GET /api/session-agents: the rows with their actions, with the session's background shell
   * commands and Monitors (a Codex session's background terminals) among them. `list` leaves those
   * out: the dashboard and the actions on agents and workflows read it. `warnings` holds why the
   * Codex terminals could not be read, so the agent rows still come.
   */
  async listAll(key: string): Promise<{ agents: SessionAgentView[]; warnings: string[] }> {
    const rows = this.list(key);
    if (CODEX_KEY_RE.test(key)) {
      const { rows: tasks, warning } = await this.codexTasksOf(key);
      return { agents: tasks.length ? [...rows, ...tasks] : rows, warnings: warning ? [warning] : [] };
    }
    const tasks = this.tasksOf(key);
    return { agents: tasks.length ? [...rows, ...tasks] : rows, warnings: [] };
  }

  /**
   * A Codex session's background terminals with their 중단. The daemon lists the terminals running
   * now and nothing else; the rows of ended ones are what this server saw (codex/backgroundTerminals.ts).
   * A read that fails gives no rows and its reason as `warning`.
   */
  private async codexTasksOf(key: string): Promise<{ rows: SessionAgentView[]; warning: string | null }> {
    const terminals = this.deps.codexTerminals;
    if (!terminals) return { rows: [], warning: null };
    let rows: SessionAgentView[];
    try {
      rows = await terminals.rows(key);
    } catch (err) {
      return { rows: [], warning: `Could not read background terminals: ${err instanceof Error ? err.message : String(err)}` };
    }
    const root = this.deps.index.get(key);
    const stop: AgentAction = this.deps.codexRuns?.isDriven(key)
      ? { enabled: true, reason: null }
      : { enabled: false, reason: root?.owner === "terminal" && root.status !== "closed" ? ACTION_REASON.terminalStop : ACTION_REASON.notDriven };
    return { rows: this.withSettling(key, TASK_KINDS, rows.map((r) => (r.status === "running" ? { ...r, stop } : r))), warning: null };
  }

  /** The background shell commands and Monitors of a Claude session, with their actions. */
  private tasksOf(key: string): SessionAgentView[] {
    if (CODEX_KEY_RE.test(key) || !this.deps.claudeTasks) return [];
    return this.withSettling(key, TASK_KINDS, withActions(this.deps.claudeTasks.rows(key), {
      session: this.deps.index.get(key),
      driven: this.deps.runs.isDriven(key),
      hostUp: this.deps.hostUp(),
    }));
  }

  /** GET /api/session-agents/output: the end of a background task's output. */
  async taskOutput(key: string, kind: string, id: string): Promise<SessionTaskOutput> {
    if ((kind !== "shell" && kind !== "monitor") || !id) throw new AgentControlError(400, "key, kind, and id are required");
    if (CODEX_KEY_RE.test(key)) {
      const terminals = this.deps.codexTerminals;
      if (!terminals || kind !== "shell") throw new AgentControlError(404, `Not a background task of this session: ${id}`);
      await terminals.rows(key);
      if (!terminals.knows(key, id)) throw new AgentControlError(404, `Not a background task of this session: ${id}`);
      return terminals.output(key, id) ?? { output: "", totalBytes: 0, truncated: false };
    }
    if (!this.deps.claudeTasks) throw new AgentControlError(503, "Background task list is disabled");
    if (!this.tasksOf(key).some((r) => r.kind === kind && r.id === id)) throw new AgentControlError(404, `Not a background task of this session: ${id}`);
    const out = this.deps.claudeTasks.output(key, id);
    if (!out) throw new AgentControlError(404, "No output file (files of long-finished tasks may have been deleted)");
    return out;
  }

  /** The agent and workflow rows with their actions. */
  list(key: string): SessionAgentView[] {
    if (CODEX_KEY_RE.test(key)) {
      const root = this.deps.index.get(key);
      if (!root) throw new AgentControlError(404, `Session not found: ${key}`);
      return this.withSettling(key, AGENT_KINDS, codexAgentRows(root, this.deps.index.snapshot(), this.deps.codexRuns?.isDriven(key) ?? false));
    }
    return this.withSettling(key, AGENT_KINDS, withActions(this.deps.claudeRows(key), {
      session: this.deps.index.get(key),
      driven: this.deps.runs.isDriven(key),
      hostUp: this.deps.hostUp(),
    }));
  }

  /** GET /api/session-agents/count: how many rows run, read without the workflows' details. */
  async count(key: string): Promise<number> {
    if (CODEX_KEY_RE.test(key)) {
      const root = this.deps.index.get(key);
      if (!root) throw new AgentControlError(404, `Session not found: ${key}`);
      // A terminal read that fails counts none: the list says why.
      const { rows: terminals } = await this.codexTasksOf(key);
      return [...codexAgentRows(root, this.deps.index.snapshot(), false), ...terminals].filter((r) => ACTIVE.has(r.status)).length;
    }
    return [...this.deps.claudeRows(key, { light: true }), ...this.tasksOf(key)].filter((r) => ACTIVE.has(r.status)).length;
  }

  async stop(req: StopSessionAgent): Promise<void> {
    // A Codex terminal's row is read from the daemon, so the check awaits; a second click meanwhile is refused here.
    const terminal = typeof req.key === "string" && CODEX_KEY_RE.test(req.key) && req.kind === "shell";
    const asked = settlingKey(req.key, req.kind, req.id);
    if (terminal) {
      if (this.checking.has(asked)) throw new AgentControlError(409, ACTION_REASON.stopping);
      this.checking.add(asked);
    }
    let row: SessionAgentView;
    try {
      row = terminal ? await this.terminalRow(req) : this.row(req, req.kind);
    } finally {
      this.checking.delete(asked);
    }
    if (!row.stop) throw new AgentControlError(409, "Not running");
    if (!row.stop.enabled) throw new AgentControlError(409, row.stop.reason ?? "Cannot stop");
    const mark = settlingKey(req.key, req.kind, req.id);
    this.settling.set(mark, { kind: "stopping", sawTurn: false });
    try {
      if (CODEX_KEY_RE.test(req.key) && req.kind === "shell") {
        const terminals = this.deps.codexTerminals;
        if (!terminals) throw new AgentControlError(503, "Codex terminal control is disabled");
        try {
          if (!(await terminals.terminate(req.key, req.id))) throw new AgentControlError(409, "This terminal has already ended");
        } catch (err) {
          if (err instanceof RpcError) throw new AgentControlError(502, `Codex daemon refused: ${err.message}`);
          throw err;
        }
        return;
      }
      if (CODEX_KEY_RE.test(req.key)) {
        const codex = this.deps.codexRuns;
        if (!codex) throw new AgentControlError(503, "Codex control is disabled");
        await this.call(() => codex.interruptSubagent(req.key, req.id, (childKey) => this.descends(childKey, req.key)));
        return;
      }
      // An agent's id, a shell command's and a Monitor's are their task ids.
      let taskId: string | null = req.kind === "workflow" ? this.deps.runs.workflowTaskId(req.key, req.id) : req.id;
      if (taskId === null) {
        // Launched before this server connected to the host: the transcript names the task.
        const files = claudeSessionFiles(req.key, this.deps.claudeAccounts);
        taskId = files ? ((await findWorkflowLaunch(files.transcript, req.id))?.taskId ?? null) : null;
      }
      if (taskId === null) throw new AgentControlError(404, `Could not find the task of workflow ${req.id} in the session record`);
      const id = taskId;
      await this.call(() => this.deps.runs.stopTask(req.key, id));
    } catch (err) {
      this.settling.delete(mark);
      throw err;
    }
  }

  async resume(req: ResumeSessionWorkflow): Promise<ResumeSessionWorkflowResult> {
    const row = this.row(req, "workflow");
    if (!row.resume) throw new AgentControlError(409, "Only a stopped or interrupted workflow can be resumed");
    if (!row.resume.enabled) throw new AgentControlError(409, row.resume.reason ?? "Cannot resume");
    const mark = settlingKey(req.key, "workflow", req.id);
    this.settling.set(mark, { kind: "resuming", sawTurn: busy(this.deps.index.get(req.key)) });
    try {
      const files = claudeSessionFiles(req.key, this.deps.claudeAccounts);
      const record = files ? await readWorkflowRecord(files.sessionDirs, files.transcript, req.id) : null;
      if (!record) throw new AgentControlError(404, `Could not find the script path in the record of workflow ${req.id}`);
      const prompt = workflowResumePrompt(record);
      await this.call(() => this.deps.runs.send(req.key, prompt));
      return { ok: true, prompt };
    } catch (err) {
      this.settling.delete(mark);
      throw err;
    }
  }

  /**
   * The rows with the actions this server sent and the files do not show yet. A stop settles once
   * its row no longer offers 중단 (it stopped or ended), a resume once its row no longer offers
   * 이어서 실행 (the run started again); until then the row says so and refuses the action again.
   */
  private withSettling(key: string, kinds: ReadonlySet<string>, rows: SessionAgentView[]): SessionAgentView[] {
    const prefix = `${key}\n`;
    const live = new Set<string>();
    const out = rows.map((row) => {
      const mark = settlingKey(key, row.kind, row.id);
      const s = this.settling.get(mark);
      if (!s) return row;
      live.add(mark);
      if (s.kind === "stopping" && row.stop) {
        return { ...row, settling: s.kind, stop: { enabled: false, reason: ACTION_REASON.stopping } };
      }
      if (s.kind === "resuming" && row.resume) {
        return { ...row, settling: s.kind, resume: { enabled: false, reason: ACTION_REASON.resuming } };
      }
      this.settling.delete(mark);
      return row;
    });
    // A row that went away (its files were deleted) has nothing left to settle. Only the kinds
    // these rows hold: the other kinds are read by another call.
    for (const mark of this.settling.keys()) {
      if (mark.startsWith(prefix) && kinds.has(mark.split("\n")[1] ?? "") && !live.has(mark)) this.settling.delete(mark);
    }
    return out;
  }

  /**
   * A resume waits for its run to start, or for the turn that got the message to end without
   * starting it (the model answered instead): then 이어서 실행 can be sent again.
   */
  private onIndex(e: IndexEvent): void {
    const key = e.type === "upsert" ? e.session.key : e.key;
    const prefix = `${key}\n`;
    for (const [mark, s] of this.settling) {
      if (s.kind !== "resuming" || !mark.startsWith(prefix)) continue;
      if (e.type === "remove") this.settling.delete(mark);
      else if (busy(e.session)) s.sawTurn = true;
      else if (s.sawTurn) this.settling.delete(mark);
    }
  }

  /** A Codex terminal's row, read from the daemon. */
  private async terminalRow(req: { key: string; id: string }): Promise<SessionAgentView> {
    if (typeof req.id !== "string" || !req.id) throw new AgentControlError(400, "key, kind, and id are required");
    const row = (await this.listAll(req.key)).agents.find((r) => r.kind === "shell" && r.id === req.id);
    if (!row) throw new AgentControlError(404, `Not a background task of this session: ${req.id}`);
    return row;
  }

  private row(req: { key: string; id: string }, kind: SessionAgentView["kind"]): SessionAgentView {
    if (typeof req.key !== "string" || typeof req.id !== "string" || !req.id || (kind !== "agent" && kind !== "workflow" && kind !== "shell" && kind !== "monitor")) {
      throw new AgentControlError(400, "key, kind, and id are required");
    }
    const row = [...this.list(req.key), ...this.tasksOf(req.key)].find((r) => r.kind === kind && r.id === req.id);
    if (!row) throw new AgentControlError(404, `Not a ${kind === "workflow" ? "workflow" : kind === "agent" ? "subagent" : "background task"} of this session: ${req.id}`);
    return row;
  }

  private descends(childKey: string, rootKey: string): boolean {
    const seen = new Set<string>();
    for (let s = this.deps.index.get(childKey); s?.parentKey && !seen.has(s.key); s = this.deps.index.get(s.parentKey)) {
      if (s.parentKey === rootKey) return true;
      seen.add(s.key);
    }
    return false;
  }

  /** Errors as HTTP: a refusal of ours 409, the host away 503, the CLI or daemon refusing 502. */
  private async call(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof HostDownError) throw new AgentControlError(503, err.message);
      if (err instanceof HostRequestError) throw new AgentControlError(502, `Claude CLI refused: ${err.message}`);
      if (err instanceof DriveError) throw new AgentControlError(/refused|connection lost/.test(err.message) ? 502 : 409, err.message);
      throw err;
    }
  }
}
