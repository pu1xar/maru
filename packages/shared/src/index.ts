// Contract shared by the server and the web UI. The UI only knows these types, never a
// provider's own record format.

export type ProviderId = "claude" | "codex";

/** Account label, e.g. "claude-work". The id an account has in the server config (config.json). */
export type AccountId = string;

/**
 * running        a turn is in progress
 * waiting-input  the agent asked a question (Claude `waiting`, Codex waitingOnUserInput/Approval)
 * open-idle      a process holds the session but no turn is running
 * closed         no process holds the session
 * error          the provider reports a failed state (Codex systemError)
 */
export type UnifiedStatus = "running" | "waiting-input" | "open-idle" | "closed" | "error";

/**
 * Who may write to the session (DESIGN.md 4.2).
 * terminal  a process this server did not start holds it: read-only in the UI
 * ui        a process this server started holds it
 * none      closed: the UI may resume it and become the owner
 */
export type Owner = "terminal" | "ui" | "none";

export interface SessionSummary {
  /** `${provider}:${account}:${id}` */
  key: string;
  provider: ProviderId;
  account: AccountId;
  id: string;
  cwd: string | null;
  /**
   * Name the user gave: maru's own name for the session when it has one, else the provider's
   * (Claude custom-title, Codex threads.name). Filled by the server (state/sessionNames.ts).
   */
  name: string | null;
  /** The provider's own user name (Claude custom-title, Codex threads.name), before maru's name is laid over it. Filled by the server. */
  providerName?: string | null;
  /** Generated title (Claude ai-title, Codex title). */
  title: string | null;
  /** First meaningful user prompt. */
  preview: string | null;
  status: UnifiedStatus;
  owner: Owner;
  /** pid of the process that holds the session, when known. */
  pid: number | null;
  /** tmux pane id like "%4" for a terminal session, when known. */
  tmuxPane: string | null;
  /** Parent session key for subagent threads. */
  parentKey: string | null;
  /** Last activity, ms since epoch. */
  updatedAt: number;
  createdAt: number | null;
  sizeBytes: number | null;
  /** Claude entrypoint (cli, sdk-ts, ...) or Codex originator/source. */
  entrypoint: string | null;
  /** User-assigned project (DESIGN.md 6c). null = 미분류. Filled by the server, not providers. */
  projectId?: string | null;
  /** Order inside its project, smaller first (DESIGN.md 6c). Filled by the server; null for a subagent thread. */
  position?: number | null;
  /**
   * Order inside 고정됨, smaller first; null when not pinned (DESIGN.md 6c). A pinned session keeps
   * `projectId` and `position` and shows in its project too. Filled by the server; null for a subagent thread.
   */
  pinPosition?: number | null;
  /**
   * When the user moved the session to 보관함 (ms since epoch, DESIGN.md 6d); null or absent when it
   * is not archived. An archived session stays on the list and keeps its `projectId`, `position` and
   * `pinPosition`, which the sidebar ignores while it is archived. Filled by the server; null for a
   * subagent thread.
   */
  archivedAt?: number | null;
  /** Delete lock (DESIGN.md 6, 잠금): the session is in the user's list (the sidebar, archive included), so it cannot be deleted. Filled by the server. */
  locked?: boolean;
  /**
   * Tasks (subagents, workflows, shell commands) still running in the background of the process
   * this server runs for the session (DESIGN.md 4.3). Such a session shows `status` "open-idle"
   * once its turn ended, though its process is still at work. Present only for a Claude session
   * this server runs; filled by the server.
   */
  backgroundTasks?: number;
  /**
   * Of `backgroundTasks`, the subagents and workflows (shell commands left out). The UI shows a
   * session whose turn ended while these run as working (DESIGN.md 4.3). Filled with backgroundTasks.
   */
  backgroundAgents?: number;
}

/** Permission modes the UI may switch a Claude session to (`thread.setPermissionMode`). */
export const SETTABLE_PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
export type SettablePermissionMode = (typeof SETTABLE_PERMISSION_MODES)[number];

/** A user-defined project. Sessions are assigned by hand; folders do not decide membership. */
export interface Project {
  id: string;
  name: string;
  /** Default cwd for a new session created in this project; can be changed per session. */
  defaultCwd: string | null;
  sortOrder: number;
  createdAt: number;
}

/** Assignment key: provider and session id without the account, so a move between accounts keeps it. */
export function assignmentKey(provider: ProviderId, id: string): string {
  return `${provider}:${id}`;
}

export type IndexEvent =
  | { type: "upsert"; session: SessionSummary }
  | { type: "remove"; key: string };

/** A provider's live session index. */
export interface SessionSource {
  readonly provider: ProviderId;
  /** Load the current sessions, emit them as upserts, then keep emitting changes. */
  start(emit: (e: IndexEvent) => void): Promise<void>;
  stop(): Promise<void>;
}

export function sessionKey(provider: ProviderId, account: AccountId, id: string): string {
  return `${provider}:${account}:${id}`;
}

/**
 * The name the list shows for a session: the name the user gave, else the generated title, else
 * the first prompt, else the start of its id. The web's list, the dashboard and the push
 * notifications use this one rule.
 */
export function sessionDisplayName(s: Pick<SessionSummary, "name" | "title" | "preview" | "id">): string {
  return s.name || s.title || s.preview || s.id.slice(0, 8);
}

// ---- HTTP and WebSocket messages ----

export interface ListSessionsResponse {
  sessions: SessionSummary[];
  generatedAt: number;
}

/**
 * Server -> UI over /ws. Sessions are only the ones the user chose (DESIGN.md 6d) and the
 * subagent threads under them; `hello` and `index` never carry the rest of the scan.
 * `projects` always carries the full ordered list.
 * Thread messages answer a `thread.subscribe`: one snapshot, then batches of live events.
 * A thread id is a session key; a subagent transcript is `<session key>:agent-<agentId>`.
 */
export type ServerMessage =
  /**
   * After every connect. `version` is the server's (version.ts, DESIGN.md 2c), so a page built for
   * another version learns that the server changed under it. Null when the server cannot read it.
   */
  | {
      type: "hello";
      sessions: SessionSummary[];
      projects: Project[];
      /** The folded sidebar folders (`SetGroupFolded`); absent from a server built before they were kept there. */
      foldedGroups?: string[];
      version?: string | null;
      /** The server clock (epoch ms) at connect, so clock-relative displays (the prompt cache clock) need no matching client clock. */
      serverTime?: number;
    }
  /** Account usage gauges (usage.ts), after hello and on every change. */
  | import("./usage.ts").UsageMessage
  | { type: "index"; event: IndexEvent }
  | { type: "projects"; projects: Project[] }
  /** The folded sidebar folders after a change: the full list, so a client replaces what it holds. */
  | { type: "foldedGroups"; keys: string[] }
  | { type: "thread.snapshot"; snapshot: ThreadSnapshot }
  /** Older rows for a windowed subscriber (threadWindow.ts), or new positions after another reader's request. */
  | { type: "thread.older"; older: import("./threadWindow.ts").ThreadOlder }
  /** The answer to a `thread.subscribe` with `have`: the window minus the rows the client holds (threadWindow.ts, DESIGN.md 6r). */
  | { type: "thread.resumed"; resumed: import("./threadWindow.ts").ThreadResumed }
  | { type: "thread.events"; threadId: string; events: ThreadLiveEvent[] }
  /** The answer to `thread.search` (threadSearch.ts, DESIGN.md 6u). */
  | { type: "thread.searchResult"; result: import("./threadSearch.ts").ThreadSearchResult }
  | { type: "thread.error"; threadId: string; error: string }
  /** Questions a UI-driven session waits on (full list for that session; empty when none). */
  | { type: "session.pending"; key: string; questions: PendingQuestionView[] }
  /**
   * The calls of a session this server runs that its CLI holds as foreground tasks, by tool_use id:
   * what `thread.background` (Ctrl+B) can move (DESIGN.md 4.5). A Bash command joins after 2 s of
   * running (the CLI registers it then), an Agent call as it starts. Full list for that session;
   * empty when none. Sent after hello for every session with some and on every change.
   */
  | { type: "session.foreground"; key: string; toolUseIds: string[] }
  /** Messages sent to a session that the model has not taken in yet (pendingSends.ts). */
  | import("./pendingSends.ts").PendingSendsMessage
  | import("./pendingSends.ts").RecalledMessage
  /** Answer to a session.create: the new session's key once the CLI reported its id. */
  | { type: "session.created"; reqId: string; key: string; nameError?: string }
  /**
   * A drive command failed (send, interrupt, answer, create). For a refused `thread.send`,
   * `unsent` and `unsentAttachments` carry what did not go (the attachments the server still has),
   * and the composer puts them back while it is still empty (as command.result `unsent`).
   */
  | {
      type: "command.error"; reqId?: string; threadId?: string; error: string;
      unsent?: string; unsentAttachments?: import("./attachments.ts").UploadedAttachment[];
    }
  | import("./commands.ts").CommandResultMessage
  /** The Claude session host's state (sessionHost.ts), after hello and on every change. */
  | { type: "sessionHost"; status: import("./sessionHost.ts").SessionHostStatus };

/**
 * A question from a session this server drives (DESIGN.md 3.1 canUseTool).
 * question  AskUserQuestion: answer with { [question text]: chosen label }
 * plan      ExitPlanMode, approval  another ask: answer with { decision: "approve" | "reject", feedback? }
 */
export interface PendingQuestionView {
  requestId: string;
  toolUseId: string;
  toolName: string;
  kind: "question" | "plan" | "approval";
  input: Record<string, unknown>;
  title: string | null;
  description: string | null;
}

/** UI -> server over /ws. */
export type ClientMessage =
  /**
   * `rows`: a windowed subscription (threadWindow.ts, DESIGN.md 6r). The snapshot holds the newest
   * `rows` conversation rows, live events stay inside the window, and `thread.loadOlder` answers
   * with `thread.older`. Without it the snapshot holds every row the server has read (the first
   * page: `pageSize` lines of a Claude transcript or turns of a Codex thread) and `thread.loadOlder`
   * answers with a new snapshot.
   * `have` (with `rows`): the rows the client kept from an earlier visit of this thread. The
   * answer is `thread.resumed` (the window from the client's first row, with the rows it lacks or
   * holds changed), or the usual snapshot when the server cannot place that first row (DESIGN.md 6r).
   */
  | { type: "thread.subscribe"; threadId: string; pageSize?: number; rows?: number; have?: import("./threadWindow.ts").ThreadHave }
  | { type: "thread.unsubscribe"; threadId: string }
  /**
   * Older history: `rows` more conversation rows for a windowed subscription, else the previous page.
   * `until` (windowed): an item id the window must reach, for a find that steps to an item the
   * client does not hold yet (DESIGN.md 6u). The window then grows to that item's conversation row
   * or `rows` more, whichever is more; an item the thread does not have leaves the window as it is.
   */
  | { type: "thread.loadOlder"; threadId: string; rows?: number; until?: string }
  /**
   * Find in a thread this socket subscribes to (threadSearch.ts, DESIGN.md 6u): every matching item
   * of the whole thread, also the rows the client does not hold. Answered with `thread.searchResult`.
   */
  | { type: "thread.search"; threadId: string; query: string; reqId: string }
  // Drive commands (M2). threadId is a top-level session key.
  /**
   * Next user message: a UI-driven session gets it at once, a closed one is resumed with it.
   * `attachments` are upload ids (attachments.ts, POST /api/attachments); the text may then be
   * empty. A paired device's connection may not send attachments (DESIGN.md 6n). It shows in
   * `session.queued` until the model has taken it in (pendingSends.ts).
   */
  | { type: "thread.send"; threadId: string; text: string; attachments?: string[]; reqId?: string }
  /** Take queued messages back into the composer (pendingSends.ts). */
  | import("./pendingSends.ts").ThreadRecall
  | { type: "thread.interrupt"; threadId: string; reqId?: string }
  /**
   * Send foreground work to the background, as Ctrl+B does in the Claude Code CLI (DESIGN.md 4.5).
   * `toolUseId` names one Bash or Agent call (the id in the tool's item id); without it every
   * foreground task goes. Each blocked tool call then returns "running in the background" and the
   * turn goes on. Answered with `command.result` (`command: "background"`, a `notice` saying what
   * moved) or, when nothing moved, `command.error` with the reason: a Codex session (the daemon has
   * no such call), a session this server does not run, no turn running, nothing in the foreground,
   * or the CLI refusing (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).
   */
  | { type: "thread.background"; threadId: string; toolUseId?: string; reqId?: string }
  /**
   * "Send now" for the messages that wait in a running Claude turn (DESIGN.md 4.4): foreground
   * tasks go to the background, then each waiting message is taken out of the CLI's queue and sent
   * again with priority now, which cuts the call the turn waits on and runs the messages as a new
   * turn. When the foreground tasks cannot move, the turn is interrupted and the messages run
   * next. Answered with `command.result` (`command: "sendNow"`,
   * `sendNow` carrying the outcome, `notice` the words) or `command.error` (a Codex session, a
   * session this server does not run). Nothing to move is a result, not an error.
   */
  | { type: "thread.sendNow"; threadId: string; reqId?: string }
  /**
   * End what this server holds for the session: a Claude process ends (a running turn is
   * interrupted); a Codex thread is let go (this server's running turn is interrupted) and the
   * daemon unloads it once no client is subscribed.
   */
  | { type: "thread.close"; threadId: string; reqId?: string }
  /**
   * Switch the permission mode of the Claude process this server runs for the session. The new
   * mode reaches every subscriber as the thread's `state.permissionMode` (snapshot, thread.patched);
   * a failure, a Codex session or a session this server does not run answers command.error.
   */
  | { type: "thread.setPermissionMode"; threadId: string; mode: SettablePermissionMode; reqId?: string }
  | { type: "thread.answer"; threadId: string; requestId: string; answers: Record<string, string>; reqId?: string }
  /** Model, effort, permission mode, fast mode, output style or an MCP server (sessionControls.ts). */
  | import("./sessionControls.ts").ThreadConfigure
  /** A new session; it joins the list (and the project) on its own. */
  | { type: "session.create"; reqId: string; provider: ProviderId; account: string; cwd: string; prompt: string; projectId: string | null; model?: string; name?: string };

/** GET /api/accounts: accounts a new session can run under (labels only). */
export interface AccountInfo { id: string; provider: ProviderId }

export function subagentThreadId(sessionKey: string, agentId: string): string {
  return `${sessionKey}:agent-${agentId}`;
}

// HTTP (JSON bodies; errors are { error: string } with a 4xx status)
//   GET    /api/projects                      -> { projects: Project[] }
//   POST   /api/projects        CreateProject -> { project: Project }
//   PATCH  /api/projects/:id    UpdateProject -> { project: Project }
//   DELETE /api/projects/:id                  -> { ok: true }   (its sessions become 미분류)
//   POST   /api/projects/order  { ids }       -> { projects: Project[] }
//   PUT    /api/session-project AssignSession -> { ok: true }
//   PUT    /api/session-order   PlaceSessions -> { ok: true }
//   PUT    /api/session-pin     PinSession    -> { ok: true }   pin at the bottom of 고정됨, or unpin
//   PUT    /api/session-pins    PinSessions   -> { ok: true }   order 고정됨
//   PUT    /api/session-chosen  ChooseSession -> { ok: true }   add to / remove from the list
//   PUT    /api/session-archive ArchiveSession -> { ok: true }  move to / take out of 보관함
//   PUT    /api/group-fold      SetGroupFolded -> { ok: true }  fold or unfold one sidebar folder
//   POST   /api/group-fold/import ImportGroupFolds -> { imported: boolean, keys: string[] }  a client's older stored folds, taken once
//   GET    /api/session-candidates?q=&offset=&limit= -> SessionCandidates (sessions not in the list)
//   PUT    /api/session-name    RenameSession -> RenameSessionResult (DESIGN.md 6, 이름 변경)
//          400 bad request (provider, id, empty name, unknown account), 404 no such session,
//          409 refused (a process holds the session, a subagent thread), 502 the Codex daemon failed
export interface CreateProject { name: string; defaultCwd?: string | null }
export interface UpdateProject { name?: string; defaultCwd?: string | null }
export interface AssignSession { provider: ProviderId; id: string; projectId: string | null }
/**
 * PUT /api/session-order: these `provider:id` keys into a project (null = 미분류) in this order, top first.
 * Pins stay as they are.
 */
export interface PlaceSessions { projectId: string | null; keys: string[] }
/** PUT /api/session-pin: pinned true adds the session at the bottom of 고정됨, false takes it out. */
export interface PinSession { provider: ProviderId; id: string; pinned: boolean }
/** PUT /api/session-pins: these `provider:id` keys into 고정됨 in this order, top first; other pins keep their places. */
export interface PinSessions { keys: string[] }
/** PUT /api/session-archive: archived true moves the session to 보관함, false takes it out (back to its Group and pin). */
export interface ArchiveSession { provider: ProviderId; id: string; archived: boolean }
/**
 * PUT /api/group-fold: one folder folded or unfolded. `key` is the sidebar folder's fold key
 * (`pinned`, `unassigned`, `project:<id>`, or `archive:open` for an open 보관함, which starts folded).
 * The server merges one key at a time, so two clients changing different folders never undo each other.
 */
export interface SetGroupFolded { key: string; folded: boolean }
/** POST /api/group-fold/import: the folds a client kept before the server held them. Taken only while the server holds none and none was ever set. */
export interface ImportGroupFolds { keys: string[] }
export interface ChooseSession { provider: ProviderId; id: string; chosen: boolean }
export interface SessionCandidates { sessions: SessionSummary[]; total: number; offset: number }
/** `name` is trimmed; the session's own store keeps it, so the terminal tools show it too. */
export interface RenameSession { provider: ProviderId; account: AccountId; id: string; name: string }
/**
 * Where the name was written.
 * maru        only maru's own name row (the session is open in a process that could write its old name back)
 * transcript  maru, and Claude: custom-title and agent-name lines appended to the transcript
 * daemon      maru, and Codex: the app-server daemon's thread/name/set
 * direct      maru, and Codex without a daemon that knows the thread: threads.name and session_index.jsonl
 * `notice` is set when the provider's own name was left as it was.
 */
export interface RenameSessionResult { ok: true; name: string; stored: "maru" | "transcript" | "daemon" | "direct"; notice?: string }

export * from "./turnItems.ts";
export * from "./goal.ts";
export * from "./promptCache.ts";
import type { ThreadLiveEvent, ThreadSnapshot } from "./turnItems.ts";
export * from "./files.ts";
export * from "./agents.ts";
export * from "./usage.ts";
export * from "./dashboard.ts";
export * from "./sessionManage.ts";
export * from "./commands.ts";
export * from "./sessionHost.ts";
export * from "./devices.ts";
export * from "./desktop.ts";
export * from "./sessionControls.ts";
export * from "./pendingSends.ts";
export * from "./attachments.ts";
export * from "./viewedImages.ts";
export * from "./version.ts";
export * from "./pendingAnswers.ts";
export * from "./newSession.ts";
export * from "./rewind.ts";
export * from "./fork.ts";
export * from "./oneMillion.ts";
export * from "./threadWindow.ts";
export * from "./shell.ts";
export * from "./threadSearch.ts";
export * from "./bonFont.ts";
export * from "./themeColors.ts";
export * from "./messageText.ts";
export * from "./accounts.ts";
export * from "./folderMatch.ts";
