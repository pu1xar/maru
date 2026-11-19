import fs from "node:fs";
import path from "node:path";
import type { SessionAgentView } from "@maru/shared";
import type { ClaudeAccount } from "../config.ts";
import {
  agentMetrics, carryAgentMetrics, configDirsResolver, configRelativePath, sessionRelativeDir, workflowFromFinal,
  workflowFromJournal, type ClaudeAgentMeta, type WorkflowAgentMetrics, type WorkflowView,
} from "./projection/sidecars.ts";

const SESSION_KEY_RE = /^claude:([^:]+):([0-9a-f-]{36})$/;

export class SessionAgentsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readJsonLines(file: string): unknown[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn last line is a write in progress.
    }
  }
  return out;
}

function iso(ms: number | undefined): string | null {
  return ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

function statOf(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export interface ListSessionAgentsOptions {
  /**
   * Only what the rows' states need: a workflow row carries no phases or agents and its run id as
   * its title. For counting the running rows (the conversation header, the idle closer).
   */
  light?: boolean;
}

/**
 * The subagents and workflows of a Claude session, from `<sid>/subagents/agent-*.meta.json` and
 * `<sid>/subagents/workflows/<runId>/` in every config dir (a resumed session spreads its files
 * over accounts).
 * - A meta with `finished` is completed, one with `stoppedByUser` (the CLI writes it when a task
 *   stop or an interrupt killed the agent) is cancelled.
 * - Otherwise it is running only while the process that runs it lives: the session must be open
 *   and the agent's transcript must have been written since the session's current process
 *   started (a background agent ends with its process). Otherwise it is interrupted.
 * - A workflow's final record (`<sid>/workflows/<runId>.json`) decides its state, unless the
 *   journal was written after it: a stopped run that was resumed (Workflow resumeFromRunId keeps
 *   the run id and appends to the same journal, measured 2026-11-16) runs again until the next
 *   final record. The journal then gives the agents, the final record the name and the numbers of
 *   the agents that had finished (workflowAgents).
 * - Before a run's first final record its name comes from its launch in the session transcript
 *   (`toolUseResult.workflowName`), else from the CLI's copy of an inline script
 *   (`<sid>/workflows/scripts/<name>-<runId>.js`); the run id is the last resort.
 */
export function listSessionAgents(
  sessionKey: string,
  accounts: ClaudeAccount[],
  /** A live process holds the session (the index says it is not closed, or this server runs it). */
  sessionOpen: boolean,
  /** When the session's current process started, ms; null when unknown (then no age check). */
  processStartMs: number | null = null,
  opts: ListSessionAgentsOptions = {},
): SessionAgentView[] {
  const m = SESSION_KEY_RE.exec(sessionKey);
  if (!m) throw new SessionAgentsError(400, `Not a Claude session key: ${sessionKey}`);
  const [, account, sid] = m as unknown as [string, string, string];
  const acct = accounts.find((a) => a.id === account);
  if (!acct) throw new SessionAgentsError(400, `Unknown account: ${account}`);

  const transcript = findTranscript(accounts, acct, sid);
  if (!transcript) throw new SessionAgentsError(404, `Transcript not found: ${sid}`);
  const rel = configRelativePath(transcript);
  if (!rel) return [];
  const sessionDir = sessionRelativeDir(rel);
  const resolve = configDirsResolver(accounts.map((a) => a.dir));
  // Write times are taken a second early: the process writes its first agent file at once.
  const writtenByLive = (writtenMs: number | undefined) =>
    sessionOpen && (processStartMs === null || writtenMs === undefined || writtenMs >= processStartMs - 1000);

  const agents = new Map<string, SessionAgentView>();
  for (const dir of resolve(`${sessionDir}/subagents`)) {
    for (const name of listDir(dir)) {
      const mm = /^agent-([A-Za-z0-9_-]+)\.meta\.json$/.exec(name);
      if (!mm || agents.has(mm[1]!)) continue;
      const agentId = mm[1]!;
      const meta = (readJson(path.join(dir, name)) ?? {}) as ClaudeAgentMeta & { parentAgentId?: unknown; stoppedByUser?: unknown };
      const tx = statOf(path.join(dir, `agent-${agentId}.jsonl`));
      const finished = meta.finished === true;
      const status: SessionAgentView["status"] = finished
        ? "completed"
        : meta.stoppedByUser === true
          ? "cancelled"
          : writtenByLive(tx?.mtimeMs) ? "running" : "interrupted";
      agents.set(agentId, {
        id: agentId,
        kind: "agent",
        title: meta.description || meta.name || meta.agentType || "subagent",
        status,
        agentType: typeof meta.agentType === "string" ? meta.agentType : null,
        model: (typeof meta.model === "string" ? meta.model : null) ?? (typeof meta.pickedEffortModel === "string" ? meta.pickedEffortModel : null),
        parentAgentId: typeof meta.parentAgentId === "string" ? meta.parentAgentId : null,
        childThreadId: tx ? `${sessionKey}:agent-${agentId}` : null,
        startedAt: iso(tx?.birthtimeMs),
        updatedAt: iso(tx?.mtimeMs),
        completedAt: finished ? iso(tx?.mtimeMs) : null,
      });
    }
  }

  const workflows = new Map<string, SessionAgentView>();
  for (const runsDir of resolve(`${sessionDir}/subagents/workflows`)) {
    for (const runId of listDir(runsDir)) {
      if (workflows.has(runId) || !statOf(path.join(runsDir, runId))?.isDirectory()) continue;
      const final = resolve(`${sessionDir}/workflows/${runId}.json`)[0];
      const runDir = statOf(path.join(runsDir, runId));
      const journal = statOf(path.join(runsDir, runId, "journal.jsonl"));
      const finalStat = final ? statOf(final) : null;
      // Settled by the final record, unless the run was resumed after it was written.
      const settled = finalStat !== null && !(journal !== null && journal.mtimeMs > finalStat.mtimeMs);
      const base = {
        id: runId,
        kind: "workflow" as const,
        agentType: null,
        model: null,
        parentAgentId: null,
        childThreadId: null,
        startedAt: iso(runDir?.birthtimeMs),
        updatedAt: iso(Math.max(finalStat?.mtimeMs ?? 0, journal?.mtimeMs ?? 0, runDir?.mtimeMs ?? 0) || undefined),
        completedAt: settled && finalStat ? iso(finalStat.mtimeMs) : null,
      };
      const liveStatus = (): SessionAgentView["status"] => (writtenByLive((journal ?? runDir)?.mtimeMs) ? "running" : "interrupted");
      if (opts.light) {
        // A final record's status is never "running": a settled run does not count.
        workflows.set(runId, { ...base, title: runId, status: settled ? "completed" : liveStatus() });
        continue;
      }
      const finalView = final ? workflowFromFinal(readJson(final), sessionKey) : null;
      const journalView = settled ? null : workflowFromJournal(readJsonLines(path.join(runsDir, runId, "journal.jsonl")), sessionKey);
      const name = finalView?.workflow.name ?? launchName(transcript, runId) ?? inlineScriptName(resolve, sessionDir, runId);
      const workflow = workflowAgents(`${sessionDir}/${runId}`, path.join(runsDir, runId), settled ? finalView : journalView, finalView);
      let status: SessionAgentView["status"] = settled ? (finalView?.status ?? "completed") : "running";
      if (status === "running") status = liveStatus();
      workflows.set(runId, {
        ...base,
        title: name ?? runId,
        status,
        ...(workflow ? { workflow: name !== undefined ? { ...workflow, name } : workflow } : {}),
      });
    }
  }
  return [...workflows.values(), ...agents.values()];
}

// ---- a workflow's agents with the numbers of the run that did their work ----

/** `<sid dir>/<runId>/<agentId>` -> the metrics a final record gave for that agent. */
const seenMetrics = new Map<string, WorkflowAgentMetrics>();

/**
 * The run's phases and agents from `view` (the final record, or the journal of a run that still
 * runs or was resumed), each agent with the metrics it lacks from, in order: the final record
 * (a resumed run's journal has no numbers), the metrics this server saw in an earlier final record
 * of the run (the resumed run's own final record marks the agents it took from the cache
 * `cached: true` and gives them none), and for a finished agent the span of its transcript's
 * writes as its duration (the tokens and tool count are then unknown: the transcript does not
 * give the CLI's token figure).
 */
function workflowAgents(
  runKey: string,
  runDir: string,
  view: WorkflowView | null,
  finalView: WorkflowView | null,
): WorkflowView["workflow"] | undefined {
  if (!view) return finalView?.workflow;
  for (const a of finalView?.workflow.agents ?? []) {
    const known = a.agentId !== undefined && a.totalTokens !== undefined ? agentMetrics(a) : undefined;
    if (known) seenMetrics.set(`${runKey}/${a.agentId}`, known);
  }
  const fromFinal = new Map((finalView?.workflow.agents ?? []).flatMap((a) => (a.agentId ? [[a.agentId, agentMetrics(a)] as const] : [])));
  const agents = carryAgentMetrics(view.workflow.agents, (agentId) => {
    const merged: WorkflowAgentMetrics = { ...seenMetrics.get(`${runKey}/${agentId}`), ...fromFinal.get(agentId) };
    return Object.keys(merged).length ? merged : undefined;
  }).map((a) => {
    if (a.agentId === undefined || a.durationMs !== undefined || (a.state !== "completed" && a.state !== "running")) return a;
    const tx = statOf(path.join(runDir, `agent-${a.agentId}.jsonl`));
    if (!tx) return a;
    // A running agent's start shows its elapsed time; a finished one's writes span its work.
    if (a.state === "running") return a.startedAt === undefined ? { ...a, startedAt: tx.birthtimeMs } : a;
    return { ...a, durationMs: Math.max(0, tx.mtimeMs - tx.birthtimeMs) };
  });
  return { ...view.workflow, agents };
}

// ---- a running workflow's name before its final record ----

/** transcript -> how far it was read and the run names its launches gave. */
const launchNames = new Map<string, { offset: number; names: Map<string, string> }>();

const NAME_MARK = Buffer.from('"workflowName"');
const CHUNK = 1 << 20;

/**
 * The name a Workflow launch in the transcript gave the run (`toolUseResult.workflowName` of the
 * `async_launched` result). The transcript is read once and then only what was appended since;
 * only lines that hold "workflowName" are parsed. Undefined when no launch names it there (a
 * workflow a subagent started writes to the subagent's transcript).
 */
function launchName(transcript: string, runId: string): string | undefined {
  const size = statOf(transcript)?.size;
  if (size === undefined) return undefined;
  let seen = launchNames.get(transcript);
  if (!seen || size < seen.offset) {
    seen = { offset: 0, names: new Map() };
    launchNames.set(transcript, seen);
  }
  if (size > seen.offset) readLaunchNames(transcript, seen, size);
  return seen.names.get(runId);
}

function readLaunchNames(file: string, seen: { offset: number; names: Map<string, string> }, size: number): void {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return;
  }
  try {
    let pending = Buffer.alloc(0);
    let pos = seen.offset;
    const buf = Buffer.alloc(CHUNK);
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const data = pending.length ? Buffer.concat([pending, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        const line = data.subarray(start, nl);
        start = nl + 1;
        if (line.indexOf(NAME_MARK) === -1) continue;
        try {
          const result = (JSON.parse(line.toString("utf8")) as { toolUseResult?: { runId?: unknown; workflowName?: unknown } }).toolUseResult;
          if (typeof result?.runId === "string" && typeof result.workflowName === "string") seen.names.set(result.runId, result.workflowName);
        } catch {
          // Not a record of ours.
        }
      }
      pending = Buffer.from(data.subarray(start));
      // Only whole lines count as read: a line being written is read again next time.
      seen.offset = pos - pending.length;
    }
  } catch {
    // An unreadable transcript names nothing.
  } finally {
    fs.closeSync(fd);
  }
}

/** `<name>` of the CLI's copy of an inline script, `<sid>/workflows/scripts/<name>-<runId>.js`. */
function inlineScriptName(resolve: (rel: string) => string[], sessionDir: string, runId: string): string | undefined {
  const suffix = `-${runId}.js`;
  for (const dir of resolve(`${sessionDir}/workflows/scripts`)) {
    const copy = listDir(dir).find((n) => n.endsWith(suffix) && n.length > suffix.length);
    if (copy) return copy.slice(0, -suffix.length);
  }
  return undefined;
}

/**
 * The session's transcript and its `<sid>` folders in every config dir (best first), for the
 * actions that read a workflow's record (claude/agentControl.ts). Null for a key that is not a
 * Claude session of a known account, or without a transcript.
 */
export function claudeSessionFiles(sessionKey: string, accounts: ClaudeAccount[]): { transcript: string; sessionDirs: string[] } | null {
  const m = SESSION_KEY_RE.exec(sessionKey);
  const acct = m ? accounts.find((a) => a.id === m[1]) : undefined;
  if (!m || !acct) return null;
  const transcript = findTranscript(accounts, acct, m[2]!);
  const rel = transcript ? configRelativePath(transcript) : null;
  if (!transcript || !rel) return null;
  return { transcript, sessionDirs: configDirsResolver(accounts.map((a) => a.dir))(sessionRelativeDir(rel)) };
}

function findTranscript(accounts: ClaudeAccount[], first: ClaudeAccount, sid: string): string | null {
  for (const a of [first, ...accounts.filter((x) => x !== first)]) {
    const projects = path.join(a.dir, "projects");
    for (const d of listDir(projects)) {
      const f = path.join(projects, d, `${sid}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
}
