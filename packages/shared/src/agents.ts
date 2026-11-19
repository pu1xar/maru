// Every subagent, workflow, background shell command and Monitor of one session (DESIGN.md 6e, the
// right panel's "작업" tab), read from the session's sidecar files and transcript rather than from
// the loaded page of its transcript, so an agent started long ago still shows while it runs.
// `GET /api/session-agents?key=<session key>`.
// Each row also says what it can do (stop, resume) and why not (DESIGN.md 6i).
import type { OrchestrationV2Subagent, OrchestrationV2SubagentWorkflow } from "./turnItems.ts";

export interface SessionAgentView {
  /** The agent id, the workflow run id, or the background task id of a shell command or Monitor. */
  id: string;
  /**
   * "shell" is a background Bash command of a Claude session or a background terminal of a Codex
   * session, "monitor" a Monitor (DESIGN.md 6i, background 작업).
   */
  kind: "agent" | "workflow" | "shell" | "monitor";
  title: string;
  /** "running" until the agent's meta says finished; "interrupted" when the session closed first. */
  status: OrchestrationV2Subagent["status"];
  agentType: string | null;
  model: string | null;
  /** The subagent that started this one, for a subagent of a subagent. */
  parentAgentId: string | null;
  /** Thread id to open its conversation, null when it has no transcript yet. */
  childThreadId: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  /** When it finished, as far as the files tell (the transcript's last write). */
  completedAt: string | null;
  workflow?: Pick<OrchestrationV2SubagentWorkflow, "phases" | "agents"> &
    Partial<Pick<OrchestrationV2SubagentWorkflow, "name" | "totalTokens" | "toolCalls" | "durationMs">>;
  /** A shell command row's command line, and a Monitor's watched command. */
  command?: string;
  /** A Codex terminal row's working directory (the daemon's list names it; a Claude row has none). */
  cwd?: string;
  /** A shell command's exit code once it ended; null when its end notice names none. */
  exitCode?: number | null;
  /** The CLI's one-line notice of how the task ended ("... completed (exit code 0)"). */
  endSummary?: string;
  /** The row's 중단 action, on a running row (DESIGN.md 6i). Absent: the row has none. */
  stop?: AgentAction;
  /** The row's 이어서 실행 action, on a workflow that was stopped, interrupted or failed. Absent: none. */
  resume?: AgentAction;
  /**
   * An action this server sent that the files do not show yet: "stopping" after 중단 until the row
   * stops running, "resuming" after 이어서 실행 until the workflow runs again or the turn that got
   * the message ends without starting it. The action stays disabled meanwhile.
   */
  settling?: "stopping" | "resuming";
}

/** An action a row offers. `reason` says why it cannot run now (the button's tooltip). */
export interface AgentAction {
  enabled: boolean;
  reason: string | null;
}

export interface SessionAgentsResponse {
  agents: SessionAgentView[];
  /** Why part of the list is missing (the Codex session's background terminals could not be read). */
  warnings?: string[];
}

/**
 * GET /api/session-agents/count?key=: how many of the session's subagents and workflows run, for
 * the conversation header while the list itself is not shown (the full list can be half a MB).
 */
export interface SessionAgentsCount {
  running: number;
}

/**
 * GET /api/session-agents/output?key=&kind=shell|monitor&id=: the end of a background shell command
 * or Monitor's output (the file the CLI writes it to), as plain text. A Codex terminal's output is
 * what its item holds once it ended; empty while it runs (the daemon gives none) or when it printed
 * nothing. 404 no such row, or a Claude task whose output file is gone.
 */
export interface SessionTaskOutput {
  output: string;
  /** The size of the whole output, bytes. */
  totalBytes: number;
  /** `output` holds only the end of a longer output. */
  truncated: boolean;
}

/**
 * POST /api/session-agents/stop: stops one running subagent, workflow, background shell command or
 * Monitor of the session.
 * `id` is the row's id (agent id, workflow run id; a Codex subagent's thread id). -> { ok: true }
 * 400 bad request, 404 no such row, 409 the row is not running or this server cannot reach it
 * (a terminal holds the session, the session host is down), 502 the CLI or daemon refused.
 */
export interface StopSessionAgent {
  key: string;
  kind: SessionAgentView["kind"];
  id: string;
}

/**
 * POST /api/session-agents/resume: asks the session to run a stopped workflow again from its run
 * (`Workflow({scriptPath, resumeFromRunId})`), resuming a closed session. -> ResumeSessionWorkflowResult
 * 400, 404 (no such workflow, or its record names no script), 409 (a terminal holds the session, or
 * a resume of this workflow was already sent and has not started it yet).
 */
export interface ResumeSessionWorkflow {
  key: string;
  id: string;
}

export interface ResumeSessionWorkflowResult {
  ok: true;
  /** The message sent to the session. */
  prompt: string;
}
