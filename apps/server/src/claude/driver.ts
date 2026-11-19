// Drives Claude Code sessions for the UI (DESIGN.md 2b, 3.1, 4.2). The SDK `query()` and so the
// CLI child processes live in the session host (host/), a separate process, so restarting this
// server leaves turns, questions and background tasks running. This side decides everything the
// host does not: the CLI's options, which tool asks need a person, who holds a session, and which
// CLI pids are ours. One run is one CLI process in streaming input mode: later sends are the next
// user messages, and each `result` message ends a turn.
//
// Rules, each from a measurement (docs/measurements-2026-11-15.md 3, 3b) or the SDK docs:
// - The child env is built from scratch: HOME, USER, LOGNAME (login fails without them), PATH,
//   LANG, SHELL (plus TMPDIR and SSH_AUTH_SOCK when set), CLAUDE_CONFIG_DIR (the account) and
//   CLAUDE_CODE_ENTRYPOINT=maru (the terminal `claude --resume` list shows a session
//   only with a non-SDK entrypoint). The SDK passes `env` as the whole environment, so the host's
//   own env does not reach the CLI.
// - bypassPermissions with settingSources left out, so settings, hooks and skills load as in
//   the terminal. canUseTool still receives AskUserQuestion, ExitPlanMode and asks that need a
//   person; those wait for answer(), every other ask is allowed at once so no turn stalls. The
//   host forwards every canUseTool call here; while this server is away (a restart) the call
//   waits in the host and arrives in the snapshot when this server connects again.
// - A session is written by one process at a time: two processes resuming one session both
//   succeed and fork the conversation inside one file. start() refuses a resume target that is
//   open anywhere, and a run keeps its sessions held until its CLI process has exited.
// - The CLI pid comes from its registration `<config dir>/sessions/<pid>.json` whose process is a
//   child of the host (driver-pid.ts); the index marks those sessions "ui"-owned.
// - Runs the host already has when this server connects (after a restart of this server) are
//   adopted: onAdopt() hands each one over with the questions it still waits on.
// - Events of a run reach its DriverEvents only after start() has returned to its caller.
// - An interrupt stops the turn only; background agents and workflows are stopped one at a time
//   with stopTask (perTaskStopAffordance, DESIGN.md 6i).
// - A rewind (DESIGN.md 6o) starts a process without a message (the host's run.start takes an
//   empty list), resumes it only up to a line (resumeSessionAt), and keeps file checkpoints
//   (enableFileCheckpointing) so rewindFiles can restore files. Whether a run keeps them travels
//   in the run.start meta, so a run adopted after a restart of this server knows it too.
// - Whether a turn runs is the host's run.state busy: it ends at the turn's result also while
//   background tasks go on (the CLI's sessions/<pid>.json stays busy until they end). Every user
//   message goes out with a client uuid; the CLI writes it under that uuid and the result names it
//   (user_message_uuids), so a result tells which transcript run it ended (measured 2026-11-16).
// - The `/` menu's commands (supportedCommands) and the model picker's models (supportedModels)
//   come from the CLI's initialize answer, which a process gives before any message. probe()
//   starts one in this process that is sent nothing, reads the answer and closes it. Measured 2026-11-16 on 2.1.325 with the API base URL
//   pointed at a local recorder: 128 commands in 1.3 to 1.7 s (11 s once for a cold account), the
//   only request a `HEAD /api/hello`, no /v1/messages; with the real endpoint one more command
//   (ultrareview). SessionStart hooks run at that start (one writes CLAUDE.md into a folder that
//   lacks it), so the probe turns hooks off; the list was the same with them off. persistSession
//   false keeps it out of the transcripts; its sessions/<pid>.json lives until the process exits.
import { randomUUID, type UUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { EffortLevel, ModelInfo, PermissionResult, SDKMessage, SDKUserMessage, Settings, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { SessionHostStatus, SettablePermissionMode } from "@maru/shared";
import { HostRequestError } from "../host/client.ts";
import type { CallbackInfo, ControlMethod, DrainWait, HostEvent, RunInfo, Snapshot, TaskInfo, WireOptions } from "../host/protocol.ts";
import { scanChildRegistration, waitForChildRegistration } from "./driver-pid.ts";
import { CLAUDE_BIN } from "../config.ts";
import { HostDownError, type HostLink } from "./hostLink.ts";
import { isPidAlive } from "./registry.ts";

/** Recorded as the transcript `entrypoint` of every session this driver runs. */
export const ENTRYPOINT = "maru";

/** Default CLI (config `claudeBin`, else `claude` on PATH), resolved to the versioned binary it points at at each start. */
export const DEFAULT_EXECUTABLE = CLAUDE_BIN;

/**
 * Keys of the answers for an approval (ExitPlanMode, or another tool whose ask needs a
 * person): `{ decision: "approve" | "reject", feedback?: string }`. AskUserQuestion answers
 * instead map each question text to the chosen label.
 */
export const DECISION_KEY = "decision";
export const FEEDBACK_KEY = "feedback";

export interface ClaudeDriverDeps {
  /** The session host that runs the CLI processes (hostLink.ts). */
  link: HostLink;
  /** SDK query() for probe(), which runs in this process. Default: the SDK's. */
  query?: typeof import("@anthropic-ai/claude-agent-sdk").query;
  /** True when a live process holds the session (filled from the Claude index). */
  isSessionOpen: (sessionId: string) => boolean;
  /** CLI path, resolved with realpath at each start. Default DEFAULT_EXECUTABLE. */
  executable?: string;
  log?: (line: string) => void;
}

export interface StartOpts {
  /** CLAUDE_CONFIG_DIR of the account. */
  accountDir: string;
  cwd: string;
  /** Session id to continue. Omitted: a new session. */
  resume?: string;
  model?: string;
  /** The name of a new session (the SDK's `title`); a resumed session keeps its own. */
  title?: string;
  /** Effort of the session's turns (the CLI's --effort). */
  effort?: EffortLevel;
  /** Flag settings the process starts with (fastMode, outputStyle), as applyFlagSettings sets them later. */
  flagSettings?: Settings;
  /** The mode the process starts in. Default bypassPermissions (DESIGN.md 1). */
  permissionMode?: SettablePermissionMode;
  /** First user message: its text, or its content blocks when it carries pictures (attachments/message.ts). Absent: the process starts and waits for the first send (a rewind, DESIGN.md 6o). */
  prompt?: UserContent;
  /** Its uuid (the pending send's id, DESIGN.md 4.4). Default: a new one. */
  promptId?: string;
  /** Resume only up to this transcript line (the SDK's resumeSessionAt): a conversation rewind (DESIGN.md 6o). */
  resumeSessionAt?: string;
  /** The CLI keeps file checkpoints so rewindFiles can restore files (the SDK's enableFileCheckpointing). */
  fileCheckpointing?: boolean;
}

/** A user message's content as the SDK takes it: text, or blocks (text, image). */
export type UserContent = SDKUserMessage["message"]["content"];

/**
 * Where the CLI puts a user message (SDKUserMessage.priority). The default is `next`: at the next
 * tool boundary of a running turn, or as the next turn. `now` cuts what the turn is waiting on and
 * runs the message as a new turn (DESIGN.md 4.4, "Send now").
 */
export type SendPriority = NonNullable<SDKUserMessage["priority"]>;

/** The parts of a CLI's initialize answer the composer uses (probe). */
export interface ProbeInfo {
  commands: SlashCommand[];
  models: ModelInfo[];
  /** The output styles the session can switch to. */
  outputStyles: string[];
}

/**
 * question  AskUserQuestion: answers map each question text to the chosen label(s)
 * plan      ExitPlanMode: answers carry DECISION_KEY (and FEEDBACK_KEY on reject)
 * approval  another tool whose ask needs a person: answers as for plan
 */
export type QuestionKind = "question" | "plan" | "approval";

export interface PendingQuestion {
  /** The control request id. answer() takes this. */
  requestId: string;
  toolUseId: string;
  toolName: string;
  kind: QuestionKind;
  /** Tool input as the model wrote it (AskUserQuestion `questions`, ExitPlanMode `plan`). */
  input: Record<string, unknown>;
  /** Prompt wording the CLI supplied, when it did. */
  title: string | null;
  description: string | null;
  decisionReason: string | null;
  /** Set when a subagent made the call. */
  agentId: string | null;
}

/** A run as the session host tracks it (host/protocol.ts RunInfo). */
export interface RunState {
  /** A turn runs: from a user message or a system/init until its result. */
  busy: boolean;
  /** Tasks the CLI reported as started and not yet ended (background ones outlive the turn). */
  tasks: TaskInfo[];
}

export interface DriverEvents {
  onMessage(m: SDKMessage): void;
  /** busy or the tasks changed. The current state is RunHandle.state(). */
  onState?(s: RunState): void;
  onQuestion(q: PendingQuestion): void;
  /**
   * A question ended without an answer: the CLI withdrew it (interrupt, cancelled turn) or the
   * run ended. answer() for it throws from then on.
   */
  onQuestionWithdrawn?(requestId: string): void;
  /**
   * Called once per run, after the CLI process has exited.
   * done         the process ended on its own or close() found it between turns
   * interrupted  close() ended it during a turn
   * error        the process or the SDK failed (also before the session started), or the run
   *              was gone from the host when this server reconnected while a turn ran
   */
  onExit(info: { code: "done" | "error" | "interrupted"; error?: string }): void;
}

export interface RunHandle {
  /** The resume target at first, or null for a new session until the CLI reports its id. */
  sessionId(): string | null;
  /** CLI pid, null until its registration file is found. */
  pid(): number | null;
  /** busy and the tasks as the host last reported them (a send makes it busy at once). */
  state(): RunState;
  /**
   * Queue the next user message, under `id` when given (a uuid, the pending send's, DESIGN.md 4.4).
   * Rejects once the run has ended or is closing, or without the host. `priority` rides on the
   * message object, which the host passes on as it is (host/core.ts run.send).
   */
  send(content: UserContent, id?: string, priority?: SendPriority): Promise<void>;
  /** Stop the current turn; the process stays for the next send(). */
  interrupt(): Promise<void>;
  /** Answer a pending question. Throws for an unknown request id, a malformed decision, or without the host. */
  answer(requestId: string, answers: Record<string, string>): void;
  /** End the process. Resolves after onExit, so after the process has exited. */
  close(): Promise<void>;
  /** The process keeps file checkpoints (started with fileCheckpointing; for an adopted run, its start's meta says so). */
  fileCheckpointing(): boolean;
  /** The session's slash commands as its process knows them now (it follows commands_changed). */
  commands(): Promise<SlashCommand[]>;
  /** Any Query control method the host allows (host/protocol.ts CONTROL_METHODS). */
  call<T = unknown>(method: ControlMethod, ...args: unknown[]): Promise<T>;
  /** Stop one task (a subagent, a workflow, a background command); the turn goes on. */
  stopTask(taskId: string): Promise<void>;
  /**
   * The task id of the newest launch of workflow run `runId` this server saw (the Workflow
   * result names both). Null when the launch came before this server connected.
   */
  workflowTaskId(runId: string): string | null;
}

/** A run the host had before this server connected. */
export interface AdoptedRun {
  accountDir: string;
  cwd: string | null;
}

export interface ClaudeDriver {
  /**
   * Starts a CLI in the host and returns once the host took it; messages and the exit arrive
   * through `ev`. Throws before launching: SessionOpenError for a held resume target, a missing
   * cwd or executable, HostDownError, or the host's refusal (a draining host takes no new runs).
   */
  start(opts: StartOpts, ev: DriverEvents): Promise<RunHandle>;
  /** pids of the live CLI processes of this driver's runs. */
  ownPids(): Set<number>;
  /**
   * True while a run holds the session: from start() until its CLI process has exited, also
   * before the process has registered (the index cannot see it yet then).
   */
  holds(sessionId: string): boolean;
  /**
   * The slash commands, models and output styles a session of this account in `cwd` would have,
   * from a CLI process that is sent no message (no model call, no transcript, hooks off). The
   * process is closed once it answered.
   */
  probe(opts: { accountDir: string; cwd: string }): Promise<ProbeInfo>;
  /**
   * Takes the runs the host already had when this server connected. The handler gets each run
   * once and returns its events; the questions the run waits on follow right after. Runs found
   * before a handler is set wait for it.
   */
  onAdopt(handler: (handle: RunHandle, run: AdoptedRun) => DriverEvents): void;
  /** Resolves once the first attempt to reach the host ended (runs adopted, their pids looked up once). */
  ready(): Promise<void>;
  hostStatus(): SessionHostStatus;
  onHostStatus(listener: (s: SessionHostStatus) => void): () => void;
}

export class SessionOpenError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} is open in a live process`);
    this.name = "SessionOpenError";
    this.sessionId = sessionId;
  }
}

/** A draining host takes no new runs until it has restarted. */
export class HostDrainingError extends Error {
  constructor() {
    super("The Claude session host is waiting for running work to finish before a restart, so it accepts no new runs. Send again after the restart");
    this.name = "HostDrainingError";
  }
}

/**
 * The child's whole environment. Values missing from `base` fall back to this machine's.
 * SHELL, TMPDIR and SSH_AUTH_SOCK pass through so the Bash tool behaves as in the terminal
 * (the user's shell, the per-user temp dir, git over ssh through the agent).
 */
export function buildEnv(accountDir: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const info = os.userInfo();
  const user = base.USER || base.LOGNAME || info.username;
  const env: Record<string, string> = {
    HOME: base.HOME || os.homedir(),
    USER: user,
    LOGNAME: base.LOGNAME || user,
    PATH: base.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
    // The shell and pm2 services on this machine run with C.UTF-8.
    LANG: base.LANG || "C.UTF-8",
    SHELL: base.SHELL || info.shell || "/bin/zsh",
    CLAUDE_CONFIG_DIR: accountDir,
    CLAUDE_CODE_ENTRYPOINT: ENTRYPOINT,
  };
  if (base.TMPDIR) env.TMPDIR = base.TMPDIR;
  if (base.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = base.SSH_AUTH_SOCK;
  return env;
}

export function questionKind(toolName: string, requiresUserInteraction: boolean): QuestionKind | null {
  if (toolName === "AskUserQuestion") return "question";
  if (toolName === "ExitPlanMode") return "plan";
  return requiresUserInteraction ? "approval" : null;
}

/** The permission result for an answer. Throws when a plan or approval answer has no valid decision. */
export function resultForAnswer(
  kind: QuestionKind,
  input: Record<string, unknown>,
  answers: Record<string, string>,
): PermissionResult {
  if (kind === "question") return { behavior: "allow", updatedInput: { ...input, answers } };
  const decision = answers[DECISION_KEY];
  if (decision === "approve") return { behavior: "allow", updatedInput: input };
  if (decision !== "reject") {
    throw new Error(`answer needs ${DECISION_KEY} "approve" or "reject", got ${JSON.stringify(decision)}`);
  }
  const feedback = answers[FEEDBACK_KEY]?.trim();
  const base = kind === "plan" ? "The user did not approve the plan. Keep planning." : "The user rejected this tool call.";
  return { behavior: "deny", message: feedback ? `${base} Feedback: ${feedback}` : base };
}

/** Async queue used as the probe's prompt: it never yields, so the CLI waits for a first message. */
function createIdleInbox() {
  let wake: (() => void) | null = null;
  let ended = false;
  return {
    end(): void {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void> {
      while (!ended) await new Promise<void>((resolve) => (wake = resolve));
    },
  };
}

/**
 * A user message with a client uuid: the CLI writes it under that uuid and its turn's result names
 * it. The host passes the message on as it is (host/protocol.ts run.start, run.send), so content
 * blocks (pictures) need no host change.
 */
export function userMessage(content: UserContent, id: string = randomUUID(), priority?: SendPriority): SDKUserMessage {
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid: id as UUID, ...(priority !== undefined ? { priority } : {}) };
}

const CANCELLED: PermissionResult = { behavior: "deny", message: "The request ended before the user answered." };

/** Event handlers belong to the server; a throw there is logged and the run keeps going. */
function safely(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`claude driver: ${what} handler threw`, err);
  }
}

function stringField(o: unknown, key: string): string | null {
  if (!o || typeof o !== "object") return null;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/** Resolves once `pid` has exited. The SDK's close() sends SIGTERM, then SIGKILL, so it does. */
async function waitForExit(pid: number): Promise<void> {
  while (isPidAlive(pid)) await sleep(100);
}

/** One UI line for a run a draining host waits for. */
function waitLine(w: DrainWait): string {
  const parts: string[] = [];
  if (w.turn) parts.push("turn running");
  if (w.callbacks.length) parts.push(`awaiting answers ${w.callbacks.length}`);
  if (w.tasks.length) parts.push(`background tasks ${w.tasks.length}`);
  return `session ${w.sessionId?.slice(0, 8) ?? "?"} (${w.cwd ? path.basename(w.cwd) : "?"}): ${parts.join(", ")}`;
}

interface Rec {
  runId: string;
  accountDir: string;
  sessionsDir: string;
  cwd: string | null;
  /** pid of the host that runs it: the CLI is that process's child. */
  hostPid: number;
  sessionId: string | null;
  busy: boolean;
  tasks: TaskInfo[];
  closing: boolean;
  ended: boolean;
  /** Started with file checkpointing on. */
  checkpointing: boolean;
  ev: DriverEvents | null;
  /** Deliveries wait here until start() has returned to its caller (or the run was adopted). */
  released: boolean;
  queue: Array<() => void>;
  questions: Map<string, { question: PendingQuestion; callbackId: string }>;
  /** Workflow run id -> task id of its newest launch, from the Workflow results in run.message. */
  workflowTasks: Map<string, string>;
  pid: number | null;
  pidWatch: AbortController;
  /** First registration scan of an adopted run, for ready(). */
  firstScan: Promise<void>;
  exited: Promise<void>;
  markExited: () => void;
  handle: RunHandle;
}

export function createClaudeDriver(deps: ClaudeDriverDeps): ClaudeDriver {
  const link = deps.link;
  const probeQuery = deps.query ?? sdkQuery;
  const recs = new Map<string, Rec>();
  /** session id -> the run holding it, from start() until its process has exited. */
  const holders = new Map<string, Rec>();
  /** callback id -> the run and the request id of the question it carries. */
  const byCallback = new Map<string, { rec: Rec; requestId: string }>();
  let adopter: ((handle: RunHandle, run: AdoptedRun) => DriverEvents) | null = null;
  const statusListeners = new Set<(s: SessionHostStatus) => void>();
  let lastStatus = "";

  // ---- delivery ----

  function deliver(rec: Rec, what: string, fn: (ev: DriverEvents) => void): void {
    const run = () => {
      if (rec.ev) safely(what, () => fn(rec.ev!));
    };
    if (rec.released && rec.ev) run();
    else rec.queue.push(run);
  }

  function release(rec: Rec): void {
    rec.released = true;
    for (const d of rec.queue.splice(0)) d();
  }

  // ---- runs ----

  function newRec(runId: string, accountDir: string, cwd: string | null, sessionId: string | null, hostPid: number): Rec {
    let markExited!: () => void;
    const rec: Rec = {
      runId, accountDir, sessionsDir: path.join(accountDir, "sessions"), cwd, hostPid, sessionId,
      busy: false, tasks: [], closing: false, ended: false, checkpointing: false, ev: null, released: false, queue: [],
      questions: new Map(), workflowTasks: new Map(), pid: null, pidWatch: new AbortController(), firstScan: Promise.resolve(),
      exited: new Promise<void>((r) => (markExited = r)), markExited: () => markExited(),
      handle: undefined as unknown as RunHandle,
    };
    rec.handle = handleOf(rec);
    if (sessionId !== null) holders.set(sessionId, rec);
    return rec;
  }

  /** Follow the session the CLI writes to; /clear and plan resets move it to a new id. */
  function setSessionId(rec: Rec, id: string | null): void {
    if (id === null || id === rec.sessionId) return;
    if (rec.sessionId !== null && holders.get(rec.sessionId) === rec) holders.delete(rec.sessionId);
    rec.sessionId = id;
    holders.set(id, rec);
  }

  /** Take busy and the tasks the host reported; the run's events hear of a change. */
  function setState(rec: Rec, busy: boolean, tasks: TaskInfo[] = rec.tasks): void {
    if (busy === rec.busy && JSON.stringify(tasks) === JSON.stringify(rec.tasks)) return;
    rec.busy = busy;
    rec.tasks = tasks;
    const s: RunState = { busy, tasks };
    deliver(rec, "onState", (ev) => ev.onState?.(s));
  }

  function watchPid(rec: Rec): void {
    rec.pidWatch.abort();
    const ctl = new AbortController();
    rec.pidWatch = ctl;
    void waitForChildRegistration({ sessionsDir: rec.sessionsDir, sessionId: () => rec.sessionId, signal: ctl.signal, parentPid: rec.hostPid }).then(
      (pid) => {
        if (pid !== null && !rec.ended) rec.pid = pid;
      },
      (err) => console.error("claude driver: pid lookup failed", err),
    );
  }

  async function finish(rec: Rec, info: { code: "done" | "error" | "interrupted"; error?: string }): Promise<void> {
    if (rec.ended) return;
    rec.ended = true;
    rec.pidWatch.abort();
    const withdrawn = [...rec.questions.entries()];
    rec.questions.clear();
    for (const [requestId, e] of withdrawn) {
      byCallback.delete(e.callbackId);
      deliver(rec, "onQuestionWithdrawn", (ev) => ev.onQuestionWithdrawn?.(requestId));
    }
    // The SDK ends its stream before the process exits (close() leaves SIGTERM to a timer).
    // The sessions stay held and the pid stays ours until the process is gone.
    let pid = rec.pid;
    if (pid === null && rec.sessionId !== null) {
      pid = await scanChildRegistration(rec.sessionsDir, rec.sessionId, rec.hostPid).catch(() => null);
      if (pid !== null) rec.pid = pid;
    }
    if (pid !== null) await waitForExit(pid);
    for (const [id, holder] of holders) if (holder === rec) holders.delete(id);
    recs.delete(rec.runId);
    rec.pid = null;
    deliver(rec, "onExit", (ev) => ev.onExit(info));
    rec.markExited();
  }

  function attach(rec: Rec): void {
    if (!adopter || rec.ev) return;
    const handler = adopter;
    safely("onAdopt", () => {
      rec.ev = handler(rec.handle, { accountDir: rec.accountDir, cwd: rec.cwd });
    });
    for (const { question } of rec.questions.values()) deliver(rec, "onQuestion", (ev) => ev.onQuestion(question));
    release(rec);
  }

  function adoptRec(r: RunInfo, hostPid: number): Rec {
    const meta = (r.meta ?? {}) as { accountDir?: unknown; fileCheckpointing?: unknown };
    const accountDir = typeof meta.accountDir === "string" ? meta.accountDir : "";
    const rec = newRec(r.runId, accountDir, r.cwd, r.sessionId, hostPid);
    // Runs started before the meta carried it ran without checkpoints.
    rec.checkpointing = meta.fileCheckpointing === true;
    rec.busy = r.busy;
    rec.tasks = r.tasks;
    rec.closing = r.closing;
    recs.set(rec.runId, rec);
    // The index needs the pid before its first sweep to mark the session "ui"-owned.
    rec.firstScan = (async () => {
      if (rec.sessionId === null || !accountDir) return;
      const pid = await scanChildRegistration(rec.sessionsDir, rec.sessionId, hostPid).catch(() => null);
      if (pid !== null && !rec.ended) rec.pid = pid;
    })();
    if (accountDir) watchPid(rec);
    deps.log?.(`claude driver: adopted run ${r.runId} session ${r.sessionId ?? "?"} busy=${r.busy}`);
    attach(rec);
    return rec;
  }

  // ---- callbacks ----

  function reply(callbackId: string, result: PermissionResult): void {
    // Without the host the call stays pending there and comes back in the next snapshot.
    link.post({ op: "callback.reply", callbackId, result });
  }

  function onCallback(info: CallbackInfo): void {
    if (byCallback.has(info.callbackId)) return;
    const rec = recs.get(info.runId);
    if (!rec) return;
    if (info.name !== "canUseTool") {
      link.post({ op: "callback.reply", callbackId: info.callbackId, error: `maru does not handle ${info.name}` });
      return;
    }
    const [toolName, input, ctx] = info.args as [unknown, Record<string, unknown> | null, Record<string, unknown> | null];
    const c = ctx ?? {};
    const kind = questionKind(String(toolName), c.requiresUserInteraction === true);
    if (kind === null) {
      reply(info.callbackId, { behavior: "allow", updatedInput: input ?? {} });
      return;
    }
    if (rec.ended || rec.closing) {
      reply(info.callbackId, CANCELLED);
      return;
    }
    const toolUseId = stringField(c, "toolUseID");
    const question: PendingQuestion = {
      requestId: stringField(c, "requestId") ?? toolUseId ?? info.callbackId,
      toolUseId: toolUseId ?? "",
      toolName: String(toolName),
      kind,
      input: input ?? {},
      title: stringField(c, "title"),
      description: stringField(c, "description"),
      decisionReason: stringField(c, "decisionReason"),
      agentId: stringField(c, "agentID"),
    };
    rec.questions.set(question.requestId, { question, callbackId: info.callbackId });
    byCallback.set(info.callbackId, { rec, requestId: question.requestId });
    if (rec.ev) deliver(rec, "onQuestion", (ev) => ev.onQuestion(question));
  }

  function withdraw(callbackId: string): void {
    const e = byCallback.get(callbackId);
    if (!e) return;
    byCallback.delete(callbackId);
    if (e.rec.questions.delete(e.requestId)) {
      deliver(e.rec, "onQuestionWithdrawn", (ev) => ev.onQuestionWithdrawn?.(e.requestId));
    }
  }

  // ---- host events ----

  /** A Workflow result names the run id and the task id of that launch (a resume: same run, new task). */
  function noteWorkflowLaunch(rec: Rec, m: SDKMessage): void {
    if (m.type !== "user") return;
    const r = (m as { tool_use_result?: unknown }).tool_use_result;
    const runId = stringField(r, "runId");
    const taskId = stringField(r, "taskId");
    if (runId !== null && taskId !== null && stringField(r, "taskType") === "local_workflow") rec.workflowTasks.set(runId, taskId);
  }

  function onEvent(e: HostEvent): void {
    switch (e.ev) {
      case "run.message": {
        const rec = recs.get(e.runId);
        if (!rec || rec.ended) return;
        setSessionId(rec, stringField(e.message, "session_id"));
        noteWorkflowLaunch(rec, e.message);
        deliver(rec, "onMessage", (ev) => ev.onMessage(e.message));
        return;
      }
      case "run.state": {
        const rec = recs.get(e.run.runId);
        if (!rec || rec.ended) return;
        if (e.run.closing) rec.closing = true;
        setSessionId(rec, e.run.sessionId);
        setState(rec, e.run.busy, e.run.tasks);
        return;
      }
      case "run.exit": {
        const rec = recs.get(e.runId);
        if (rec) void finish(rec, e.code === "error" ? { code: e.code, error: e.error ?? "Claude run failed" } : { code: e.code });
        return;
      }
      case "callback":
        onCallback(e.callback);
        return;
      case "callback.settled":
        withdraw(e.callbackId);
        return;
      case "host.state":
        publishStatus();
        return;
    }
  }

  function onSnapshot(s: Snapshot): void {
    const inHost = new Set(s.runs.map((r) => r.runId));
    for (const rec of [...recs.values()]) {
      if (rec.ended || inHost.has(rec.runId)) continue;
      // It ended while this server was not connected (or the host restarted).
      void finish(rec, rec.busy ? { code: "error", error: "The Claude run ended while the connection to the session host was down" } : { code: "done" });
    }
    for (const r of s.runs) {
      const rec = recs.get(r.runId);
      if (!rec) {
        adoptRec(r, s.host.pid);
        continue;
      }
      if (rec.ended) continue;
      if (r.closing) rec.closing = true;
      setSessionId(rec, r.sessionId);
      setState(rec, r.busy, r.tasks);
    }
    const live = new Set(s.callbacks.map((c) => c.callbackId));
    for (const id of [...byCallback.keys()]) if (!live.has(id)) withdraw(id);
    for (const c of s.callbacks) onCallback(c);
    publishStatus();
  }

  // ---- host status ----

  function hostStatus(): SessionHostStatus {
    if (!link.connected()) return { state: "down", error: link.error(), waitingFor: [] };
    const drain = link.host()?.drain;
    if (drain) return { state: "draining", error: null, waitingFor: drain.closing ? ["Closing the run"] : drain.waiting.map(waitLine) };
    return { state: "up", error: null, waitingFor: [] };
  }

  function publishStatus(): void {
    const s = hostStatus();
    const sig = JSON.stringify(s);
    if (sig === lastStatus) return;
    lastStatus = sig;
    for (const l of [...statusListeners]) safely("onHostStatus", () => l(s));
  }

  link.listen({ onSnapshot, onEvent, onDown: () => publishStatus() });

  // ---- handles ----

  function handleOf(rec: Rec): RunHandle {
    const call = <T>(method: ControlMethod, ...args: unknown[]) =>
      link.request<T>({ op: "run.call", runId: rec.runId, method, args });
    return {
      sessionId: () => rec.sessionId,
      pid: () => rec.pid,
      state: () => ({ busy: rec.busy, tasks: rec.tasks }),
      async send(content: UserContent, id?: string, priority?: SendPriority): Promise<void> {
        if (rec.ended || rec.closing) throw new Error("the Claude run has ended");
        // The host sets busy as it takes the message; the UI shows the turn from the send on.
        setState(rec, true);
        try {
          await link.request({ op: "run.send", runId: rec.runId, message: userMessage(content, id, priority) });
        } catch (err) {
          if (err instanceof HostRequestError && err.code === "draining") throw new HostDrainingError();
          if (err instanceof HostRequestError && err.code === "unknown-run") throw new Error("the Claude run has ended");
          throw err;
        }
      },
      async interrupt(): Promise<void> {
        if (rec.ended || rec.closing) return;
        await call("interrupt");
      },
      answer(requestId: string, answers: Record<string, string>): void {
        const e = rec.questions.get(requestId);
        if (!e) throw new Error(`no pending question ${requestId}`);
        const result = resultForAnswer(e.question.kind, e.question.input, answers);
        // Removed before the reply goes out: the host's callback.settled for it may arrive at once.
        rec.questions.delete(requestId);
        byCallback.delete(e.callbackId);
        if (!link.post({ op: "callback.reply", callbackId: e.callbackId, result })) {
          rec.questions.set(requestId, e);
          byCallback.set(e.callbackId, { rec, requestId });
          throw new HostDownError();
        }
      },
      async close(): Promise<void> {
        if (!rec.ended && !rec.closing) {
          rec.closing = true;
          try {
            await link.request({ op: "run.close", runId: rec.runId });
          } catch (err) {
            // A run the host no longer has has ended; its exit event or the next snapshot finishes it.
            if (!(err instanceof HostRequestError && err.code === "unknown-run")) {
              rec.closing = false;
              throw err;
            }
          }
        }
        await rec.exited;
      },
      fileCheckpointing: () => rec.checkpointing,
      commands: () => call<SlashCommand[]>("supportedCommands"),
      call,
      async stopTask(taskId: string): Promise<void> {
        if (rec.ended) throw new Error("the Claude run has ended");
        await call("stopTask", taskId);
      },
      workflowTaskId: (runId) => rec.workflowTasks.get(runId) ?? null,
    };
  }

  async function start(opts: StartOpts, ev: DriverEvents): Promise<RunHandle> {
    if (opts.resume === "") throw new Error("resume must be a session id");
    // Check and claim the session without an await in between, so two starts of one session
    // cannot both pass. The index learns of a new holder only once its registration appears.
    if (opts.resume !== undefined && (holders.has(opts.resume) || deps.isSessionOpen(opts.resume))) {
      throw new SessionOpenError(opts.resume);
    }
    const executable = fs.realpathSync(deps.executable ?? DEFAULT_EXECUTABLE);
    if (!fs.statSync(opts.cwd).isDirectory()) throw new Error(`cwd is not a directory: ${opts.cwd}`);
    const host = link.host();
    if (!link.connected() || !host) throw new HostDownError();
    const accountDir = path.resolve(opts.accountDir);
    const rec = newRec(randomUUID(), accountDir, opts.cwd, opts.resume ?? null, host.pid);
    rec.ev = ev;
    // A start without a message waits for the first send: no turn runs yet.
    rec.busy = opts.prompt !== undefined;
    rec.checkpointing = opts.fileCheckpointing === true;
    // Registered before the request: the host's first events can come before its reply.
    recs.set(rec.runId, rec);
    const options: WireOptions = {
      cwd: opts.cwd,
      env: buildEnv(accountDir),
      pathToClaudeCodeExecutable: executable,
      permissionMode: opts.permissionMode ?? "bypassPermissions",
      // The SDK docs require this flag next to bypassPermissions (also to switch to it later).
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      // The 작업 tab stops tasks one by one (stop_task), so an interrupt (the composer's 멈추기)
      // ends only the turn and background agents and workflows go on, as Esc in the terminal.
      // Without it the CLI kills them on interrupt (measured 2026-11-16, DESIGN.md 6i).
      perTaskStopAffordance: true,
      ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
      ...(opts.resume !== undefined && opts.resumeSessionAt !== undefined ? { resumeSessionAt: opts.resumeSessionAt } : {}),
      ...(opts.fileCheckpointing ? { enableFileCheckpointing: true } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.title !== undefined && opts.resume === undefined ? { title: opts.title } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts.flagSettings !== undefined ? { settings: opts.flagSettings } : {}),
    };
    try {
      await link.request({
        op: "run.start", runId: rec.runId, options, callbacks: ["canUseTool"],
        messages: opts.prompt !== undefined ? [userMessage(opts.prompt, opts.promptId)] : [],
        meta: { accountDir, fileCheckpointing: rec.checkpointing },
      });
    } catch (err) {
      recs.delete(rec.runId);
      for (const [id, holder] of holders) if (holder === rec) holders.delete(id);
      if (err instanceof HostRequestError && err.code === "draining") throw new HostDrainingError();
      throw err;
    }
    watchPid(rec);
    // The caller stores the handle when this promise resolves; events follow after that.
    setImmediate(() => release(rec));
    return rec.handle;
  }

  async function probe(opts: { accountDir: string; cwd: string }): Promise<ProbeInfo> {
    const executable = fs.realpathSync(deps.executable ?? DEFAULT_EXECUTABLE);
    if (!fs.statSync(opts.cwd).isDirectory()) throw new Error(`cwd is not a directory: ${opts.cwd}`);
    const inbox = createIdleInbox();
    const q = probeQuery({
      prompt: inbox,
      options: {
        cwd: opts.cwd,
        env: buildEnv(path.resolve(opts.accountDir)),
        pathToClaudeCodeExecutable: executable,
        persistSession: false,
        settings: { disableAllHooks: true },
      },
    });
    // Drained so the SDK reads the process's output; with hooks off nothing comes before close.
    void (async () => {
      try {
        for await (const _ of q) {
          // a probe has no use for its messages
        }
      } catch {
        // A process that failed also rejects supportedCommands(), which the caller sees.
      }
    })();
    try {
      const init = await q.initializationResult();
      return { commands: init.commands, models: init.models, outputStyles: init.available_output_styles ?? [] };
    } finally {
      inbox.end();
      q.close();
    }
  }

  return {
    start,
    ownPids: () => new Set([...recs.values()].flatMap((r) => (r.pid !== null ? [r.pid] : []))),
    holds: (sessionId) => holders.has(sessionId),
    probe,
    onAdopt(handler): void {
      adopter = handler;
      for (const rec of recs.values()) if (!rec.ev) attach(rec);
    },
    async ready(): Promise<void> {
      await link.ready();
      await Promise.all([...recs.values()].map((r) => r.firstScan));
    },
    hostStatus,
    onHostStatus(listener): () => void {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
  };
}
