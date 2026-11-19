// Projection state machine for one Claude transcript (a session file or one subagent file):
// raw records in, T3-shaped turn items and side records out (docs/event-model.md).
//
// Records arrive in pages. The first page is the tail of the file; `prepend` adds older pages as
// the UI scrolls up, and `push` adds lines as they are written. A page boundary can cut a turn or
// a tool_use/tool_result pair, so the projection is a fold over the loaded lines in file order:
//   - extract.ts turns each line into facts that depend on that line alone (kept per line)
//   - the fold applies them in file order: tool results merge into their tool item, meta lines
//     write thread state, openers start runs, and so on
//   - `push` continues the fold from where it stands and reports what changed as live events
//   - `prepend` refolds every loaded line from the start; ids are deterministic, so items that
//     were already shown keep their ids and a result that waited for its tool_use (7.1 6) joins it
// After a refold the projection equals a projection of the same lines read in one piece.
import type {
  OrchestrationV2AppThreadLineage,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2Subagent,
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemStatus,
  OrchestrationV2PlanStep,
  ProjectionExtension,
  RawRef,
  SessionChosen,
  ThreadBranches,
  ThreadGoalState,
  ThreadLiveEvent,
  ThreadProjectionState,
  ThreadRunSummary,
  ThreadRuntimeSummary,
  ThreadSnapshot,
  ThreadTokenUsageSnapshot,
  UserInputAttachmentAnswerPayload,
} from "@maru/shared";
import type { RawRecord } from "../../transcript/claudeTranscript.ts";
import {
  claudeCommandOutputText,
  claudeFileChangeText,
  claudeSubagentResultText,
  claudeToolOutputValue,
  isClaudeSubagentAsyncLaunchAck,
  webFetchResultFromClaudeOutput,
  webSearchPatternsFromClaudeTool,
  webSearchResultsFromClaudeOutput,
} from "./claudeTools.ts";
import type { ToolOutput } from "./claudeTools.ts";
import { claudeContextWindow } from "./claudeModels.ts";
import { oneMillionModelOf, PROMPT_CACHE_TTL_5M_MS, promptCacheTtlOf } from "@maru/shared";
import { extractLine, notificationOutcome, rec, siblingThreadId, str } from "./extract.ts";
import { chooseGoal, lastEventAt, reduceGoal, type GoalEvent, type LiveGoal } from "./goalState.ts";
import type { Disposition, ExtractCtx, ItemTemplate, LineFacts, NotificationTags, Op, StatePatch, StepUsage, ToolKind } from "./extract.ts";
import { computeLanes } from "./lanes.ts";
import type { LaneFork, LaneNode } from "./lanes.ts";
import type { RewindMarker } from "../rewindScan.ts";
import {
  agentMetrics,
  carryAgentMetrics,
  childThreadIdOf,
  childTranscriptRelativePath,
  configRelativePath,
  noSidecars,
  sessionRelativeDir,
  workflowFromFinal,
  workflowFromJournal,
} from "./sidecars.ts";
import type { ClaudeAgentMeta, ClaudeSidecars, WorkflowAgentMetrics, WorkflowView } from "./sidecars.ts";

/** Registry status of the process holding the session (7.10); null = no process. */
export type ClaudeLiveStatus = "busy" | "waiting" | "idle" | null;

/** A turn end this server saw: the SDK result message of a process it runs (DESIGN.md 2b). */
export interface ClaudeTurnEnd {
  /** When the result arrived, ISO. */
  at: string;
  /**
   * Client uuids of the user messages the turn answered (result `user_message_uuids`). The CLI
   * writes a sent message under its client uuid, so these are the uuids of the turn's openers.
   * Empty for a turn the CLI started itself (a task notification).
   */
  userMessageUuids: string[];
}

/**
 * What this server knows about a session's turns beyond its transcript. A transcript of an SDK
 * run has no turn_duration line, so the end of such a run comes from here.
 */
export interface ClaudeTurnInfo {
  /** The process this server runs for the session; null when it runs none. */
  run: {
    /** A turn runs (the session host's run.state busy). Background tasks alone leave it false. */
    busy: boolean;
    /** The turn waits on a question this server holds. */
    waiting: boolean;
    /** When the running turn began, ISO; null while busy is false. */
    busySince: string | null;
    /** The mode the process reported last (system/init, system/status, a setPermissionMode); null before it did. */
    permissionMode: string | null;
    /** The process's latest `active_goal` message (goalState.ts chooseGoal); absent before it sent one. */
    activeGoal?: LiveGoal;
  } | null;
  /** Turn ends seen while this server ran, oldest first. They outlive the process. */
  ends: ClaudeTurnEnd[];
  /**
   * Model, effort and the like chosen here for the next turns, or what the process reported
   * (state.chosen, DESIGN.md 6m); null when there is none. Absent: the thread state has no `chosen`.
   */
  chosen?: SessionChosen | null;
  /**
   * A conversation rewind waiting for the next message (DESIGN.md 6o): until a run opener is
   * written after its last line, the lanes take a run opener under its kept line as the newest
   * one, so what came after that line shows as a rewound branch.
   */
  rewind?: RewindMarker | null;
}

const NO_TURNS: ClaudeTurnInfo = { run: null, ends: [] };

/** The goal_status records of a transcript from the newest goal boundary on, read apart from the page (goalScan.ts). */
export interface GoalHistory {
  events: GoalEvent[];
  /** The scan covered the file before this byte offset. */
  endOffset: number;
}

export interface ClaudeProjectorCtx {
  threadId: string;
  account: string;
  sessionId: string;
  agentId?: string;
  path: string;
  readonly: boolean;
  /** meta.json, workflow json and journal readers. Default: none. */
  sidecars?: ClaudeSidecars;
  /** Registry status at creation. Default null (no live process). */
  live?: ClaudeLiveStatus;
  /** Turns as this server saw them, at creation. Default: none seen, no process of this server. */
  turns?: ClaudeTurnInfo;
}

export interface PendingUserInput {
  requestId: string;
  itemId: string;
  questions: unknown[];
  createdAt: string | null;
}

/** A child transcript this thread links to (7.7), for the caller to open as its own thread. */
export interface ClaudeChildTranscript {
  childThreadId: string;
  agentId: string;
  /** Item id of the Agent or Workflow call in this thread. */
  parentItemId: string;
  /** Path relative to a config dir; resolve it with the ClaudePathResolver (any account dir). */
  relativePath: string | null;
  workflowRunId?: string;
}

export interface ClaudeProjector {
  /** Lines appended after the loaded ones. Returns the rows and records that changed. */
  push(records: RawRecord[]): ThreadLiveEvent[];
  /** An older page (lines before the loaded ones). */
  prepend(records: RawRecord[]): void;
  snapshot(): ThreadSnapshot;
  stats(): ThreadProjectionState["stats"];
  /** The registry status changed (7.10). Tool and run status depend on it. */
  setLiveStatus(status: ClaudeLiveStatus): ThreadLiveEvent[];
  /**
   * What this server knows about the turns changed. While it runs the session's process, run
   * status, the runtime and the permission mode follow it instead of the registry status.
   */
  setTurns(info: ClaudeTurnInfo): ThreadLiveEvent[];
  /**
   * The goal_status records of the whole file up to `endOffset` (goalScan.ts), which the loaded
   * page may not reach back to. They replace the loaded lines before `endOffset` in the goal.
   */
  setGoalHistory(history: GoalHistory): ThreadLiveEvent[];
  /** Re-read meta.json and workflow files (call when they change on disk). */
  refreshSidecars(): ThreadLiveEvent[];
  /** Requests the UI may answer; always empty for a readonly (terminal-owned) thread (6.1). */
  pending(): { approvals: unknown[]; userInputs: PendingUserInput[] };
  /** Child transcripts known so far (linked subagents and workflow agents). */
  children(): ClaudeChildTranscript[];
  /**
   * A waiting rewind's kept line is older than the loaded lines (DESIGN.md 6o): the caller loads
   * older pages until it is there, so what came after it folds into the rewound branch.
   */
  needsOlder(): boolean;
}

// ---- fold state ----

interface ToolState {
  name: string | null;
  input: unknown;
  kind: ToolKind;
  resolved: boolean;
  orphan: boolean;
  lastOutput?: unknown;
}

interface ItemRec {
  id: string;
  ordinal: number;
  /** uuid of the line that owns the item (its lane); null = main lane. */
  node: string | null;
  item: OrchestrationV2TurnItem;
  x: ProjectionExtension;
  visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  sourceThreadId: string;
  sourceItemId: string;
  runId: string | null;
  tool?: ToolState;
  removed?: boolean;
}

interface RunRec {
  runId: string;
  /** Position in Model.runOrder. */
  index: number;
  providerTurnId: string;
  openerUuid: string;
  requestedAt: string | null;
  completedAt: string | null;
  /** Timestamp of the run's last line, any kind. */
  lastTs: string | null;
  /**
   * Timestamp of the run's last displayed line. The lines that follow it before the next opener
   * (queue operations, a meta reminder) are written when the next request comes, so lastTs of a
   * finished run is often the next run's start (measured on SDK transcripts, 2026-11-16).
   */
  contentTs: string | null;
  endSignal: boolean;
  interrupted: boolean;
  lastItemType: OrchestrationV2TurnItem["type"] | null;
  assistantMessageId: string | null;
  turnEnded?: boolean;
}

/** A subagent as the transcript alone describes it; sidecar files add an overlay (Overlay). */
interface SubagentRec {
  record: OrchestrationV2Subagent;
  /** From the parent's tool result (`toolUseResult.agentId`). */
  agentId: string | null;
  asyncLaunched: boolean;
  /** Settled by a tool result or a task notification. */
  terminal: boolean;
  runHandles?: { runId?: string; transcriptDir?: string; scriptPath?: string };
  workflowName?: string;
  /** Notification items about this subagent (their source.childThreadId follows the link). */
  notifications: Set<string>;
}

/**
 * What meta.json and the workflow files say about one subagent. Kept apart from the fold and
 * applied when rows are built, so the result does not depend on when the files were read.
 */
interface Overlay {
  meta?: { agentId: string; meta: ClaudeAgentMeta };
  view?: WorkflowView;
  /** The view is the journal of a run resumed after its final record: the run runs again. */
  resumed?: true;
}

interface NodeInfo {
  parentUuid: string | null;
  opener: boolean;
  offset: number;
}

interface Dirty {
  created: Set<string>;
  items: Set<string>;
  runs: Set<string>;
  subagents: Set<string>;
  /** Items removed in this batch (queue entries delivered or dropped, a replaced orphan). */
  removed: string[];
  newOpener: boolean;
  usage: boolean;
}

function newDirty(): Dirty {
  return { created: new Set(), items: new Set(), runs: new Set(), subagents: new Set(), removed: [], newOpener: false, usage: false };
}

interface TaskEntry {
  text: string;
  status: OrchestrationV2PlanStep["status"];
}

type StatsT = ThreadProjectionState["stats"];

function emptyStats(): StatsT {
  return { linesRead: 0, parseFailures: 0, partialTail: 0, byKey: {}, displayedByKey: {}, hiddenByKey: {}, unknownByKey: {} };
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

const STATE_KEYS = ["customTitle", "agentName", "aiTitle", "lastPrompt", "model", "effort", "permissionMode", "mode", "outputStyle", "cwd", "gitBranch"] as const;
type StateKey = (typeof STATE_KEYS)[number];
type ThreadState = Partial<Pick<ThreadProjectionState, StateKey>>;

class Model {
  items = new Map<string, ItemRec>();
  itemsByUuid = new Map<string, string[]>();
  nodes = new Map<string, NodeInfo>();
  nodeOrder: string[] = [];
  /** Alternate lane of a node; absent = main lane. */
  alt = new Map<string, string>();
  forks: LaneFork[] = [];
  laneCycles = 0;
  runs = new Map<string, RunRec>();
  runOrder: string[] = [];
  currentRun: RunRec | null = null;
  runByUuid = new Map<string, RunRec>();
  resultToolsByUuid = new Map<string, string[]>();
  pendingResults = new Map<string, Array<{ op: Extract<Op, { op: "toolResult" }>; f: LineFacts }>>();
  hiddenTools = new Set<string>();
  unresolved = new Set<string>();
  queue: string[] = [];
  lastCompactionId: string | null = null;
  pendingScheduled: { taskId: string | null; cron: string | null } | null = null;
  state: ThreadState = {};
  /** The goal_status records read, in line order (goalState.ts). */
  goalEvents: GoalEvent[] = [];
  stats: StatsT = emptyStats();
  usageByMsg = new Map<string, StepUsage>();
  usageTotal: StepUsage = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  lastStep: StepUsage | null = null;
  /** Run of each message in usageByMsg, and output tokens per run. */
  usageRunByMsg = new Map<string, string | null>();
  outputByRun = new Map<string, number>();
  /** The newest `api-request` line: its model and whether it asked for the 1M context. */
  lastRequest: { model: string; oneMillion: boolean } | null = null;
  /** Largest context of one step (input, cache and output tokens). */
  peakContext = 0;
  /** Prompt cache clock (promptCache.ts): the latest cache-using message, its first line's time, and the TTL it used. */
  cacheMsgId: string | null = null;
  cacheAt: string | null = null;
  cacheTtlMs: number | null = null;
  /** A compaction came after the latest cache-using message. */
  cacheCold = false;
  costUsd: number | null = null;
  byModel: ThreadProjectionState["byModel"] | undefined;
  prUrls = new Set<string>();
  tasks = new Map<string, TaskEntry>();
  todoOrdinal: number | null = null;
  todoRunId: string | null = null;
  subagents = new Map<string, SubagentRec>();
  forkedFrom: string | null = null;
  firstPrompt: string | null = null;
  lastError: string | null = null;
  lastTs: string | null = null;
  lineOf = new Map<number, number>();
  /** parentUuids not loaded yet; a node arriving with one of them relinks the tree. */
  waitingParents = new Set<string>();
  dirty: Dirty = newDirty();
}

// ---- helpers ----

function terminalStatus(status: OrchestrationV2TurnItemStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

const FAILED_DENIALS = new Set(["user-rejected", "permission-rule", "automode-blocked", "automode-unavailable"]);

function resultStatus(op: Extract<Op, { op: "toolResult" }>): OrchestrationV2TurnItemStatus {
  if (op.denial === "interrupted") return "interrupted";
  if (op.denial === "cancelled") return "cancelled";
  if (op.denial !== null && FAILED_DENIALS.has(op.denial)) return "failed";
  return op.isError ? "failed" : "completed";
}

function taskStatus(value: unknown): OrchestrationV2PlanStep["status"] | undefined {
  switch (value) {
    case "pending":
      return "pending";
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    default:
      return undefined;
  }
}

function taskString(value: unknown, key: string): string | undefined {
  const v = rec(value)?.[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/** T3 applyClaudeTaskTool (ClaudeAdapterV2.ts 5248-5296) over the transcript result. */
function applyTaskTool(tasks: Map<string, TaskEntry>, toolName: string, input: unknown, result: unknown): Map<string, TaskEntry> | undefined {
  if (toolName === "TaskList") {
    const listed = rec(result)?.tasks;
    if (!Array.isArray(listed)) return undefined;
    const next = new Map<string, TaskEntry>();
    for (const task of listed) {
      const id = taskString(task, "id");
      const text = taskString(task, "subject");
      const status = taskStatus(rec(task)?.status);
      if (id !== undefined && text !== undefined && status !== undefined) next.set(id, { text, status });
    }
    return next.size === 0 && tasks.size === 0 ? undefined : next;
  }
  if (toolName === "TaskCreate") {
    const created = rec(result)?.task;
    const m = typeof result === "string" ? /^Task #(\S+) created successfully: (.+)$/s.exec(result) : null;
    const id = taskString(created, "id") ?? m?.[1];
    const text = taskString(created, "subject") ?? m?.[2]?.trim() ?? taskString(input, "subject");
    if (id === undefined || text === undefined) return undefined;
    return new Map(tasks).set(id, { text, status: "pending" });
  }
  if (toolName !== "TaskUpdate" || rec(result)?.success === false || (typeof result === "string" && !result.startsWith("Updated task #"))) {
    return undefined;
  }
  const id = taskString(input, "taskId") ?? taskString(result, "taskId");
  const task = id === undefined ? undefined : tasks.get(id);
  if (id === undefined || task === undefined) return undefined;
  const nativeStatus = rec(input)?.status;
  if (nativeStatus === "deleted") {
    const next = new Map(tasks);
    next.delete(id);
    return next;
  }
  const text = taskString(input, "subject") ?? task.text;
  const status = taskStatus(nativeStatus) ?? task.status;
  if (text === task.text && status === task.status) return undefined;
  return new Map(tasks).set(id, { text, status });
}

function parentThreadIdOf(threadId: string): string {
  const i = threadId.lastIndexOf(":agent-");
  return i < 0 ? threadId : threadId.slice(0, i);
}

function rootThreadIdOf(threadId: string): string {
  const i = threadId.indexOf(":agent-");
  return i < 0 ? threadId : threadId.slice(0, i);
}

function subagentResultStatus(status: string | null): OrchestrationV2Subagent["status"] | null {
  switch (notificationOutcome(status)) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

/**
 * What an Agent result's `toolUseResult` says about the run: an async launch carries the resolved
 * model and isAsync; a foreground agent's final result adds agentType and its totals.
 */
function subagentResultStats(structured: Record<string, unknown> | undefined): Partial<OrchestrationV2Subagent> | null {
  if (structured === undefined) return null;
  const out: Partial<OrchestrationV2Subagent> = {};
  const modelResolved = str(structured.resolvedModel);
  if (modelResolved !== undefined) out.modelResolved = modelResolved;
  const agentType = str(structured.agentType);
  if (agentType !== undefined) out.agentType = agentType;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const toolUses = num(structured.totalToolUseCount);
  if (toolUses !== undefined) out.toolUses = toolUses;
  const totalTokens = num(structured.totalTokens);
  if (totalTokens !== undefined) out.totalTokens = totalTokens;
  const durationMs = num(structured.totalDurationMs);
  if (durationMs !== undefined) out.durationMs = durationMs;
  if (structured.isAsync === true) out.background = true;
  return Object.keys(out).length === 0 ? null : out;
}

function backgroundStatus(status: string | null): NonNullable<ProjectionExtension["background"]>["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "killed":
    case "stopped":
    case "cancelled":
      return "killed";
    case "running":
      return "running";
    default:
      return "unknown";
  }
}

const TITLE_CHARS = 80;

function promptTitle(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS)}...` : line;
}

// ---- projector ----

export function createClaudeProjector(ctx: ClaudeProjectorCtx): ClaudeProjector {
  const threadId = ctx.threadId;
  const kind: "top" | "sub" = ctx.agentId === undefined ? "top" : "sub";
  const providerInstanceId = `claude:${ctx.account}`;
  const providerThreadId = ctx.agentId === undefined ? ctx.sessionId : `${ctx.sessionId}:agent-${ctx.agentId}`;
  const sidecars = ctx.sidecars ?? noSidecars;
  const xctx: ExtractCtx = { threadId, kind, path: ctx.path, providerInstanceId, providerThreadId };
  const relPath = configRelativePath(ctx.path);
  const sessionDir = relPath === null ? null : sessionRelativeDir(relPath);

  /** Loaded lines, file order. */
  let entries: LineFacts[] = [];
  const offsets = new Set<number>();
  let live: ClaudeLiveStatus = ctx.live ?? null;
  let turns: ClaudeTurnInfo = ctx.turns ?? NO_TURNS;
  /** goal_status records read from the whole file (setGoalHistory); null until a scan reports. */
  let goalHistory: GoalHistory | null = null;
  let ownMeta: ClaudeAgentMeta | null = null;
  let m = new Model();

  // materialized visible order, kept between pushes
  let visibleIds: string[] = [];
  let posOf = new Map<string, number>();
  let branchNotices = new Map<string, ItemRec>();
  /** Sidecar overlays by subagent item id; survives refolds (item ids are stable). */
  const overlays = new Map<string, Overlay>();
  /** Per workflow run id, the numbers a final record gave each agent, kept past the record's next write. */
  const seenAgentMetrics = new Map<string, Map<string, WorkflowAgentMetrics>>();

  const isLive = () => live !== null;

  // ---- raw refs and lines ----

  function assignLines(): void {
    m.lineOf = new Map();
    if (entries.length === 0) return;
    if (entries[0]!.offset === 0) {
      let n = 1;
      let next = 0;
      for (const e of entries) {
        if (e.offset !== next) break;
        m.lineOf.set(e.offset, n++);
        next = e.offset + e.length;
      }
    }
    for (const e of entries) if (e.recLine !== null && !m.lineOf.has(e.offset)) m.lineOf.set(e.offset, e.recLine);
  }

  function extendLines(f: LineFacts, prev: LineFacts | undefined): void {
    if (prev !== undefined) {
      const pl = m.lineOf.get(prev.offset);
      if (pl !== undefined && prev.offset + prev.length === f.offset) {
        m.lineOf.set(f.offset, pl + 1);
        return;
      }
    } else if (f.offset === 0) {
      m.lineOf.set(0, 1);
      return;
    }
    if (f.recLine !== null) m.lineOf.set(f.offset, f.recLine);
  }

  function rawRef(f: LineFacts, key: string): RawRef {
    const line = m.lineOf.get(f.offset);
    return { source: "claude-transcript", key, path: ctx.path, ...(line === undefined ? {} : { line }), byteOffset: f.offset };
  }

  // ---- items ----

  function touch(id: string): void {
    if (!m.dirty.created.has(id)) m.dirty.items.add(id);
  }

  /** `patch` holds fields of r.item's own member type. */
  function setItem(r: ItemRec, patch: object): void {
    r.item = { ...r.item, ...patch } as OrchestrationV2TurnItem;
    touch(r.id);
  }

  function setX(r: ItemRec, patch: Partial<ProjectionExtension>): void {
    r.x = { ...r.x, ...patch };
    touch(r.id);
  }

  function addRaw(r: ItemRec, f: LineFacts): void {
    r.x = { ...r.x, raw: [...r.x.raw, rawRef(f, f.key)] };
    touch(r.id);
  }

  function addItem(t: ItemTemplate, f: LineFacts, run: RunRec | null, ordinal = f.offset * 100 + t.slot, node: string | null = f.uuid): ItemRec {
    const id = t.item.id;
    let item = {
      ...t.item,
      runId: run?.runId ?? null,
      providerTurnId: run?.providerTurnId ?? null,
      ordinal,
      updatedAt: t.item.updatedAt.length > 0 ? t.item.updatedAt : (m.lastTs ?? ""),
    } as OrchestrationV2TurnItem;
    let x: ProjectionExtension = { raw: [rawRef(f, f.key)], sourceKey: f.key, ...t.x };
    if (item.type === "user_message" && item.inputIntent === "turn_start" && m.pendingScheduled !== null && item.createdBy === "user") {
      const s = m.pendingScheduled;
      m.pendingScheduled = null;
      item = { ...item, createdBy: "system" };
      x = { ...x, origin: { kind: "scheduled", ...(s.taskId === null ? {} : { taskId: s.taskId }), ...(s.cron === null ? {} : { cron: s.cron }) } };
    }
    const inherited = f.forkedFrom !== null && t.synthetic !== true;
    const sourceThreadId = inherited ? siblingThreadId(threadId, f.forkedFrom!) : threadId;
    const r: ItemRec = {
      id,
      ordinal,
      node,
      item,
      x,
      visibility: t.synthetic === true ? "synthetic" : inherited ? "inherited" : "local",
      sourceThreadId,
      sourceItemId: inherited ? sourceThreadId + id.slice(threadId.length) : id,
      runId: run?.runId ?? null,
    };
    const existing = m.items.get(id);
    if (existing !== undefined && !existing.removed) {
      // Same line read twice (or a repeated uuid): keep the first position, take the newer content.
      r.ordinal = existing.ordinal;
      r.item = { ...r.item, ordinal: existing.ordinal } as OrchestrationV2TurnItem;
      r.x = { ...r.x, raw: [...existing.x.raw, ...r.x.raw] };
      if (existing.tool !== undefined && r.tool === undefined) r.tool = existing.tool;
      m.items.set(id, r);
      touch(id);
    } else {
      m.items.set(id, r);
      m.dirty.created.add(id);
    }
    if (f.uuid !== null) {
      const list = m.itemsByUuid.get(f.uuid);
      if (list === undefined) m.itemsByUuid.set(f.uuid, [id]);
      else if (!list.includes(id)) list.push(id);
    }
    if (run !== null) {
      run.lastItemType = item.type;
      if (item.type === "assistant_message") run.assistantMessageId = id;
      m.dirty.runs.add(run.runId);
    }
    if (item.type === "error") m.lastError = item.failure.message;
    if (item.type === "user_message" && item.inputIntent === "turn_start" && m.firstPrompt === null && item.text.trim().length > 0) {
      m.firstPrompt = item.text;
    }
    if (item.type === "compaction") {
      m.lastCompactionId = id;
      m.cacheCold = true;
    }
    return r;
  }

  // ---- runs ----

  function startRun(f: LineFacts): RunRec {
    const prev = m.currentRun;
    const run: RunRec = {
      runId: `${threadId}:run:${f.uuid}`,
      index: m.runOrder.length,
      providerTurnId: f.promptId ?? f.uuid!,
      openerUuid: f.uuid!,
      requestedAt: f.timestamp,
      completedAt: null,
      lastTs: f.timestamp,
      contentTs: null,
      endSignal: false,
      interrupted: false,
      lastItemType: null,
      assistantMessageId: null,
    };
    m.runs.set(run.runId, run);
    m.runOrder.push(run.runId);
    m.currentRun = run;
    m.dirty.runs.add(run.runId);
    if (prev !== null) m.dirty.runs.add(prev.runId);
    // Unresolved tools of the run that ended stop being "running".
    for (const id of m.unresolved) touch(id);
    for (const s of m.subagents.values()) if (!s.terminal) m.dirty.subagents.add(s.record.id);
    return run;
  }

  // ---- subagents ----

  function createSubagent(r: ItemRec, name: string, input: unknown, f: LineFacts, run: RunRec | null): void {
    const inRec = rec(input);
    const record: OrchestrationV2Subagent = {
      id: r.id,
      threadId,
      runId: run?.runId ?? null,
      parentNodeId: r.id,
      origin: "provider_native",
      createdBy: "agent",
      driver: "claude",
      providerInstanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: { driver: "claude", nativeId: r.id.slice(`${threadId}:tool:`.length), strength: "strong" },
      prompt: str(inRec?.prompt) ?? "",
      title: str(inRec?.description) ?? (name === "Workflow" ? "Workflow" : null),
      model: str(inRec?.model) ?? null,
      status: "pending",
      result: null,
      startedAt: f.timestamp,
      completedAt: null,
      updatedAt: f.timestamp ?? m.lastTs ?? "",
    };
    if (name === "Workflow") record.workflow = { phases: [], agents: [] };
    const agentType = str(inRec?.subagent_type);
    if (agentType !== undefined) record.agentType = agentType;
    if (inRec?.run_in_background === true || inRec?.run_in_background === "true") record.background = true;
    m.subagents.set(r.id, { record, agentId: null, asyncLaunched: false, terminal: false, notifications: new Set() });
    m.dirty.subagents.add(r.id);
  }

  function updateSubagent(id: string, patch: Partial<OrchestrationV2Subagent>, ts: string | null): void {
    const s = m.subagents.get(id);
    if (s === undefined) return;
    s.record = { ...s.record, ...patch, updatedAt: ts ?? s.record.updatedAt };
    m.dirty.subagents.add(id);
    const r = m.items.get(id);
    if (r !== undefined && r.item.type === "subagent") {
      const itemPatch: Partial<OrchestrationV2TurnItem & { type: "subagent" }> = {};
      if (patch.status !== undefined) itemPatch.status = patch.status;
      if (patch.result !== undefined) itemPatch.result = patch.result;
      if (patch.title !== undefined) itemPatch.title = patch.title;
      if (patch.completedAt !== undefined) itemPatch.completedAt = patch.completedAt;
      if (ts !== null) itemPatch.updatedAt = ts;
      setItem(r, itemPatch);
    }
  }

  function linkSubagent(id: string, agentId: string): void {
    const s = m.subagents.get(id);
    if (s === undefined || s.agentId === agentId) return;
    s.agentId = agentId;
    m.dirty.subagents.add(id);
    touch(id);
    for (const n of s.notifications) touch(n);
  }

  function settleSubagent(id: string, status: OrchestrationV2Subagent["status"], result: string | null, ts: string | null): void {
    const s = m.subagents.get(id);
    if (s === undefined) return;
    s.terminal = true;
    updateSubagent(id, { status, ...(result === null ? {} : { result }), completedAt: ts }, ts);
  }

  // ---- tool results ----

  function mergeResult(r: ItemRec, op: Extract<Op, { op: "toolResult" }>, f: LineFacts): void {
    const t = r.tool!;
    const status = resultStatus(op);
    const value = claudeToolOutputValue(op.output);
    if (t.resolved && t.lastOutput !== undefined) setX(r, { previousOutputs: [...(r.x.previousOutputs ?? []), t.lastOutput] });
    t.lastOutput = value;
    t.resolved = true;
    m.unresolved.delete(r.id);
    addRaw(r, f);
    const common: { status: OrchestrationV2TurnItemStatus; completedAt: string | null; updatedAt: string; toolNonExecutionKind?: string } = {
      status,
      completedAt: op.timestamp,
      updatedAt: op.timestamp ?? r.item.updatedAt,
      ...(op.denial === null ? {} : { toolNonExecutionKind: op.denial }),
    };
    const item = r.item;
    switch (item.type) {
      case "command_execution": {
        const output = claudeCommandOutputText(op.output);
        setItem(r, { ...common, ...(output.length === 0 ? {} : { output }) });
        const bg = str(rec(op.output.structured)?.backgroundTaskId);
        if (bg !== undefined) setX(r, { background: { taskId: bg, status: "running" } });
        break;
      }
      case "file_change": {
        const change = claudeFileChangeText(op.output);
        setItem(r, {
          ...common,
          ...(change.diffStr.length === 0 ? {} : { diffStr: change.diffStr }),
          ...(change.additions === undefined ? {} : { additions: change.additions }),
          ...(change.deletions === undefined ? {} : { deletions: change.deletions }),
        });
        break;
      }
      case "web_search": {
        const patterns = webSearchPatternsFromClaudeTool(t.input, op.output);
        const results = webSearchResultsFromClaudeOutput(op.output);
        const fetched = results.length === 0 && t.name === "WebFetch" ? webFetchResultFromClaudeOutput(t.input, op.output) : null;
        setItem(r, {
          ...common,
          ...(patterns.length === 0 ? {} : { patterns }),
          ...(results.length > 0 ? { results } : fetched !== null ? { results: [fetched] } : {}),
        });
        break;
      }
      case "dynamic_tool":
        setItem(r, { ...common, ...(value === undefined ? {} : { output: value }) });
        break;
      case "user_input_request": {
        const answers = rec(rec(op.output.structured)?.answers);
        if (answers !== undefined && status === "completed") {
          const byText = new Map(item.questions.map((q) => [q.question, q.id]));
          const mapped: Record<string, unknown> = {};
          const questionTextById: Record<string, string> = {};
          for (const [question, answer] of Object.entries(answers)) {
            const qid = byText.get(question) ?? question;
            mapped[qid] = answer;
            questionTextById[qid] = question;
          }
          const questionAnswer: UserInputAttachmentAnswerPayload = { requestId: item.requestId, questionTextById, answers: mapped, attachmentsByQuestionId: {} };
          setItem(r, { ...common, questionAnswer });
        } else {
          setItem(r, common);
        }
        break;
      }
      case "proposed_plan":
        setItem(r, common);
        break;
      case "subagent": {
        const s = m.subagents.get(r.id);
        const structured = rec(op.output.structured);
        const agentId = str(structured?.agentId);
        if (agentId !== undefined) linkSubagent(r.id, agentId);
        const stats = subagentResultStats(structured);
        if (stats !== null) updateSubagent(r.id, stats, op.timestamp);
        if (t.kind === "workflow" && structured !== undefined && s !== undefined) {
          const runHandles: NonNullable<SubagentRec["runHandles"]> = {};
          for (const k of ["runId", "transcriptDir", "scriptPath"] as const) {
            const v = str(structured[k]);
            if (v !== undefined) runHandles[k] = v;
          }
          s.runHandles = runHandles;
          const name = str(structured.workflowName);
          if (name !== undefined) s.workflowName = name;
          const wf: OrchestrationV2SubagentWorkflow = { ...(s.record.workflow ?? { phases: [], agents: [] }), runHandles };
          if (name !== undefined) wf.name = name;
          updateSubagent(r.id, { workflow: wf, ...(name === undefined ? {} : { title: s.record.title === "Workflow" ? name : s.record.title }) }, op.timestamp);
          if (runHandles.runId !== undefined) syncOverlay(r.id, null);
        }
        if (status !== "completed") {
          settleSubagent(r.id, status === "interrupted" ? "interrupted" : status === "cancelled" ? "cancelled" : "failed", claudeSubagentResultText(op.output), op.timestamp);
        } else if (isClaudeSubagentAsyncLaunchAck(op.output) || (t.kind === "workflow" && structured?.status === "async_launched")) {
          if (s !== undefined) {
            s.asyncLaunched = true;
            updateSubagent(r.id, { status: s.record.status === "pending" ? "running" : s.record.status, background: true }, op.timestamp);
          }
        } else {
          settleSubagent(r.id, "completed", claudeSubagentResultText(op.output), op.timestamp);
        }
        setItem(r, {
          ...(op.denial === null ? {} : { toolNonExecutionKind: op.denial }),
          ...(op.timestamp === null ? {} : { updatedAt: op.timestamp }),
        });
        break;
      }
      default:
        setItem(r, common);
    }
    if (t.kind === "task" && t.name !== null && status === "completed") {
      const next = applyTaskTool(m.tasks, t.name, t.input, op.output.structured ?? op.output.content);
      if (next !== undefined) {
        m.tasks = next;
        upsertTodo(r, f);
      }
    }
  }

  function upsertTodo(caller: ItemRec, f: LineFacts): void {
    const id = `${threadId}:todo`;
    const steps: OrchestrationV2PlanStep[] = [...m.tasks].map(([tid, e]) => ({ id: tid, text: e.text, status: e.status }));
    const existing = m.items.get(id);
    if (existing === undefined) {
      m.todoOrdinal = caller.ordinal + 50;
      m.todoRunId = caller.runId;
      const run = caller.runId === null ? null : (m.runs.get(caller.runId) ?? null);
      const t: ItemTemplate = {
        item: {
          id,
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: null,
          startedAt: f.timestamp,
          completedAt: f.timestamp,
          updatedAt: f.timestamp ?? m.lastTs ?? "",
          type: "todo_list",
          planId: id,
          steps,
        },
        slot: 50,
        x: {},
        synthetic: true,
      };
      addItem(t, f, run, m.todoOrdinal, caller.node);
    } else {
      setItem(existing, { steps, updatedAt: f.timestamp ?? existing.item.updatedAt });
      addRaw(existing, f);
    }
  }

  function orphanResult(op: Extract<Op, { op: "toolResult" }>, f: LineFacts, run: RunRec | null): void {
    const id = `${threadId}:tool:${op.toolUseId}`;
    const list = m.pendingResults.get(op.toolUseId) ?? [];
    list.push({ op, f });
    m.pendingResults.set(op.toolUseId, list);
    const value = claudeToolOutputValue(op.output);
    const existing = m.items.get(id);
    if (existing !== undefined && existing.tool?.orphan === true) {
      setX(existing, { previousOutputs: [...(existing.x.previousOutputs ?? []), existing.tool.lastOutput] });
      existing.tool.lastOutput = value;
      setItem(existing, { output: value, status: resultStatus(op), completedAt: op.timestamp });
      addRaw(existing, f);
      return;
    }
    const t: ItemTemplate = {
      item: {
        id,
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: { driver: "claude", nativeId: op.toolUseId, strength: "strong" },
        parentItemId: null,
        ordinal: 0,
        status: resultStatus(op),
        title: null,
        startedAt: op.timestamp,
        completedAt: op.timestamp,
        updatedAt: op.timestamp ?? m.lastTs ?? "",
        ...(op.denial === null ? {} : { toolNonExecutionKind: op.denial }),
        type: "dynamic_tool",
        toolName: null,
        input: null,
        ...(value === undefined ? {} : { output: value }),
      },
      slot: op.slot,
      x: { unknown: true },
    };
    const r = addItem(t, f, run);
    r.tool = { name: null, input: null, kind: "generic", resolved: true, orphan: true, lastOutput: value };
  }

  // ---- apply one line ----

  function apply(f: LineFacts, prev: LineFacts | undefined): void {
    extendLines(f, prev);
    const st = m.stats;
    st.linesRead++;
    if (f.parseFailure) {
      st.parseFailures++;
      return;
    }
    if (f.timestamp !== null) m.lastTs = f.timestamp;
    if (f.cwd !== null) writeState({ cwd: f.cwd });
    if (f.gitBranch !== null) writeState({ gitBranch: f.gitBranch });

    // node, lane and run
    let run: RunRec | null = m.currentRun;
    if (f.uuid !== null && !m.nodes.has(f.uuid)) {
      m.nodes.set(f.uuid, { parentUuid: f.parentUuid, opener: f.opener, offset: f.offset });
      m.nodeOrder.push(f.uuid);
      if (f.parentUuid !== null && !m.nodes.has(f.parentUuid)) m.waitingParents.add(f.parentUuid);
      // A parent written after its child (not seen in the corpus): lanes need a full pass.
      if (m.waitingParents.delete(f.uuid)) m.dirty.newOpener = true;
      if (f.opener) {
        m.dirty.newOpener = true;
        run = startRun(f);
      } else {
        const parentRun = f.parentUuid === null ? undefined : m.runByUuid.get(f.parentUuid);
        if (parentRun !== undefined) run = parentRun;
        const parentLane = f.parentUuid === null ? undefined : m.alt.get(f.parentUuid);
        if (parentLane !== undefined) m.alt.set(f.uuid, parentLane);
      }
      if (run !== null) m.runByUuid.set(f.uuid, run);
    } else if (f.uuid !== null) {
      run = m.runByUuid.get(f.uuid) ?? run;
    }
    if (run !== null && f.timestamp !== null) run.lastTs = f.timestamp;

    if (f.forkedFrom !== null && m.forkedFrom === null) {
      m.forkedFrom = f.forkedFrom;
      addItem(
        {
          item: {
            id: `${threadId}:syn:fork:${f.forkedFrom}`,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            title: null,
            startedAt: f.timestamp,
            completedAt: f.timestamp,
            updatedAt: f.timestamp ?? "",
            type: "fork",
            source: { type: "provider_thread", providerThreadId: f.forkedFrom },
            targetThreadId: threadId,
          },
          slot: 0,
          x: { link: { threadId: siblingThreadId(threadId, f.forkedFrom), evidence: "forkedFrom" } },
          synthetic: true,
        },
        f,
        null,
        f.offset * 100 - 1,
        null,
      );
    }

    let key = f.key;
    let disposition: Disposition = f.disposition;
    for (const op of f.ops) {
      const override = applyOp(op, f, run);
      if (override !== undefined) {
        key = override.key;
        disposition = override.disposition;
      }
    }
    bump(st.byKey, key);
    bump(disposition === "displayed" ? st.displayedByKey : disposition === "hidden" ? st.hiddenByKey : st.unknownByKey, key);
    if (run !== null && f.uuid !== null && f.timestamp !== null && disposition === "displayed" && run.contentTs !== f.timestamp) {
      run.contentTs = f.timestamp;
      m.dirty.runs.add(run.runId);
    }
  }

  function writeState(patch: StatePatch & { gitBranch?: string }): void {
    for (const [k, v] of Object.entries(patch) as Array<[StateKey, unknown]>) {
      if (v === undefined) continue;
      const cur = m.state[k];
      // null clears a value (sent as null, since a live patch merges keys); there is nothing to clear before a first value.
      if (v === null && cur === undefined) continue;
      if (JSON.stringify(cur) === JSON.stringify(v)) continue;
      (m.state as Record<string, unknown>)[k] = v;
    }
  }

  function applyOp(op: Op, f: LineFacts, run: RunRec | null): { key: string; disposition: Disposition } | undefined {
    switch (op.op) {
      case "item":
        addItem(op.t, f, run);
        return undefined;
      case "tool": {
        if (m.hiddenTools.has(op.toolUseId)) return undefined;
        const id = op.t.item.id;
        const orphan = m.items.get(id);
        const waiting = orphan?.tool?.orphan === true ? m.pendingResults.get(op.toolUseId) : undefined;
        if (orphan?.tool?.orphan === true) {
          m.items.delete(id);
          m.dirty.removed.push(id);
        }
        const r = addItem(op.t, f, run);
        r.tool = { name: op.name, input: op.input, kind: op.kind, resolved: false, orphan: false };
        m.unresolved.add(r.id);
        if (op.kind === "subagent" || op.kind === "workflow") createSubagent(r, op.name, op.input, f, run);
        if (waiting !== undefined) {
          m.pendingResults.delete(op.toolUseId);
          for (const w of waiting) mergeResult(r, w.op, w.f);
        }
        return undefined;
      }
      case "toolResult": {
        if (f.uuid !== null) {
          const list = m.resultToolsByUuid.get(f.uuid) ?? [];
          list.push(op.toolUseId);
          m.resultToolsByUuid.set(f.uuid, list);
        }
        if (m.hiddenTools.has(op.toolUseId)) return undefined;
        const r = m.items.get(`${threadId}:tool:${op.toolUseId}`);
        if (r === undefined || r.tool === undefined || r.tool.orphan) orphanResult(op, f, run);
        else mergeResult(r, op, f);
        return undefined;
      }
      case "advisorResult": {
        const r = m.items.get(`${threadId}:tool:${op.toolUseId}`);
        if (r !== undefined && r.tool !== undefined) {
          r.tool.resolved = true;
          m.unresolved.delete(r.id);
          setItem(r, { status: "completed", completedAt: f.timestamp, output: op.contentType });
          addRaw(r, f);
        }
        return undefined;
      }
      case "goal":
        m.goalEvents.push(op.event);
        return undefined;
      case "state":
        writeState(op.patch);
        return undefined;
      case "queue": {
        if (op.operation === "enqueue" && op.t !== null) {
          const r = addItem(op.t, f, run, f.offset * 100, null);
          m.queue.push(r.id);
        } else if (op.operation === "dequeue") {
          const id = m.queue.shift();
          if (id !== undefined) removeItem(id);
        } else if (op.operation === "remove") {
          const i = m.queue.findIndex((id) => {
            const it = m.items.get(id)?.item;
            return it?.type === "user_message" && it.text === op.content;
          });
          if (i >= 0) removeItem(m.queue.splice(i, 1)[0]!);
        } else if (op.operation === "popAll") {
          for (const id of m.queue.splice(0)) removeItem(id);
        }
        return undefined;
      }
      case "compactSummary": {
        const r = m.lastCompactionId === null ? undefined : m.items.get(m.lastCompactionId);
        if (r !== undefined) {
          setItem(r, { summary: op.text });
          addRaw(r, f);
        }
        return undefined;
      }
      case "turnDuration":
        if (run !== null) {
          run.endSignal = true;
          run.completedAt = f.timestamp;
          m.dirty.runs.add(run.runId);
        }
        return undefined;
      case "stopHook":
        if (run !== null) {
          run.turnEnded = true;
          m.dirty.runs.add(run.runId);
        }
        return undefined;
      case "assistantLine":
        if (run !== null && run.turnEnded === true) {
          run.turnEnded = false;
          m.dirty.runs.add(run.runId);
        }
        return undefined;
      case "interrupt":
        if (run !== null) {
          run.interrupted = true;
          m.dirty.runs.add(run.runId);
        }
        return undefined;
      case "hook": {
        const r = m.items.get(`${threadId}:tool:${op.toolUseId}`);
        if (r !== undefined) {
          setX(r, { hooks: [...(r.x.hooks ?? []), op.hook] });
          addRaw(r, f);
        }
        return undefined;
      }
      case "truncNotice": {
        const r = m.items.get(`${threadId}:tool:${op.toolUseId}`);
        if (r !== undefined) {
          setX(r, { attachedNotices: [...(r.x.attachedNotices ?? []), op.banner] });
          addRaw(r, f);
        }
        return undefined;
      }
      case "notify":
        notify(op.t, op.tags, f, run);
        return undefined;
      case "taskStatus": {
        const r = addItem(op.t, f, run);
        const target = op.toolUseId === null ? undefined : m.items.get(`${threadId}:tool:${op.toolUseId}`);
        if (target !== undefined && target.item.type === "subagent") {
          setItem(r, { source: { kind: "subagent" } });
          m.subagents.get(target.id)?.notifications.add(r.id);
        }
        if (target !== undefined && target.x.background !== undefined && op.status !== null && op.status !== "running") {
          setX(target, { background: { ...target.x.background, status: backgroundStatus(op.status) } });
        }
        return undefined;
      }
      case "retract":
        for (const uuid of op.uuids) for (const id of m.itemsByUuid.get(uuid) ?? []) {
          const r = m.items.get(id);
          if (r !== undefined) setX(r, { retracted: true });
        }
        return undefined;
      case "usage": {
        const prev = m.usageByMsg.get(op.messageId);
        const t = m.usageTotal;
        if (prev !== undefined) {
          t.input -= prev.input;
          t.cacheRead -= prev.cacheRead;
          t.cacheCreation -= prev.cacheCreation;
          t.output -= prev.output;
        }
        t.input += op.usage.input;
        t.cacheRead += op.usage.cacheRead;
        t.cacheCreation += op.usage.cacheCreation;
        t.output += op.usage.output;
        m.usageByMsg.set(op.messageId, op.usage);
        m.lastStep = op.usage;
        if (op.usage.cacheRead + op.usage.cacheCreation > 0 && f.timestamp !== null) {
          // The message's first line is nearest to its request; later lines of it keep that time.
          if (m.cacheMsgId !== op.messageId || m.cacheAt === null) {
            m.cacheMsgId = op.messageId;
            m.cacheAt = f.timestamp;
          }
          m.cacheTtlMs = promptCacheTtlOf(op.usage.created ?? { fiveMinute: 0, oneHour: 0 }, m.cacheTtlMs);
          m.cacheCold = false;
        }
        m.peakContext = Math.max(m.peakContext, op.usage.input + op.usage.cacheRead + op.usage.cacheCreation + op.usage.output);
        // Output per run: a message read again moves its count to the run it is in now.
        const prevRun = m.usageRunByMsg.get(op.messageId);
        if (prev !== undefined && prevRun !== undefined && prevRun !== null) m.outputByRun.set(prevRun, (m.outputByRun.get(prevRun) ?? 0) - prev.output);
        const runId = run?.runId ?? null;
        m.usageRunByMsg.set(op.messageId, runId);
        if (runId !== null) m.outputByRun.set(runId, (m.outputByRun.get(runId) ?? 0) + op.usage.output);
        m.dirty.usage = true;
        return undefined;
      }
      case "request":
        m.lastRequest = { model: op.model, oneMillion: op.oneMillion };
        m.dirty.usage = true;
        return undefined;
      case "cost": {
        if (op.totalCostUsd !== null) m.costUsd = op.totalCostUsd;
        if (op.modelUsage !== null) {
          const byModel: NonNullable<ThreadProjectionState["byModel"]> = {};
          for (const [model, u] of Object.entries(op.modelUsage)) {
            const r = rec(u);
            if (r === undefined) continue;
            const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : undefined);
            byModel[model] = {
              input: n("inputTokens") ?? 0,
              output: n("outputTokens") ?? 0,
              ...(n("cacheReadInputTokens") === undefined ? {} : { cacheRead: n("cacheReadInputTokens")! }),
              ...(n("cacheCreationInputTokens") === undefined ? {} : { cacheWrite: n("cacheCreationInputTokens")! }),
              ...(n("costUSD") === undefined ? {} : { costUsd: n("costUSD")! }),
            };
          }
          m.byModel = byModel;
        }
        m.dirty.usage = true;
        return undefined;
      }
      case "prLink":
        if (m.prUrls.has(op.url)) return { key: `${f.key}|repeat`, disposition: "hidden" };
        m.prUrls.add(op.url);
        addItem(op.t, f, run);
        return undefined;
      case "metaImage": {
        const tools = f.parentUuid === null ? undefined : m.resultToolsByUuid.get(f.parentUuid);
        const r = tools === undefined ? undefined : m.items.get(`${threadId}:tool:${tools[0]!}`);
        if (r === undefined || r.item.type !== "dynamic_tool") {
          return { key: f.key.replace(/\|row=1b$/, "|row=12"), disposition: "hidden" };
        }
        const prev = r.item.output;
        const output = Array.isArray(prev) ? [...prev, ...op.images] : prev === undefined ? op.images : { content: op.images, structuredContent: prev };
        setItem(r, { output });
        addRaw(r, f);
        return undefined;
      }
      case "forkCopy":
        m.hiddenTools.add(op.toolUseId);
        return undefined;
      case "scheduled":
        m.pendingScheduled = { taskId: op.taskId, cron: op.cron };
        return undefined;
      case "structuredOutput": {
        const r = m.items.get(`${threadId}:tool:${op.toolUseId}`);
        if (r !== undefined) {
          setX(r, { data: { ...(r.x.data ?? {}), structuredOutput: op.data } });
          addRaw(r, f);
        }
        return undefined;
      }
    }
  }

  function removeItem(id: string): void {
    const r = m.items.get(id);
    if (r === undefined || r.removed) return;
    r.removed = true;
    m.dirty.removed.push(id);
  }

  function notify(t: ItemTemplate, tags: NotificationTags, f: LineFacts, run: RunRec | null): void {
    const r = addItem(t, f, run);
    const target = tags.toolUseId === null ? undefined : m.items.get(`${threadId}:tool:${tags.toolUseId}`);
    if (target === undefined) return;
    if (r.item.type === "notification") {
      const ti = target.item;
      const source =
        ti.type === "subagent"
          ? { kind: "subagent" as const }
          : ti.type === "command_execution"
            ? { kind: "command" as const }
            : ti.type === "dynamic_tool" && ti.toolName === "Monitor"
              ? { kind: "monitor" as const }
              : { kind: "background_task" as const };
      setItem(r, { source });
      setX(r, { relatedCallId: tags.toolUseId! });
    }
    if (target.item.type === "subagent") {
      m.subagents.get(target.id)?.notifications.add(r.id);
      if (tags.usage !== null) updateSubagent(target.id, tags.usage, f.timestamp);
      const status = subagentResultStatus(tags.status);
      if (status !== null) settleSubagent(target.id, status, tags.result, f.timestamp);
    } else if (target.x.background !== undefined || tags.status !== null) {
      const taskId = target.x.background?.taskId ?? tags.taskId ?? "";
      setX(target, {
        background: {
          taskId,
          status: backgroundStatus(tags.status),
          ...(tags.outputFile === null ? {} : { outputFile: tags.outputFile }),
        },
      });
    }
  }

  // ---- sidecars ----

  /** Re-read the files of one subagent. `metas` is the meta.json listing, null to keep the old one. */
  function syncOverlay(id: string, metas: Map<string, { agentId: string; meta: ClaudeAgentMeta }> | null): void {
    const s = m.subagents.get(id);
    if (s === undefined) return;
    const old = overlays.get(id) ?? {};
    const next: Overlay = {};
    const meta = metas === null ? old.meta : metas.get(id.slice(`${threadId}:tool:`.length));
    if (meta !== undefined) next.meta = meta;
    const runId = s.runHandles?.runId;
    if (runId !== undefined) {
      const run = workflowRun(runId);
      if (run.view !== null) next.view = run.view;
      if (run.resumed) next.resumed = true;
    }
    if (JSON.stringify(next) === JSON.stringify(old)) return;
    overlays.set(id, next);
    m.dirty.subagents.add(id);
    touch(id);
    for (const n of s.notifications) touch(n);
  }

  /**
   * A workflow run as the 작업 tab reads it (DESIGN.md 6e, 6i): the final record, or the journal
   * while the run has none yet or was resumed after it. The journal has no numbers, and the
   * resumed run's own final record gives none for the agents it served from the cache, so each
   * agent keeps the numbers the run's earlier final record gave it (carryAgentMetrics).
   */
  function workflowRun(runId: string): { view: WorkflowView | null; resumed: boolean } {
    const final = workflowFromFinal(sidecars.workflowFinal(runId), threadId);
    const resumed = final !== null && sidecars.workflowResumed(runId);
    const view = final !== null && !resumed ? final : (workflowFromJournal(sidecars.workflowJournal(runId), threadId) ?? final);
    if (view === null) return { view: null, resumed: false };
    let seen = seenAgentMetrics.get(runId);
    const fromFinal = new Map<string, WorkflowAgentMetrics>();
    for (const a of final?.workflow.agents ?? []) {
      const known = a.agentId === undefined ? undefined : agentMetrics(a);
      if (a.agentId === undefined || known === undefined) continue;
      fromFinal.set(a.agentId, known);
      if (a.totalTokens === undefined) continue;
      if (!seen) seenAgentMetrics.set(runId, (seen = new Map()));
      seen.set(a.agentId, known);
    }
    const agents = carryAgentMetrics(view.workflow.agents, (agentId) => {
      const merged: WorkflowAgentMetrics = { ...seen?.get(agentId), ...fromFinal.get(agentId) };
      return Object.keys(merged).length ? merged : undefined;
    });
    return { view: { ...view, workflow: { ...view.workflow, agents } }, resumed: resumed && view !== final };
  }

  function syncSidecars(): void {
    if (kind === "sub") ownMeta = sidecars.ownMeta();
    if (m.subagents.size === 0) return;
    const metas = new Map<string, { agentId: string; meta: ClaudeAgentMeta }>();
    for (const entry of sidecars.agentMetas()) {
      if (typeof entry.meta.toolUseId === "string") metas.set(entry.meta.toolUseId, entry);
    }
    for (const id of m.subagents.keys()) syncOverlay(id, metas);
  }

  /** The fold's subagent with its overlay and the liveness rule (7.1 4, 7.7 3). */
  function effectiveSubagent(id: string): { record: OrchestrationV2Subagent; evidence: NonNullable<ProjectionExtension["link"]>["evidence"] } | null {
    const s = m.subagents.get(id);
    if (s === undefined) return null;
    const o = overlays.get(id) ?? {};
    const meta = o.meta;
    const agentId = meta?.agentId ?? s.agentId;
    const evidence = meta !== undefined ? "meta.toolUseId" : s.agentId !== null ? "toolUseResult.agentId" : "unlinked";
    let status = s.record.status;
    const finished = meta?.meta.finished === true;
    if (status === "pending" && agentId !== null) status = "running";
    let workflow = s.record.workflow;
    if (o.view !== undefined) {
      workflow = { ...(workflow ?? { phases: [], agents: [] }), ...o.view.workflow };
      if (s.runHandles !== undefined) workflow.runHandles = s.runHandles;
      if (workflow.name === undefined && s.workflowName !== undefined) workflow.name = s.workflowName;
      if (o.view.status !== undefined && o.view.status !== "running") status = o.view.status;
      // Every card of a resumed run shows it running again, as its final record's status shows on each.
      else if (status === "pending" || o.resumed) status = "running";
    }
    if (!s.terminal && finished && (status === "pending" || status === "running")) status = "completed";
    if (!isLive() && (status === "pending" || status === "running")) status = "interrupted";
    const childThreadId = agentId === null ? null : childThreadIdOf(threadId, agentId);
    const record: OrchestrationV2Subagent = {
      ...s.record,
      status,
      childThreadId,
      providerThreadId: agentId === null ? null : `${ctx.sessionId}:agent-${agentId}`,
      title: str(meta?.meta.name) ?? str(meta?.meta.description) ?? s.record.title,
      model: s.record.model ?? str(meta?.meta.model) ?? null,
    };
    if (workflow !== undefined) record.workflow = workflow;
    // meta.json `model` is the alias the call asked for; `pickedEffortModel` is the resolved id.
    const metaType = str(meta?.meta.agentType);
    if (record.agentType === undefined && metaType !== undefined) record.agentType = metaType;
    const metaModel = str(meta?.meta.pickedEffortModel);
    if (record.modelResolved === undefined && metaModel !== undefined) record.modelResolved = metaModel;
    return { record, evidence };
  }

  // ---- lanes and the visible list ----

  function recomputeLanes(): void {
    const nodes: LaneNode[] = m.nodeOrder.map((uuid) => {
      const n = m.nodes.get(uuid)!;
      return { uuid, parentUuid: n.parentUuid, opener: n.opener };
    });
    const waiting = waitingRewind();
    if (waiting !== null && waiting.lastIndex !== null && m.nodes.has(waiting.marker.keepUuid)) {
      // The next message, not written yet, goes under the kept line: the newest opener, in file
      // order right after the rewind's last line. It owns no item, so it adds no row and no alternate.
      nodes.splice(waiting.lastIndex + 1, 0, { uuid: `rewind:${waiting.marker.atUuid}`, parentUuid: waiting.marker.keepUuid, opener: true });
    }
    const res = computeLanes(nodes);
    m.alt = res.alt;
    m.forks = res.forks;
    m.laneCycles = res.cycles;
  }

  /**
   * The rewind marker while it may wait (rewindScan.ts markerActive): no run opener among the
   * loaded lines after its last line. `lastIndex` is that line's place in nodeOrder, null when the
   * loaded lines do not reach it (and hold no opener): older pages tell.
   */
  function waitingRewind(): { marker: RewindMarker; lastIndex: number | null } | null {
    const marker = turns.rewind ?? null;
    if (marker === null) return null;
    for (let i = m.nodeOrder.length - 1; i >= 0; i--) {
      const uuid = m.nodeOrder[i]!;
      if (uuid === marker.lastUuid) return { marker, lastIndex: i };
      if (m.nodes.get(uuid)!.opener) return null;
    }
    return { marker, lastIndex: null };
  }

  function laneOfRec(r: ItemRec): string | null {
    return r.node === null ? null : (m.alt.get(r.node) ?? null);
  }

  function buildBranchNotices(): Map<string, ItemRec> {
    const out = new Map<string, ItemRec>();
    if (m.forks.length === 0) return out;
    const counts = new Map<string, { n: number; first: number }>();
    for (const r of m.items.values()) {
      if (r.removed) continue;
      const lane = laneOfRec(r);
      if (lane === null) continue;
      const c = counts.get(lane) ?? { n: 0, first: Number.POSITIVE_INFINITY };
      c.n++;
      c.first = Math.min(c.first, Math.floor(r.ordinal / 100));
      counts.set(lane, c);
    }
    for (const fork of m.forks) {
      const node = m.nodes.get(fork.forkPointUuid);
      if (node === undefined) continue;
      const id = `${threadId}:syn:branch:${fork.forkPointUuid}`;
      const alternates = fork.laneIds.map((laneId) => {
        const c = counts.get(laneId);
        const rootOffset = m.nodes.get(laneId.slice("lane:".length))?.offset ?? -1;
        return { laneId, firstLine: m.lineOf.get(rootOffset) ?? -1, itemCount: c?.n ?? 0 };
      });
      const run = m.runByUuid.get(fork.forkPointUuid) ?? null;
      const ts = m.items.get(m.itemsByUuid.get(fork.forkPointUuid)?.[0] ?? "")?.item.startedAt ?? null;
      const ordinal = node.offset * 100 + 99;
      out.set(id, {
        id,
        ordinal,
        node: null,
        item: {
          id,
          threadId,
          runId: run?.runId ?? null,
          nodeId: null,
          providerThreadId,
          providerTurnId: run?.providerTurnId ?? null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed",
          title: null,
          startedAt: ts,
          completedAt: ts,
          updatedAt: ts ?? "",
          type: "system_notice",
          message: `Rewound branches: ${alternates.length}`,
          level: "info",
        },
        x: {
          raw: [],
          sourceKey: "synthetic:branch",
          noticeKind: "branch",
          branch: { forkPointUuid: fork.forkPointUuid, alternates },
        },
        visibility: "synthetic",
        sourceThreadId: threadId,
        sourceItemId: id,
        runId: run?.runId ?? null,
      });
    }
    return out;
  }

  function rebuildVisible(): void {
    branchNotices = buildBranchNotices();
    const list: ItemRec[] = [];
    for (const r of m.items.values()) if (!r.removed && laneOfRec(r) === null) list.push(r);
    for (const r of branchNotices.values()) list.push(r);
    list.sort((a, b) => a.ordinal - b.ordinal);
    visibleIds = list.map((r) => r.id);
    posOf = new Map(visibleIds.map((id, i) => [id, i]));
  }

  function recOf(id: string): ItemRec | undefined {
    return m.items.get(id) ?? branchNotices.get(id);
  }

  // ---- materialize ----

  function lastRunId(): string | null {
    return m.runOrder.at(-1) ?? null;
  }

  /** Status of an unresolved tool call depends on liveness and on being in the latest run. */
  function effectiveStatus(r: ItemRec): OrchestrationV2TurnItemStatus {
    const item = r.item;
    const t = r.tool;
    if (t === undefined || t.resolved || t.orphan || terminalStatus(item.status)) return item.status;
    const active = isLive() && r.runId !== null && r.runId === lastRunId();
    if (item.type === "user_input_request") return active ? "waiting" : "interrupted";
    return active ? "running" : "interrupted";
  }

  function row(r: ItemRec, position: number): OrchestrationV2ProjectedTurnItem {
    let item = r.item;
    let x = r.x;
    if (item.type === "subagent") {
      const eff = effectiveSubagent(r.id);
      if (eff !== null) {
        const e = eff.record;
        item = { ...item, status: e.status, childThreadId: e.childThreadId, title: e.title, result: e.result, completedAt: e.completedAt };
        x = { ...x, link: e.childThreadId === null ? { evidence: eff.evidence } : { threadId: e.childThreadId, evidence: eff.evidence } };
      }
    } else if (item.type === "notification" && item.source.kind === "subagent" && x.relatedCallId !== undefined) {
      const child = effectiveSubagent(`${threadId}:tool:${x.relatedCallId}`)?.record.childThreadId ?? null;
      if (child !== null) item = { ...item, source: { kind: "subagent", childThreadId: child } };
    } else {
      const status = effectiveStatus(r);
      if (status !== item.status) item = { ...item, status } as OrchestrationV2TurnItem;
    }
    return { position, visibility: r.visibility, sourceThreadId: r.sourceThreadId, sourceItemId: r.sourceItemId, item, x };
  }

  function visibleRows(): OrchestrationV2ProjectedTurnItem[] {
    return visibleIds.map((id, i) => row(recOf(id)!, i));
  }

  function branches(): ThreadBranches {
    const lanes = new Map<string, ItemRec[]>();
    for (const r of m.items.values()) {
      if (r.removed) continue;
      const lane = laneOfRec(r);
      if (lane === null) continue;
      const list = lanes.get(lane) ?? [];
      list.push(r);
      lanes.set(lane, list);
    }
    const out: ThreadBranches = { lanes: [] };
    for (const fork of m.forks) {
      for (const laneId of fork.laneIds) {
        const list = (lanes.get(laneId) ?? []).sort((a, b) => a.ordinal - b.ordinal);
        out.lanes.push({ laneId, forkPointUuid: fork.forkPointUuid, items: list.map((r, i) => row(r, i)) });
      }
    }
    return out;
  }

  function hasPendingInput(runId: string): boolean {
    for (const id of m.unresolved) {
      const r = m.items.get(id);
      if (r !== undefined && r.item.type === "user_input_request" && r.runId === runId) return true;
    }
    return false;
  }

  /**
   * When a turn this server saw ended the run: the result that names the run's opener, else, for a
   * turn the CLI started itself, the first result without names between the run's start and the
   * next run's.
   */
  function seenEnd(run: RunRec, next: RunRec | undefined): string | null {
    for (const e of turns.ends) if (e.userMessageUuids.includes(run.openerUuid)) return e.at;
    const from = run.requestedAt === null ? Number.NaN : Date.parse(run.requestedAt);
    if (!Number.isFinite(from)) return null;
    const to = next?.requestedAt ? Date.parse(next.requestedAt) : Number.POSITIVE_INFINITY;
    for (const e of turns.ends) {
      if (e.userMessageUuids.length > 0) continue;
      const t = Date.parse(e.at);
      if (t >= from && t <= to) return e.at;
    }
    return null;
  }

  /**
   * The run is still going: the latest one, without a turn_duration line, and its process is
   * still in a turn. A process this server runs answers that itself (its turn ended at a result
   * even while background tasks go on); for any other process the registry status does.
   */
  function runOpen(run: RunRec, next: RunRec | undefined, end: string | null): boolean {
    if (next !== undefined || run.endSignal) return false;
    return turns.run !== null ? turns.run.busy && end === null : isLive();
  }

  function runSummary(run: RunRec): ThreadRunSummary {
    const nextId = m.runOrder[run.index + 1];
    const next = nextId === undefined ? undefined : m.runs.get(nextId);
    const end = run.endSignal ? null : seenEnd(run, next);
    const open = runOpen(run, next, end);
    const waiting = live === "waiting" || turns.run?.waiting === true;
    let status: ThreadRunSummary["status"];
    if (run.endSignal) status = "completed";
    else if (run.interrupted) status = "interrupted";
    else if (run.lastItemType === "error") status = "failed";
    else if (open) status = hasPendingInput(run.runId) || waiting ? "waiting" : "running";
    else status = "completed";
    const completedAt = run.endSignal ? run.completedAt : open ? null : (end ?? run.contentTs ?? run.lastTs);
    return {
      runId: run.runId,
      status,
      requestedAt: run.requestedAt,
      startedAt: run.requestedAt,
      completedAt,
      assistantMessageId: run.assistantMessageId,
      ...(run.turnEnded === undefined ? {} : { turnEnded: run.turnEnded }),
    };
  }

  function runtime(): ThreadRuntimeSummary {
    const last = lastRunId();
    const tr = turns.run;
    if (tr === null) {
      const status: ThreadRuntimeSummary["status"] = live === "busy" ? "running" : live === "waiting" ? "waiting" : "idle";
      const active = status !== "idle" ? last : null;
      return {
        status,
        activeRunId: active,
        activityStartedAt: active === null ? null : (m.runs.get(active)?.requestedAt ?? null),
        providerInstanceId,
        providerName: "Claude",
        lastError: m.lastError,
      };
    }
    // A process this server runs. A busy process whose latest run already ended works on a turn
    // whose opener is not read yet (a message just sent, a task notification): it is active
    // without a run.
    const status: ThreadRuntimeSummary["status"] = tr.waiting ? "waiting" : tr.busy ? "running" : "idle";
    const lastRun = last === null ? undefined : m.runs.get(last);
    const active = status !== "idle" && lastRun !== undefined && runOpen(lastRun, undefined, seenEnd(lastRun, undefined)) ? last : null;
    return {
      status,
      activeRunId: active,
      activityStartedAt: active !== null ? (lastRun?.requestedAt ?? null) : status !== "idle" ? tr.busySince : null,
      providerInstanceId,
      providerName: "Claude",
      lastError: m.lastError,
    };
  }

  function tokenUsage(): ThreadTokenUsageSnapshot | null {
    if (m.lastStep === null && m.costUsd === null) return null;
    const t = m.usageTotal;
    const l = m.lastStep ?? { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
    const lastInput = l.input + l.cacheRead + l.cacheCreation;
    const req = m.lastRequest;
    const maxTokens = req !== null ? claudeContextWindow(req.model, req.oneMillion) : claudeContextWindow(m.state.model, null, m.peakContext);
    const last = lastRunId();
    const runOutputTokens = last === null ? undefined : (m.outputByRun.get(last) ?? 0);
    return {
      usedTokens: lastInput + l.output,
      totalProcessedTokens: t.input + t.cacheRead + t.cacheCreation + t.output,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(runOutputTokens === undefined ? {} : { runOutputTokens }),
      inputTokens: t.input + t.cacheRead + t.cacheCreation,
      cachedInputTokens: t.cacheRead,
      outputTokens: t.output,
      lastUsedTokens: lastInput + l.output,
      lastInputTokens: lastInput,
      lastCachedInputTokens: l.cacheRead,
      lastOutputTokens: l.output,
      ...(m.costUsd === null ? {} : { cost: { amount: m.costUsd, currency: "USD" } }),
      ...(m.cacheAt === null ? {} : { promptCache: { at: m.cacheAt, ttlMs: m.cacheTtlMs ?? PROMPT_CACHE_TTL_5M_MS, ...(m.cacheCold ? { cold: true as const } : {}) } }),
    };
  }

  function titleAndSource(): { title: string; nameSource: ThreadProjectionState["nameSource"] } {
    if (kind === "sub") {
      const t = str(ownMeta?.name) ?? str(ownMeta?.description) ?? str(ownMeta?.agentType);
      if (t !== undefined) return { title: t, nameSource: "subagent-meta" };
    } else {
      if (m.state.customTitle !== undefined) return { title: m.state.customTitle, nameSource: "custom-title" };
      if (m.state.agentName !== undefined) return { title: m.state.agentName, nameSource: "agent-name" };
      if (m.state.aiTitle !== undefined) return { title: m.state.aiTitle, nameSource: "ai-title" };
    }
    if (m.firstPrompt !== null) return { title: promptTitle(m.firstPrompt), nameSource: "first-prompt" };
    return { title: (ctx.agentId ?? ctx.sessionId).slice(0, 8), nameSource: "id" };
  }

  /** The request's model and the thread's model are one model that can run at 1M (dates and `[1m]` ignored). */
  function sameOneMillionModel(requested: string, model: string | undefined): boolean {
    const a = oneMillionModelOf(requested);
    return a !== null && a === oneMillionModelOf(model);
  }

  function threadState(): ThreadProjectionState {
    const { nameSource } = titleAndSource();
    const mainLeaf = lastMainLeaf();
    // A process this server runs reports its mode as it changes; the transcript records a change
    // only with a later line, if at all (no permission-mode line for an SDK setPermissionMode).
    const mode = turns.run?.permissionMode ?? null;
    return {
      ownership: ctx.readonly ? "terminal" : "headless",
      control: ctx.readonly ? "readonly" : "headless",
      nameSource,
      ...m.state,
      ...goalPart(),
      transcriptPath: ctx.path,
      ...(mode === null ? {} : { permissionMode: mode }),
      // The transcript names a model without "[1m]"; the latest request's context-1m beta tells the run was at 1M.
      // A boolean (not absent) once a request is known, so a live patch can clear it.
      ...(m.lastRequest === null ? {} : { oneMillion: m.lastRequest.oneMillion && sameOneMillionModel(m.lastRequest.model, m.state.model) }),
      // Always present (null when empty) for a session this server can drive, so a patch can clear it.
      ...(turns.chosen === undefined ? {} : { chosen: turns.chosen }),
      ...(mainLeaf === null ? {} : { mainLeafUuid: mainLeaf }),
      ...(m.byModel === undefined ? {} : { byModel: m.byModel }),
      stats: statsCopy(),
    };
  }

  /**
   * state.goal: absent until a goal_status record is known, then the goal or null (a later patch
   * can clear it). The scanned history stands for the lines before its endOffset, the loaded lines
   * for the rest; a live process's active_goal message counts while the transcript is behind it.
   */
  function goalPart(): { goal?: ThreadGoalState | null } {
    const events = goalHistory === null ? m.goalEvents : [...goalHistory.events, ...m.goalEvents.filter((e) => e.offset >= goalHistory!.endOffset)];
    const live = turns.run?.activeGoal;
    if (events.length === 0 && live === undefined) return {};
    return { goal: chooseGoal(reduceGoal(events), lastEventAt(events), live) };
  }

  function lastMainLeaf(): string | null {
    for (let i = m.nodeOrder.length - 1; i >= 0; i--) {
      const uuid = m.nodeOrder[i]!;
      if (!m.alt.has(uuid)) return uuid;
    }
    return null;
  }

  function lineage(): OrchestrationV2AppThreadLineage {
    if (kind === "sub") return { parentThreadId: parentThreadIdOf(threadId), relationshipToParent: "subagent", rootThreadId: rootThreadIdOf(threadId) };
    if (m.forkedFrom !== null) return { parentThreadId: siblingThreadId(threadId, m.forkedFrom), relationshipToParent: "fork", rootThreadId: threadId };
    return { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId };
  }

  function subagentRecords(): OrchestrationV2Subagent[] {
    return [...m.subagents.keys()].map((id) => effectiveSubagent(id)!.record);
  }

  function statsCopy(): StatsT {
    const s = m.stats;
    return {
      linesRead: s.linesRead,
      parseFailures: s.parseFailures,
      partialTail: s.partialTail,
      byKey: { ...s.byKey },
      displayedByKey: { ...s.displayedByKey },
      hiddenByKey: { ...s.hiddenByKey },
      unknownByKey: { ...s.unknownByKey },
    };
  }

  function pendingInputs(): PendingUserInput[] {
    if (ctx.readonly || !isLive()) return [];
    const last = lastRunId();
    const out: PendingUserInput[] = [];
    for (const id of m.unresolved) {
      const r = m.items.get(id);
      if (r === undefined || r.item.type !== "user_input_request" || r.runId !== last || r.removed) continue;
      out.push({ requestId: r.item.requestId, itemId: r.id, questions: r.item.questions, createdAt: r.item.startedAt });
    }
    return out;
  }

  // ---- whole refold ----

  function refold(): void {
    m = new Model();
    assignLines();
    for (let i = 0; i < entries.length; i++) apply(entries[i]!, i === 0 ? undefined : entries[i - 1]);
    recomputeLanes();
    syncSidecars();
    m.dirty = newDirty();
    rebuildVisible();
  }

  function ingest(records: RawRecord[]): LineFacts[] {
    const out: LineFacts[] = [];
    for (const r of records) {
      if (offsets.has(r.offset)) continue;
      offsets.add(r.offset);
      out.push(extractLine(r, xctx));
    }
    return out;
  }

  // ---- events ----

  interface Before {
    title: string;
    state: string;
    runtime: string;
    usage: string;
    pending: string;
  }

  function before(): Before {
    const { nameSource, ...rest } = threadState();
    return {
      title: titleAndSource().title,
      state: JSON.stringify({ ...rest, nameSource, stats: undefined }),
      runtime: JSON.stringify(runtime()),
      usage: JSON.stringify(tokenUsage()),
      pending: JSON.stringify(pendingInputs()),
    };
  }

  function stateDiff(prevJson: string): Partial<ThreadProjectionState> | null {
    const prev = JSON.parse(prevJson) as Record<string, unknown>;
    const { stats: _stats, ...cur } = threadState();
    const diff: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(prev), ...Object.keys(cur)]);
    for (const k of keys) {
      if (k === "stats") continue;
      const a = JSON.stringify(prev[k]);
      const b = JSON.stringify((cur as Record<string, unknown>)[k]);
      if (a !== b) diff[k] = (cur as Record<string, unknown>)[k];
    }
    return Object.keys(diff).length === 0 ? null : (diff as Partial<ThreadProjectionState>);
  }

  function collectEvents(b: Before, forceReplace: "branch" | "resync" | null): ThreadLiveEvent[] {
    const d = m.dirty;
    const events: ThreadLiveEvent[] = [];
    let replace = forceReplace;
    if (d.newOpener) {
      const prevAlt = m.alt;
      const prevForks = JSON.stringify(m.forks);
      recomputeLanes();
      let changed = prevForks !== JSON.stringify(m.forks) || prevAlt.size !== m.alt.size;
      if (!changed) for (const [k, v] of m.alt) if (prevAlt.get(k) !== v) { changed = true; break; }
      if (changed) replace = "branch";
    }
    // A removal shifts positions only when the client saw the item.
    if (replace === null && d.removed.some((id) => posOf.has(id))) replace = "resync";
    // An item created again under an id the client holds (an orphan result joined by its call).
    if (replace === null) for (const id of d.created) if (posOf.has(id)) { replace = "resync"; break; }
    if (replace === null) {
      for (const id of [...d.created, ...d.items]) {
        const r = m.items.get(id);
        if (r !== undefined && !r.removed && laneOfRec(r) !== null) {
          replace = "branch";
          break;
        }
      }
    }
    const created = [...d.created].map((id) => m.items.get(id)!).filter((r) => !r.removed && laneOfRec(r) === null);
    created.sort((a, b2) => a.ordinal - b2.ordinal);
    if (replace === null && created.length > 0 && visibleIds.length > 0) {
      const lastOrdinal = recOf(visibleIds.at(-1)!)!.ordinal;
      if (created[0]!.ordinal < lastOrdinal) replace = "resync";
    }
    if (replace !== null) {
      rebuildVisible();
      events.push({ t: "turnItems.replaced", threadId, reason: replace, visibleTurnItems: visibleRows(), branches: branches() });
    } else {
      for (const r of created) {
        posOf.set(r.id, visibleIds.length);
        visibleIds.push(r.id);
      }
      const ids = new Set<string>([...d.items, ...d.created]);
      const rows: OrchestrationV2ProjectedTurnItem[] = [];
      for (const id of ids) {
        const pos = posOf.get(id);
        const r = recOf(id);
        if (pos === undefined || r === undefined) continue;
        rows.push(row(r, pos));
      }
      rows.sort((a, b2) => a.position - b2.position);
      for (const rowItem of rows) events.push({ t: "turnItem.upserted", threadId, row: rowItem });
    }
    for (const runId of d.runs) {
      const run = m.runs.get(runId);
      if (run !== undefined) events.push({ t: "run.upserted", threadId, run: runSummary(run) });
    }
    const subs = new Map(subagentRecords().map((s) => [s.id, s]));
    for (const id of d.subagents) {
      const s = subs.get(id);
      if (s !== undefined) events.push({ t: "subagent.upserted", threadId, subagent: s });
    }
    const title = titleAndSource().title;
    const stateChange = stateDiff(b.state);
    if (title !== b.title || stateChange !== null) {
      events.push({ t: "thread.patched", threadId, ...(title !== b.title ? { title } : {}), ...(stateChange === null ? {} : { state: stateChange }) });
    }
    const usageJson = JSON.stringify(tokenUsage());
    if (usageJson !== b.usage) {
      const usage = tokenUsage();
      if (usage !== null) events.push({ t: "tokenUsage.updated", threadId, usage });
    }
    if (JSON.stringify(runtime()) !== b.runtime) events.push({ t: "runtime.updated", threadId, runtime: runtime() });
    if (!ctx.readonly) {
      const p = pendingInputs();
      if (JSON.stringify(p) !== b.pending) events.push({ t: "pending.updated", threadId, approvals: [], userInputs: p });
    }
    m.dirty = newDirty();
    return events;
  }

  // ---- public ----

  return {
    push(records) {
      const facts = ingest(records);
      if (facts.length === 0) return [];
      const lastLoaded = entries.at(-1)?.offset ?? -1;
      const inOrder = facts.every((f, i) => f.offset > (i === 0 ? lastLoaded : facts[i - 1]!.offset));
      const b = before();
      if (!inOrder) {
        // A line older than the loaded tail (a gap filled late): refold everything.
        entries = [...entries, ...facts].sort((a, c) => a.offset - c.offset);
        refold();
        m.dirty = newDirty();
        return collectEvents(b, "resync");
      }
      const firstLoad = entries.length === 0;
      const subsBefore = m.subagents.size;
      const workflowsBefore = [...m.subagents.values()].filter((s) => s.runHandles?.runId !== undefined).length;
      for (const f of facts) {
        apply(f, entries.at(-1));
        entries.push(f);
      }
      const workflowsAfter = [...m.subagents.values()].filter((s) => s.runHandles?.runId !== undefined).length;
      if (firstLoad || m.subagents.size !== subsBefore || workflowsAfter !== workflowsBefore) syncSidecars();
      return collectEvents(b, null);
    },

    prepend(records) {
      const facts = ingest(records);
      if (facts.length === 0) return;
      entries = [...facts, ...entries].sort((a, c) => a.offset - c.offset);
      refold();
    },

    snapshot() {
      const { title } = titleAndSource();
      return {
        threadId,
        lineage: lineage(),
        providerInstanceId,
        title,
        state: threadState(),
        runtime: runtime(),
        runs: m.runOrder.map((id) => runSummary(m.runs.get(id)!)),
        visibleTurnItems: visibleRows(),
        branches: branches(),
        subagents: subagentRecords(),
        tokenUsage: tokenUsage(),
        hasMoreBefore: (entries[0]?.offset ?? 0) > 0,
      };
    },

    stats() {
      return statsCopy();
    },

    setLiveStatus(status) {
      if (status === live) return [];
      const b = before();
      live = status;
      for (const id of m.unresolved) touch(id);
      for (const id of m.subagents.keys()) {
        m.dirty.subagents.add(id);
        touch(id);
      }
      const last = lastRunId();
      if (last !== null) m.dirty.runs.add(last);
      return collectEvents(b, null);
    },

    setGoalHistory(history) {
      const b = before();
      goalHistory = history;
      return collectEvents(b, null);
    },

    setTurns(info) {
      const b = before();
      const prev = m.runOrder.map((id) => JSON.stringify(runSummary(m.runs.get(id)!)));
      // A rewind made or dropped moves the lanes (collectEvents recomputes them and replaces the rows).
      if (JSON.stringify(turns.rewind ?? null) !== JSON.stringify(info.rewind ?? null)) m.dirty.newOpener = true;
      turns = info;
      m.runOrder.forEach((id, i) => {
        if (JSON.stringify(runSummary(m.runs.get(id)!)) !== prev[i]) m.dirty.runs.add(id);
      });
      return collectEvents(b, null);
    },

    refreshSidecars() {
      const b = before();
      syncSidecars();
      return collectEvents(b, null);
    },

    pending() {
      return { approvals: [], userInputs: pendingInputs() };
    },

    needsOlder() {
      const waiting = waitingRewind();
      return waiting !== null && (waiting.lastIndex === null || !m.nodes.has(waiting.marker.keepUuid));
    },

    children() {
      const out: ClaudeChildTranscript[] = [];
      for (const [id, s] of m.subagents) {
        const agentId = overlays.get(id)?.meta?.agentId ?? s.agentId;
        if (agentId !== null) {
          out.push({
            childThreadId: childThreadIdOf(threadId, agentId),
            agentId,
            parentItemId: id,
            relativePath: sessionDir === null ? null : childTranscriptRelativePath(sessionDir, agentId),
          });
        }
        const runId = s.runHandles?.runId;
        for (const agent of effectiveSubagent(id)?.record.workflow?.agents ?? []) {
          if (agent.agentId === undefined) continue;
          out.push({
            childThreadId: childThreadIdOf(threadId, agent.agentId),
            agentId: agent.agentId,
            parentItemId: id,
            relativePath: sessionDir === null ? null : childTranscriptRelativePath(sessionDir, agent.agentId, runId),
            ...(runId === undefined ? {} : { workflowRunId: runId }),
          });
        }
      }
      return out;
    },
  };
}
