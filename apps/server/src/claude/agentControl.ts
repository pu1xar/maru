// Stop and resume for the rows of the right panel's "작업" tab (DESIGN.md 6i): which action a row
// offers and why it cannot run now, the message that resumes a stopped workflow, and where the
// workflow's run record is. Measured on Claude Code 2.1.325 (2026-11-16):
// - A subagent's task id is its agent id (task_started.task_id equals the Agent result's agentId
//   and the `agent-<id>.meta.json` name).
// - A workflow's task id is not its run id. The Workflow result (`async_launched`) names both, and
//   a resumed run keeps the run id under a new task id, so the latest result for a run id counts.
// - stopTask on a workflow writes its final record with status "killed", scriptPath and args at
//   once; the model is not told. Resuming with `Workflow({scriptPath, resumeFromRunId})` appends to
//   the same run: finished agents come back from the cache, the others run again.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { AgentAction, SessionAgentView, SessionSummary } from "@maru/shared";

/** Tooltips of a disabled action. Short phrases: they end without a period. */
export const ACTION_REASON = {
  terminalStop: "Running in a terminal, so it cannot be stopped here",
  terminalResume: "Open in a terminal, so you cannot send from here",
  notDriven: "Not a run started by this server",
  hostDown: "Claude session host is down",
  unread: "Still reading the session state",
  stopping: "Stopping",
  resuming: "Resuming",
} as const;

const RESUMABLE = new Set<SessionAgentView["status"]>(["cancelled", "interrupted", "failed"]);

export interface ActionContext {
  /** The session as the index sees it; undefined when it is not there. */
  session: SessionSummary | undefined;
  /** A CLI process this server started holds the session (ClaudeRuns). */
  driven: boolean;
  /** The Claude session host is connected. */
  hostUp: boolean;
}

const ok: AgentAction = { enabled: true, reason: null };
const no = (reason: string): AgentAction => ({ enabled: false, reason });

/**
 * The rows with their actions. 중단 on a running row: it needs the session's CLI to be this
 * server's (stopTask goes to that process). 이어서 실행 on a workflow that was stopped, interrupted
 * or failed: it sends a message, so it needs only that no terminal holds the session (a closed
 * session is resumed by the send). A session the index has not read yet (the first sweep after a
 * restart of this server) and this server does not run offers neither until its state is known.
 */
export function withActions(rows: readonly SessionAgentView[], ctx: ActionContext): SessionAgentView[] {
  const terminal = ctx.session?.owner === "terminal" && ctx.session.status !== "closed";
  const unread = ctx.session === undefined && !ctx.driven;
  const stop = terminal
    ? no(ACTION_REASON.terminalStop)
    : unread ? no(ACTION_REASON.unread) : !ctx.driven ? no(ACTION_REASON.notDriven) : !ctx.hostUp ? no(ACTION_REASON.hostDown) : ok;
  const resume = terminal
    ? no(ACTION_REASON.terminalResume)
    : unread ? no(ACTION_REASON.unread) : !ctx.hostUp ? no(ACTION_REASON.hostDown) : ok;
  return rows.map((row) => {
    const out: SessionAgentView = { ...row };
    if (row.status === "running") out.stop = stop;
    if (row.kind === "workflow" && RESUMABLE.has(row.status)) out.resume = resume;
    return out;
  });
}

/**
 * The message that asks the session to run a stopped workflow again: the CLI's own resume prompt
 * (buildResumePrompt in 2.1.325, with a period where it has a dash) after a sentence that says the
 * user asks for it. A stop makes the CLI queue a notice that ends "Only if the user asks you to
 * resume it, call: Workflow(...)", and it reaches the model together with this message; with the
 * CLI's prompt alone haiku once answered by offering to resume instead of resuming (2026-11-16).
 */
export function workflowResumePrompt(r: { scriptPath: string; runId: string; args?: unknown }): string {
  const args = r.args !== undefined ? `, args: ${JSON.stringify(r.args)}` : "";
  return `I want this workflow to continue. Resume the paused workflow by calling: Workflow({scriptPath: '${r.scriptPath}', resumeFromRunId: '${r.runId}'${args}}). Completed agents return cached results.`;
}

/** A workflow run as the resume message and the stop need it. */
export interface WorkflowRecord {
  runId: string;
  scriptPath: string;
  /** Workflow's `args` input; absent when the launch had none. */
  args?: unknown;
}

/** What the session's transcript says about the newest launch of a run. */
export interface WorkflowLaunch extends WorkflowRecord {
  /** The task id of that launch, for stopTask. */
  taskId: string;
}

const RUN_ID = /^wf_[A-Za-z0-9_-]+$/;

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * The newest launch of `runId` in a transcript: the last Workflow result (`toolUseResult` with this
 * runId and a taskId), and the args of the Workflow call it answers. The file is read line by
 * line; only lines that name Workflow or the run id are parsed. Null when no launch is there (a
 * workflow a subagent started writes to the subagent's transcript).
 */
export async function findWorkflowLaunch(transcript: string, runId: string): Promise<WorkflowLaunch | null> {
  if (!RUN_ID.test(runId)) return null;
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(transcript, { encoding: "utf8" });
  } catch {
    return null;
  }
  const inputs = new Map<string, Record<string, unknown>>();
  let last: { taskId: string; scriptPath: string; toolUseId: string | null } | null = null;
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const names = line.includes('"name":"Workflow"');
      if (!names && !line.includes(runId)) continue;
      let o: Record<string, unknown> | null;
      try {
        o = rec(JSON.parse(line));
      } catch {
        continue;
      }
      const content = rec(o?.message)?.content;
      if (names && Array.isArray(content)) {
        for (const b of content) {
          const block = rec(b);
          if (block?.type === "tool_use" && block.name === "Workflow" && typeof block.id === "string") {
            inputs.set(block.id, rec(block.input) ?? {});
          }
        }
      }
      const result = rec(o?.toolUseResult);
      if (result?.runId === runId && typeof result.taskId === "string" && typeof result.scriptPath === "string") {
        const first = Array.isArray(content) ? rec(content[0]) : null;
        last = { taskId: result.taskId, scriptPath: result.scriptPath, toolUseId: typeof first?.tool_use_id === "string" ? first.tool_use_id : null };
      }
    }
  } catch {
    // An unreadable transcript has no launch to offer.
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!last) return null;
  const input = last.toolUseId ? inputs.get(last.toolUseId) : undefined;
  return {
    runId, taskId: last.taskId, scriptPath: last.scriptPath,
    ...(input && input.args !== undefined ? { args: input.args } : {}),
  };
}

/**
 * Where to resume `runId` from, in this order:
 * 1. its final record `<sid>/workflows/<runId>.json` (stopped, failed, or finished runs): scriptPath, args
 * 2. the newest launch in the session transcript (a run its process left without a final record)
 * 3. the copy the CLI keeps of an inline script, `<sid>/workflows/scripts/<name>-<runId>.js` (args unknown)
 * `sessionDirs` are the session's `<sid>` folders in every config dir, best first.
 */
export async function readWorkflowRecord(sessionDirs: readonly string[], transcript: string | null, runId: string): Promise<WorkflowRecord | null> {
  if (!RUN_ID.test(runId)) return null;
  for (const dir of sessionDirs) {
    const final = rec(readJson(path.join(dir, "workflows", `${runId}.json`)));
    if (final && typeof final.scriptPath === "string" && final.scriptPath) {
      return { runId, scriptPath: final.scriptPath, ...("args" in final && final.args !== undefined ? { args: final.args } : {}) };
    }
  }
  if (transcript) {
    const launch = await findWorkflowLaunch(transcript, runId);
    if (launch) return { runId, scriptPath: launch.scriptPath, ...(launch.args !== undefined ? { args: launch.args } : {}) };
  }
  for (const dir of sessionDirs) {
    const scripts = path.join(dir, "workflows", "scripts");
    let names: string[];
    try {
      names = fs.readdirSync(scripts);
    } catch {
      continue;
    }
    const copy = names.find((n) => n.endsWith(`-${runId}.js`));
    if (copy) return { runId, scriptPath: path.join(scripts, copy) };
  }
  return null;
}
