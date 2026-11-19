// Files next to a Claude transcript that the projection links in (docs/event-model.md 5.6, 7.7):
//
//   <sid>/subagents/agent-<agentId>.meta.json            subagent: toolUseId, name, finished
//   <sid>/subagents/workflows/<runId>/agent-<id>.meta.json  workflow agent (same shape)
//   <sid>/workflows/<runId>.json                          workflow: final summary
//   <sid>/subagents/workflows/<runId>/journal.jsonl       workflow: live progress
//
// The projector reads them through ClaudeSidecars, so tests pass fakes. Reads are synchronous:
// the files are small and the projector's push/snapshot are synchronous.
//
// Where a file lives: a session resumed under another account keeps writing to the new
// account's directory, so the files of one session are spread over `~/.claude*/projects/<enc>/`
// at the same relative path (measured: session e933053f in ~/.claude-personal has 49 of its 87
// agent files under ~/.claude). Paths here are therefore relative to a config dir
// (`projects/<enc>/<sid>/...`) and go through an injected ClaudePathResolver that returns the
// existing copies. A Workflow result's `transcriptDir` is not used: it names the directory at
// launch time, which a later move or rehome changes.
import fs from "node:fs";
import path from "node:path";
import type {
  OrchestrationV2Subagent,
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2WorkflowAgent,
  OrchestrationV2WorkflowPhase,
} from "@maru/shared";

export interface ClaudeAgentMeta {
  agentType?: string;
  description?: string;
  name?: string;
  toolUseId?: string;
  isFork?: boolean;
  finished?: boolean;
  model?: string;
  pickedEffortModel?: string;
  workflowPhase?: string;
  [key: string]: unknown;
}

export interface ClaudeSidecars {
  /** Every `<sid>/subagents/agent-*.meta.json` of the session. */
  agentMetas(): Array<{ agentId: string; meta: ClaudeAgentMeta }>;
  /** The meta.json next to this transcript (a subagent's own), null for a session file. */
  ownMeta(): ClaudeAgentMeta | null;
  /** Parsed `<sid>/workflows/<runId>.json`, null while it does not exist. */
  workflowFinal(runId: string): unknown;
  /** Parsed lines of the workflow journal, oldest first; broken lines are skipped. */
  workflowJournal(runId: string): unknown[];
  /**
   * The journal was written after the final record: the run was resumed (Workflow
   * resumeFromRunId keeps the run id and appends to the same journal) and runs again until its
   * next final record. The 작업 tab uses the same rule (claude/sessionAgents.ts).
   */
  workflowResumed(runId: string): boolean;
}

export const noSidecars: ClaudeSidecars = {
  agentMetas: () => [],
  ownMeta: () => null,
  workflowFinal: () => null,
  workflowJournal: () => [],
  workflowResumed: () => false,
};

/** One path segment (agent ids and workflow run ids come from transcript records). */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Existing files or directories for a path relative to a Claude config dir
 * (`projects/<enc>/<sid>/...`), best candidate first. A file present under several config dirs
 * yields several paths.
 */
export type ClaudePathResolver = (relativePath: string) => string[];

/**
 * `projects/<enc>/...` part of an absolute transcript path, or null. The encoded project dir
 * holds no slash, so the last `/projects/` before it is the config dir's.
 */
export function configRelativePath(absPath: string): string | null {
  const parts = absPath.split(path.sep);
  for (let i = parts.length - 3; i >= 0; i--) {
    if (parts[i] === "projects" && parts[i + 1]!.startsWith("-")) return parts.slice(i).join("/");
  }
  return null;
}

/** `projects/<enc>/<sid>` of a session file or of any file under its `<sid>/` directory. */
export function sessionRelativeDir(relativePath: string): string {
  const parts = relativePath.split("/");
  const sid = (parts[2] ?? "").replace(/\.jsonl$/, "");
  return [parts[0], parts[1], sid].join("/");
}

/**
 * Transcript of a child agent, relative to a config dir. A workflow agent lives under its run:
 * `<sid>/subagents/workflows/<runId>/agent-<id>.jsonl`; other subagents directly under
 * `<sid>/subagents/`.
 */
export function childTranscriptRelativePath(sessionDir: string, agentId: string, workflowRunId?: string): string | null {
  if (!SEGMENT.test(agentId)) return null;
  if (workflowRunId === undefined) return `${sessionDir}/subagents/agent-${agentId}.jsonl`;
  if (!SEGMENT.test(workflowRunId)) return null;
  return `${sessionDir}/subagents/workflows/${workflowRunId}/agent-${agentId}.jsonl`;
}

/**
 * Resolver over Claude config dirs (`~/.claude`, `~/.claude-personal`, ...): the copies that exist,
 * in the order of `configDirs`.
 */
export function configDirsResolver(configDirs: string[]): ClaudePathResolver {
  return (relativePath) => {
    const out: string[] = [];
    for (const dir of configDirs) {
      const p = path.join(dir, ...relativePath.split("/"));
      if (fs.existsSync(p)) out.push(p);
    }
    return out;
  };
}

function readJson(file: string | undefined): unknown {
  if (file === undefined) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function asMeta(value: unknown): ClaudeAgentMeta | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ClaudeAgentMeta) : null;
}

/**
 * Sidecars of the transcript at `transcriptPath` (a session file or a subagent file), read with
 * node:fs from wherever `resolve` finds them. A meta.json present in several config dirs is taken
 * from the first candidate.
 */
export function createFsSidecars(transcriptPath: string, resolve: ClaudePathResolver): ClaudeSidecars {
  const rel = configRelativePath(transcriptPath);
  const sessionDir = rel === null ? null : sessionRelativeDir(rel);
  const isSubagent = rel !== null && rel.includes("/subagents/");
  return {
    agentMetas() {
      if (sessionDir === null) return [];
      const seen = new Set<string>();
      const out: Array<{ agentId: string; meta: ClaudeAgentMeta }> = [];
      for (const dir of resolve(`${sessionDir}/subagents`)) {
        let names: string[];
        try {
          names = fs.readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          const m = /^agent-(.+)\.meta\.json$/.exec(name);
          if (m === null || seen.has(m[1]!)) continue;
          const meta = asMeta(readJson(path.join(dir, name)));
          if (meta === null) continue;
          seen.add(m[1]!);
          out.push({ agentId: m[1]!, meta });
        }
      }
      return out;
    },
    ownMeta() {
      if (!isSubagent || rel === null) return null;
      return asMeta(readJson(resolve(rel.replace(/\.jsonl$/, ".meta.json"))[0]));
    },
    workflowFinal(runId) {
      if (sessionDir === null || !SEGMENT.test(runId)) return null;
      return readJson(resolve(`${sessionDir}/workflows/${runId}.json`)[0]);
    },
    workflowJournal(runId) {
      if (sessionDir === null || !SEGMENT.test(runId)) return [];
      const file = resolve(`${sessionDir}/subagents/workflows/${runId}/journal.jsonl`)[0];
      if (file === undefined) return [];
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        return [];
      }
      const out: unknown[] = [];
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // A torn last line is a write in progress.
        }
      }
      return out;
    },
    workflowResumed(runId) {
      if (sessionDir === null || !SEGMENT.test(runId)) return false;
      const final = resolve(`${sessionDir}/workflows/${runId}.json`)[0];
      const journal = resolve(`${sessionDir}/subagents/workflows/${runId}/journal.jsonl`)[0];
      if (final === undefined || journal === undefined) return false;
      try {
        return fs.statSync(journal).mtimeMs > fs.statSync(final).mtimeMs;
      } catch {
        return false;
      }
    },
  };
}

// ---- workflow records -> OrchestrationV2SubagentWorkflow ----

function rec(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function agentState(value: unknown): OrchestrationV2WorkflowAgent["state"] {
  switch (value) {
    case "done":
    case "completed":
      return "completed";
    case "queued":
      return "queued";
    case "failed":
    case "error":
    case "cancelled":
    case "killed":
      return "failed";
    default:
      return "running";
  }
}

export function subagentStatusFromWorkflow(value: unknown): OrchestrationV2Subagent["status"] | undefined {
  switch (value) {
    case "completed":
    case "done":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "killed":
    case "stopped":
      return "cancelled";
    case "running":
      return "running";
    default:
      return undefined;
  }
}

export function childThreadIdOf(parentThreadId: string, agentId: string): string {
  return `${parentThreadId}:agent-${agentId}`;
}

export interface WorkflowView {
  workflow: Pick<OrchestrationV2SubagentWorkflow, "phases" | "agents"> &
    Partial<Pick<OrchestrationV2SubagentWorkflow, "name" | "totalTokens" | "toolCalls" | "durationMs">>;
  status?: OrchestrationV2Subagent["status"];
}

/** `<sid>/workflows/<runId>.json` (5.6 row 3). */
export function workflowFromFinal(value: unknown, parentThreadId: string): WorkflowView | null {
  const wf = rec(value);
  if (wf === undefined) return null;
  const phases: OrchestrationV2WorkflowPhase[] = [];
  const agents: OrchestrationV2WorkflowAgent[] = [];
  const progress = Array.isArray(wf.workflowProgress) ? wf.workflowProgress : [];
  for (const entry of progress) {
    const e = rec(entry);
    if (e === undefined) continue;
    if (e.type === "workflow_phase") {
      const title = str(e.title);
      if (title !== undefined) phases.push({ index: num(e.index) ?? phases.length + 1, title });
    } else if (e.type === "workflow_agent") {
      const agentId = str(e.agentId);
      const agent: OrchestrationV2WorkflowAgent = {
        index: num(e.index) ?? agents.length + 1,
        label: str(e.label) ?? agentId ?? "",
        state: agentState(e.state),
      };
      if (agentId !== undefined) {
        agent.agentId = agentId;
        agent.childThreadId = childThreadIdOf(parentThreadId, agentId);
      }
      const phaseIndex = num(e.phaseIndex);
      if (phaseIndex !== undefined) agent.phaseIndex = phaseIndex;
      const phaseTitle = str(e.phaseTitle);
      if (phaseTitle !== undefined) agent.phaseTitle = phaseTitle;
      for (const k of ["model", "effort", "speed"] as const) {
        const v = str(e[k]);
        if (v !== undefined) agent[k] = v;
      }
      const attempt = num(e.attempt);
      if (attempt !== undefined) agent.attempt = attempt;
      const tokens = num(e.tokens);
      if (tokens !== undefined) agent.totalTokens = tokens;
      for (const k of ["toolCalls", "durationMs", "queuedAt", "startedAt", "completedAt"] as const) {
        const v = num(e[k]);
        if (v !== undefined) agent[k] = v;
      }
      const prompt = str(e.promptPreview);
      if (prompt !== undefined) agent.prompt = prompt;
      const result = str(e.resultPreview);
      if (result !== undefined) agent.result = result;
      agents.push(agent);
    }
  }
  if (phases.length === 0 && Array.isArray(wf.phases)) {
    wf.phases.forEach((p, i) => {
      const title = str(rec(p)?.title);
      if (title !== undefined) phases.push({ index: i + 1, title });
    });
  }
  const workflow: WorkflowView["workflow"] = { phases, agents };
  const name = str(wf.workflowName);
  if (name !== undefined) workflow.name = name;
  const totalTokens = num(wf.totalTokens);
  if (totalTokens !== undefined) workflow.totalTokens = totalTokens;
  const toolCalls = num(wf.totalToolCalls) ?? num(wf.toolCalls);
  if (toolCalls !== undefined) workflow.toolCalls = toolCalls;
  const durationMs = num(wf.durationMs);
  if (durationMs !== undefined) workflow.durationMs = durationMs;
  const status = subagentStatusFromWorkflow(wf.status);
  return status === undefined ? { workflow } : { workflow, status };
}

/** The per-agent numbers a final record gives and a later view of the same run can lack. */
export const WORKFLOW_AGENT_METRICS = [
  "totalTokens", "toolCalls", "durationMs", "queuedAt", "startedAt", "completedAt", "model", "effort", "speed", "attempt",
] as const;

export type WorkflowAgentMetrics = Pick<OrchestrationV2WorkflowAgent, (typeof WORKFLOW_AGENT_METRICS)[number]>;

function copyMetric<K extends keyof WorkflowAgentMetrics>(to: WorkflowAgentMetrics, from: WorkflowAgentMetrics, k: K): void {
  to[k] = from[k];
}

/** The metrics an agent has, or undefined when it has none of them. */
export function agentMetrics(agent: OrchestrationV2WorkflowAgent): WorkflowAgentMetrics | undefined {
  const out: WorkflowAgentMetrics = {};
  let any = false;
  for (const k of WORKFLOW_AGENT_METRICS) {
    if (agent[k] !== undefined) {
      copyMetric(out, agent, k);
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * Each agent with the metrics it lacks taken from `from(agentId)`. A resumed run (Workflow
 * resumeFromRunId) keeps the agents that had finished: its journal has no numbers for them, and
 * its final record marks them `cached: true` with none (2.1.325, measured 2026-11-16). The numbers
 * of the run that did their work still describe them.
 */
export function carryAgentMetrics(
  agents: readonly OrchestrationV2WorkflowAgent[],
  from: (agentId: string) => WorkflowAgentMetrics | undefined,
): OrchestrationV2WorkflowAgent[] {
  return agents.map((agent) => {
    const known = agent.agentId === undefined ? undefined : from(agent.agentId);
    if (known === undefined) return agent;
    const out: OrchestrationV2WorkflowAgent = { ...agent };
    for (const k of WORKFLOW_AGENT_METRICS) {
      if (out[k] === undefined && known[k] !== undefined) copyMetric(out, known, k);
    }
    return out;
  });
}

/**
 * `journal.jsonl` records: launched, started, result, failed (5.1, 7.7 workflow 2). A resumed run
 * (Workflow resumeFromRunId) appends to the same journal: an agent that runs again gets a new
 * `started` with the same `key` and a new agentId, and takes over that agent's row (measured
 * 2026-11-16 on 2.1.325). Agents served from the cache get no new record.
 */
export function workflowFromJournal(records: unknown[], parentThreadId: string): WorkflowView | null {
  if (records.length === 0) return null;
  const phases: OrchestrationV2WorkflowPhase[] = [];
  const agents: OrchestrationV2WorkflowAgent[] = [];
  const byAgentId = new Map<string, OrchestrationV2WorkflowAgent>();
  const byKey = new Map<string, OrchestrationV2WorkflowAgent>();
  let launched = false;
  for (const r of records) {
    const e = rec(r);
    if (e === undefined) continue;
    const agentId = str(e.agentId);
    switch (e.type) {
      case "launched":
        launched = true;
        break;
      case "started": {
        if (agentId === undefined) break;
        const phaseTitle = str(e.phase);
        let phaseIndex: number | undefined;
        if (phaseTitle !== undefined) {
          let phase = phases.find((p) => p.title === phaseTitle);
          if (phase === undefined) {
            phase = { index: phases.length + 1, title: phaseTitle };
            phases.push(phase);
          }
          phaseIndex = phase.index;
        }
        const key = str(e.key);
        const again = key === undefined ? undefined : byKey.get(key);
        const agent: OrchestrationV2WorkflowAgent = {
          index: again?.index ?? agents.length + 1,
          label: str(e.label) ?? agentId,
          agentId,
          childThreadId: childThreadIdOf(parentThreadId, agentId),
          state: "running",
        };
        if (phaseTitle !== undefined) agent.phaseTitle = phaseTitle;
        if (phaseIndex !== undefined) agent.phaseIndex = phaseIndex;
        if (again !== undefined) agents[agents.indexOf(again)] = agent;
        else agents.push(agent);
        byAgentId.set(agentId, agent);
        if (key !== undefined) byKey.set(key, agent);
        break;
      }
      case "result": {
        const agent = agentId === undefined ? undefined : byAgentId.get(agentId);
        if (agent === undefined) break;
        agent.state = "completed";
        const result = e.result;
        if (result !== undefined) agent.result = typeof result === "string" ? result : JSON.stringify(result);
        break;
      }
      case "failed": {
        const agent = agentId === undefined ? undefined : byAgentId.get(agentId);
        if (agent !== undefined) agent.state = "failed";
        break;
      }
    }
  }
  return launched || agents.length > 0 ? { workflow: { phases, agents }, status: "running" } : null;
}
