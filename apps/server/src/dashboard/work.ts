// The dashboard's work list (DESIGN.md 6j), `GET /api/dashboard/work`: in one answer, for every
// session on the list (DESIGN.md 6d),
//   - the sessions that need the user: a question or approval waiting here, input another client
//     waits on, a last turn that ended on an error
//   - the turns in progress, with when each began
//   - the running subagents and workflows, and the workflows that stopped and can run again, each
//     with the 작업 tab's actions (SessionAgentControl.list, DESIGN.md 6i)
//
// The 작업 rows come from each session's sidecar files. Only open sessions can have running rows,
// and an open session's files are read again only when the last read had a running row, or the
// session (status, owner, pid, last activity, this server's run, the host) or one of its folders
// (`<sid>/subagents`, `<sid>/subagents/workflows`, `<sid>/workflows` in every config dir) changed
// since. A new agent or workflow adds files to those folders; a running row is read every time,
// so its end shows at once. Every other open session is answered from the last read.
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type {
  AgentAction, DashboardAgent, DashboardAttention, DashboardSessionRef, DashboardTask, DashboardTurn, DashboardWork, IndexEvent,
  PendingQuestionView, SessionAgentView, SessionSummary,
} from "@maru/shared";
import { sessionDisplayName } from "@maru/shared";
import type { ClaudeAccount } from "../config.ts";
import { ACTION_REASON } from "../claude/agentControl.ts";
import { parseRegistration } from "../claude/registry.ts";
import { configRelativePath, sessionRelativeDir } from "../claude/projection/sidecars.ts";
import { findTranscript } from "../sessions/claudeFiles.ts";
import { readLastError, type LastError } from "./lastError.ts";

export interface DashboardWorkDeps {
  claudeAccounts: ClaudeAccount[];
  /** The sessions on the list and their subagent threads (VisibleIndex.snapshot). */
  sessions: () => SessionSummary[];
  /** Changes of those sessions (VisibleIndex.subscribe), to note when each began to run or to wait. */
  subscribe: (listener: (e: IndexEvent) => void) => () => void;
  /** Any indexed session: a question of a run this server drives shows even for a session off the list. */
  get: (key: string) => SessionSummary | undefined;
  /** A session's 작업 rows with their actions (SessionAgentControl.list). */
  rows: (key: string) => SessionAgentView[];
  /** Questions the sessions this server drives wait on (ClaudeRuns, CodexRuns allPending). */
  pending: () => Array<{ key: string; questions: PendingQuestionView[] }>;
  /** A process this server started holds the session. */
  driven: (key: string) => boolean;
  /** The Claude session host is connected. */
  hostUp: () => boolean;
  now?: () => number;
}

/** 작업 statuses that are still going. */
const ACTIVE = new Set<SessionAgentView["status"]>(["running", "pending", "waiting"]);

const REASON = {
  codexOther: "Belongs to another client's turn (such as a terminal), so it cannot be stopped here",
  claudeTerminalSend: "Open in a terminal, so you cannot send from here",
  codexOtherSend: "You can send after the other client's turn (such as a terminal) ends",
  answerInTerminal: "Must be answered in the terminal",
  answerInOtherClient: "Must be answered in another client (such as a terminal)",
} as const;

const OK: AgentAction = { enabled: true, reason: null };
const no = (reason: string): AgentAction => ({ enabled: false, reason });

interface RowsCache {
  signature: string;
  rows: SessionAgentView[];
}

interface TailCache {
  file: string;
  size: number;
  mtimeMs: number;
  error: LastError | null;
}

export class DashboardWorkService {
  private readonly deps: DashboardWorkDeps;
  private readonly now: () => number;
  /** Last read of each open session's rows. */
  private readonly rowsCache = new Map<string, RowsCache>();
  /** Last tail check of each Claude transcript. */
  private readonly tailCache = new Map<string, TailCache>();
  /** Claude session key -> its transcript, as last found. */
  private readonly transcripts = new Map<string, string>();
  /** Session key -> its last status, for when a span began. */
  private readonly seen = new Map<string, SessionSummary["status"]>();
  /** Running or waiting since, ms (null: began before this server saw it). */
  private readonly activeSince = new Map<string, number | null>();
  private readonly waitingSince = new Map<string, number | null>();
  private readonly off: () => void;

  constructor(deps: DashboardWorkDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    for (const s of deps.sessions()) this.observe(s);
    this.off = deps.subscribe((e) => {
      if (e.type === "upsert") this.observe(e.session);
      else this.forget(e.key);
    });
  }

  close(): void {
    this.off();
  }

  /** Answers `GET /api/dashboard/work`; false for any other request. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
    if (req.method !== "GET" || url.pathname !== "/api/dashboard/work") return false;
    const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
    this.snapshot().then(
      (body) => res.writeHead(200, headers).end(JSON.stringify(body)),
      (err: unknown) => {
        console.error("dashboard work error", err);
        res.writeHead(500, headers).end(JSON.stringify({ error: "internal error" }));
      },
    );
    return true;
  }

  async snapshot(): Promise<DashboardWork> {
    const t0 = performance.now();
    const stats = { open: 0, reread: 0, reused: 0, tails: 0, ms: 0 };
    const top = this.deps.sessions().filter((s) => !s.parentKey);
    const byKey = new Map(top.map((s) => [s.key, s]));
    const hostUp = this.deps.hostUp();

    const attention: DashboardAttention[] = [];
    const asked = new Map(this.deps.pending().map((p) => [p.key, p.questions]));
    for (const [key, questions] of asked) {
      const s = byKey.get(key) ?? this.deps.get(key);
      if (!s) continue;
      attention.push({ kind: "question", session: ref(s), summary: s, since: this.waitingSince.get(key) ?? null, titles: questions.map(titleOf) });
    }
    const turns: DashboardTurn[] = [];
    const tasks: DashboardTask[] = [];
    const errors: Extract<DashboardAttention, { kind: "error" }>[] = [];
    const live = new Set<string>();
    for (const s of top) {
      const driven = this.deps.driven(s.key);
      if (s.status === "waiting-input" && !asked.has(s.key)) {
        // A run of this server whose question has not been published yet still answers here.
        if (s.owner === "ui") attention.push({ kind: "question", session: ref(s), summary: s, since: this.waitingSince.get(s.key) ?? null, titles: [] });
        else attention.push({
          kind: "waiting", session: ref(s), since: this.waitingSince.get(s.key) ?? null,
          reason: s.provider === "claude" ? REASON.answerInTerminal : REASON.answerInOtherClient,
        });
      }
      if (s.status === "running") turns.push({ session: ref(s), startedAt: this.activeSince.get(s.key) ?? null, stop: turnStop(s, hostUp) });
      if (s.status === "error") {
        errors.push({
          kind: "error", session: ref(s), summary: s, at: s.updatedAt || null,
          message: "Thread is in an error state (systemError)", code: "systemError", send: sendAction(s, hostUp),
        });
      } else if (s.provider === "claude" && s.status !== "running" && s.status !== "waiting-input") {
        const e = await this.claudeLastError(s, stats);
        if (e) errors.push({ kind: "error", session: ref(s), summary: s, at: e.at, message: e.message, code: e.code, send: sendAction(s, hostUp) });
      }
      if (s.status === "closed" && !driven) continue;
      live.add(s.key);
      stats.open++;
      for (const agent of this.rowsOf(s, driven, hostUp, stats)) {
        if (ACTIVE.has(agent.status) || agent.resume) tasks.push({ session: ref(s), agent: slim(agent) });
      }
    }
    // A session that closed or left the list is read afresh if it opens again.
    for (const key of this.rowsCache.keys()) if (!live.has(key)) this.rowsCache.delete(key);
    for (const key of this.tailCache.keys()) if (!byKey.has(key)) this.tailCache.delete(key);

    errors.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    turns.sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
    stats.ms = Math.round((performance.now() - t0) * 10) / 10;
    return { generatedAt: this.now(), attention: [...attention, ...errors], turns, tasks, stats };
  }

  // ---- 작업 rows ----

  private rowsOf(s: SessionSummary, driven: boolean, hostUp: boolean, stats: DashboardWork["stats"]): SessionAgentView[] {
    const signature = s.provider === "codex" ? null : this.signature(s, driven, hostUp);
    const cached = this.rowsCache.get(s.key);
    if (signature !== null && cached && cached.signature === signature && !cached.rows.some((r) => ACTIVE.has(r.status))) {
      stats.reused++;
      return cached.rows;
    }
    stats.reread++;
    let rows: SessionAgentView[];
    try {
      rows = this.deps.rows(s.key);
    } catch {
      // No transcript yet (a session that is starting), or one that is gone: nothing to show.
      rows = [];
    }
    if (signature !== null) this.rowsCache.set(s.key, { signature, rows });
    return rows;
  }

  /** What the session's rows depend on besides its running rows (module comment). */
  private signature(s: SessionSummary, driven: boolean, hostUp: boolean): string {
    const parts: (string | number | boolean | null)[] = [s.status, s.owner, s.pid, s.updatedAt, driven, hostUp];
    const file = this.transcriptOf(s);
    const rel = file ? configRelativePath(file) : null;
    if (rel) {
      const dir = sessionRelativeDir(rel);
      for (const a of this.deps.claudeAccounts) {
        const base = path.join(a.dir, ...dir.split("/"));
        for (const sub of ["subagents", path.join("subagents", "workflows"), "workflows"]) parts.push(mtimeOf(path.join(base, sub)));
      }
    }
    return JSON.stringify(parts);
  }

  private transcriptOf(s: SessionSummary): string | null {
    const known = this.transcripts.get(s.key);
    if (known && fs.existsSync(known)) return known;
    const own = this.deps.claudeAccounts.find((a) => a.id === s.account);
    const order = own ? [own, ...this.deps.claudeAccounts.filter((a) => a !== own)] : this.deps.claudeAccounts;
    for (const a of order) {
      const file = findTranscript(a.dir, s.id);
      if (file) {
        this.transcripts.set(s.key, file);
        return file;
      }
    }
    this.transcripts.delete(s.key);
    return null;
  }

  // ---- errors ----

  /** The error that ends the session's transcript; the tail is read again only when the file changed. */
  private async claudeLastError(s: SessionSummary, stats: DashboardWork["stats"]): Promise<LastError | null> {
    const file = this.transcriptOf(s);
    if (!file) return null;
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    const cached = this.tailCache.get(s.key);
    if (cached && cached.file === file && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.error;
    stats.tails++;
    let error: LastError | null = null;
    try {
      error = await readLastError(file);
    } catch {
      error = null;
    }
    this.tailCache.set(s.key, { file, size: st.size, mtimeMs: st.mtimeMs, error });
    return error;
  }

  // ---- when each session began to run or wait ----

  private observe(s: SessionSummary): void {
    if (s.parentKey) return;
    const prev = this.seen.get(s.key);
    this.seen.set(s.key, s.status);
    const active = s.status === "running" || s.status === "waiting-input";
    const waiting = s.status === "waiting-input";
    // A session first seen mid-span began before this server looked: its registration (Claude) or
    // its last activity when that is a moment ago (a Codex thread that just started) tells when.
    const start = () => (prev === undefined ? this.firstSeenStart(s) : this.now());
    if (!active) this.activeSince.delete(s.key);
    else if (!this.activeSince.has(s.key)) this.activeSince.set(s.key, start());
    if (!waiting) this.waitingSince.delete(s.key);
    else if (!this.waitingSince.has(s.key)) this.waitingSince.set(s.key, start());
  }

  private forget(key: string): void {
    this.seen.delete(key);
    this.activeSince.delete(key);
    this.waitingSince.delete(key);
    this.rowsCache.delete(key);
    this.tailCache.delete(key);
    this.transcripts.delete(key);
  }

  private firstSeenStart(s: SessionSummary): number | null {
    if (s.provider === "codex") return this.now() - s.updatedAt < FRESH_MS ? s.updatedAt : null;
    if (s.pid === null) return null;
    const acct = this.deps.claudeAccounts.find((a) => a.id === s.account);
    if (!acct) return null;
    try {
      const reg = parseRegistration(fs.readFileSync(path.join(acct.dir, "sessions", `${s.pid}.json`), "utf8"), s.pid);
      // statusUpdatedAt: when the CLI set its current status.
      return reg?.updatedAt ?? null;
    } catch {
      return null;
    }
  }
}

/** A Codex thread's last activity this recent is the start of the span it is seen in. */
const FRESH_MS = 10_000;

function mtimeOf(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function ref(s: SessionSummary): DashboardSessionRef {
  return {
    key: s.key, provider: s.provider, account: s.account, label: sessionDisplayName(s),
    cwd: s.cwd, status: s.status, owner: s.owner,
  };
}

/** The row without the workflow's phases and agents (the 작업 tab has them): how far its agents got. */
function slim(agent: SessionAgentView): DashboardAgent {
  const { workflow, ...rest } = agent;
  const agents = workflow?.agents ?? null;
  return { ...rest, progress: agents ? { done: agents.filter((a) => a.state === "completed").length, total: agents.length } : null };
}

function titleOf(q: PendingQuestionView): string {
  const first = (q.input as { questions?: Array<{ question?: unknown }> }).questions?.[0]?.question;
  return q.title ?? (typeof first === "string" ? first : q.toolName);
}

/** 멈추기 on a running turn: the composer's rule (only a run this server started). */
function turnStop(s: SessionSummary, hostUp: boolean): AgentAction {
  if (s.owner !== "ui") return no(s.provider === "claude" ? ACTION_REASON.terminalStop : REASON.codexOther);
  if (s.provider === "claude" && !hostUp) return no(ACTION_REASON.hostDown);
  return OK;
}

/** Sending a message (the composer's sendBlocker; a closed session resumes). */
function sendAction(s: SessionSummary, hostUp: boolean): AgentAction {
  if (s.provider === "codex") {
    return s.owner === "terminal" && (s.status === "running" || s.status === "waiting-input") ? no(REASON.codexOtherSend) : OK;
  }
  if (s.owner === "terminal" && s.status !== "closed") return no(REASON.claudeTerminalSend);
  if (!hostUp) return no(ACTION_REASON.hostDown);
  return OK;
}
