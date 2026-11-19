import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AccountInfo, EffortLevel, McpServerStatus, ModelInfo, SDKControlInitializeResponse, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type {
  CommandResultMessage, McpServerView, PendingQuestionView, ServerMessage, SessionChosen, SessionCommand, SessionModelsResponse,
  SessionSummary, SettablePermissionMode, ThreadConfigure,
} from "@maru/shared";
import { SETTABLE_PERMISSION_MODES, handlingNeedsList, optionFor, runsCliCommand, sessionKey, splitCommand } from "@maru/shared";
import type { ClaudeAccount } from "../config.ts";
import type { SessionIndex } from "../index/store.ts";
import type { ProjectStore } from "../projects/store.ts";
import type { ChosenStore } from "../state/chosen.ts";
import type { SessionChoiceStore } from "../state/sessionChoices.ts";
import type { AdoptedRun, ClaudeDriver, DriverEvents, PendingQuestion, RunHandle, RunState, StartOpts, UserContent } from "../claude/driver.ts";
import type { ClaudeTurnEnd, ClaudeTurnInfo } from "../claude/projection/projector.ts";
import { liveGoalOf, type LiveGoal } from "../claude/projection/goalState.ts";
import { HostRequestError } from "../host/client.ts";
import type { RewindMarker } from "../claude/rewindScan.ts";
import { CLAUDE_EFFORTS, parseClaudeCommand, type ClaudeCommand } from "./claudeCommands.ts";
import { lastModelOf, lastTurnModeOf, transcriptOf } from "./transcriptFacts.ts";
import { claudeContent, commandWithAttachments } from "../attachments/message.ts";
import type { StoredAttachment } from "../attachments/store.ts";

export class DriveError extends Error {}

/** A /clear waiting for its run to move (ClaudeRuns.clear); `handedOff` once the text went to a process. */
interface MoveWaiter {
  done: (to: string | null) => void;
  handedOff: boolean;
}

/** What a command this server ran itself tells the UI that sent it (command.result). */
export type CommandResult = Omit<CommandResultMessage, "type" | "reqId" | "threadId">;

/** The fields of a `thread.configure` (sessionControls.ts). */
export type ConfigureOpts = Omit<ThreadConfigure, "type" | "threadId" | "reqId">;

const NOT_DRIVEN = "This session is not run by this server";
const NOT_RUNNING = "Only possible while the session is running. Send a message to open the session, then try again";

interface ModelAsked {
  value: string;
  /** The model id the first system/init after the ask named; null until it came. */
  id: string | null;
  /** No system/init has come since the ask: the responses so far belong to a turn that began before it. */
  untilInit: boolean;
}

function askedModel(value: string): ModelAsked {
  return { value, id: null, untilInit: true };
}

/** A 1M-context choice: transcripts write the model without "[1m]", so no response stands for it. */
const ONE_M = /\[1m\]$/i;

/** A full model id, as `--model` and setModel take it. */
const MODEL_ID = /^claude-[a-z0-9.-]+(\[1m\])?$/i;

/** Model ids as system/init and transcripts write them, compared without the date suffix. */
function sameModel(a: string, b: string): boolean {
  const norm = (m: string) => m.toLowerCase().replace(/-\d{8}$/, "");
  return norm(a) === norm(b);
}

const MCP_ACTIONS = ["enable", "disable", "reconnect"];

/** What a configure on the running process changed, kept for the thread's state.chosen. */
interface RunChoice {
  model?: string;
  effort?: string | null;
  fast?: boolean;
  outputStyle?: string;
}

interface Run {
  account: ClaudeAccount;
  handle: RunHandle;
  /** null until the CLI reports the id of a new session. */
  key: string | null;
  pending: Map<string, PendingQuestion>;
  /** tool_use id of each task the CLI announced (task_started), by task id: names a foreground task by its call. */
  toolOfTask: Map<string, string>;
  /** The foreground tool_use ids last broadcast (session.foreground), as JSON; "[]" while none. */
  foregroundSent: string;
  /** When the running turn began (busy became true), ms; null while no turn runs. */
  busySince: number | null;
  /** The mode the process reported last (system/init, system/status) or was set to here. */
  permissionMode: string | null;
  /** The process's latest `active_goal` message (goalState.ts); absent before it sent one. */
  activeGoal?: LiveGoal;
  /** Set here on this process (thread.configure). */
  chosen: RunChoice;
  /**
   * The model this process was last asked to run (a configure's setModel, or the chosen model it
   * started with or held when adopted), and the id the first system/init after the ask named. Only
   * a response of that id in a turn begun after the ask drops the session's pending model choice
   * (responded).
   */
  modelAsked: ModelAsked | null;
  /**
   * The mode the running turn began in (the mode at its system/init); null before the first. A
   * resume skips a turn begun in plan mode (transcriptFacts.ts), so its responses drop no choice.
   */
  turnMode: string | null;
  /** What the process's system/init said last. */
  reported: { model: string | null; outputStyle: string | null; fast: string | null };
  /** close() was called: the process is ending. */
  closing: boolean;
  /** Resolves once the run's process has exited (onExit). */
  exited: Promise<void>;
  markExited: () => void;
}

export interface ClaudeRunsDeps {
  driver: ClaudeDriver;
  accounts: ClaudeAccount[];
  index: SessionIndex;
  chosen: ChosenStore;
  projects: ProjectStore;
  /** Re-run the Claude index sweep (owner becomes "ui" once the driver knows the pid). */
  resweep: () => Promise<void>;
  /** Sends a message to every connected UI. */
  broadcast: (msg: ServerMessage) => void;
  /**
   * What annotate() says about the session changed (a turn began or ended, a question, the
   * background tasks, the run ended): the index should annotate its entry again.
   */
  stateChanged?: (key: string) => void;
  /** How long to look for the pid of a started CLI before giving up, ms. */
  pidWaitMs?: number;
  /** Model, effort, fast mode chosen for a session's next start (DESIGN.md 6m). Without it a closed session takes none. */
  choices?: SessionChoiceStore;
  /** The model picker's rows and output styles for a session (SessionCommands.models): checks a choice, names it in notices. */
  models?: (key: string) => Promise<SessionModelsResponse>;
  /**
   * The session's `/` list (SessionCommands.list: its process, the cache, or a listing CLI that is
   * sent no message), to tell a CLI screen from the user's own command of that name.
   */
  listed?: (key: string) => Promise<readonly SessionCommand[] | null>;
  /**
   * Conversation rewinds (DESIGN.md 6o, drive/sessionRewind.ts). `resumeAt` answers the line a
   * process for the session resumes up to while a rewind waits for the next message (dropping one
   * the session already went past); `markerOf` gives the thread view the waiting rewind.
   */
  rewind?: {
    resumeAt: (sessionId: string, transcript: string | null) => Promise<string | null>;
    markerOf: (sessionId: string) => RewindMarker | null;
  };
  /** Whether a process for the account and folder keeps file checkpoints (claude/checkpointing.ts). Default: off. */
  fileCheckpointing?: (accountDir: string, cwd: string) => boolean;
}

/**
 * Claude sessions this server drives (DESIGN.md 4.2, M2). One run per session key. A send to a
 * closed session resumes it on the model it last ran on; a session a terminal process holds is
 * refused, since two writers fork the conversation inside one file. The CLI processes live in the
 * session host (DESIGN.md 2b): after a restart of this server the host's runs are adopted with
 * their open questions.
 *
 * The state of a session it drives comes from the host, not from the CLI's registration file
 * (DESIGN.md 4.3): the file says busy while background tasks run after the turn ended, the host's
 * run.state busy ends with the turn's result. annotate() puts that into the index entry, and
 * turnInfo() gives the thread projector the turn ends (result messages) the transcript lacks.
 */
export class ClaudeRuns {
  private deps: ClaudeRunsDeps;
  private runs = new Map<string, Run>();
  /** Turn ends by session key, oldest first. Kept after the run ended, for this server's lifetime. */
  private ends = new Map<string, ClaudeTurnEnd[]>();
  /** The model each session's process last reported (system/init), by session key. */
  private models = new Map<string, string>();
  /** A start under way per session key (start()): sends and configures wait for its run. */
  private starting = new Map<string, Promise<void>>();
  /** A rewind under way per session key (exclusive()): sends and configures wait for it to end. */
  private exclusives = new Map<string, Promise<void>>();
  private turnListeners = new Set<(key: string) => void>();
  private resultListeners = new Set<(key: string, result: Record<string, unknown>) => void>();
  private exitListeners = new Set<(key: string, info: { code: "done" | "error" | "interrupted"; error?: string }) => void>();
  private runListeners = new Set<(key: string, ev: { type: "message"; message: unknown } | { type: "exit" }) => void>();
  /** A /clear waiting to learn where its session went, by the key it was sent to (clear()). */
  private moveWaiters = new Map<string, Set<MoveWaiter>>();

  constructor(deps: ClaudeRunsDeps) {
    this.deps = deps;
    deps.driver.onAdopt((handle, info) => this.adopt(handle, info));
  }

  handles(key: string): boolean {
    return /^claude:[^:]+:[0-9a-f-]{36}$/.test(key);
  }

  /**
   * Next user message. A command this server runs itself (claudeCommands.ts) runs instead and
   * resolves with what the UI shows for it. Attachments (uploads, attachments/store.ts) go with the
   * text: pictures as image blocks, every one as a path note (attachments/message.ts). The message
   * goes under `id` when given (the pending send's uuid, DESIGN.md 4.4).
   */
  async send(key: string, text: string, attachments: readonly StoredAttachment[] = [], id?: string): Promise<CommandResult | void> {
    if (!text.trim() && attachments.length === 0) throw new DriveError("Cannot send an empty message");
    // A CLI screen is told from the user's own command or skill of that name by the session's list
    // (sessionControls.ts); a list that cannot be read leaves the text to the CLI.
    const word = splitCommand(text);
    const listed = word && handlingNeedsList("claude", word.name) ? ((await this.deps.listed?.(key).catch(() => null)) ?? null) : null;
    const cmd = parseClaudeCommand(text, listed);
    // A command takes no attachments: maru's own, and the CLI's own commands (`/compact` takes the
    // notes as its argument and drops the pictures, measured 2026-11-16). A skill or a prompt
    // command does take them, the user's and the CLI's alike (the pictures go before its text
    // block, which it still expands). The session's list says which one `/name` runs
    // (runsCliCommand); while it is unknown the message goes, since it may be the user's. The web
    // server puts the text and the attachments back in the composer (command.error unsent).
    if (cmd && attachments.length > 0) throw new DriveError(commandWithAttachments(cmd.name === "unsupported" ? cmd.command : cmd.name));
    if (word && attachments.length > 0) {
      const list = listed ?? (await this.deps.listed?.(key).catch(() => null)) ?? null;
      if (runsCliCommand(word.name, list) === true) throw new DriveError(commandWithAttachments(word.name));
    }
    if (cmd?.name === "unsupported") return { ...(await this.runCommand(key, cmd)), unsent: text };
    // `/plan <text>` means the text in plan mode; set during a turn, the mode would take the turn
    // under way at once. `/plan` alone switches now, as /permissions plan does.
    if (cmd?.name === "plan" && cmd.prompt !== null) {
      const run = this.runs.get(key);
      if (run && !run.closing && run.handle.state().busy) {
        return { command: "plan", notice: "/plan: not sent because a turn is in progress. Plan mode would apply to the current turn right away. Send again after it ends", unsent: text };
      }
    }
    if (cmd) return this.runCommand(key, cmd);
    if (word?.name === "clear") return this.clear(key, text);
    await this.deliver(key, claudeContent(text, attachments, (a) => fs.readFileSync(a.imagePath!)), id);
  }

  /**
   * /clear goes to the CLI, which goes on in a new session (moved()). Answers the session the UI
   * opens, once the run moved there and the index lists it. Nothing when the turn ended first: a
   * user command named clear that moves nowhere, or a turn already running when /clear was sent.
   */
  private async clear(key: string, text: string): Promise<CommandResult | void> {
    let done!: (to: string | null) => void;
    const moved = new Promise<string | null>((r) => (done = r));
    // Registered before the text goes (the move can follow at once); a turn end or an exit counts
    // only once the text reached a process, not that of a process ending (닫기) before it.
    const waiter: MoveWaiter = { done, handedOff: false };
    const waiters = this.moveWaiters.get(key) ?? new Set();
    waiters.add(waiter);
    this.moveWaiters.set(key, waiters);
    try {
      await this.deliver(key, text, undefined, () => {
        waiter.handedOff = true;
      });
    } catch (err) {
      waiters.delete(waiter);
      if (waiters.size === 0 && this.moveWaiters.get(key) === waiters) this.moveWaiters.delete(key);
      throw err;
    }
    const to = await moved;
    if (!to) return;
    await this.untilIndexed(to);
    // The process may have ended before the index saw the new transcript: nothing to open then.
    return this.deps.index.get(to) ? { command: "clear", open: to } : undefined;
  }

  /** A move from `key` answers every waiter; a turn end or an exit (to null) only those whose text went. */
  private settleMoves(key: string, to: string | null): void {
    const waiters = this.moveWaiters.get(key);
    if (!waiters) return;
    for (const w of [...waiters]) {
      if (to === null && !w.handedOff) continue;
      waiters.delete(w);
      w.done(to);
    }
    if (waiters.size === 0) this.moveWaiters.delete(key);
  }

  /** Resolves once the full index holds the session, or no run of this server is in it any more. */
  private untilIndexed(key: string): Promise<void> {
    if (this.deps.index.get(key) || !this.runs.has(key)) return Promise.resolve();
    void this.deps.resweep();
    return new Promise((resolve) => {
      const check = () => {
        if (!this.deps.index.get(key) && this.runs.has(key)) return;
        offIndex();
        offTurns();
        resolve();
      };
      const offIndex = this.deps.index.subscribe(check);
      const offTurns = this.onTurns(check);
    });
  }

  /** The message (text, or blocks with pictures) to the session's process, starting one for a closed session. */
  private async deliver(key: string, content: UserContent, id?: string, handOff?: () => void): Promise<void> {
    for (;;) {
      await this.settled(key);
      // Read again with no wait in between: another send may have started the session meanwhile.
      const run = this.runs.get(key);
      if (run && !run.closing) {
        handOff?.();
        await run.handle.send(content, id);
        return;
      }
      if (!run && !this.starting.has(key)) break;
    }
    handOff?.();
    const start = this.start(key, content, id);
    this.starting.set(key, start);
    try {
      await start;
    } finally {
      if (this.starting.get(key) === start) this.starting.delete(key);
    }
  }

  /**
   * Waits until nothing is between the session and its next process: a start under way has its run,
   * a process that is ending (닫기) has exited and the index has seen it go.
   */
  private async settled(key: string, inExclusive = false): Promise<void> {
    for (;;) {
      const exclusive = inExclusive ? undefined : this.exclusives.get(key);
      if (exclusive) {
        await exclusive;
        continue;
      }
      const starting = this.starting.get(key);
      if (starting) {
        await starting.catch(() => {});
        continue;
      }
      const run = this.runs.get(key);
      if (!run?.closing) return;
      await run.exited;
      await this.deps.resweep();
    }
  }

  /**
   * Runs `fn` with the session to itself (a rewind, DESIGN.md 6o): sends and configures that come
   * meanwhile wait until it ended, so none reaches a process the rewind is about to end, or starts
   * one that misses the rewind. Inside, open() is the only way to start a process.
   */
  async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    while (this.exclusives.has(key)) await this.exclusives.get(key);
    let release!: () => void;
    this.exclusives.set(key, new Promise<void>((r) => (release = r)));
    try {
      return await fn();
    } finally {
      this.exclusives.delete(key);
      release();
    }
  }

  /**
   * A process for the session without a message (a rewind needs one for rewindFiles, DESIGN.md
   * 6o). Resolves once the session's process runs; one that already runs is kept. `fullResume`
   * resumes the whole conversation even while a conversation rewind waits, so the process reads
   * every checkpoint; it is for exclusive() callers, which close it before the next send.
   */
  async open(key: string, opts: { fullResume?: boolean } = {}): Promise<void> {
    for (;;) {
      await this.settled(key, true);
      const run = this.runs.get(key);
      if (run && !run.closing) return;
      if (!run && !this.starting.has(key)) break;
    }
    const start = this.start(key, null, undefined, opts.fullResume === true);
    this.starting.set(key, start);
    try {
      await start;
    } finally {
      if (this.starting.get(key) === start) this.starting.delete(key);
    }
  }

  /**
   * What a rewind checks about the session's process; null when this server runs none and starts
   * none. A start under way counts as a turn (it carries a message).
   */
  rewindState(key: string): { busy: boolean; pending: boolean; backgroundTasks: number; closing: boolean; fileCheckpointing: boolean } | null {
    const run = this.runs.get(key);
    if (!run) return this.starting.has(key) ? { busy: true, pending: false, backgroundTasks: 0, closing: false, fileCheckpointing: false } : null;
    const st = run.handle.state();
    return {
      busy: st.busy,
      pending: run.pending.size > 0,
      backgroundTasks: st.tasks.filter((t) => !t.ambient && (t.background || !st.busy)).length,
      closing: run.closing,
      fileCheckpointing: run.handle.fileCheckpointing(),
    };
  }

  /** A Query control method on the session's process (rewindFiles for a rewind). */
  async call<T>(key: string, method: "rewindFiles", ...args: unknown[]): Promise<T> {
    const run = this.runs.get(key);
    if (!run || run.closing) throw new DriveError(NOT_RUNNING);
    return run.handle.call<T>(method, ...args);
  }

  /** turnInfo(key) changed outside this class (a rewind was made or dropped). */
  refreshTurns(key: string): void {
    this.notifyTurns(key);
  }

  /**
   * A process for a closed session, with the message as its first prompt (none: it waits for the
   * first send). Sends and configures that come meanwhile wait for it (`starting`), so the choice
   * read here is the last word and a configure then goes to the new process. A conversation rewind
   * that waits for the next message makes it resume up to the kept line (DESIGN.md 6o).
   */
  private async start(key: string, content: UserContent | null, id?: string, fullResume = false): Promise<void> {
    const s = this.deps.index.get(key);
    if (!s) throw new DriveError(`Session not found: ${key}`);
    if (s.owner === "terminal") {
      throw new DriveError("This session is open in a terminal. Close the terminal, then send");
    }
    if (!s.cwd || !fs.existsSync(s.cwd)) throw new DriveError(`Working folder not found: ${s.cwd ?? "(none)"}`);
    const account = this.account(s.account);
    const fromTranscript = await this.resumeModel(key, account, s.id);
    // What the user chose here for the next start wins over the transcript's model (DESIGN.md 6m).
    const choice = this.deps.choices?.get("claude", s.id) ?? null;
    const model = choice?.model ?? fromTranscript;
    const flags = {
      ...(choice?.fast !== undefined ? { fastMode: choice.fast } : {}),
      ...(choice?.outputStyle !== undefined ? { outputStyle: choice.outputStyle } : {}),
    };
    const resumeAt = fullResume ? null : ((await this.deps.rewind?.resumeAt(s.id, transcriptOf(account.dir, s.id))) ?? null);
    await this.launch(account, {
      cwd: s.cwd, resume: s.id,
      ...(content !== null ? { prompt: content, ...(id ? { promptId: id } : {}) } : {}),
      ...(resumeAt ? { resumeSessionAt: resumeAt } : {}),
      ...(model ? { model } : {}),
      ...(choice?.effort ? { effort: choice.effort as EffortLevel } : {}),
      ...(Object.keys(flags).length ? { flagSettings: flags } : {}),
      ...(choice?.permissionMode ? { permissionMode: choice.permissionMode as SettablePermissionMode } : {}),
    }, key);
    // The new process runs with them: state.chosen shows them as its own.
    const started = this.runs.get(key);
    if (started && choice) {
      if (choice.effort !== undefined) started.chosen.effort = choice.effort;
      if (choice.fast !== undefined) started.chosen.fast = choice.fast;
      if (choice.model !== undefined) {
        started.chosen.model = choice.model;
        started.modelAsked = askedModel(choice.model);
      }
      this.notifyTurns(key);
    }
    // The mode and the style are the process's own from its start on; model, effort and fast stay
    // (the model until a response on it reaches the transcript, effort and fast for every start).
    // A start without a message (a rewind) keeps them: it closes before the next send's start.
    if (content !== null) this.deps.choices?.clear("claude", s.id, ["permissionMode", "outputStyle"]);
  }

  // ---- model, effort, permission mode, fast, output style, MCP (DESIGN.md 6m) ----

  /**
   * Applies what a `thread.configure` (or a `/model opus`) asks for. A running process gets it at
   * once; a closed session keeps model, effort, fast, permission mode and output style for its
   * next start. A start under way is waited for, so the choice reaches its process. Answers the
   * notice the composer shows.
   */
  async configure(key: string, raw: ConfigureOpts): Promise<CommandResult> {
    const command = raw.model !== undefined ? "model" : raw.effort !== undefined ? "effort" : raw.permissionMode !== undefined ? "permissions"
      : raw.fast !== undefined ? "fast" : raw.outputStyle !== undefined ? "output-style" : raw.mcp !== undefined ? "mcp" : null;
    if (!command) throw new DriveError("Nothing to change");
    const c = await this.checked(key, raw);
    await this.settled(key);
    const run = this.runs.get(key);
    const notes: string[] = [];
    if (!run) {
      const s = this.deps.index.get(key);
      if (!s) throw new DriveError(`Session not found: ${key}`);
      if (s.owner === "terminal" && s.status !== "closed") throw new DriveError("This session is open in a terminal");
      if (c.mcp) throw new DriveError(NOT_RUNNING);
      if (!this.deps.choices) throw new DriveError(NOT_DRIVEN);
      this.deps.choices.merge("claude", s.id, {
        ...(c.model !== undefined ? { model: c.model } : {}),
        ...(c.effort !== undefined ? { effort: c.effort } : {}),
        ...(c.fast !== undefined ? { fast: c.fast } : {}),
        ...(c.permissionMode ? { permissionMode: c.permissionMode } : {}),
        ...(c.outputStyle !== undefined ? { outputStyle: c.outputStyle ?? "default" } : {}),
      });
      this.notifyTurns(key);
      notes.push(...(await this.describe(key, c)), "applies the next time the session opens");
      return { command, notice: notes.join(", ") };
    }
    const sid = run.handle.sessionId();
    const remember = (patch: Parameters<SessionChoiceStore["merge"]>[2]) => {
      // So a close before the next response keeps the choice (the transcript does not have it yet).
      if (sid && this.deps.choices) this.deps.choices.merge("claude", sid, patch);
    };
    if (c.model !== undefined) {
      await run.handle.call("setModel", c.model);
      run.chosen.model = c.model;
      // Set once the CLI took it: a system/init it wrote before names the old model.
      run.modelAsked = askedModel(c.model);
      remember({ model: c.model });
    }
    if (c.effort !== undefined) {
      await run.handle.call("applyFlagSettings", { effortLevel: c.effort });
      run.chosen.effort = c.effort;
      if (c.effort === null) {
        if (sid) this.deps.choices?.clear("claude", sid, ["effort"]);
      } else remember({ effort: c.effort });
    }
    if (c.fast !== undefined) {
      await run.handle.call("applyFlagSettings", { fastMode: c.fast });
      run.chosen.fast = c.fast;
      remember({ fast: c.fast });
    }
    if (c.permissionMode) await this.setPermissionMode(key, c.permissionMode);
    if (c.outputStyle !== undefined) {
      // The name, as a start gets it: null in the flag layer would fall back to the settings files' style.
      const style = c.outputStyle ?? "default";
      await run.handle.call("applyFlagSettings", { outputStyle: style });
      run.chosen.outputStyle = style;
    }
    if (c.mcp) {
      const { server, action } = c.mcp;
      if (action === "reconnect") await run.handle.call("reconnectMcpServer", server);
      else await run.handle.call("toggleMcpServer", server, action === "enable");
    }
    this.notifyTurns(key);
    notes.push(...(await this.describe(key, c)));
    return { command, notice: notes.join(", ") };
  }

  /**
   * A configure's fields checked as a start would take them (it comes over /ws, so the types are
   * checked too): an effort level, a settable mode, a model id or an alias of the session's picker
   * list, an output style the session has. Answers it with the style named as the session names it.
   */
  private async checked(key: string, c: ConfigureOpts): Promise<ConfigureOpts> {
    const bad = (what: string) => new DriveError(`Invalid value for ${what}`);
    if (c.model !== undefined && (typeof c.model !== "string" || !c.model.trim())) throw bad("model");
    if (c.effort !== undefined && c.effort !== null && !(CLAUDE_EFFORTS as readonly unknown[]).includes(c.effort)) {
      throw new DriveError(`effort must be one of ${[...CLAUDE_EFFORTS, "auto"].join(", ")}`);
    }
    if (c.permissionMode !== undefined && !(SETTABLE_PERMISSION_MODES as readonly unknown[]).includes(c.permissionMode)) {
      throw new DriveError(`permission mode must be one of ${SETTABLE_PERMISSION_MODES.join(", ")}: ${JSON.stringify(c.permissionMode)}`);
    }
    if (c.fast !== undefined && typeof c.fast !== "boolean") throw bad("fast");
    if (c.outputStyle !== undefined && c.outputStyle !== null && (typeof c.outputStyle !== "string" || !c.outputStyle.trim())) throw bad("outputStyle");
    if (c.mcp !== undefined && (typeof c.mcp?.server !== "string" || !c.mcp.server || !MCP_ACTIONS.includes(c.mcp.action))) throw bad("mcp");
    if (c.model === undefined && (c.outputStyle === undefined || c.outputStyle === null)) return c;
    let list: SessionModelsResponse | null = null;
    try {
      list = this.deps.models ? await this.deps.models(key) : null;
    } catch {
      list = null;
    }
    // A model id goes as it is (the CLI takes ids the picker does not list, claude-opus-4-6 among
    // them; describe() names one off the list); an alias must be a row of the list ("opus[1m]" is
    // the 1M-context run of a listed row).
    if (c.model !== undefined && c.model !== "default" && !MODEL_ID.test(c.model)) {
      if (!list?.options.length) throw new DriveError(`Could not read the model list, so ${c.model} cannot be verified. Use a model ID (claude-...)`);
      if (!optionFor(list.options, c.model.replace(ONE_M, ""))) {
        throw new DriveError(`Unknown model: ${c.model}. Use ${list.options.map((o) => o.value).join(", ")}, or a model ID`);
      }
    }
    if (typeof c.outputStyle === "string" && list?.outputStyles?.length) {
      const style = list.outputStyles.find((s) => s === c.outputStyle) ?? list.outputStyles.find((s) => s.toLowerCase() === c.outputStyle!.toLowerCase());
      if (!style) throw new DriveError(`Unknown output style: ${c.outputStyle}. Use one of ${list.outputStyles.join(", ")}`);
      return { ...c, outputStyle: style };
    }
    return c;
  }

  /** The MCP servers of the session's process (the /mcp picker). */
  async mcpServers(key: string): Promise<McpServerView[]> {
    const run = this.runs.get(key);
    if (!run || run.closing) throw new DriveError(NOT_RUNNING);
    const list = await run.handle.call<McpServerStatus[]>("mcpServerStatus");
    return list.map((m) => ({
      name: m.name,
      status: m.status,
      scope: m.scope ?? null,
      error: m.error ?? null,
      tools: m.tools?.length ?? 0,
    }));
  }

  /** Models and output styles of the process this server runs for the session; null when it runs none. */
  modelsOf(key: string): Promise<{ models: ModelInfo[]; outputStyles: string[] }> | null {
    const run = this.runs.get(key);
    if (!run || run.closing) return null;
    return Promise.all([
      run.handle.call<ModelInfo[]>("supportedModels"),
      run.handle.call<SDKControlInitializeResponse>("initializationResult"),
    ]).then(([models, init]) => ({ models, outputStyles: init.available_output_styles ?? [] }));
  }

  /** One phrase per change, for the notice. */
  private async describe(key: string, c: ConfigureOpts): Promise<string[]> {
    const out: string[] = [];
    if (c.model !== undefined) out.push(`Model ${await this.modelLabel(key, c.model)}`);
    if (c.effort !== undefined) out.push(`effort ${c.effort ?? "auto"}`);
    if (c.permissionMode) out.push(`permission mode ${c.permissionMode}`);
    if (c.fast !== undefined) out.push(`fast mode ${c.fast ? "on" : "off"}`);
    if (c.outputStyle !== undefined) out.push(`output style ${c.outputStyle ?? "default"}`);
    if (c.mcp) out.push(`MCP ${c.mcp.server} ${c.mcp.action === "reconnect" ? "reconnected" : c.mcp.action === "enable" ? "enabled" : "disabled"}`);
    return out;
  }

  /**
   * The picker row's label for a model value or id, else the value as given; a model id the list
   * does not have says so (a typo shows here, and in the first response's error).
   */
  private async modelLabel(key: string, model: string): Promise<string> {
    try {
      const options = this.deps.models ? (await this.deps.models(key)).options : [];
      // A "(1M)" row names its own run; "opus[1m]" and the like are the plain row's label with the tag.
      const wide = optionFor(options, model);
      if (wide) return wide.label;
      const opt = optionFor(options, model.replace(ONE_M, ""));
      if (opt) return ONE_M.test(model) ? `${opt.label} [1m]` : opt.label;
      return options.length && MODEL_ID.test(model) ? `${model} (ID not in the picker list)` : model;
    } catch {
      return model;
    }
  }

  /** A command typed with its argument (or from a composer without the picker). */
  private async runCommand(key: string, cmd: ClaudeCommand): Promise<CommandResult> {
    switch (cmd.name) {
      case "unsupported":
        return { command: cmd.command, notice: `/${cmd.command}: ${cmd.reason}` };
      case "model":
        if (cmd.value !== null) return this.configure(key, { model: cmd.value });
        return { command: "model", notice: await this.modelList(key) };
      case "effort":
        if (cmd.value !== undefined) return this.configure(key, { effort: cmd.value });
        return { command: "effort", notice: `effort: ${this.current(key).effort ?? "auto"}\nChange with: /effort <${[...CLAUDE_EFFORTS, "auto"].join("|")}>` };
      case "permissions": {
        if (cmd.mode) return this.configure(key, { permissionMode: cmd.mode });
        return { command: "permissions", notice: `permission mode: ${this.modeText(key)}\nChange with: /permissions <${SETTABLE_PERMISSION_MODES.join("|")}>` };
      }
      case "fast":
        if (cmd.on !== null) return this.configure(key, { fast: cmd.on });
        return { command: "fast", notice: `fast mode: ${fastText(this.current(key))}\nChange with: /fast <on|off>` };
      case "output-style":
        if (cmd.style !== undefined) return this.configure(key, { outputStyle: cmd.style });
        return { command: "output-style", notice: `output style: ${this.current(key).outputStyle ?? "default"}\nChange with: /output-style <name>` };
      case "mcp":
        if (cmd.action !== "list") return this.configure(key, { mcp: { server: cmd.server, action: cmd.action } });
        return {
          command: "mcp",
          notice: (await this.mcpServers(key)).map((m) => `${m.name}: ${m.status}${m.error ? ` (${m.error})` : ""}`).join("\n") || "No MCP servers",
        };
      case "status":
        return { command: "status", notice: await this.statusText(key) };
      case "plan": {
        const set = await this.configure(key, { permissionMode: "plan" });
        if (cmd.prompt === null) return { ...set, command: "plan" };
        // The CLI's `/plan <text>` enters plan mode and sends the text; a closed session starts in plan mode with it.
        await this.deliver(key, cmd.prompt);
        return { command: "plan", notice: "permission mode plan" };
      }
      case "exit": {
        const run = this.runs.get(key);
        if (!run || run.closing) return { command: "exit", notice: "Session is not open" };
        // The header's 닫기 is hidden in the same states: closing would cut the work off.
        const busy = closeBlocker(run.handle.state(), run.pending.size);
        if (busy) return { command: "exit", notice: `/exit: not closed because ${busy}. Send again after it ends` };
        await this.close(key);
        return { command: "exit", notice: "Session closed" };
      }
    }
  }

  /** The permission mode the session runs in, or the one a closed session starts in. */
  private modeText(key: string): string {
    const run = this.runs.get(key);
    if (run && !run.closing) return run.permissionMode ?? "unknown";
    const pending = this.current(key).permissionMode;
    // The driver starts a session in bypass mode unless told otherwise (claude/driver.ts).
    return pending ? `${pending} (next start)` : "bypassPermissions (next start)";
  }

  /**
   * `/status`: what the CLI's status screen shows that maru knows. A running process adds its
   * account (Query.accountInfo) and MCP servers; a closed session shows what it starts with.
   */
  private async statusText(key: string): Promise<string> {
    const run = this.runs.get(key);
    const live = run !== undefined && !run.closing;
    const s = this.deps.index.get(key);
    const cur = this.current(key);
    let model = cur.model ?? null;
    if (!model && !live && s) model = await this.resumeModel(key, this.account(s.account), s.id).catch(() => null);
    const next = live ? "" : " (next start)";
    const lines = [
      `Session: ${live ? (run.handle.state().busy ? "running, turn in progress" : "running") : "closed"}`,
      `Model: ${model ? await this.modelLabel(key, model) : "account default"}${next}`,
      `effort: ${cur.effort ?? "auto"}${next}`,
      `fast mode: ${fastText(cur)}${next}`,
      `permission mode: ${this.modeText(key)}`,
      `output style: ${cur.outputStyle ?? "default"}${next}`,
      `Working folder: ${s?.cwd ?? "unknown"}`,
    ];
    if (live) {
      try {
        const a = await run.handle.call<AccountInfo>("accountInfo");
        const more = [a.organization, a.subscriptionType].filter(Boolean).join(", ");
        lines.push(`Account: ${a.email ?? "unknown"}${more ? ` (${more})` : ""}`);
      } catch {
        // The line is left out when the process does not answer.
      }
      try {
        const mcp = await this.mcpServers(key);
        const by = new Map<string, number>();
        for (const m of mcp) by.set(m.status, (by.get(m.status) ?? 0) + 1);
        lines.push(`MCP: ${mcp.length ? [...by].map(([st, n]) => `${st} ${n}`).join(", ") : "none"}`);
      } catch {
        // As above.
      }
    }
    return lines.join("\n");
  }

  /** `/model` alone as text: the current model and the names /model takes. */
  private async modelList(key: string): Promise<string> {
    const cur = this.current(key).model ?? null;
    if (!this.deps.models) return `Model: ${cur ?? "unknown"}`;
    const { options } = await this.deps.models(key);
    const now = optionFor(options, cur);
    return [
      `Model: ${now?.label ?? cur ?? "unknown"}`,
      ...options.map((o) => `${o === now ? "* " : "  "}${o.value}: ${o.label}${o.description ? `, ${o.description}` : ""}`),
      "Change with: /model <name>",
    ].join("\n");
  }

  /** state.chosen of the session (turnInfo). */
  private current(key: string): SessionChosen {
    return this.chosenOf(key) ?? {};
  }

  private chosenOf(key: string): SessionChosen | null {
    const run = this.runs.get(key);
    if (run) {
      // What was set here since the process last reported (noteInit drops what an init overrides), else its report.
      const model = run.chosen.model ?? run.reported.model ?? undefined;
      const outputStyle = run.chosen.outputStyle ?? run.reported.outputStyle ?? undefined;
      // "cooldown": fast mode is on and runs at standard speed for a while after a rate limit.
      const fast = run.chosen.fast ?? (run.reported.fast === null ? undefined : run.reported.fast !== "off");
      const out: SessionChosen = {
        ...(model ? { model } : {}),
        ...(run.chosen.effort !== undefined ? { effort: run.chosen.effort } : {}),
        ...(fast !== undefined ? { fast } : {}),
        ...(run.chosen.fast === undefined && run.reported.fast === "cooldown" ? { fastCooldown: true } : {}),
        ...(outputStyle ? { outputStyle } : {}),
      };
      return Object.keys(out).length ? out : null;
    }
    const sid = /^claude:[^:]+:(.+)$/.exec(key)?.[1];
    const c = sid ? this.deps.choices?.get("claude", sid) : null;
    if (!c) return null;
    const out: SessionChosen = {
      ...(c.model !== undefined ? { model: c.model } : {}),
      ...(c.effort !== undefined ? { effort: c.effort } : {}),
      ...(c.fast !== undefined ? { fast: c.fast } : {}),
      ...(c.outputStyle !== undefined ? { outputStyle: c.outputStyle } : {}),
      ...(c.permissionMode !== undefined ? { permissionMode: c.permissionMode } : {}),
    };
    return Object.keys(out).length ? { ...out, pending: true } : null;
  }

  /** Start a new session; resolves with its key once the CLI reports the session id. */
  async create(opts: { account: string; cwd: string; prompt: string; projectId: string | null; model?: string; name?: string }): Promise<string> {
    if (!opts.prompt.trim()) throw new DriveError("A first message is required");
    const account = this.account(opts.account);
    if (!fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory()) {
      throw new DriveError(`Working folder not found: ${opts.cwd}`);
    }
    return new Promise<string>((resolve, reject) => {
      this.launch(account, { cwd: opts.cwd, prompt: opts.prompt, ...(opts.model ? { model: opts.model } : {}), ...(opts.name ? { title: opts.name } : {}) }, null, (err) => reject(new DriveError(err)), (key, sid) => {
        // A new session joins the list and its project on its own (DESIGN.md 6c, 6d).
        this.deps.chosen.set("claude", sid, true);
        if (opts.projectId) {
          try {
            this.deps.projects.assign("claude", sid, opts.projectId);
          } catch {
            // The project was deleted meanwhile: the session stays in 미분류.
          }
        }
        resolve(key);
      }).catch(reject);
    });
  }

  async interrupt(key: string): Promise<void> {
    const run = this.runs.get(key);
    if (!run) throw new DriveError(NOT_DRIVEN);
    await run.handle.interrupt();
  }

  /**
   * Takes a message the CLI still queues back out of its queue (cancel_async_message). False when
   * the model already has it.
   */
  async cancelQueued(key: string, id: string): Promise<boolean> {
    const run = this.runs.get(key);
    if (!run) throw new DriveError(NOT_DRIVEN);
    const out = await this.cancelAsync(run, id);
    if (out === "unsupported") throw new DriveError("The Claude session host is running code without take-back support. Restart the host, then take back");
    return out;
  }

  /**
   * One cancelAsyncMessage call: whether the CLI took the message out of its queue, or
   * `unsupported` for a session host started before the call joined its allowlist (host/protocol.ts).
   * Any other failure (a lost host connection) is thrown.
   */
  private async cancelAsync(run: Run, id: string): Promise<boolean | "unsupported"> {
    try {
      return (await run.handle.call<boolean>("cancelAsyncMessage", id)) === true;
    } catch (err) {
      if (err instanceof HostRequestError && err.code === "not-allowed") return "unsupported";
      throw err;
    }
  }

  /**
   * Sends the session's foreground Bash and Agent calls to the background (Query.backgroundTasks,
   * the CLI's Ctrl+B): `toolUseId` names one call, none sends every one. Resolves with the text for
   * the notice area. Throws DriveError with the reason when nothing moved: no process of this
   * server, no turn running, no foreground task, the call is not in the foreground, or the CLI has
   * background tasks disabled (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).
   */
  async backgroundTasks(key: string, toolUseId?: string): Promise<string> {
    const run = this.runs.get(key);
    if (!run) throw new DriveError(NOT_DRIVEN);
    if (run.closing) throw new DriveError("Session is closing");
    const st = run.handle.state();
    const foreground = foregroundTasks(st);
    if (!st.busy) throw new DriveError("No turn is in progress, so there is no foreground work to send to background");
    if (toolUseId === undefined && foreground.length === 0) throw new DriveError("No work is running in the foreground");
    const res = await this.callBackgroundTasks(run, toolUseId);
    if (res.kind === "unavailable") throw new DriveError(res.reason);
    if (res.kind === "none") throw new DriveError("That task is not running in the foreground (it already finished or is in the background)");
    return toolUseId === undefined
      ? `Sent ${foreground.length} foreground ${foreground.length === 1 ? "task" : "tasks"} to background`
      : "Sent the task to background";
  }

  /**
   * One Query.backgroundTasks call, its refusals sorted: `unavailable` is the CLI or the host
   * saying it cannot (disabled for the session, a host older than the call), `none` a false answer
   * (the named call is not in the foreground). Anything else (a lost host connection) is thrown.
   */
  private async callBackgroundTasks(run: Run, toolUseId?: string): Promise<{ kind: "moved" | "none" } | { kind: "unavailable"; reason: string }> {
    try {
      const moved = (await run.handle.call<boolean>("backgroundTasks", ...(toolUseId === undefined ? [] : [toolUseId]))) === true;
      return { kind: moved ? "moved" : "none" };
    } catch (err) {
      if (err instanceof HostRequestError && /disabled/i.test(err.message)) {
        return { kind: "unavailable", reason: `Background tasks are disabled for this session (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS): ${err.message}` };
      }
      if (err instanceof HostRequestError && err.code === "not-allowed") {
        return { kind: "unavailable", reason: "The Claude session host is running code without background support. Restart the host to use it" };
      }
      throw err;
    }
  }

  /**
   * "Send now" for the queued messages of a running turn (DESIGN.md 4.4). The CLI folds a queued
   * message into the turn at the next tool boundary, so what delays it is the call that has no
   * boundary yet. The order (decideSendNow):
   * 1. no turn, or no message waits: nothing to do
   * 2. foreground tasks (a Bash command the CLI registered, a subagent): send them to the
   *    background first (Query.backgroundTasks, the CLI's Ctrl+B). A message with priority `now`
   *    does not move them: it leaves a running Bash command to finish and stops a foreground
   *    subagent (measured 2026-11-18). When the work cannot move (background tasks disabled, a
   *    host without the call), interrupt the turn instead (Query.interrupt keeps the CLI's queue,
   *    so the messages run as the next turn)
   * 3. every message the CLI still queues is taken out (cancelAsyncMessage) and sent again with
   *    priority `now` under a new uuid. The CLI cuts the call the turn waits on (an MCP call, a
   *    WebFetch, the model's own text) at once and runs the messages together as a new turn, in
   *    order. A message the model already has is left alone
   * `messages` are the waiting messages the CLI queues, oldest first (PendingSends, state queued),
   * with the content to send again (null when it cannot be rebuilt: it stays queued). `hooks` tell
   * the caller's record of them what happened to each.
   */
  async sendNow(key: string, messages: readonly SendNowMessage[], hooks: SendNowHooks): Promise<SendNowResult> {
    const run = this.runs.get(key);
    if (!run) throw new DriveError(NOT_DRIVEN);
    if (run.closing) throw new DriveError("Session is closing");
    const st = run.handle.state();
    const foreground = foregroundTasks(st);
    const plan = decideSendNow({ busy: st.busy, foreground: foreground.length, queued: messages.length });
    if (plan === "no-turn" || plan === "no-message") return sendNowNothing(plan);
    let moved = 0;
    if (plan === "background-resend") {
      const res = await this.callBackgroundTasks(run);
      if (res.kind === "unavailable") {
        await run.handle.interrupt();
        return {
          outcome: "stopped", moved: 0, sent: 0,
          notice: `Could not move the foreground work to background (${res.reason}), so the turn was stopped and the queued ${messages.length === 1 ? "message runs" : "messages run"} next`,
        };
      }
      // A false answer: the work left the foreground meanwhile. The messages still go.
      if (res.kind === "moved") moved = foreground.length;
    }
    const done = await this.resendNow(run, messages, hooks);
    if (done.sent === 0 && done.lost === 0 && done.error !== null) throw done.error;
    return { outcome: done.sent > 0 ? "sent" : moved > 0 ? "moved" : "nothing", moved, sent: done.sent, notice: sendNowNotice({ moved, messages: messages.length, ...done }) };
  }

  /**
   * Step 3 of sendNow. Every message is taken out first, then the ones that came out are sent in
   * one go, oldest first (their requests leave in that order), so the CLI gets them together and
   * runs them as one turn. A send that fails after its take-out is reported to `hooks.lost`.
   */
  private async resendNow(run: Run, messages: readonly SendNowMessage[], hooks: SendNowHooks): Promise<ResendDone> {
    const out: ResendDone = { sent: 0, kept: 0, lost: 0, unsupported: false, error: null };
    const taken: Array<{ content: UserContent; to: string }> = [];
    for (const m of messages) {
      if (m.content === null) {
        out.kept += 1;
        continue;
      }
      const to = randomUUID();
      // Before the take-out: the CLI's `cancelled` message can come ahead of its answer.
      hooks.replacing(m.id, to);
      let took: boolean | "unsupported";
      try {
        took = await this.cancelAsync(run, m.id);
      } catch (err) {
        hooks.kept(m.id);
        out.kept += 1;
        out.error ??= err;
        continue;
      }
      if (took !== true) {
        hooks.kept(m.id);
        out.kept += 1;
        if (took === "unsupported") {
          out.unsupported = true;
          break;
        }
        continue;
      }
      hooks.replaced(m.id, to);
      taken.push({ content: m.content, to });
    }
    const results = await Promise.allSettled(taken.map((t) => run.handle.send(t.content, t.to, "now")));
    results.forEach((res, i) => {
      const to = taken[i]!.to;
      if (res.status === "fulfilled") {
        out.sent += 1;
        hooks.handed(to);
      } else {
        out.lost += 1;
        hooks.lost(to, res.reason instanceof Error ? res.reason.message : String(res.reason));
      }
    });
    return out;
  }

  /** `listener` hears every SDK message of a run with a session key, and the run's exit. Returns the unsubscribe. */
  onRunEvent(listener: (key: string, ev: { type: "message"; message: unknown } | { type: "exit" }) => void): () => void {
    this.runListeners.add(listener);
    return () => {
      this.runListeners.delete(listener);
    };
  }

  private emitRun(key: string, ev: { type: "message"; message: unknown } | { type: "exit" }): void {
    for (const l of [...this.runListeners]) {
      try {
        l(key, ev);
      } catch (err) {
        console.error("claude runs: run listener threw", err);
      }
    }
  }

  answer(key: string, requestId: string, answers: Record<string, string>): void {
    const run = this.runs.get(key);
    if (!run) throw new DriveError(NOT_DRIVEN);
    run.handle.answer(requestId, answers);
    run.pending.delete(requestId);
    this.publishPending(run);
    this.changed(key);
  }

  /**
   * Switch the permission mode of the session's process (the terminal UI's shift+tab). The thread
   * shows the new mode at once; the CLI confirms it with a system/status message.
   */
  async setPermissionMode(key: string, mode: string): Promise<void> {
    if (!(SETTABLE_PERMISSION_MODES as readonly string[]).includes(mode)) {
      throw new DriveError(`permission mode must be one of ${SETTABLE_PERMISSION_MODES.join(", ")}: ${JSON.stringify(mode)}`);
    }
    const run = this.runs.get(key);
    if (!run) throw new DriveError(NOT_DRIVEN);
    await run.handle.call("setPermissionMode", mode as SettablePermissionMode);
    if (run.permissionMode !== mode && this.runs.get(key) === run) {
      run.permissionMode = mode;
      this.notifyTurns(key);
    }
  }

  pendingOf(key: string): PendingQuestionView[] {
    const run = this.runs.get(key);
    return run ? [...run.pending.values()].map(view) : [];
  }

  /** The slash commands of the process this server runs for the session; null when it runs none. */
  commandsOf(key: string): Promise<SlashCommand[]> | null {
    const run = this.runs.get(key);
    return run ? run.handle.commands() : null;
  }

  /** Every session with open questions, for a UI that just connected. */
  allPending(): Array<{ key: string; questions: PendingQuestionView[] }> {
    const out: Array<{ key: string; questions: PendingQuestionView[] }> = [];
    for (const [key, run] of this.runs) if (run.pending.size) out.push({ key, questions: [...run.pending.values()].map(view) });
    return out;
  }

  /** Every session with foreground calls, for a UI that just connected. */
  allForeground(): Array<{ key: string; toolUseIds: string[] }> {
    const out: Array<{ key: string; toolUseIds: string[] }> = [];
    for (const [key, run] of this.runs) {
      const ids = foregroundToolUseIds(run.handle.state(), run.toolOfTask);
      if (ids.length) out.push({ key, toolUseIds: ids });
    }
    return out;
  }

  /** Sessions with a CLI process this server runs. */
  liveKeys(): string[] {
    return [...this.runs.keys()];
  }

  /** A CLI process this server runs holds the session. */
  isDriven(key: string): boolean {
    return this.runs.has(key);
  }

  /** pid of the CLI process this server runs for the session, once the driver found it. */
  pidOf(key: string): number | null {
    return this.runs.get(key)?.handle.pid() ?? null;
  }

  /** The ids of the tasks the session's process reports as running (host state); null when this server runs no process for it. */
  liveTaskIds(key: string): Set<string> | null {
    const run = this.runs.get(key);
    return run ? new Set(run.handle.state().tasks.map((t) => t.taskId)) : null;
  }

  /** Stop one task (subagent, workflow, background command, Monitor) of the session's process; its turn, if any, goes on. */
  async stopTask(key: string, taskId: string): Promise<void> {
    const run = this.runs.get(key);
    if (!run) throw new DriveError(NOT_DRIVEN);
    await run.handle.stopTask(taskId);
  }

  /** Task id of the newest launch of a workflow run, as the session's process reported it; null when unseen. */
  workflowTaskId(key: string, runId: string): string | null {
    return this.runs.get(key)?.handle.workflowTaskId(runId) ?? null;
  }

  /** End the CLI process this server runs for the session; the index then sees it closed. */
  async close(key: string): Promise<void> {
    const run = this.runs.get(key);
    if (!run) throw new DriveError(NOT_DRIVEN);
    run.closing = true;
    try {
      await run.handle.close();
    } catch (err) {
      run.closing = false;
      throw err;
    }
  }

  // ---- state for the index and the thread view ----

  /**
   * The index entry of a session whose process this server runs, with the status the host knows
   * (DESIGN.md 4.3): waiting-input while a question waits here, running while a turn runs,
   * open-idle otherwise, also while background tasks run (counted in `backgroundTasks`). Any
   * other entry comes back unchanged.
   */
  annotate(s: SessionSummary): SessionSummary {
    if (s.provider !== "claude" || s.owner !== "ui") return s;
    const run = this.runs.get(s.key);
    if (!run) return s;
    const st = run.handle.state();
    const status = run.pending.size > 0 ? "waiting-input" : st.busy ? "running" : "open-idle";
    return { ...s, status, backgroundTasks: backgroundCount(st), backgroundAgents: backgroundAgentCount(st) };
  }

  /** What this server knows about the session's turns, for its thread projector. */
  turnInfo(key: string): ClaudeTurnInfo {
    const run = this.runs.get(key);
    return {
      run: run
        ? {
            busy: run.handle.state().busy,
            waiting: run.pending.size > 0,
            busySince: run.busySince === null ? null : new Date(run.busySince).toISOString(),
            permissionMode: run.permissionMode,
            ...(run.activeGoal ? { activeGoal: run.activeGoal } : {}),
          }
        : null,
      ends: this.ends.get(key) ?? [],
      chosen: this.chosenOf(key),
      ...(this.deps.rewind ? { rewind: this.deps.rewind.markerOf(/^claude:[^:]+:(.+)$/.exec(key)?.[1] ?? "") } : {}),
    };
  }

  /** `listener(key)` runs whenever turnInfo(key) may have changed. Returns the unsubscribe. */
  onTurns(listener: (key: string) => void): () => void {
    this.turnListeners.add(listener);
    return () => {
      this.turnListeners.delete(listener);
    };
  }

  /**
   * `listener(key, result)` runs for each result message (a turn's end, with how it ended) of a
   * process this server runs, before the host reports the run idle. Returns the unsubscribe.
   */
  onResult(listener: (key: string, result: Record<string, unknown>) => void): () => void {
    this.resultListeners.add(listener);
    return () => {
      this.resultListeners.delete(listener);
    };
  }

  /**
   * `listener(key, info)` runs when a process this server runs for a session ended (the driver's
   * onExit), before the index hears of it. Returns the unsubscribe.
   */
  onRunExit(listener: (key: string, info: { code: "done" | "error" | "interrupted"; error?: string }) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  // ---- internals ----

  private account(id: string): ClaudeAccount {
    const a = this.deps.accounts.find((x) => x.id === id);
    if (!a) throw new DriveError(`Unknown account: ${id}`);
    return a;
  }

  /** The model the session last ran on: from its transcript (transcriptFacts.ts), else what its last process reported here. */
  private async resumeModel(key: string, account: ClaudeAccount, sessionId: string): Promise<string | null> {
    const file = transcriptOf(account.dir, sessionId);
    let model: string | null = null;
    if (file) {
      try {
        model = await lastModelOf(file);
      } catch {
        // An unreadable transcript leaves the model to the CLI (the account's default).
      }
    }
    return model ?? this.models.get(key) ?? null;
  }

  private async launch(
    account: ClaudeAccount,
    opts: Omit<StartOpts, "accountDir">,
    key: string | null,
    onFailBeforeId?: (error: string) => void,
    onSessionId?: (key: string, sid: string) => void,
  ): Promise<void> {
    const t = this.track(account, key, onFailBeforeId, onSessionId);
    // File checkpoints let a rewind restore the files (DESIGN.md 6o), as the terminal keeps them by default.
    const fileCheckpointing = this.deps.fileCheckpointing?.(account.dir, opts.cwd) ?? false;
    const handle = await this.deps.driver.start({ accountDir: account.dir, ...opts, ...(fileCheckpointing ? { fileCheckpointing } : {}) }, t.events);
    // The driver starts a run in bypass mode unless told otherwise (claude/driver.ts) until the CLI says otherwise.
    t.attach(handle, opts.permissionMode ?? "bypassPermissions");
  }

  /** A run the session host already had when this server connected (a restart of this server). */
  private adopt(handle: RunHandle, info: AdoptedRun): DriverEvents {
    const account = this.deps.accounts.find((a) => path.resolve(a.dir) === info.accountDir)
      ?? { id: path.basename(info.accountDir), dir: info.accountDir };
    const t = this.track(account, null);
    t.attach(handle, null);
    const sid = handle.sessionId();
    if (sid) {
      void this.inheritMode(handle, account, sid);
      // A model chosen before the restart is the one this process was last asked for.
      const pending = this.deps.choices?.get("claude", sid)?.model;
      const run = this.runs.get(sessionKey("claude", account.id, sid));
      if (pending !== undefined && run?.handle === handle) run.modelAsked = askedModel(pending);
    }
    return t.events;
  }

  /**
   * A run taken over after a restart reports its mode only at its next turn or change; until
   * then the mode its newest turn started in (transcriptFacts.ts) stands in.
   */
  private async inheritMode(handle: RunHandle, account: ClaudeAccount, sessionId: string): Promise<void> {
    const file = transcriptOf(account.dir, sessionId);
    if (!file) return;
    let mode: string | null = null;
    try {
      mode = await lastTurnModeOf(file);
    } catch {
      return;
    }
    const key = sessionKey("claude", account.id, sessionId);
    const run = this.runs.get(key);
    if (!mode || !run || run.handle !== handle || run.permissionMode !== null) return;
    run.permissionMode = mode;
    this.notifyTurns(key);
  }

  /**
   * The events of one run, and attach() for its handle once start() returned it (the driver
   * delivers events only after that). The run joins `runs` under its session key; a new session
   * gets its key once the CLI reports the id.
   */
  private track(
    account: ClaudeAccount,
    key: string | null,
    onFailBeforeId?: (error: string) => void,
    onSessionId?: (key: string, sid: string) => void,
  ): { events: DriverEvents; attach: (handle: RunHandle, permissionMode: string | null) => void } {
    let run: Run | null = null;
    let announced = false;
    const known = (sid: string | null) => {
      if (!run || !sid) return;
      const k = sessionKey("claude", account.id, sid);
      if (announced) {
        if (run.key !== k) this.moved(run, k, sid);
        return;
      }
      announced = true;
      run.key = k;
      this.runs.set(k, run);
      onSessionId?.(k, sid);
      this.changed(k);
    };
    const events: DriverEvents = {
      onMessage: (m) => {
        const o = m as unknown as Record<string, unknown>;
        if (typeof o.session_id === "string") known(o.session_id);
        if (!run?.key) return;
        this.emitRun(run.key, { type: "message", message: m });
        // The CLI's /goal state as it changes (set, a check, met, cleared): the thread's goal follows it
        // until the transcript's own record of the change arrives (goalState.ts chooseGoal).
        const goal = liveGoalOf(o, Date.now());
        if (goal !== null) {
          run.activeGoal = goal;
          this.notifyTurns(run.key);
          return;
        }
        if (o.type === "system" && o.subtype === "task_started" && typeof o.task_id === "string" && typeof o.tool_use_id === "string") {
          run.toolOfTask.set(o.task_id, o.tool_use_id);
          this.publishForeground(run);
        }
        if (o.type === "result") {
          this.endTurn(run.key, o);
          return;
        }
        if (o.type === "assistant") {
          this.responded(run, o);
          return;
        }
        if (o.type !== "system" || (o.subtype !== "init" && o.subtype !== "status")) return;
        if (o.subtype === "init") this.noteInit(run, o);
        // system/status carries the mode when it changed (setPermissionMode, the CLI entering plan mode).
        if (typeof o.permissionMode === "string" && o.permissionMode !== run.permissionMode) {
          run.permissionMode = o.permissionMode;
          this.notifyTurns(run.key);
        }
        if (o.subtype === "init") run.turnMode = run.permissionMode;
      },
      onState: (s) => {
        if (!run) return;
        this.noteBusy(run, s);
        this.publishForeground(run);
        if (run.key) this.changed(run.key);
      },
      onQuestion: (q) => {
        if (!run) return;
        run.pending.set(q.requestId, q);
        this.publishPending(run);
        if (run.key) this.changed(run.key);
      },
      onQuestionWithdrawn: (requestId) => {
        if (!run) return;
        if (run.pending.delete(requestId)) {
          this.publishPending(run);
          if (run.key) this.changed(run.key);
        }
      },
      onExit: (info) => {
        if (!run) return;
        if (!announced) onFailBeforeId?.(info.error ?? "The run ended before the session started");
        if (run.key && this.runs.get(run.key) === run) this.runs.delete(run.key);
        if (run.key) this.emitRun(run.key, { type: "exit" });
        if (run.key) this.settleMoves(run.key, null);
        if (run.pending.size) {
          run.pending.clear();
          this.publishPending(run);
        }
        if (run.key && run.foregroundSent !== "[]") {
          run.foregroundSent = "[]";
          this.deps.broadcast({ type: "session.foreground", key: run.key, toolUseIds: [] });
        }
        if (info.code === "error") {
          this.deps.broadcast({ type: "command.error", ...(run.key ? { threadId: run.key } : {}), error: info.error ?? "Claude run failed" });
        }
        if (run.key) {
          for (const l of [...this.exitListeners]) {
            try {
              l(run.key, info);
            } catch (err) {
              console.error("claude runs: exit listener threw", err);
            }
          }
        }
        if (run.key) this.changed(run.key);
        run.markExited();
        void this.deps.resweep();
      },
    };
    const attach = (handle: RunHandle, permissionMode: string | null) => {
      let markExited!: () => void;
      const exited = new Promise<void>((r) => (markExited = r));
      run = {
        account, handle, key, pending: new Map(), toolOfTask: new Map(), foregroundSent: "[]", busySince: null, permissionMode, closing: false, exited, markExited,
        chosen: {}, modelAsked: null, turnMode: null, reported: { model: null, outputStyle: null, fast: null },
      };
      this.noteBusy(run, handle.state());
      if (key) {
        this.runs.set(key, run);
        announced = true;
        this.changed(key);
      } else {
        known(handle.sessionId());
      }
      void this.watchPid(handle);
    };
    return { events, attach };
  }

  /**
   * The process went on in a new session: /clear (or a plan accepted with its context cleared)
   * gives it a new id and transcript, and every message after the CLI's conversation_reset names
   * the new id (measured 2026-11-16 on 2.1.325). The run's key follows; the new session joins the
   * list and the old session's Group, and the old session is no longer this server's.
   */
  private moved(run: Run, to: string, sid: string): void {
    const from = run.key;
    if (from && this.runs.get(from) === run) this.runs.delete(from);
    run.key = to;
    this.runs.set(to, run);
    // A close before the new session's first response resumes it on the model the process ran.
    const model = from ? this.models.get(from) : undefined;
    if (model) this.models.set(to, model);
    this.deps.chosen.set("claude", sid, true);
    const fromId = from?.split(":")[2];
    const project = fromId ? this.deps.projects.projectOf("claude", fromId) : null;
    if (project) {
      try {
        this.deps.projects.assign("claude", sid, project);
      } catch {
        // The project was deleted meanwhile: the session stays in 미분류.
      }
    }
    if (from && run.pending.size) {
      this.deps.broadcast({ type: "session.pending", key: from, questions: [] });
      this.publishPending(run);
    }
    if (from) {
      this.changed(from);
      this.settleMoves(from, to);
    }
    this.changed(to);
    void this.deps.resweep();
  }

  /** system/init (every turn): the model, output style and fast mode the process runs with. */
  private noteInit(run: Run, o: Record<string, unknown>): void {
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    const next = { model: str(o.model), outputStyle: str(o.output_style), fast: str(o.fast_mode_state) };
    if (next.model && run.key) this.models.set(run.key, next.model);
    const asked = run.modelAsked;
    if (next.model && asked?.untilInit) {
      asked.id = next.model;
      asked.untilInit = false;
    }
    // The report is newer than what was set here: a value set here stays only while the report
    // agrees with it (a model value stays while the process runs the id it was asked for).
    let dropped = false;
    const drop = (field: keyof RunChoice) => {
      if (run.chosen[field] === undefined) return;
      delete run.chosen[field];
      dropped = true;
    };
    if (next.model && run.chosen.model !== undefined && !(asked?.value === run.chosen.model && asked.id !== null && sameModel(asked.id, next.model))) drop("model");
    if (next.outputStyle) drop("outputStyle");
    if (next.fast) drop("fast");
    if (!dropped && JSON.stringify(next) === JSON.stringify(run.reported)) return;
    run.reported = next;
    if (run.key) this.notifyTurns(run.key);
  }

  /**
   * The transcript names the chosen model now: the model chosen for the next start is no longer
   * needed. A resume takes the model of the newest turn's first main line (transcriptFacts.ts), so
   * only a response in a turn begun after the ask counts (a system/init came since, naming the id
   * it runs), and only one of that id. So the rest of a turn under way, on the model before or
   * already on the new one, keeps the choice. A plan-mode response may come from another model,
   * and a resume skips a turn begun in plan mode even after it left plan mode (an approved plan;
   * transcriptFacts.ts); a 1M-context choice is never written to the transcript. None of them
   * drops it.
   */
  private responded(run: Run, o: Record<string, unknown>): void {
    const model = (o.message as { model?: unknown } | undefined)?.model;
    if (typeof model !== "string" || !model || model.startsWith("<") || run.permissionMode === "plan" || run.turnMode === "plan") return;
    if ((o as { parent_tool_use_id?: unknown }).parent_tool_use_id) return;
    const sid = run.handle.sessionId();
    const pending = sid ? this.deps.choices?.get("claude", sid)?.model : undefined;
    if (!sid || pending === undefined || ONE_M.test(pending)) return;
    const asked = run.modelAsked;
    if (!asked || asked.value !== pending || asked.untilInit || asked.id === null || ONE_M.test(asked.id)) return;
    if (sameModel(asked.id, model)) this.deps.choices!.clear("claude", sid, ["model"]);
  }

  private noteBusy(run: Run, s: RunState): void {
    if (s.busy && run.busySince === null) run.busySince = Date.now();
    else if (!s.busy) run.busySince = null;
  }

  /** A result message: the turn ended now. Its user_message_uuids name the runs it answered. */
  private endTurn(key: string, result: Record<string, unknown>): void {
    const list = Array.isArray(result.user_message_uuids)
      ? result.user_message_uuids.filter((u): u is string => typeof u === "string")
      : typeof result.user_message_uuid === "string" ? [result.user_message_uuid] : [];
    const ends = this.ends.get(key) ?? [];
    ends.push({ at: new Date().toISOString(), userMessageUuids: list });
    this.ends.set(key, ends);
    // A /clear moves its run before its result comes; a result under the same key means no move.
    this.settleMoves(key, null);
    this.notifyTurns(key);
    for (const l of [...this.resultListeners]) {
      try {
        l(key, result);
      } catch (err) {
        console.error("claude runs: result listener threw", err);
      }
    }
  }

  /** The index entry and the thread view both depend on what changed. */
  private changed(key: string): void {
    this.deps.stateChanged?.(key);
    this.notifyTurns(key);
  }

  private notifyTurns(key: string): void {
    for (const l of [...this.turnListeners]) {
      try {
        l(key);
      } catch (err) {
        console.error("claude runs: turn listener threw", err);
      }
    }
  }

  /** The index marks a session "ui"-owned once its pid is known; ask it to look right away. */
  private async watchPid(handle: RunHandle): Promise<void> {
    const end = Date.now() + (this.deps.pidWaitMs ?? 15_000);
    while (Date.now() < end) {
      if (handle.pid() !== null) {
        await this.deps.resweep();
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Broadcasts the calls of this run that the CLI holds in the foreground, when they changed (session.foreground). */
  private publishForeground(run: Run): void {
    if (!run.key) return;
    const ids = foregroundToolUseIds(run.handle.state(), run.toolOfTask);
    const json = JSON.stringify(ids);
    if (json === run.foregroundSent) return;
    run.foregroundSent = json;
    this.deps.broadcast({ type: "session.foreground", key: run.key, toolUseIds: ids });
  }

  private publishPending(run: Run): void {
    if (!run.key) return;
    this.deps.broadcast({ type: "session.pending", key: run.key, questions: [...run.pending.values()].map(view) });
  }
}

/** Background tasks of the process as the index counts them: a task that is not backgrounded belongs to the turn while one runs. */
function backgroundCount(st: RunState): number {
  return st.tasks.filter((t) => !t.ambient && (t.background || !st.busy)).length;
}

/**
 * What "Send now" does (ClaudeRuns.sendNow): the first step that applies. `resend` takes the
 * waiting messages out and sends them again with priority `now`; `background-resend` sends the
 * foreground tasks to the background before that.
 */
export type SendNowPlan = "no-turn" | "no-message" | "resend" | "background-resend";

/** The send-now order from what the server knows; the fallback (an interrupt) follows a refused background call. */
export function decideSendNow(input: { busy: boolean; foreground: number; queued: number }): SendNowPlan {
  if (!input.busy) return "no-turn";
  if (input.queued <= 0) return "no-message";
  return input.foreground > 0 ? "background-resend" : "resend";
}

/** A waiting message as sendNow takes it: its send id, and what to send again (null: cannot be rebuilt, it stays queued). */
export interface SendNowMessage {
  id: string;
  content: UserContent | null;
}

/**
 * What the caller's record of waiting messages hears while sendNow replaces them. A message is
 * sent again under a new uuid (the CLI drops one it has seen).
 * replacing  `from` is about to be taken out of the CLI's queue and sent again as `to` (before the take-out)
 * kept       the take-out did not happen: `from` stays as it is
 * replaced   the CLI let go of `from`: the message is `to` from now on
 * handed     the send of `to` went through
 * lost       the send of `to` failed after the take-out: the message must not vanish
 */
export interface SendNowHooks {
  replacing(from: string, to: string): void;
  kept(from: string): void;
  replaced(from: string, to: string): void;
  handed(to: string): void;
  lost(to: string, error: string): void;
}

/** What step 3 of sendNow did: messages sent, left alone, lost; whether the host lacks the take-out; the first take-out failure. */
interface ResendDone {
  sent: number;
  kept: number;
  lost: number;
  unsupported: boolean;
  error: unknown;
}

/**
 * The outcome of ClaudeRuns.sendNow: sent (waiting messages were sent again with priority now),
 * moved (only foreground tasks went to the background), nothing (nothing to do), stopped (the turn
 * was interrupted). `moved` counts the tasks sent to background, `sent` the messages sent again.
 */
export interface SendNowResult {
  outcome: "sent" | "moved" | "nothing" | "stopped";
  moved: number;
  sent: number;
  notice: string;
}

const SEND_NOW_NOTHING: Record<"no-turn" | "no-message", string> = {
  "no-turn": "No turn is running, so there is nothing to send now",
  "no-message": "No queued message is waiting",
};

function sendNowNothing(plan: "no-turn" | "no-message"): SendNowResult {
  return { outcome: "nothing", moved: 0, sent: 0, notice: SEND_NOW_NOTHING[plan] };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The notice of a finished sendNow: what moved, what was sent again, and what was not. */
export function sendNowNotice(r: { moved: number; messages: number; sent: number; kept: number; lost: number; unsupported: boolean }): string {
  const parts: string[] = [];
  if (r.moved > 0) parts.push(`Sent ${plural(r.moved, "foreground task", "foreground tasks")} to background`);
  if (r.sent > 0) parts.push(`${parts.length ? "sent" : "Sent"} ${plural(r.sent, "queued message", "queued messages")} now`);
  if (r.lost > 0) parts.push(`${plural(r.lost, "message", "messages")} could not be sent again and now show as failed in the queue, take back to edit`);
  if (r.unsupported) {
    parts.push("the session host cannot take queued messages back (restart it to send them now), so they go in at the next step");
  } else if (r.kept > 0 && r.sent === 0 && r.lost === 0) {
    parts.push(r.moved > 0 ? "the queued messages go in next" : "the model already has the queued messages or they could not be taken out, nothing to send now");
  } else if (r.kept > 0) {
    parts.push(`${plural(r.kept, "message was", "messages were")} left as they were (the model already has ${r.kept === 1 ? "it" : "them"})`);
  }
  if (parts.length === 0) return "Nothing to send now";
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The tasks of a turn that Ctrl+B would send to the background: started, not backgrounded, not a watcher. */
export function foregroundTasks(st: RunState): RunState["tasks"] {
  return st.tasks.filter((t) => !t.ambient && !t.background);
}

/** The tool_use ids of the foreground tasks whose call is known (a task without one, an adopted run's, is left out). */
export function foregroundToolUseIds(st: RunState, toolOfTask: ReadonlyMap<string, string>): string[] {
  const ids: string[] = [];
  for (const t of foregroundTasks(st)) {
    const id = toolOfTask.get(t.taskId);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/** Of those, the subagents and workflows: shell commands (local_bash, a dev server) are not a subagent at work. */
function backgroundAgentCount(st: RunState): number {
  return st.tasks.filter((t) => !t.ambient && (t.background || !st.busy) && t.type !== "local_bash").length;
}

/**
 * Why closing the process now would cut work off, or null: a question waits, a turn runs, or
 * background tasks run (the states in which the header hides 닫기, SessionDetail.tsx).
 */
function closeBlocker(st: RunState, questions: number): string | null {
  if (questions > 0) return "a question is waiting for an answer";
  if (st.busy) return "a turn is in progress";
  const bg = backgroundCount(st);
  return bg > 0 ? `${bg} background ${bg === 1 ? "task is" : "tasks are"} running` : null;
}

function fastText(c: SessionChosen): string {
  return c.fast ? (c.fastCooldown ? "on, standard speed for a while after a rate limit" : "on") : "off";
}

function view(q: PendingQuestion): PendingQuestionView {
  return {
    requestId: q.requestId,
    toolUseId: q.toolUseId,
    toolName: q.toolName,
    kind: q.kind,
    input: q.input,
    title: q.title,
    description: q.description,
  };
}
