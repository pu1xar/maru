// Codex threads this server drives (DESIGN.md 4.2, M2), through each account's app-server daemon.
// One driver connection per account, apart from the connections that watch (the index, the
// thread views). Facts below are from measurements on codex-cli 0.169.0 (2026-11-15).
//
// Who drives a thread. The daemon is the only writer of a thread and serializes its clients, so
// two clients never fork a conversation (two Claude processes do). A thread belongs to the client
// whose turn runs on it:
// - A turn another client started runs (a TUI, `codex agents`, `codex queue`, the daemon itself):
//   the UI only watches. send, interrupt and answer are refused here, and that turn's server
//   requests stay for its own client.
// - Idle: a send takes the thread over. A TUI still attached is a daemon client too and shows
//   this server's turn as it runs. Whether a TUI is attached cannot be known: no daemon method
//   lists a thread's subscribers, and the UI's own thread view keeps a thread loaded (the daemon
//   unloads a thread 60 s after its last subscriber leaves), so "loaded" does not mean a terminal.
// - Closed (notLoaded): a codex process outside the daemon (`codex exec`, a `--no-daemon` TUI)
//   writes the rollout itself while the daemon reports notLoaded. A send is refused while a codex
//   process has the rollout open (lsof); otherwise the thread is resumed here.
// - A turn this server did not start begins on a thread it drives: the thread is let go at once.
// - This server restarts (every release deploy): the threads it drove stay its own. They are kept in
//   state.sqlite (state/codexHeld.ts) and restore() takes them up again with their running turn,
//   and the daemon sends their open questions again once the thread is resumed.
//
// Permissions (DESIGN.md 1, always bypass): every turn this server starts carries approvalPolicy
// "never" and a dangerFullAccess sandbox, so no approval request comes. Turn settings stay the
// thread's defaults for later turns, a terminal's turns included.
//
// Server requests reach every connection subscribed to the thread, the first answer wins, and a
// request still pending is sent again to a connection that resumes the thread. The driver answers
// only requests of turns this server started; any other gets NO_ANSWER and stays for its client.
// Questions (request_user_input) and approvals that still come go to the UI as session.pending; a
// dynamic tool call is refused at once (this client provides no dynamic tools).
//
// Sending while this server's turn runs steers that turn (turn/steer with expectedTurnId); a steer
// that finds the turn over starts a new one. turn/start on a thread with an active turn would
// steer it too, whoever started it, so turn/start is only sent while no turn is known to run.
//
// Slash commands (codexCommands.ts) become the daemon's methods. /model and /effort wait for this
// server's next turn/start (DESIGN.md 6m). A TUI screen maru does not have, and any other `/name`
// (the TUI's "Unrecognized command"), is refused with the text handed back; the rest of a send is
// text, including one that starts with a space or a path.
// - /compact and /review need the thread idle and take it over like a send. Their turns are this
//   server's: a review works in an inner turn whose rootTurnId is the turn review/start names, and
//   the compaction turn is the first one the daemon starts after thread/compact/start (its answer
//   names none; measured 2026-11-16). A review takes no steer; a send during it is refused.
// - /goal <objective> and /goal resume also take the thread over: with an active goal the daemon
//   starts turns on its own to pursue it, and those count as this server's until the goal stops
//   being active. /goal pause and /goal clear are refused only while another client's turn runs;
//   /goal alone reads the goal.
// - /fork copies the thread into a new one this server then drives, in the source's project.
//   forkAt (a message's 여기서 fork, DESIGN.md 6q) does the same through one turn (lastTurnId).
// - /rename goes through the session renamer (sessions/rename.ts).

import fs from "node:fs";
import type { CommandResultMessage, PendingQuestionView, RenameSession, RenameSessionResult, ServerMessage, SessionChosen } from "@maru/shared";
import { GOAL_STATUS_LABEL, commandHandling, sessionKey, splitCommand } from "@maru/shared";
import type { CodexAccount } from "../config.ts";
import type { SessionIndex } from "../index/store.ts";
import type { ProjectStore } from "../projects/store.ts";
import type { ChosenStore } from "../state/chosen.ts";
import { CodexRpc, METHOD_NOT_FOUND, NO_ANSWER, RpcError, RpcTransportError } from "../codex/rpc.ts";
import type { NotificationParams, ServerRequestParams } from "../codex/rpc.ts";
import type { RequestId } from "../codex/protocol/RequestId.ts";
import type { DynamicToolCallParams } from "../codex/protocol/v2/DynamicToolCallParams.ts";
import type { ReviewStartResponse } from "../codex/protocol/v2/ReviewStartResponse.ts";
import type { ReviewTarget } from "../codex/protocol/v2/ReviewTarget.ts";
import type { SkillMetadata } from "../codex/protocol/v2/SkillMetadata.ts";
import type { SkillsListResponse } from "../codex/protocol/v2/SkillsListResponse.ts";
import type { Thread } from "../codex/protocol/v2/Thread.ts";
import type { ThreadStatus } from "../codex/protocol/v2/ThreadStatus.ts";
import type { ThreadForkResponse } from "../codex/protocol/v2/ThreadForkResponse.ts";
import type { ThreadGoal } from "../codex/protocol/v2/ThreadGoal.ts";
import type { ThreadGoalClearResponse } from "../codex/protocol/v2/ThreadGoalClearResponse.ts";
import type { ThreadGoalGetResponse } from "../codex/protocol/v2/ThreadGoalGetResponse.ts";
import type { ThreadGoalSetResponse } from "../codex/protocol/v2/ThreadGoalSetResponse.ts";
import type { ThreadReadResponse } from "../codex/protocol/v2/ThreadReadResponse.ts";
import type { ThreadResumeResponse } from "../codex/protocol/v2/ThreadResumeResponse.ts";
import type { ThreadStartResponse } from "../codex/protocol/v2/ThreadStartResponse.ts";
import type { ThreadTurnsListResponse } from "../codex/protocol/v2/ThreadTurnsListResponse.ts";
import type { Turn } from "../codex/protocol/v2/Turn.ts";
import type { TurnStartResponse } from "../codex/protocol/v2/TurnStartResponse.ts";
import type { UserInput } from "../codex/protocol/v2/UserInput.ts";
import type { Model } from "../codex/protocol/v2/Model.ts";
import type { ModelListResponse } from "../codex/protocol/v2/ModelListResponse.ts";
import { codexOpenJsonl } from "../sessions/rename.ts";
import type { CodexHeldStore } from "../state/codexHeld.ts";
import type { SessionChoiceStore } from "../state/sessionChoices.ts";
import { DriveError, type ConfigureOpts } from "./claudeRuns.ts";
import { codexInput, commandWithAttachments } from "../attachments/message.ts";
import type { StoredAttachment } from "../attachments/store.ts";
import { goalNotice, parseCodexCommand, type CodexCommand } from "./codexCommands.ts";

/** What a command this server ran itself tells the UI that sent it (command.result). */
export type CommandResult = Omit<CommandResultMessage, "type" | "reqId" | "threadId">;

const KEY_RE = /^codex:([^:]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** What the driver connection saw on a thread this server drives (CodexRuns.onThreadEvent). */
export type CodexThreadEvent =
  | { type: "userMessage"; clientId: string }
  | { type: "turnCompleted"; turnId: string }
  /** This server let the thread go (closed, taken by another client, gone): it sees no more of its turns. */
  | { type: "released" };

/** Settings of every thread and turn this server starts (DESIGN.md 1: always bypass). */
export const BYPASS_THREAD = { approvalPolicy: "never", sandbox: "danger-full-access" } as const;
export const BYPASS_TURN = { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } as const;

/**
 * Config for threads this server starts: Codex asks the user (request_user_input) in default
 * mode too, not only in Plan mode, and the UI answers (user decision 2026-11-15). The feature is
 * marked under development in codex-cli 0.169.
 */
export const START_CONFIG = { "features.default_mode_request_user_input": true } as const;

/** Server requests that wait for a person. */
export const ASK_METHODS = [
  "item/tool/requestUserInput",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
] as const;
export type AskMethod = (typeof ASK_METHODS)[number];

const FOREIGN_TURN = "A turn started by another client (such as a terminal) is in progress. Send after that turn ends";
const NOT_DRIVEN = "This session is not run by this server";
const SUBAGENT = "Cannot send to a subagent thread. Send to the parent session";
const REVIEW_TURN = "Cannot add messages during a review. Send after the review ends, or stop it";

export interface CodexRunsDeps {
  accounts: CodexAccount[];
  index: Pick<SessionIndex, "get">;
  chosen: Pick<ChosenStore, "set">;
  projects: Pick<ProjectStore, "assign" | "projectOf">;
  /** Ids of the threads this server drives; the Codex index marks them owner "ui". */
  owned: Set<string>;
  /** `owned` changed for this thread: publish its index entry again. */
  ownerChanged: (accountId: string, threadId: string) => void;
  /** Sends a message to every connected UI. */
  broadcast: (msg: ServerMessage) => void;
  /** /rename: the session renamer (SessionRenamer.rename). */
  rename: (req: RenameSession) => Promise<RenameSessionResult>;
  /** Paths of the .jsonl files codex processes have open. Default: codexOpenJsonl (lsof). */
  codexOpenFiles?: () => Promise<Set<string>>;
  /** Wait between checks that a new thread's history can be read, ms. Default 50. */
  readyPollMs?: number;
  /** Model and effort chosen with /model for this server's next turn/start (DESIGN.md 6m). */
  choices?: SessionChoiceStore;
  /** The driven threads kept for a restart of this server (restore()). */
  held?: Pick<CodexHeldStore, "list" | "hold" | "addTurn" | "endTurn" | "setGoal" | "drop">;
}

/** A question or approval of a turn this server started, waiting for the UI. */
export interface CodexAsk {
  method: AskMethod;
  params: unknown;
  view: PendingQuestionView;
  /** request_user_input: the question text the UI keys its answer by -> the question id. */
  questionIds: Map<string, string>;
}

interface Pending extends CodexAsk {
  turnId: string | null;
  /** Sends the result, or NO_ANSWER when the request ended elsewhere. Removes the entry. */
  settle: (result: unknown) => void;
}

interface Driven {
  key: string;
  account: CodexAccount;
  threadId: string;
  /** Turns this server started on the thread. */
  turns: Set<string>;
  /** The turn in progress as the driver connection saw it (any client's), or null. */
  activeTurn: string | null;
  /** The last turn the driver connection saw end. */
  lastEnded: string | null;
  /** turn/start in flight: resolves with its turn id, null when it failed. */
  starting: Promise<string | null> | null;
  /**
   * The driver connection subscribed (thread/start or thread/resume). Until then the daemon's
   * notLoaded and thread/closed are about the thread before this server took it.
   */
  subscribed: boolean;
  pending: Map<string, Pending>;
  /** thread/compact/start was sent: the next turn the daemon starts is that compaction. */
  adoptNext: boolean;
  /** A goal this server set is active: the turns the daemon starts to pursue it are this server's. */
  goalByUs: boolean;
  /** A goal/set or goal/clear this server sent for /goal is in flight (see goal()). */
  goalSetting: boolean;
  /**
   * A review's inner turn -> its root turn. turn/interrupt takes the inner id; turn/steer and
   * turn/completed name the root (measured 2026-11-16).
   */
  rootOf: Map<string, string>;
}

export class CodexRuns {
  private deps: CodexRunsDeps;
  private conns = new Map<string, Promise<CodexRpc>>();
  private driven = new Map<string, Driven>();
  private chains = new Map<string, Promise<unknown>>();
  private chosenListeners = new Set<(key: string) => void>();
  private turnEndListeners = new Set<(key: string, turn: Turn) => void>();
  private statusListeners = new Set<(key: string, status: ThreadStatus) => void>();
  private threadListeners = new Set<(key: string, ev: CodexThreadEvent) => void>();

  constructor(deps: CodexRunsDeps) {
    this.deps = deps;
  }

  /**
   * `listener(key, turn)` runs for each turn/completed (the turn's status and error) of a thread
   * this server drives, as the driver connection gets it. Returns the unsubscribe.
   */
  onTurnEnd(listener: (key: string, turn: Turn) => void): () => void {
    this.turnEndListeners.add(listener);
    return () => {
      this.turnEndListeners.delete(listener);
    };
  }

  /**
   * `listener(key, status)` runs for each thread/status/changed of a thread this server drives, as
   * the driver connection gets it: in the daemon's order with that thread's turn/started and
   * turn/completed, which the index connection does not keep (measured 2026-11-16). A status that
   * lets the thread go (notLoaded) is not passed on. Returns the unsubscribe.
   */
  onThreadStatus(listener: (key: string, status: ThreadStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  handles(key: string): boolean {
    return KEY_RE.test(key);
  }

  /**
   * Next user message: steers this server's running turn, else starts a turn (taking the thread
   * over). `id` goes along as the clientUserMessageId, which the daemon's userMessage item carries
   * (the pending send, DESIGN.md 4.4). A message that is one of the Codex slash commands runs that
   * command instead and resolves with what the UI shows for it.
   */
  send(key: string, text: string, attachments: readonly StoredAttachment[] = [], id?: string): Promise<CommandResult | void> {
    if (!text.trim() && attachments.length === 0) return Promise.reject(new DriveError("Cannot send an empty message"));
    let account: CodexAccount;
    let threadId: string;
    let command: CodexCommand | null;
    try {
      ({ account, threadId } = this.parse(key));
      // As in the TUI, a message that starts with a space is text whatever follows (splitCommand).
      const word = splitCommand(text);
      // A TUI screen maru does not have: as text it would reach the model (sessionControls.ts).
      const handling = word ? commandHandling("codex", word.name) : null;
      // Every `/name` is a command here: one this server runs, a TUI screen, or one the TUI refuses
      // (the daemon has none of its own; skills are `$name` text). None takes attachments, so the
      // web server gives the text and the attachments back to the composer (command.error unsent).
      if (word && attachments.length > 0) throw new DriveError(commandWithAttachments(word.name));
      if (word && handling?.kind === "unsupported") {
        return Promise.resolve({ command: word.name, notice: `/${word.name}: ${handling.reason}`, unsent: text });
      }
      command = word ? parseCodexCommand(text) : null;
      // Any other `/name` the TUI refuses as "Unrecognized command" and keeps in the composer
      // (0.169.0 chat_composer.rs); a path (`/Users/...`) is no `/name` and goes as text.
      if (!command && word) {
        return Promise.resolve({ command: word.name, notice: `/${word.name}: not a Codex command. Pick a command from the / menu`, unsent: text });
      }
    } catch (err) {
      return Promise.reject(err);
    }
    if (command) {
      const cmd = command;
      return this.serial(key, () => this.runCommand(key, account, threadId, cmd));
    }
    // Pictures go as localImage items the daemon reads from disk; every attachment as a path note.
    const input = codexInput(text, attachments);
    return this.serial(key, async () => {
      const rpc = await this.conn(account);
      const d = this.driven.get(key);
      if (d) await this.sendDriven(rpc, d, input, id);
      else await this.takeOver(rpc, key, account, threadId, input, id);
    });
  }

  /** The daemon's model/list for the session's account, every page (the model picker). */
  async models(key: string): Promise<Model[]> {
    const { account } = this.parse(key);
    const rpc = await this.conn(account);
    const out: Model[] = [];
    let cursor: string | null = null;
    try {
      do {
        const res = (await rpc.request("model/list", cursor ? { cursor } : {})) as ModelListResponse;
        out.push(...res.data);
        cursor = res.nextCursor;
      } while (cursor);
    } catch (err) {
      throw driveError(err);
    }
    return out;
  }

  /**
   * /model for a Codex thread: the daemon takes a model and an effort only with turn/start
   * ("for this turn and subsequent turns"), so they wait here for this server's next turn/start.
   * A turn another client starts first runs on the thread's own settings.
   */
  async configure(key: string, c: ConfigureOpts): Promise<CommandResult> {
    const { account, threadId } = this.parse(key);
    if (c.model === undefined && c.effort === undefined) throw new DriveError("Codex sessions only allow changing the model and effort");
    if (c.model !== undefined && (typeof c.model !== "string" || !c.model)) throw new DriveError("Invalid model value");
    if (c.effort !== undefined && c.effort !== null && (typeof c.effort !== "string" || !c.effort)) throw new DriveError("Invalid effort value");
    if (!this.deps.choices) throw new DriveError("Model selection is disabled");
    if (this.deps.index.get(key)?.parentKey) throw new DriveError(SUBAGENT);
    const models = await this.models(key);
    const find = (name: string | null | undefined) => (name ? models.find((m) => m.model === name || m.id === name) ?? null : null);
    const model = c.model === undefined ? undefined : find(c.model);
    if (c.model !== undefined && !model) {
      throw new DriveError(`Unknown model: ${c.model}. Use one of ${models.filter((m) => !m.hidden).map((m) => m.model).join(", ")}`);
    }
    // The effort is checked against the model the next turn runs: the one picked now, the one
    // waiting from before, else the thread's own (thread/read).
    let target = model ?? null;
    if (!target && c.effort !== undefined) {
      const waiting = this.deps.choices.get("codex", threadId)?.model;
      const own = waiting ? null : (await this.readTopLevel(await this.conn(account), key, threadId)).model;
      target = find(waiting ?? own);
      if (!target) throw new DriveError("Cannot verify effort because this thread's model is unknown. Pick both with /model <model> <effort>");
    }
    const levels = target?.supportedReasoningEfforts.map((e) => e.reasoningEffort) ?? [];
    if (c.effort && target && levels.length && !levels.includes(c.effort as (typeof levels)[number])) {
      throw new DriveError(`effort for ${target.displayName} must be one of ${levels.join(", ")}`);
    }
    // turn/start takes null as "no override", so "the model's own" is its default effort.
    const effort = c.effort === null ? target?.defaultReasoningEffort ?? undefined : c.effort;
    if (c.effort === null && effort === undefined) throw new DriveError(`The default effort for ${target?.displayName ?? "this model"} is unknown`);
    this.deps.choices.merge("codex", threadId, {
      ...(model ? { model: model.model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    });
    this.notifyChosen(key);
    const parts = [model ? `model ${model.displayName}` : null, c.effort !== undefined ? `effort ${effort}${c.effort === null ? " (default)" : ""}` : null].filter(Boolean);
    return { command: c.model !== undefined ? "model" : "effort", notice: `Set ${parts.join(", ")}, applies from the next turn this server sends` };
  }

  /** state.chosen of the thread: the model and effort waiting for this server's next turn/start. */
  chosenOf(key: string): SessionChosen | null {
    const id = KEY_RE.exec(key)?.[2];
    const c = id ? this.deps.choices?.get("codex", id) : null;
    if (!c || (c.model === undefined && c.effort === undefined)) return null;
    return { ...(c.model !== undefined ? { model: c.model } : {}), ...(c.effort !== undefined ? { effort: c.effort } : {}), pending: true };
  }

  /** `listener(key)` runs when chosenOf(key) may have changed. Returns the unsubscribe. */
  onChosen(listener: (key: string) => void): () => void {
    this.chosenListeners.add(listener);
    return () => {
      this.chosenListeners.delete(listener);
    };
  }

  /** `listener` hears what the driver connection sees of the threads this server drives. Returns the unsubscribe. */
  onThreadEvent(listener: (key: string, ev: CodexThreadEvent) => void): () => void {
    this.threadListeners.add(listener);
    return () => {
      this.threadListeners.delete(listener);
    };
  }

  private emitThread(key: string, ev: CodexThreadEvent): void {
    for (const l of [...this.threadListeners]) {
      try {
        l(key, ev);
      } catch (err) {
        console.error("codex runs: thread listener threw", err);
      }
    }
  }

  private notifyChosen(key: string): void {
    for (const l of [...this.chosenListeners]) {
      try {
        l(key);
      } catch (err) {
        console.error("codex runs: chosen listener threw", err);
      }
    }
  }

  /** Enabled skills the daemon lists for the session's working folder (the `/` menu's `$name` entries). */
  async skills(key: string, opts: { reload?: boolean } = {}): Promise<SkillMetadata[]> {
    const { account } = this.parse(key);
    const cwd = this.deps.index.get(key)?.cwd;
    if (!cwd) throw new DriveError("This session's working folder is unknown");
    const rpc = await this.conn(account);
    let res: SkillsListResponse;
    try {
      res = (await rpc.request("skills/list", { cwds: [cwd], ...(opts.reload ? { forceReload: true } : {}) })) as SkillsListResponse;
    } catch (err) {
      throw driveError(err);
    }
    return res.data.flatMap((entry) => entry.skills).filter((s) => s.enabled);
  }

  /** A new thread with its first turn; resolves with its key once its history can be read. */
  async create(opts: {
    account: string; cwd: string; prompt: string; projectId: string | null; model?: string;
    /** Names the new thread once it can be listed; a refusal goes to `nameFailed` and the thread stays. */
    name?: string; nameFailed?: (message: string) => void;
  }): Promise<string> {
    if (!opts.prompt.trim()) throw new DriveError("A first message is required");
    const account = this.account(opts.account);
    if (!fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory()) {
      throw new DriveError(`Working folder not found: ${opts.cwd}`);
    }
    const rpc = await this.conn(account);
    let started: ThreadStartResponse;
    try {
      started = (await rpc.request("thread/start", {
        cwd: opts.cwd,
        ...(opts.model ? { model: opts.model } : {}),
        ...BYPASS_THREAD,
        config: START_CONFIG,
      })) as ThreadStartResponse;
    } catch (err) {
      throw driveError(err);
    }
    const threadId = started.thread.id;
    const key = sessionKey("codex", account.id, threadId);
    // thread/start subscribed this connection already.
    const d = this.claim(key, account, threadId, true);
    return this.serial(key, async () => {
      let turnId: string;
      try {
        turnId = await this.startTurn(rpc, d, textInput(opts.prompt));
      } catch (err) {
        this.release(d, true);
        throw driveError(err);
      }
      // A new session joins the list and its project on its own (DESIGN.md 6c, 6d).
      this.deps.chosen.set("codex", threadId, true);
      if (opts.projectId) {
        try {
          this.deps.projects.assign("codex", threadId, opts.projectId);
        } catch {
          // The project was deleted meanwhile: the session stays in 미분류.
        }
      }
      await this.untilListable(rpc, d, turnId);
      if (opts.name) {
        try {
          await this.deps.rename({ provider: "codex", account: account.id, id: threadId, name: opts.name });
        } catch (err) {
          opts.nameFailed?.(errorMessage(err));
        }
      }
      return key;
    });
  }

  async interrupt(key: string): Promise<void> {
    const d = this.driven.get(key);
    if (!d) throw new DriveError(NOT_DRIVEN);
    if (d.starting) await d.starting;
    const turnId = d.activeTurn;
    if (turnId === null || !d.turns.has(turnId)) throw new DriveError("No turn is running");
    const rpc = await this.conn(d.account);
    try {
      await rpc.request("turn/interrupt", { threadId: d.threadId, turnId });
    } catch (err) {
      if (err instanceof RpcError && /no active turn/i.test(err.message)) throw new DriveError("No turn is running");
      throw driveError(err);
    }
  }

  /**
   * Let the thread go (the UI's 닫기, as for a Claude session): this server's running turn is
   * interrupted, its open questions end, and the driver connection unsubscribes. The index then
   * shows the thread as no longer this server's. The daemon unloads a thread once no connection
   * has been subscribed for 60 s (a thread view open in a browser is a subscriber too); deleting
   * or moving it waits for that, as for any loaded thread. An active goal stays as it is.
   */
  close(key: string): Promise<void> {
    if (!this.driven.has(key)) return Promise.reject(new DriveError(NOT_DRIVEN));
    return this.serial(key, async () => {
      const d = this.driven.get(key);
      if (!d) return;
      if (d.starting) await d.starting;
      const rpc = await this.conn(d.account);
      const turnId = d.activeTurn;
      if (turnId !== null && d.turns.has(turnId)) {
        try {
          await rpc.request("turn/interrupt", { threadId: d.threadId, turnId });
        } catch (err) {
          if (!(err instanceof RpcError && /no active turn/i.test(err.message))) throw driveError(err);
        }
      }
      this.release(d, false);
      if (!d.subscribed) return;
      try {
        await rpc.request("thread/unsubscribe", { threadId: d.threadId });
      } catch (err) {
        throw driveError(err);
      }
    });
  }

  /** This server drives the thread (DESIGN.md 4.2): its subagent threads may be stopped from here. */
  isDriven(key: string): boolean {
    return this.driven.has(key);
  }

  /**
   * The thread and its turns, oldest first, with their user messages (itemsView summary carries
   * them, measured on 0.169.0), for the rewind screen (DESIGN.md 6o). Every page is read.
   */
  async rewindTurns(key: string): Promise<{ thread: Thread; turns: Turn[] }> {
    const { account, threadId } = this.parse(key);
    const rpc = await this.conn(account);
    const thread = await this.readTopLevel(rpc, key, threadId);
    const turns: Turn[] = [];
    if (thread.historyMode !== "paginated") return { thread, turns };
    let cursor: string | null = null;
    try {
      do {
        const page = (await rpc.request("thread/turns/list", { threadId, cursor, sortDirection: "asc", itemsView: "summary" })) as ThreadTurnsListResponse;
        turns.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
    } catch (err) {
      throw driveError(err);
    }
    return { thread, turns };
  }

  /**
   * The conversation goes back to before turn `turnId` (daemon thread/revert, the TUI's Esc Esc
   * backtrack, DESIGN.md 6o). The thread is held as for a send: a closed thread is resumed first
   * (the daemon answers "thread not found" for one it has not loaded, measured), and a running
   * turn of any client refuses it. The files stay as they are: thread/revert changes the history only.
   */
  revert(key: string, turnId: string): Promise<void> {
    let account: CodexAccount;
    let threadId: string;
    try {
      ({ account, threadId } = this.parse(key));
    } catch (err) {
      return Promise.reject(err);
    }
    return this.serial(key, async () => {
      const rpc = await this.conn(account);
      const d = this.driven.get(key);
      if (d) {
        if (d.starting) await d.starting;
        if (d.activeTurn !== null) throw new DriveError(d.turns.has(d.activeTurn) ? "Cannot rewind while a turn is running" : FOREIGN_TURN);
      } else {
        await this.hold(rpc, key, account, threadId);
      }
      try {
        await rpc.request("thread/revert", { threadId, beforeTurnId: turnId });
      } catch (err) {
        throw driveError(err);
      }
    });
  }

  /**
   * Stops the running turn of a subagent thread under a thread this server drives (the 작업 tab's
   * 중단, DESIGN.md 6i). The daemon takes turn/interrupt on a subagent thread like on any other
   * (measured 2026-11-16 on 0.169.0: the turn ended "interrupted" 20 ms later). `isUnder` tells
   * whether `childKey` descends from `key` (the index's parentKey chain).
   */
  async interruptSubagent(key: string, childThreadId: string, isUnder: (childKey: string) => boolean): Promise<void> {
    const d = this.driven.get(key);
    if (!d) throw new DriveError(NOT_DRIVEN);
    if (!isUnder(sessionKey("codex", d.account.id, childThreadId))) throw new DriveError("Not a subagent thread of this session");
    const rpc = await this.conn(d.account);
    try {
      const page = (await rpc.request("thread/turns/list", {
        threadId: childThreadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
      })) as ThreadTurnsListResponse;
      const newest = page.data[0];
      if (!newest || newest.status !== "inProgress") throw new DriveError("No turn is running");
      await rpc.request("turn/interrupt", { threadId: childThreadId, turnId: newest.id });
    } catch (err) {
      if (err instanceof RpcError && /no active turn/i.test(err.message)) throw new DriveError("No turn is running");
      throw driveError(err);
    }
  }

  answer(key: string, requestId: string, answers: Record<string, string>): void {
    const d = this.driven.get(key);
    if (!d) throw new DriveError(NOT_DRIVEN);
    const p = d.pending.get(requestId);
    if (!p) throw new DriveError("This question has already ended");
    p.settle(askResult(p, answers));
    this.publish(d);
  }

  pendingOf(key: string): PendingQuestionView[] {
    const d = this.driven.get(key);
    return d ? [...d.pending.values()].map((p) => p.view) : [];
  }

  /** Every session with open questions, for a UI that just connected. */
  allPending(): Array<{ key: string; questions: PendingQuestionView[] }> {
    const out: Array<{ key: string; questions: PendingQuestionView[] }> = [];
    for (const d of this.driven.values()) if (d.pending.size) out.push({ key: d.key, questions: this.pendingOf(d.key) });
    return out;
  }

  /**
   * Take up the threads this server drove before it restarted (deps.held, DESIGN.md 4.2). They are
   * this server's at once, so the index's first look shows them owned here. Each is then checked
   * with its daemon, in that thread's send order: one the daemon has unloaded or cannot read is
   * let go without loading it, one running another client's turn is let go, and the rest are
   * resumed, which makes the daemon send their open questions again. Resolves with how many stay.
   */
  async restore(): Promise<{ kept: number; released: number }> {
    const back: Driven[] = [];
    for (const row of this.deps.held?.list() ?? []) {
      const m = KEY_RE.exec(row.key);
      const account = m ? this.deps.accounts.find((a) => a.id === m[1]) : undefined;
      if (!m || !account || this.driven.has(row.key)) {
        if (!this.driven.has(row.key)) this.deps.held?.drop(row.key);
        continue;
      }
      const d = newDriven(row.key, account, m[2]!, false);
      for (const t of row.turns) d.turns.add(t);
      d.goalByUs = row.goalByUs;
      this.driven.set(d.key, d);
      this.deps.owned.add(d.threadId);
      this.deps.ownerChanged(account.id, d.threadId);
      back.push(d);
    }
    const kept = await Promise.all(back.map((d) => this.serial(d.key, () => this.retake(d))));
    return { kept: kept.filter(Boolean).length, released: kept.filter((k) => !k).length };
  }

  /** One restored thread checked with its daemon (restore). True when it stays this server's. */
  private async retake(d: Driven): Promise<boolean> {
    if (this.driven.get(d.key) !== d) return false;
    // The daemon sends the open requests again as it answers thread/resume, before the newest turn
    // is known to be this server's (a goal's turn started meanwhile, a request with no turn): they
    // wait for that decision, as requests wait for a turn/start answer.
    let decided!: (id: string | null) => void;
    d.starting = new Promise<string | null>((r) => (decided = r));
    try {
      const rpc = await this.conn(d.account);
      const t = ((await rpc.request("thread/read", { threadId: d.threadId, includeTurns: false })) as ThreadReadResponse).thread;
      // Unloaded while this server was down (no subscriber for 60 s, or the daemon restarted): no
      // turn runs there, and resuming would load it again.
      if (t.status.type === "notLoaded") {
        this.release(d, false);
        return false;
      }
      await rpc.request("thread/resume", { threadId: d.threadId, excludeTurns: true });
      d.subscribed = true;
      const page = (await rpc.request("thread/turns/list", {
        threadId: d.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
      })) as ThreadTurnsListResponse;
      const newest = page.data[0];
      const running = newest?.status === "inProgress" ? newest : null;
      if (running) {
        const root = running.rootTurnId ?? null;
        if (!this.claimTurn(d, running.id, root)) {
          this.release(d, true);
          return false;
        }
        // A review's inner turn: turn/completed names its root.
        if (root !== null && root !== running.id && d.turns.has(root)) d.rootOf.set(running.id, root);
        // Its turn/completed may have come while the list was on its way.
        if (d.lastEnded !== running.id) d.activeTurn = running.id;
      }
      // Every other turn of the row ended while this server was down.
      for (const turnId of d.turns) {
        if (turnId !== running?.id && turnId !== running?.rootTurnId) this.deps.held?.endTurn(d.key, turnId);
      }
      return this.driven.get(d.key) === d;
    } catch {
      this.release(d, d.subscribed);
      return false;
    } finally {
      d.starting = null;
      decided(null);
    }
  }

  /**
   * Close the driver connections. Turns keep running in the daemon; the threads unload once no
   * client is subscribed. The held rows stay for the next start (restore).
   */
  async closeAll(): Promise<void> {
    for (const d of [...this.driven.values()]) {
      for (const p of [...d.pending.values()]) p.settle(NO_ANSWER);
      this.driven.delete(d.key);
      this.deps.owned.delete(d.threadId);
    }
    const conns = [...this.conns.values()];
    this.conns.clear();
    await Promise.allSettled(conns.map((p) => p.then((rpc) => rpc.close())));
  }

  // ---- sending ----

  private async sendDriven(rpc: CodexRpc, d: Driven, input: UserInput[], id?: string): Promise<void> {
    const active = d.activeTurn;
    if (active !== null) {
      if (!d.turns.has(active)) throw new DriveError(FOREIGN_TURN);
      try {
        await rpc.request("turn/steer", {
          threadId: d.threadId, input, expectedTurnId: d.rootOf.get(active) ?? active, ...(id ? { clientUserMessageId: id } : {}),
        });
        return;
      } catch (err) {
        if (!(err instanceof RpcError)) throw driveError(err);
        // "expected active turn id `a` but found `b`": another client's turn runs now.
        if (/expected active turn/i.test(err.message)) throw new DriveError(FOREIGN_TURN);
        // "cannot steer a review turn" (measured, code -32600).
        if (/steer a review turn/i.test(err.message)) throw new DriveError(REVIEW_TURN);
        if (!/no active turn/i.test(err.message)) throw driveError(err);
        // The turn ended in between: the message opens the next one.
        if (d.activeTurn === active) d.activeTurn = null;
      }
    }
    try {
      await this.startTurn(rpc, d, input, id);
    } catch (err) {
      throw driveError(err);
    }
  }

  /** Resume a thread no client is running a turn on, and start this server's turn on it. */
  private async takeOver(rpc: CodexRpc, key: string, account: CodexAccount, threadId: string, input: UserInput[], id?: string): Promise<void> {
    const d = await this.hold(rpc, key, account, threadId);
    try {
      await this.startTurn(rpc, d, input, id);
    } catch (err) {
      this.release(d, true);
      throw driveError(err);
    }
  }

  /**
   * Resume a thread no client is running a turn on and hold it as this server's. Refuses a
   * subagent thread, a running one, and one a codex process outside the daemon has open.
   */
  private async hold(rpc: CodexRpc, key: string, account: CodexAccount, threadId: string): Promise<Driven> {
    const t = await this.readTopLevel(rpc, key, threadId);
    if (t.status.type === "active") throw new DriveError(FOREIGN_TURN);
    if (t.status.type === "notLoaded" && t.path) {
      let open: Set<string>;
      try {
        open = await (this.deps.codexOpenFiles ?? codexOpenJsonl)();
      } catch (err) {
        throw new DriveError(`Could not check codex processes: ${errorMessage(err)}`);
      }
      if (open.has(t.path)) {
        throw new DriveError("A codex process outside the daemon (codex exec, --no-daemon TUI) has this session open. Send after it ends");
      }
    }
    const d = this.claim(key, account, threadId, false);
    try {
      const res = (await rpc.request("thread/resume", { threadId, excludeTurns: true })) as ThreadResumeResponse;
      d.subscribed = true;
      if (this.driven.get(key) !== d) throw new DriveError(FOREIGN_TURN);
      // Another client may have started a turn between the read and the resume. The resume's
      // status alone does not say so: for a thread with a goal it answers active while no turn
      // runs and thread/read says idle (measured 2026-11-16), so the newest turn decides.
      if (res.thread.status.type === "active") {
        const page = (await rpc.request("thread/turns/list", {
          threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
        })) as ThreadTurnsListResponse;
        if (page.data[0]?.status === "inProgress" || this.driven.get(key) !== d) throw new DriveError(FOREIGN_TURN);
      }
    } catch (err) {
      this.release(d, true);
      throw driveError(err);
    }
    return d;
  }

  /** thread/read, refusing a subagent thread. */
  private async readTopLevel(rpc: CodexRpc, key: string, threadId: string): Promise<Thread> {
    if (this.deps.index.get(key)?.parentKey) throw new DriveError(SUBAGENT);
    let t: Thread;
    try {
      t = ((await rpc.request("thread/read", { threadId, includeTurns: false })) as ThreadReadResponse).thread;
    } catch (err) {
      throw driveError(err);
    }
    if (t.parentThreadId) throw new DriveError(SUBAGENT);
    return t;
  }

  /**
   * turn/start with the bypass settings and the model and effort chosen with /model, which the
   * daemon keeps for the thread from then on. Resolves with the turn id.
   */
  private async startTurn(rpc: CodexRpc, d: Driven, input: UserInput[], clientId?: string): Promise<string> {
    const choice = this.deps.choices?.get("codex", d.threadId) ?? null;
    const id = await this.ownTurnRequest(d, async () =>
      ((await rpc.request("turn/start", {
        threadId: d.threadId, input, ...BYPASS_TURN, ...(clientId ? { clientUserMessageId: clientId } : {}),
        ...(choice?.model !== undefined ? { model: choice.model } : {}),
        ...(choice?.effort !== undefined ? { effort: choice.effort } : {}),
      })) as TurnStartResponse).turn);
    // The daemon keeps what turn/start carried; a choice made while it was on its way stays for the next turn.
    if (choice) {
      const now = this.deps.choices!.get("codex", d.threadId);
      const used = (["model", "effort"] as const).filter((f) => choice[f] !== undefined && now?.[f] === choice[f]);
      if (used.length) {
        this.deps.choices!.clear("codex", d.threadId, used);
        this.notifyChosen(d.key);
      }
    }
    return id;
  }

  /**
   * A request whose answer names a turn this server starts (turn/start, review/start). While it
   * is in flight `d.starting` is set, so a turn/started that comes before the answer waits for it.
   */
  private async ownTurnRequest(d: Driven, request: () => Promise<Turn>): Promise<string> {
    let done!: (id: string | null) => void;
    d.starting = new Promise<string | null>((resolve) => (done = resolve));
    let id: string | null = null;
    try {
      const turn = await request();
      id = turn.id;
      this.ownTurn(d, id);
      // A turn/started that came first already set the running turn (this one, or a review's
      // inner turn, which interrupt names); it stays.
      if (turn.status === "inProgress" && d.lastEnded !== id && d.activeTurn === null) d.activeTurn = id;
      return id;
    } finally {
      d.starting = null;
      done(id);
    }
  }

  // ---- slash commands ----

  private async runCommand(key: string, account: CodexAccount, threadId: string, cmd: CodexCommand): Promise<CommandResult> {
    if (cmd.name === "rename") return this.renameThread(key, account, threadId, cmd.title);
    if (cmd.name === "effort") {
      if (cmd.level !== null) return this.configure(key, { effort: cmd.level === "default" || cmd.level === "auto" ? null : cmd.level });
      const chosen = this.chosenOf(key);
      return { command: "effort", notice: `${chosen?.effort ? `Next turn effort: ${chosen.effort}` : "effort: thread setting unchanged"}\nChange with: /effort <effort|default>` };
    }
    if (cmd.name === "model") {
      if (cmd.model !== null) return this.configure(key, { model: cmd.model, ...(cmd.effort !== undefined ? { effort: cmd.effort } : {}) });
      const models = (await this.models(key)).filter((m) => !m.hidden);
      const chosen = this.chosenOf(key);
      return {
        command: "model",
        notice: [
          ...(chosen?.model ? [`Next turn model: ${chosen.model}${chosen.effort ? `, effort ${chosen.effort}` : ""}`] : []),
          ...models.map((m) => `${m.isDefault ? "* " : "  "}${m.model}: ${m.displayName}, effort ${m.supportedReasoningEfforts.map((e) => e.reasoningEffort).join("|")}`),
          "Change with: /model <model> [effort]",
        ].join("\n"),
      };
    }
    const rpc = await this.conn(account);
    switch (cmd.name) {
      case "compact":
        return this.compact(rpc, key, account, threadId);
      case "review":
        return this.review(rpc, key, account, threadId, cmd.instructions);
      case "goal":
        return this.goal(rpc, key, account, threadId, cmd);
      case "fork":
        return this.fork(rpc, key, account, threadId);
    }
  }

  /**
   * The thread held by this server with no turn running, taking it over when no client runs a
   * turn on it. `took` says it was taken over here, so a failed command lets it go again.
   */
  private async idle(rpc: CodexRpc, key: string, account: CodexAccount, threadId: string, name: string): Promise<{ d: Driven; took: boolean }> {
    const d = this.driven.get(key);
    if (!d) return { d: await this.hold(rpc, key, account, threadId), took: true };
    if (d.starting) await d.starting;
    const active = d.activeTurn;
    if (active === null) return { d, took: false };
    throw new DriveError(d.turns.has(active) ? `Send /${name} after the running turn ends` : FOREIGN_TURN);
  }

  private async compact(rpc: CodexRpc, key: string, account: CodexAccount, threadId: string): Promise<CommandResult> {
    const { d, took } = await this.idle(rpc, key, account, threadId, "compact");
    d.adoptNext = true;
    try {
      await rpc.request("thread/compact/start", { threadId });
    } catch (err) {
      d.adoptNext = false;
      if (took) this.release(d, true);
      throw driveError(err);
    }
    return { command: "compact" };
  }

  /** No instructions: the uncommitted changes, as the TUI's "review my current changes"; else a custom review. */
  private async review(rpc: CodexRpc, key: string, account: CodexAccount, threadId: string, instructions: string | null): Promise<CommandResult> {
    const { d, took } = await this.idle(rpc, key, account, threadId, "review");
    const target: ReviewTarget = instructions ? { type: "custom", instructions } : { type: "uncommittedChanges" };
    try {
      await this.ownTurnRequest(d, async () =>
        ((await rpc.request("review/start", { threadId, target, delivery: "inline" })) as ReviewStartResponse).turn);
    } catch (err) {
      if (took) this.release(d, true);
      throw driveError(err);
    }
    return { command: "review" };
  }

  private async goal(rpc: CodexRpc, key: string, account: CodexAccount, threadId: string, cmd: Extract<CodexCommand, { name: "goal" }>): Promise<CommandResult> {
    if (cmd.action === "get") {
      if (this.deps.index.get(key)?.parentKey) throw new DriveError(SUBAGENT);
      try {
        const res = (await rpc.request("thread/goal/get", { threadId })) as ThreadGoalGetResponse;
        return { command: "goal", notice: goalNotice(res.goal) };
      } catch (err) {
        throw driveError(err);
      }
    }
    if (cmd.action === "pause" || cmd.action === "clear") {
      // Stopping a goal changes only the thread's goal, so the thread is not taken over; refused
      // while another client's turn runs. The daemon's goal/updated or goal/cleared that follows
      // ends goalByUs.
      const d = this.driven.get(key);
      if (d?.starting) await d.starting;
      if (d && d.activeTurn !== null && !d.turns.has(d.activeTurn)) throw new DriveError(FOREIGN_TURN);
      if (!d && (await this.readTopLevel(rpc, key, threadId)).status.type === "active") throw new DriveError(FOREIGN_TURN);
      try {
        if (cmd.action === "clear") {
          const res = (await rpc.request("thread/goal/clear", { threadId, origin: "user" })) as ThreadGoalClearResponse;
          return { command: "goal", notice: res.cleared ? "Goal cleared" : "No goal to clear" };
        }
        const res = (await rpc.request("thread/goal/set", { threadId, origin: "user", status: "paused" })) as ThreadGoalSetResponse;
        return { command: "goal", notice: goalNotice(res.goal) };
      } catch (err) {
        throw noGoalError(err) ?? driveError(err);
      }
    }
    // A new objective replaces the goal there is, whatever its state: the TUI's "Replace goal?"
    // answered yes, which the user asked for every time (2026-11-16). It goes the TUI's way:
    // cleared, then set, so usage starts again at 0.
    let replacing = false;
    if (cmd.action === "set") {
      let current: ThreadGoal | null;
      try {
        current = ((await rpc.request("thread/goal/get", { threadId })) as ThreadGoalGetResponse).goal;
      } catch (err) {
        throw driveError(err);
      }
      replacing = current !== null;
    }
    // set or resume: the daemon pursues an active goal with turns of its own, so the thread is
    // held first and those turns count as this server's.
    const d = this.driven.get(key);
    if (d?.starting) await d.starting;
    if (d && d.activeTurn !== null && !d.turns.has(d.activeTurn)) throw new DriveError(FOREIGN_TURN);
    const held = d ? { d, took: false } : { d: await this.hold(rpc, key, account, threadId), took: true };
    const was = held.d.goalByUs;
    this.setGoal(held.d, true);
    // Resuming the thread (hold) makes the daemon send a snapshot of the goal, thread/goal/cleared
    // when there is none (measured 2026-11-16, 0.169.0), and it can arrive after this point. Until
    // the answer to goal/set, which comes after it on the same connection, goal notifications do
    // not decide whether the goal is ours: before this a snapshot ended goalByUs, the turn the
    // daemon started for the new goal was taken for another client's, and the thread was let go.
    held.d.goalSetting = true;
    try {
      if (replacing) await rpc.request("thread/goal/clear", { threadId, origin: "user" });
      const params = cmd.action === "set"
        ? { threadId, origin: "user" as const, objective: cmd.objective, status: "active" as const }
        : { threadId, origin: "user" as const, status: "active" as const };
      const res = (await rpc.request("thread/goal/set", params)) as ThreadGoalSetResponse;
      this.setGoal(held.d, res.goal.status === "active");
      return { command: "goal", notice: goalNotice(res.goal) };
    } catch (err) {
      this.setGoal(held.d, was);
      if (held.took) this.release(held.d, true);
      throw noGoalError(err) ?? driveError(err);
    } finally {
      held.d.goalSetting = false;
    }
  }

  /**
   * A copy of the thread up to and including turn `turnId` (daemon thread/fork with lastTurnId,
   * DESIGN.md 6q), that this server drives, chosen and in the source's project. The source is not
   * touched, a turn of it may run (the daemon refuses a turn still in progress as the last one).
   * Resolves with the new thread's key.
   */
  forkAt(key: string, turnId: string): Promise<string> {
    let account: CodexAccount;
    let threadId: string;
    try {
      ({ account, threadId } = this.parse(key));
    } catch (err) {
      return Promise.reject(err);
    }
    return this.serial(key, async () => {
      const rpc = await this.conn(account);
      await this.readTopLevel(rpc, key, threadId);
      return (await this.fork(rpc, key, account, threadId, turnId)).open!;
    });
  }

  /** A copy of the thread that this server drives, chosen and in the source's project; the UI opens it. */
  private async fork(rpc: CodexRpc, key: string, account: CodexAccount, threadId: string, lastTurnId: string | null = null): Promise<CommandResult> {
    if (lastTurnId === null) {
      const source = await this.readTopLevel(rpc, key, threadId);
      if (source.status.type === "active") throw new DriveError("Send /fork after the running turn ends");
    }
    let res: ThreadForkResponse;
    try {
      res = (await rpc.request("thread/fork", {
        threadId, ...(lastTurnId !== null ? { lastTurnId } : {}), excludeTurns: true, ...BYPASS_THREAD, config: START_CONFIG,
      })) as ThreadForkResponse;
    } catch (err) {
      throw driveError(err);
    }
    const forkId = res.thread.id;
    const forkKey = sessionKey("codex", account.id, forkId);
    // thread/fork subscribed this connection to the new thread.
    this.claim(forkKey, account, forkId, true);
    this.deps.chosen.set("codex", forkId, true);
    const projectId = this.deps.projects.projectOf("codex", threadId);
    if (projectId) {
      try {
        this.deps.projects.assign("codex", forkId, projectId);
      } catch {
        // The project was deleted meanwhile: the fork stays in 미분류.
      }
    }
    return { command: "fork", open: forkKey };
  }

  private async renameThread(key: string, account: CodexAccount, threadId: string, title: string): Promise<CommandResult> {
    if (this.deps.index.get(key)?.parentKey) throw new DriveError("Cannot rename a subagent thread. Rename the parent session");
    try {
      const res = await this.deps.rename({ provider: "codex", account: account.id, id: threadId, name: title });
      return { command: "rename", notice: `Renamed to "${res.name}"` };
    } catch (err) {
      throw new DriveError(errorMessage(err));
    }
  }

  /**
   * A new thread's history cannot be listed for a moment after its first turn/start
   * (thread/turns/list and thread/resume answer -32601 "list_turns is not supported yet"), and the
   * UI opens the thread right after session.created. Waits while that answer comes and the turn runs.
   */
  private async untilListable(rpc: CodexRpc, d: Driven, turnId: string): Promise<void> {
    for (;;) {
      try {
        await rpc.request("thread/turns/list", { threadId: d.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
        return;
      } catch (err) {
        if (!(err instanceof RpcError) || err.code !== METHOD_NOT_FOUND) return;
      }
      if (this.driven.get(d.key) !== d || d.activeTurn !== turnId) return;
      await new Promise((r) => setTimeout(r, this.deps.readyPollMs ?? 50));
    }
  }

  // ---- ownership ----

  private claim(key: string, account: CodexAccount, threadId: string, subscribed: boolean): Driven {
    const d = newDriven(key, account, threadId, subscribed);
    this.driven.set(key, d);
    this.deps.held?.hold(key);
    this.deps.owned.add(threadId);
    this.deps.ownerChanged(account.id, threadId);
    return d;
  }

  /** Let the thread go: its open questions end here, and the index shows it as another client's. */
  private release(d: Driven, unsubscribe: boolean): void {
    if (this.driven.get(d.key) !== d) return;
    this.driven.delete(d.key);
    this.deps.held?.drop(d.key);
    this.deps.owned.delete(d.threadId);
    this.emitThread(d.key, { type: "released" });
    const had = d.pending.size > 0;
    for (const p of [...d.pending.values()]) p.settle(NO_ANSWER);
    if (had) this.publish(d);
    this.deps.ownerChanged(d.account.id, d.threadId);
    if (unsubscribe) {
      void this.conns.get(d.account.id)
        ?.then((rpc) => rpc.request("thread/unsubscribe", { threadId: d.threadId }))
        .catch(() => {});
    }
  }

  // ---- the driver connection ----

  private conn(account: CodexAccount): Promise<CodexRpc> {
    let p = this.conns.get(account.id);
    if (!p) {
      const opened = this.open(account);
      p = opened;
      this.conns.set(account.id, opened);
      opened.catch(() => {
        if (this.conns.get(account.id) === opened) this.conns.delete(account.id);
      });
    }
    return p;
  }

  private async open(account: CodexAccount): Promise<CodexRpc> {
    // Default unhandledRequests "ignore": only the handlers below answer, and only for this server's turns.
    const rpc = new CodexRpc(account.home, { clientInfo: { name: "maru", title: null, version: "0.0.0" } });
    for (const method of ASK_METHODS) {
      rpc.onRequest(method, (params, ctx) => this.onAsk(account, method, params, ctx.id));
    }
    rpc.onRequest("item/tool/call", (params) => this.onToolCall(account, params));
    rpc.on("turn/started", (p) => this.onTurnStarted(account, p.threadId, p.turn.id, p.turn.rootTurnId));
    rpc.on("turn/completed", (p) => this.onTurnCompleted(account, p.threadId, p.turn.id));
    rpc.on("turn/completed", (p) => {
      const key = sessionKey("codex", account.id, p.threadId);
      if (!this.driven.has(key)) return;
      for (const l of [...this.turnEndListeners]) {
        try {
          l(key, p.turn);
        } catch (err) {
          console.error("codex runs: turn end listener threw", err);
        }
      }
    });
    // The daemon records a sent message as a userMessage item carrying its clientUserMessageId.
    rpc.on("item/started", (p) => {
      if (p.item.type !== "userMessage" || !p.item.clientId) return;
      const key = sessionKey("codex", account.id, p.threadId);
      if (this.driven.has(key)) this.emitThread(key, { type: "userMessage", clientId: p.item.clientId });
    });
    rpc.on("thread/status/changed", (p) => this.onStatus(account, p));
    rpc.on("thread/status/changed", (p) => {
      // After onStatus: a status that let the thread go has removed it from `driven` by now.
      const key = sessionKey("codex", account.id, p.threadId);
      if (!this.driven.has(key)) return;
      for (const l of [...this.statusListeners]) {
        try {
          l(key, p.status);
        } catch (err) {
          console.error("codex runs: status listener threw", err);
        }
      }
    });
    // A goal that stopped being active (paused, complete, limited, cleared) starts no more turns.
    rpc.on("thread/goal/updated", (p) => {
      const d = this.driven.get(sessionKey("codex", account.id, p.threadId));
      if (d && !d.goalSetting && p.goal.status !== "active") this.setGoal(d, false);
    });
    rpc.on("thread/goal/cleared", (p) => {
      const d = this.driven.get(sessionKey("codex", account.id, p.threadId));
      if (d && !d.goalSetting) this.setGoal(d, false);
    });
    rpc.on("thread/closed", (p) => {
      const d = this.driven.get(sessionKey("codex", account.id, p.threadId));
      if (d?.subscribed) this.release(d, false);
    });
    for (const gone of ["thread/archived", "thread/deleted"] as const) {
      rpc.on(gone, (p) => {
        const d = this.driven.get(sessionKey("codex", account.id, p.threadId));
        if (d) this.release(d, false);
      });
    }
    rpc.on("serverRequest/resolved", (p) => {
      const d = this.driven.get(sessionKey("codex", account.id, p.threadId));
      const pending = d?.pending.get(String(p.requestId));
      if (!d || !pending) return;
      // Answered by another client, or cleared by the daemon (interrupt, turn end).
      pending.settle(NO_ANSWER);
      this.publish(d);
    });
    let first = true;
    rpc.onConnected(() => {
      if (first) {
        first = false;
        return;
      }
      void this.rejoin(account, rpc);
    });
    rpc.onDisconnected(() => {
      // Requests belong to the connection; the daemon sends a pending one again after rejoin.
      for (const d of this.driven.values()) {
        if (d.account.id !== account.id || d.pending.size === 0) continue;
        for (const p of [...d.pending.values()]) p.settle(NO_ANSWER);
        this.publish(d);
      }
    });
    if (!(await rpc.start())) {
      const reason = rpc.stats().lastError ?? "connect failed";
      await rpc.close();
      throw new DriveError(`Could not connect to the Codex daemon for account ${account.id} (${reason})`);
    }
    return rpc;
  }

  /** A new connection after a drop: subscribe to the driven threads again, and let go of any another client took. */
  private async rejoin(account: CodexAccount, rpc: CodexRpc): Promise<void> {
    for (const d of [...this.driven.values()]) {
      if (d.account.id !== account.id) continue;
      try {
        await rpc.request("thread/resume", { threadId: d.threadId, excludeTurns: true });
        const page = (await rpc.request("thread/turns/list", {
          threadId: d.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
        })) as ThreadTurnsListResponse;
        const newest = page.data[0];
        if (newest && newest.status === "inProgress") {
          if (!d.turns.has(newest.id)) {
            this.release(d, true);
            continue;
          }
          d.activeTurn = newest.id;
        } else {
          // A turn that ended while the connection was down sent its turn/completed to no one.
          if (d.activeTurn !== null) this.emitThread(d.key, { type: "turnCompleted", turnId: d.activeTurn });
          d.activeTurn = null;
        }
      } catch {
        this.release(d, false);
      }
    }
  }

  private onTurnStarted(account: CodexAccount, threadId: string, turnId: string, rootTurnId: string | null): void {
    const d = this.driven.get(sessionKey("codex", account.id, threadId));
    if (!d) return;
    d.activeTurn = turnId;
    if (d.turns.has(turnId)) return;
    const decide = () => {
      if (this.driven.get(d.key) === d && !this.claimTurn(d, turnId, rootTurnId)) this.release(d, true);
    };
    // The notification can come before the answer that names the turn (turn/start, review/start).
    if (d.starting) void d.starting.then(decide);
    else decide();
  }

  /** Whether a turn the driver connection saw start is this server's; adds it to `d.turns` when it is. */
  private claimTurn(d: Driven, turnId: string, rootTurnId: string | null): boolean {
    if (d.turns.has(turnId)) return true;
    // A review works in an inner turn under the turn review/start answered with.
    if (rootTurnId !== null && d.turns.has(rootTurnId)) {
      this.ownTurn(d, turnId);
      d.rootOf.set(turnId, rootTurnId);
      return true;
    }
    if (d.adoptNext) {
      d.adoptNext = false;
      this.ownTurn(d, turnId);
      return true;
    }
    if (d.goalByUs) {
      this.ownTurn(d, turnId);
      return true;
    }
    return false;
  }

  /** A turn of this server on the thread; kept for a restart until it ends. */
  private ownTurn(d: Driven, turnId: string): void {
    d.turns.add(turnId);
    // A turn/completed that came before the turn/start answer already ended it.
    if (this.driven.get(d.key) === d && d.lastEnded !== turnId) this.deps.held?.addTurn(d.key, turnId);
  }

  private setGoal(d: Driven, on: boolean): void {
    d.goalByUs = on;
    if (this.driven.get(d.key) === d) this.deps.held?.setGoal(d.key, on);
  }

  private onTurnCompleted(account: CodexAccount, threadId: string, turnId: string): void {
    const d = this.driven.get(sessionKey("codex", account.id, threadId));
    if (!d) return;
    this.emitThread(d.key, { type: "turnCompleted", turnId });
    d.lastEnded = turnId;
    if (d.activeTurn !== null && (d.activeTurn === turnId || d.rootOf.get(d.activeTurn) === turnId)) d.activeTurn = null;
    this.deps.held?.endTurn(d.key, turnId);
    for (const [inner, root] of d.rootOf) {
      if (root !== turnId && inner !== turnId) continue;
      d.rootOf.delete(inner);
      this.deps.held?.endTurn(d.key, inner);
    }
    let changed = false;
    for (const p of [...d.pending.values()]) {
      if (p.turnId !== turnId) continue;
      p.settle(NO_ANSWER);
      changed = true;
    }
    if (changed) this.publish(d);
  }

  private onStatus(account: CodexAccount, p: NotificationParams<"thread/status/changed">): void {
    const d = this.driven.get(sessionKey("codex", account.id, p.threadId));
    if (!d) return;
    if (p.status.type === "notLoaded") {
      if (d.subscribed) this.release(d, false);
    } else if (p.status.type === "idle") {
      d.activeTurn = null;
    }
  }

  // ---- server requests ----

  private onAsk(account: CodexAccount, method: AskMethod, params: ServerRequestParams<AskMethod>, id: RequestId): unknown {
    const turnId = (params as { turnId?: string | null }).turnId ?? null;
    const d = this.driven.get(sessionKey("codex", account.id, params.threadId));
    if (!d) return NO_ANSWER;
    const decide = (): unknown => {
      if (this.driven.get(d.key) !== d || !this.isOwnTurn(d, turnId)) return NO_ANSWER;
      return this.ask(d, method, params, id, turnId);
    };
    // A request can come before the turn/start answer that names its turn, or while a restore is
    // still deciding whose turn runs (retake); one with no turn waits as well.
    if (d.starting && (turnId === null || !d.turns.has(turnId))) return d.starting.then(decide);
    return decide();
  }

  private onToolCall(account: CodexAccount, params: DynamicToolCallParams): unknown {
    const d = this.driven.get(sessionKey("codex", account.id, params.threadId));
    if (!d) return NO_ANSWER;
    const decide = (): unknown => {
      if (this.driven.get(d.key) !== d || !d.turns.has(params.turnId)) return NO_ANSWER;
      const name = params.namespace ? `${params.namespace}.${params.tool}` : params.tool;
      return { contentItems: [{ type: "inputText", text: `maru does not provide the dynamic tool ${name}.` }], success: false };
    };
    if (d.starting && !d.turns.has(params.turnId)) return d.starting.then(decide);
    return decide();
  }

  /** turnId null: an MCP elicitation the daemon could not tie to a turn, taken as part of this server's running turn. */
  private isOwnTurn(d: Driven, turnId: string | null): boolean {
    if (turnId !== null) return d.turns.has(turnId);
    return d.activeTurn !== null && d.turns.has(d.activeTurn);
  }

  private ask(d: Driven, method: AskMethod, params: unknown, id: RequestId, turnId: string | null): Promise<unknown> {
    const requestId = String(id);
    const a = askView(method, params, requestId);
    return new Promise<unknown>((resolve) => {
      const settle = (result: unknown): void => {
        if (d.pending.get(requestId)?.settle !== settle) return;
        d.pending.delete(requestId);
        resolve(result);
      };
      d.pending.get(requestId)?.settle(NO_ANSWER);
      d.pending.set(requestId, { ...a, turnId, settle });
      this.publish(d);
    });
  }

  private publish(d: Driven): void {
    this.deps.broadcast({ type: "session.pending", key: d.key, questions: [...d.pending.values()].map((p) => p.view) });
  }

  // ---- helpers ----

  private parse(key: string): { account: CodexAccount; threadId: string } {
    const m = KEY_RE.exec(key);
    if (!m) throw new DriveError(`Not a Codex session key: ${key}`);
    return { account: this.account(m[1]!), threadId: m[2]! };
  }

  private account(id: string): CodexAccount {
    const a = this.deps.accounts.find((x) => x.id === id);
    if (!a) throw new DriveError(`Unknown account: ${id}`);
    return a;
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => {}, () => {});
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }
}

function newDriven(key: string, account: CodexAccount, threadId: string, subscribed: boolean): Driven {
  return {
    key, account, threadId,
    turns: new Set(), activeTurn: null, lastEnded: null, starting: null, subscribed, pending: new Map(),
    adoptNext: false, goalByUs: false, goalSetting: false, rootOf: new Map(),
  };
}

// ---- questions and approvals: daemon request -> UI view, UI answer -> daemon result ----

/**
 * The UI form for a request (PendingQuestionView in packages/shared).
 * request_user_input   kind "question": input.questions [{question, header, options, multiSelect}].
 *                      The UI keys answers by question text, so equal texts are made distinct.
 * approvals, elicitation  kind "approval": answered { decision: "approve" | "reject" }.
 */
export function askView(method: AskMethod, params: unknown, requestId: string): CodexAsk {
  const questionIds = new Map<string, string>();
  const base = (toolName: string, toolUseId: string, kind: PendingQuestionView["kind"], input: Record<string, unknown>, title: string | null, description: string | null): CodexAsk => ({
    method, params, questionIds,
    view: { requestId, toolUseId, toolName, kind, input, title, description },
  });
  switch (method) {
    case "item/tool/requestUserInput": {
      const p = params as ServerRequestParams<"item/tool/requestUserInput">;
      const questions = p.questions.map((q) => {
        const first = q.question || q.header || q.id;
        let text = first;
        if (questionIds.has(text) && q.header) text = `${q.header}: ${first}`;
        for (let n = 2; questionIds.has(text); n++) text = `${first} (${n})`;
        questionIds.set(text, q.id);
        return {
          question: text,
          header: q.header,
          multiSelect: false,
          options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
          isOther: q.isOther,
          isSecret: q.isSecret,
        };
      });
      return base("request_user_input", p.itemId, "question", { questions }, null, null);
    }
    case "item/commandExecution/requestApproval": {
      const p = params as ServerRequestParams<"item/commandExecution/requestApproval">;
      const target = p.networkApprovalContext
        ? `${p.networkApprovalContext.protocol}://${p.networkApprovalContext.host}`
        : (p.command ?? "");
      const description = lines([target, p.cwd ? `cwd: ${p.cwd}` : null, p.reason ?? null]);
      const title = p.networkApprovalContext ? "Allow network access?" : "Allow running the command?";
      return base("commandExecution", p.itemId, "approval", p as unknown as Record<string, unknown>, title, description);
    }
    case "item/fileChange/requestApproval": {
      const p = params as ServerRequestParams<"item/fileChange/requestApproval">;
      const description = lines([p.reason ?? null, p.grantRoot ? `Write scope: ${p.grantRoot}` : null]);
      return base("fileChange", p.itemId, "approval", p as unknown as Record<string, unknown>, "Allow the file change?", description);
    }
    case "item/permissions/requestApproval": {
      const p = params as ServerRequestParams<"item/permissions/requestApproval">;
      const description = lines([p.reason, `Request: ${JSON.stringify(p.permissions)}`, `cwd: ${p.cwd}`]);
      return base("permissions", p.itemId, "approval", p as unknown as Record<string, unknown>, "Allow the permission?", description);
    }
    case "mcpServer/elicitation/request": {
      const p = params as ServerRequestParams<"mcpServer/elicitation/request">;
      const description = lines([p.message, p.mode === "url" ? p.url : null]);
      return base(`mcp:${p.serverName}`, p.mode === "url" ? p.elicitationId : "", "approval", p as unknown as Record<string, unknown>, `Allow the ${p.serverName} request?`, description);
    }
  }
}

/** The daemon result for the UI's answer. Throws DriveError for an approval without a valid decision. */
export function askResult(ask: CodexAsk, answers: Record<string, string>): unknown {
  if (ask.method === "item/tool/requestUserInput") {
    const out: Record<string, { answers: string[] }> = {};
    for (const [text, id] of ask.questionIds) {
      const a = answers[text]?.trim();
      out[id] = { answers: a ? [a] : [] };
    }
    return { answers: out };
  }
  const decision = answers.decision;
  if (decision !== "approve" && decision !== "reject") {
    throw new DriveError(`decision must be "approve" or "reject": ${JSON.stringify(decision)}`);
  }
  const approve = decision === "approve";
  switch (ask.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: approve ? "accept" : "decline" };
    case "item/permissions/requestApproval": {
      const p = ask.params as ServerRequestParams<"item/permissions/requestApproval">;
      const granted = approve
        ? { ...(p.permissions.network ? { network: p.permissions.network } : {}), ...(p.permissions.fileSystem ? { fileSystem: p.permissions.fileSystem } : {}) }
        : {};
      return { permissions: granted, scope: "turn" };
    }
    case "mcpServer/elicitation/request": {
      const p = ask.params as ServerRequestParams<"mcpServer/elicitation/request">;
      if (!approve) return { action: "decline", content: null, _meta: null };
      return { action: "accept", content: p.mode === "url" ? null : {}, _meta: null };
    }
  }
}

function lines(parts: Array<string | null>): string | null {
  const s = parts.filter((x): x is string => typeof x === "string" && x !== "").join("\n");
  return s === "" ? null : s;
}

function textInput(text: string): UserInput[] {
  return [{ type: "text", text, text_elements: [] }];
}

/** The daemon's refusal of a pause or resume with no goal, in the words /goal uses for a thread with none. */
function noGoalError(err: unknown): DriveError | null {
  return err instanceof RpcError && /no goal exists/.test(err.message) ? new DriveError(goalNotice(null)) : null;
}

function driveError(err: unknown): Error {
  if (err instanceof DriveError) return err;
  if (err instanceof RpcTransportError) return new DriveError(`Codex daemon connection lost (${err.message})`);
  if (err instanceof RpcError) return new DriveError(`Codex daemon refused: ${err.message}`);
  return new DriveError(errorMessage(err));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
