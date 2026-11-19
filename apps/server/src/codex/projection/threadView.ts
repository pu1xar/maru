// Projection of one Codex thread for the UI: a snapshot of the latest turns, older pages on
// request, and live events while the daemon holds the thread (docs/event-model.md 5.8, 6.3, 7.4,
// 7.6, 7.10, 7.12; docs/measurements-2026-11-15.md 5).
//
// Daemon calls, in order of use:
// - thread/read {includeTurns: false}: metadata and status. It does not load the thread.
// - thread/resume {excludeTurns: true}: subscribes this connection to the thread's turn, item
//   and delta notifications. Only for a thread the daemon already holds (status idle or active):
//   resuming a notLoaded thread would load it and start its MCP servers and hooks.
// - thread/turns/list {sortDirection: desc, itemsView: full}: history, one page of turns at a time.
//   A paginated thread the daemon serves without turns (its history projection is missing) is
//   read from its rollout file instead, in the same page shape (rolloutFallback.ts, turnsPage).
// - thread/unsubscribe on close(). The thread itself stays open in the daemon.
//
// thread/status/changed reaches every connection without a subscription. The view listens for it
// on its own rpc connection: when a notLoaded thread becomes idle or active (another client
// started a turn), the view resumes it and re-reads the newest turns. A reconnect of the rpc
// connection does the same, since subscriptions belong to a connection.
//
// While a snapshot or a re-read is in flight, notifications for the thread wait in a buffer and
// apply after it, so nothing between the subscription and the page is lost. A delta for an item
// the page already has as finished is dropped (item/completed is authoritative). For an item the
// page returned still running, the page text may already hold the first waiting deltas: the
// longest run of waiting deltas that the page text ends with is skipped and the rest appended.
//
// Subscriptions belong to a connection, so a connection carries at most one view per thread: a
// second view's close() would end the first one's subscription.
//
// This view registers no server request handler, and its pending lists stay empty. The daemon
// sends a thread's requests to every subscribed connection, this one included (measured
// 2026-11-15); CodexRpc leaves a request without a handler unanswered by default, so the client
// that drives the turn answers it (drive/codexRuns.ts for turns this server starts).

import path from "node:path";
import type {
  IsoDateTime,
  OrchestrationV2AppThreadLineage,
  OrchestrationV2PlanStep,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ProviderFailure,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemStatus,
  ProjectionExtension,
  RawRef,
  ThreadLiveEvent,
  ThreadProjectionState,
  ThreadRunSummary,
  ThreadRuntimeSummary,
  ThreadGoalState,
  ThreadSnapshot,
  ThreadTokenUsageSnapshot,
} from "@maru/shared";
import type { ClientMethod, CodexRpc, NotificationMethod, NotificationParams, ParamsOf } from "../rpc.ts";
import type { Thread } from "../protocol/v2/Thread.ts";
import type { ThreadGoal } from "../protocol/v2/ThreadGoal.ts";
import type { ThreadGoalGetResponse } from "../protocol/v2/ThreadGoalGetResponse.ts";
import type { ThreadItem } from "../protocol/v2/ThreadItem.ts";
import type { ThreadReadResponse } from "../protocol/v2/ThreadReadResponse.ts";
import type { ThreadResumeResponse } from "../protocol/v2/ThreadResumeResponse.ts";
import type { ThreadStatus } from "../protocol/v2/ThreadStatus.ts";
import type { ThreadTurnsListResponse } from "../protocol/v2/ThreadTurnsListResponse.ts";
import type { Turn } from "../protocol/v2/Turn.ts";
import type { TurnStatus } from "../protocol/v2/TurnStatus.ts";
import { GOAL_STATUS_LABEL } from "@maru/shared";
import {
  baseFields,
  codexItemKey,
  codexItemRowId,
  diffLineCounts,
  fileChangeFields,
  mapThreadItem,
  settle,
} from "./mapItems.ts";
import type { CodexMapContext, ItemDisposition, ItemLifecycle, MappedItem, MappedRow } from "./mapItems.ts";
import {
  codexRunId,
  codexThreadKey,
  isLoadedStatus,
  isWaitingStatus,
  isoFromSec,
  threadRuntime,
  tokenUsageSnapshot,
  turnFailure,
  turnSummary,
  turnToRun,
} from "./summaries.ts";
import type { TurnSummary } from "./summaries.ts";
import { isRolloutCursor } from "./rolloutFallback.ts";
import type { RolloutHistory, RolloutHistoryStats } from "./rolloutFallback.ts";

/** The part of CodexRpc a view uses. `home` names the provider instance (`codex:.codex`). */
export type CodexThreadRpc = Pick<CodexRpc, "request" | "on" | "onConnected"> & { readonly home?: string };

export interface CodexThreadViewDeps {
  rpc: CodexThreadRpc;
  account: string;
  threadId: string;
  /** Another process drives the thread: the UI only watches (control "readonly"). */
  readonly: boolean;
  /** Upper bound for each daemon request, ms. Default 60000. */
  requestTimeoutMs?: number;
  /**
   * History read from the rollout file, for a paginated thread the daemon serves without turns
   * (rolloutFallback.ts). Called once, when the daemon's newest page first comes back empty.
   */
  rolloutHistory?: (thread: Thread) => RolloutHistory | null;
  /** Told after each rollout page, with the history's counters. */
  onRolloutPage?: (stats: RolloutHistoryStats) => void;
}

export interface CodexThreadViewStats {
  /** Daemon methods this view called, with counts. */
  calls: Record<string, number>;
  subscribed: boolean;
  resumes: number;
  unsubscribes: number;
  resyncs: number;
  /** thread/turns/list pages read. */
  pages: number;
  turns: number;
  rows: number;
  /** Notifications that waited for a snapshot or re-read and were applied after it. */
  buffered: number;
  /** Deltas for an item already finished (the final value is kept). */
  droppedDeltas: number;
  /** Rows created from a delta whose item/started this connection never saw. */
  rowsFromDeltas: number;
  /** Live rows that landed before the end of the list and forced a full replace. */
  outOfOrderInserts: number;
  listenerErrors: number;
  /** thread/goal/get calls the daemon refused (the thread has no goal state, e.g. a temporary one). */
  goalReadFailures: number;
  errors: number;
  lastError: string | null;
  /** ms for load(). */
  loadMs: number | null;
  /** Record counters (every history item, turn and notification for this thread). */
  records: ThreadProjectionState["stats"];
  /** The rollout history's counters, once the view has read it. */
  rollout: RolloutHistoryStats | null;
}

export interface CodexThreadView {
  /** The newest page of turns, and a subscription when the daemon holds the thread. */
  load(opts: { pageSize: number }): Promise<ThreadSnapshot>;
  /**
   * The previous page of turns: a full `turnItems.replaced` plus the new runs. Also sent to onEvent
   * listeners. `limit`: this page's turns instead of the view's page size (a find reading the whole
   * thread asks for growing pages, DESIGN.md 6u).
   */
  loadOlder(limit?: number): Promise<ThreadLiveEvent[]>;
  onEvent(cb: (e: ThreadLiveEvent) => void): () => void;
  /** thread/unsubscribe when subscribed. The thread stays open in the daemon. */
  close(): Promise<void>;
  /** Whether older turns exist before the loaded ones (ThreadLiveEvent has no field for it). */
  readonly hasMoreBefore: boolean;
  snapshot(): ThreadSnapshot;
  /** The visible rows as held, not copied (snapshot() copies everything): for counting, not to keep. */
  visibleRows(): readonly OrchestrationV2ProjectedTurnItem[];
  stats(): CodexThreadViewStats;
}

/** Notification methods whose params name a thread (an index signature such as skills/changed does not count). */
type ThreadScopedMethod = {
  [M in NotificationMethod]: string extends keyof NotificationParams<M>
    ? never
    : "threadId" extends keyof NotificationParams<M>
      ? M
      : never;
}[NotificationMethod];

/**
 * Every thread-scoped notification: handled ones change the projection, hidden ones are only
 * counted (list-level thread state that the session index owns, realtime audio, raw responses).
 * `satisfies` fails the type check when a regenerated protocol adds or drops a method.
 */
const THREAD_METHODS = {
  error: "handled",
  "thread/status/changed": "handled",
  "thread/archived": "handled",
  "thread/deleted": "handled",
  "thread/closed": "handled",
  "thread/reverted": "handled",
  "thread/name/updated": "handled",
  "thread/goal/updated": "handled",
  "thread/goal/cleared": "handled",
  "thread/tokenUsage/updated": "handled",
  "thread/compacted": "handled",
  "turn/started": "handled",
  "turn/completed": "handled",
  "turn/diff/updated": "handled",
  "turn/plan/updated": "handled",
  "hook/started": "handled",
  "hook/completed": "handled",
  "item/started": "handled",
  "item/completed": "handled",
  "item/agentMessage/delta": "handled",
  "item/plan/delta": "handled",
  "item/reasoning/summaryTextDelta": "handled",
  "item/reasoning/summaryPartAdded": "handled",
  "item/reasoning/textDelta": "handled",
  "item/commandExecution/outputDelta": "handled",
  "item/commandExecution/terminalInteraction": "handled",
  "item/fileChange/outputDelta": "handled",
  "item/fileChange/patchUpdated": "handled",
  "item/mcpToolCall/progress": "handled",
  "item/autoApprovalReview/started": "handled",
  "item/autoApprovalReview/completed": "handled",
  "autoApprovalReview/strictReviewRequired": "handled",
  "serverRequest/resolved": "handled",
  "mcpServer/startupStatus/updated": "handled",
  "model/rerouted": "handled",
  "model/verification": "handled",
  "modelProvider/authRecoveryStarted": "handled",
  "modelProvider/authRecoveryCompleted": "handled",
  "turn/moderationMetadata": "handled",
  "model/safetyBuffering/updated": "handled",
  warning: "handled",
  guardianWarning: "handled",
  "thread/readState/changed": "hidden",
  "thread/unarchived": "hidden",
  "thread/section/changed": "hidden",
  "thread/attachment/updated": "hidden",
  "thread/prediction/updated": "hidden",
  "thread/queue/changed": "hidden",
  "thread/project/updated": "hidden",
  "thread/environment/connected": "hidden",
  "thread/environment/disconnected": "hidden",
  "thread/settings/updated": "handled",
  "rawResponseItem/completed": "hidden",
  "rawResponse/completed": "hidden",
  "mcpServer/oauthLogin/completed": "hidden",
  "thread/realtime/started": "hidden",
  "thread/realtime/itemAdded": "hidden",
  "thread/realtime/item/started": "hidden",
  "thread/realtime/item/transcript/delta": "hidden",
  "thread/realtime/item/completed": "hidden",
  "thread/realtime/transcript/delta": "hidden",
  "thread/realtime/transcript/done": "hidden",
  "thread/realtime/outputAudio/delta": "hidden",
  "thread/realtime/sdp": "hidden",
  "thread/realtime/error": "hidden",
  "thread/realtime/closed": "hidden",
} as const satisfies Record<ThreadScopedMethod, "handled" | "hidden">;

export const THREAD_SCOPED_METHODS = Object.keys(THREAD_METHODS) as ThreadScopedMethod[];

/** Notifications that append to a row's text. */
const DELTA_METHODS = new Set<ThreadScopedMethod>([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/reasoning/summaryTextDelta",
]);

const INTERRUPTED_TEXT = "Turn interrupted";
const FAILED_TEXT = "Turn failed";

interface RowState {
  /** Internal and mutable; consumers only ever get clones. */
  row: OrchestrationV2ProjectedTurnItem;
  turnId: string | null;
  /** reasoning: the summary part the text currently ends in. */
  summaryIndex: number;
}

interface TurnState {
  id: string;
  summary: TurnSummary;
  /** Row ids of this turn in display order. */
  rowIds: string[];
  /** userMessage rows so far (the first opens the turn, later ones are steers). */
  userMessages: number;
}

type SyncReason = "resync" | "reverted";

export function createCodexThreadView(deps: CodexThreadViewDeps): CodexThreadView {
  return new ThreadView(deps);
}

class ThreadView implements CodexThreadView {
  private readonly rpc: CodexThreadRpc;
  private readonly account: string;
  private readonly threadId: string;
  private readonly readonlyView: boolean;
  private readonly timeoutMs: number;
  private readonly key: string;
  private readonly providerInstanceId: string;

  private thread: Thread | null = null;
  private status: ThreadStatus = { type: "notLoaded" };
  private turns: TurnState[] = [];
  private readonly turnById = new Map<string, TurnState>();
  /** Rows before the first turn: the fork marker, notices that arrived before any turn. */
  private headRowIds: string[] = [];
  private readonly rows = new Map<string, RowState>();
  private order: string[] = [];
  private olderCursor: string | null = null;
  private readonly openRollout: CodexThreadViewDeps["rolloutHistory"];
  private readonly onRolloutPage: CodexThreadViewDeps["onRolloutPage"];
  /** Made on the first empty daemon page; kept, since the view may hold its cursors. */
  private rollout: RolloutHistory | null = null;
  /** Turns whose rows came from the rollout (x.raw conn "rollout"); a daemon page takes a turn back. */
  private readonly rolloutTurns = new Set<string>();
  private pageSize = 20;
  private tokenUsage: ThreadTokenUsageSnapshot | null = null;
  private readonly subagents = new Map<string, OrchestrationV2Subagent>();
  private readonly subagentByChild = new Map<string, string>();
  /** Newest known status per child thread (raw id), also for children whose spawn is not loaded yet. */
  private readonly childStatus = new Map<string, OrchestrationV2Subagent["status"]>();
  private lastGoal: string | null = null;
  /** state.goal: the newest goal the daemon told this view of (undefined until a read or an update). */
  private goal: ThreadGoalState | null | undefined = undefined;
  /** Counts goal updates and clears, so a goal read can tell it is older than one that arrived meanwhile. */
  private goalSeq = 0;
  private readonly retriesByTurn = new Map<string, number>();
  private seq = 0;

  private loaded = false;
  private closed = false;
  private subscribed = false;
  private syncing = false;
  private quiet = false;
  private resyncQueued = false;
  private buffer: Array<{ method: ThreadScopedMethod; params: unknown }> = [];
  /** True while waiting notifications are applied. */
  private draining = false;
  /** Running rows the last page returned with streamed text (see the header). */
  private readonly pageHeld = new Set<string>();
  /** While draining: how many leading waiting deltas of a row the page text already holds. */
  private readonly deltaSkips = new Map<string, number>();
  /** thread/compacted per turn; a compaction row is made at turn end unless an item covers it. */
  private readonly compactedTurns = new Set<string>();
  /** archived or deleted while load() applied waiting notifications without events. */
  private removedDuringLoad: "archived" | "deleted" | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelayMs = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private listening = false;
  private readonly offs: Array<() => void> = [];
  private readonly listeners = new Set<(e: ThreadLiveEvent) => void>();
  /** What listeners last got, so unchanged runs and runtime are not re-sent. */
  private readonly sentRuns = new Map<string, string>();
  private sentRuntime = "";

  private readonly records: ThreadProjectionState["stats"] = {
    linesRead: 0,
    parseFailures: 0,
    partialTail: 0,
    byKey: {},
    displayedByKey: {},
    hiddenByKey: {},
    unknownByKey: {},
  };
  private readonly counters = {
    calls: {} as Record<string, number>,
    resumes: 0,
    unsubscribes: 0,
    resyncs: 0,
    pages: 0,
    buffered: 0,
    droppedDeltas: 0,
    rowsFromDeltas: 0,
    outOfOrderInserts: 0,
    listenerErrors: 0,
    goalReadFailures: 0,
    errors: 0,
    lastError: null as string | null,
    loadMs: null as number | null,
  };

  constructor(deps: CodexThreadViewDeps) {
    this.rpc = deps.rpc;
    this.account = deps.account;
    this.threadId = deps.threadId;
    this.readonlyView = deps.readonly;
    this.timeoutMs = deps.requestTimeoutMs ?? 60_000;
    this.openRollout = deps.rolloutHistory;
    this.onRolloutPage = deps.onRolloutPage;
    this.key = codexThreadKey(deps.account, deps.threadId);
    this.providerInstanceId = deps.rpc.home ? `codex:${path.basename(deps.rpc.home)}` : `codex:${deps.account}`;
  }

  get hasMoreBefore(): boolean {
    return this.olderCursor !== null;
  }

  // ---- public API ----

  load(opts: { pageSize: number }): Promise<ThreadSnapshot> {
    if (this.closed) return Promise.reject(new Error(`thread view ${this.key} is closed`));
    return this.serial(async () => {
      if (this.loaded) return this.snapshot();
      const t0 = performance.now();
      this.pageSize = Math.max(1, Math.floor(opts.pageSize));
      this.listen();
      this.syncing = true;
      this.buffer = [];
      this.pageHeld.clear();
      try {
        await this.readThread();
        if (this.mayResume()) await this.tryResume();
        const page = await this.turnsPage(null);
        this.ingestPage(page.data, "replace");
        this.olderCursor = page.nextCursor;
        this.addForkMarker();
        this.settleQuestions(false);
        this.rebuildOrder();
        this.loaded = true;
      } catch (err) {
        this.syncing = false;
        this.buffer = [];
        this.noteError(err);
        // Do not leave a subscription behind for a view that never loaded.
        await this.unsubscribe();
        throw err;
      }
      // Apply what waited without events: the snapshot below includes it.
      this.syncing = false;
      this.quiet = true;
      try {
        this.drainBuffer();
      } finally {
        this.quiet = false;
      }
      this.counters.loadMs = Math.round(performance.now() - t0);
      const snap = this.snapshot();
      this.markSent();
      const removed = this.removedDuringLoad;
      this.removedDuringLoad = null;
      // After the caller has the snapshot.
      if (removed) setImmediate(() => this.closed || this.emit({ t: "thread.removed", threadId: this.key, reason: removed }));
      this.maybeResubscribe();
      return snap;
    });
  }

  loadOlder(limit?: number): Promise<ThreadLiveEvent[]> {
    return this.serial(async () => {
      if (!this.loaded || this.closed || this.olderCursor === null) return [];
      const page = await this.turnsPage(this.olderCursor, limit);
      this.olderCursor = page.nextCursor;
      const { turns, subagents } = this.ingestPage(page.data, "prepend");
      this.pageHeld.clear();
      this.addForkMarker();
      this.settleQuestions(false);
      this.rebuildOrder();
      const events: ThreadLiveEvent[] = [this.replacedEvent("resync")];
      for (const ts of turns) {
        const run = this.runOf(ts);
        this.sentRuns.set(ts.id, JSON.stringify(run));
        events.push({ t: "run.upserted", threadId: this.key, run });
      }
      for (const id of subagents) {
        const s = this.subagents.get(id);
        if (s) events.push({ t: "subagent.upserted", threadId: this.key, subagent: structuredClone(s) });
      }
      // An older page can bring the first error this view has seen.
      const runtime = this.runtime();
      if (JSON.stringify(runtime) !== this.sentRuntime) {
        this.sentRuntime = JSON.stringify(runtime);
        events.push({ t: "runtime.updated", threadId: this.key, runtime });
      }
      for (const e of events) this.emit(e);
      return events;
    });
  }

  onEvent(cb: (e: ThreadLiveEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const off of this.offs.splice(0)) off();
    this.listeners.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.closing = this.serial(() => this.unsubscribe());
    return this.closing;
  }

  /** A copy of the current state. It does not change what live events are still sent. */
  snapshot(): ThreadSnapshot {
    return structuredClone({
      threadId: this.key,
      lineage: this.lineage(),
      providerInstanceId: this.providerInstanceId,
      title: this.title(),
      state: this.state(),
      runtime: this.runtime(),
      runs: this.turns.map((ts) => this.runOf(ts)),
      visibleTurnItems: this.order.map((id) => this.rows.get(id)!.row),
      branches: { lanes: [] },
      subagents: [...this.subagents.values()],
      tokenUsage: this.tokenUsage,
      hasMoreBefore: this.hasMoreBefore,
    });
  }

  visibleRows(): readonly OrchestrationV2ProjectedTurnItem[] {
    return this.order.map((id) => this.rows.get(id)!.row);
  }

  stats(): CodexThreadViewStats {
    return {
      ...this.counters,
      calls: { ...this.counters.calls },
      subscribed: this.subscribed,
      turns: this.turns.length,
      rows: this.rows.size,
      records: structuredClone(this.records),
      rollout: this.rollout?.stats() ?? null,
    };
  }

  // ---- daemon calls ----

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private call<M extends ClientMethod>(method: M, params: ParamsOf<M>): Promise<unknown> {
    this.counters.calls[method] = (this.counters.calls[method] ?? 0) + 1;
    return this.rpc.request(method, params, { timeoutMs: this.timeoutMs });
  }

  private async readThread(): Promise<void> {
    const res = (await this.call("thread/read", { threadId: this.threadId, includeTurns: false })) as ThreadReadResponse;
    this.thread = res.thread;
    this.status = res.thread.status;
    await this.readGoal();
  }

  /**
   * The thread's goal for state.goal. A thread the daemon cannot hold a goal for (a temporary one)
   * answers an error: the goal stays unread and goalReadFailures counts it. A goal change this view
   * heard of while the read was in flight is newer than the read, so it stays.
   */
  private async readGoal(): Promise<void> {
    const before = this.goalSeq;
    try {
      const res = (await this.call("thread/goal/get", { threadId: this.threadId })) as ThreadGoalGetResponse;
      if (this.goalSeq === before) this.goal = res.goal ? goalState(res.goal) : null;
    } catch {
      this.counters.goalReadFailures++;
    }
  }

  /** The snapshot from load() is what listeners hold: later events are measured against it. */
  private markSent(): void {
    this.sentRuns.clear();
    for (const ts of this.turns) this.sentRuns.set(ts.id, JSON.stringify(this.runOf(ts)));
    this.sentRuntime = JSON.stringify(this.runtime());
  }

  /**
   * Whether to subscribe now: the daemon holds the thread, and no notification that waited since
   * the read says it let go of it (resuming then would load it again).
   */
  private mayResume(): boolean {
    if (this.closed || this.subscribed || !isLoadedStatus(this.status)) return false;
    for (const n of this.buffer) {
      if (n.method === "thread/closed") return false;
      if (n.method === "thread/status/changed" && (n.params as NotificationParams<"thread/status/changed">).status.type === "notLoaded") return false;
    }
    return true;
  }

  private async unsubscribe(): Promise<void> {
    if (!this.subscribed) return;
    this.subscribed = false;
    try {
      await this.call("thread/unsubscribe", { threadId: this.threadId });
      this.counters.unsubscribes++;
    } catch (err) {
      this.noteError(err);
    }
  }

  /** Subscribe. A failure leaves the view without live updates but keeps the history. */
  private async tryResume(): Promise<void> {
    try {
      const res = (await this.call("thread/resume", { threadId: this.threadId, excludeTurns: true })) as ThreadResumeResponse;
      this.subscribed = true;
      this.counters.resumes++;
      this.thread = res.thread;
      this.status = res.thread.status;
    } catch (err) {
      this.noteError(err);
    }
  }

  /**
   * A page of turns from the daemon, or from the rollout: a rollout cursor goes to the rollout,
   * and an empty newest page from the daemon is answered from the rollout when it has turns.
   */
  private async turnsPage(cursor: string | null, limit = this.pageSize): Promise<ThreadTurnsListResponse> {
    if (isRolloutCursor(cursor)) return this.rolloutPage(cursor, limit);
    const res = (await this.call("thread/turns/list", {
      threadId: this.threadId,
      cursor,
      limit,
      sortDirection: "desc",
      itemsView: "full",
    })) as ThreadTurnsListResponse;
    this.counters.pages++;
    for (const t of res.data) this.rolloutTurns.delete(t.id);
    if (cursor === null && res.data.length === 0 && res.nextCursor === null && this.rolloutAvailable()) {
      try {
        const page = await this.rolloutPage(null);
        if (page.data.length > 0) return page;
      } catch (err) {
        // The daemon's answer stands; the error shows in stats().
        this.noteError(err);
      }
    }
    return res;
  }

  /** Whether the thread's rollout can stand in for the daemon's history (rolloutFallback.ts). */
  private rolloutAvailable(): boolean {
    if (this.rollout) return true;
    const t = this.thread;
    if (!this.openRollout || !t || t.historyMode !== "paginated" || !t.path) return false;
    this.rollout = this.openRollout(t);
    return this.rollout !== null;
  }

  private async rolloutPage(cursor: string | null, limit = this.pageSize): Promise<ThreadTurnsListResponse> {
    if (!this.rollout) throw new Error(`thread view ${this.key} has no rollout history for cursor ${cursor}`);
    this.counters.calls["rollout/page"] = (this.counters.calls["rollout/page"] ?? 0) + 1;
    const page = await this.rollout.page(cursor, limit);
    this.counters.pages++;
    for (const t of page.data) this.rolloutTurns.add(t.id);
    this.onRolloutPage?.(this.rollout.stats());
    return page;
  }

  // ---- re-read after a subscription starts or a connection comes back ----

  private maybeResubscribe(): void {
    if (this.closed || !this.loaded || this.subscribed) return;
    if (!isLoadedStatus(this.status)) return;
    this.queueResync("resync");
  }

  private queueResync(reason: SyncReason): void {
    if (this.closed) return;
    if (reason === "resync") {
      if (this.resyncQueued) return;
      this.resyncQueued = true;
    }
    void this.serial(() => this.resync(reason)).then(
      () => {
        this.retryDelayMs = 0;
      },
      (err: unknown) => {
        this.noteError(err);
        this.scheduleRetry(reason);
      },
    );
  }

  /** A failed re-read is tried again with a growing delay (1 s doubling to 30 s) until it succeeds or the view closes. */
  private scheduleRetry(reason: SyncReason): void {
    if (this.closed || this.retryTimer) return;
    this.retryDelayMs = Math.min(Math.max(this.retryDelayMs * 2, 1000), 30_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.queueResync(reason);
    }, this.retryDelayMs);
    this.retryTimer.unref?.();
  }

  private async resync(reason: SyncReason): Promise<void> {
    if (reason === "resync") this.resyncQueued = false;
    if (this.closed || !this.loaded) return;
    this.counters.resyncs++;
    this.syncing = true;
    this.buffer = [];
    this.pageHeld.clear();
    let replaced: SyncReason | null = null;
    try {
      await this.readThread();
      if (this.mayResume()) await this.tryResume();
      if (this.closed) return;
      if (reason === "reverted") {
        const page = await this.turnsPage(null);
        if (this.closed) return;
        this.reset();
        this.ingestPage(page.data, "replace");
        this.olderCursor = page.nextCursor;
      } else {
        const known = new Set(this.turnById.keys());
        const fetched: Turn[] = [];
        let cursor: string | null = null;
        let next: string | null = null;
        // Page back until the pages overlap what this view holds.
        for (;;) {
          const page = await this.turnsPage(cursor);
          if (this.closed) return;
          fetched.push(...page.data);
          next = page.nextCursor;
          if (known.size === 0 || next === null || page.data.some((t) => known.has(t.id))) break;
          cursor = next;
        }
        if (known.size > 0 && !fetched.some((t) => known.has(t.id))) {
          // The history no longer contains what this view holds: start over from these pages.
          this.reset();
          this.ingestPage(fetched, "replace");
          this.olderCursor = next;
        } else {
          if (known.size === 0) this.olderCursor = next;
          this.dropTurnsMissingFrom(fetched);
          this.ingestPage(fetched, "merge");
        }
      }
      this.addForkMarker();
      this.settleQuestions(false);
      this.rebuildOrder();
      replaced = reason;
    } finally {
      this.syncing = false;
      if (replaced) {
        this.emit(this.replacedEvent(replaced));
        this.emit({ t: "thread.patched", threadId: this.key, title: this.title(), state: this.state() });
        for (const ts of this.turns) this.emitRun(ts);
        for (const s of this.subagents.values()) this.emit({ t: "subagent.upserted", threadId: this.key, subagent: structuredClone(s) });
        this.emitRuntime();
      }
      this.drainBuffer();
    }
  }

  private reset(): void {
    this.turns = [];
    this.turnById.clear();
    this.headRowIds = [];
    this.rows.clear();
    this.order = [];
    this.subagents.clear();
    this.subagentByChild.clear();
    this.childStatus.clear();
    this.sentRuns.clear();
  }

  /**
   * The pages cover every turn from the oldest held turn they contain up to now. A held turn in
   * that range that the pages lack was removed (a revert this connection did not hear about).
   */
  private dropTurnsMissingFrom(fetched: Turn[]): void {
    const ids = new Set(fetched.map((t) => t.id));
    const first = this.turns.findIndex((ts) => ids.has(ts.id));
    if (first < 0) return;
    for (const ts of this.turns.slice(first)) {
      if (ids.has(ts.id)) continue;
      for (const id of ts.rowIds) this.rows.delete(id);
      this.turnById.delete(ts.id);
      this.sentRuns.delete(ts.id);
    }
    this.turns = this.turns.filter((ts) => this.turnById.has(ts.id));
  }

  private drainBuffer(): void {
    const buffered = this.buffer;
    this.buffer = [];
    this.counters.buffered += buffered.length;
    this.planDeltaSkips(buffered);
    this.draining = true;
    try {
      for (const n of buffered) this.apply(n.method, n.params);
    } finally {
      this.draining = false;
      this.pageHeld.clear();
      this.deltaSkips.clear();
    }
  }

  /**
   * For each running row the page returned with text: how many of its leading waiting deltas the
   * page text already ends with (the longest such run). Those are skipped, the rest appended.
   */
  private planDeltaSkips(buffered: Array<{ method: ThreadScopedMethod; params: unknown }>): void {
    this.deltaSkips.clear();
    if (this.pageHeld.size === 0) return;
    const pieces = new Map<string, string[]>();
    const partIndex = new Map<string, number>();
    for (const n of buffered) {
      if (!DELTA_METHODS.has(n.method)) continue;
      const p = n.params as { itemId: string; delta: string; summaryIndex?: number };
      const id = codexItemRowId(this.key, p.itemId);
      const rs = this.rows.get(id);
      if (!rs || !this.pageHeld.has(id)) continue;
      let piece = p.delta;
      if (n.method === "item/reasoning/summaryTextDelta") {
        // The separator a new summary part would bring (see summarySeparator).
        const cur = partIndex.get(id) ?? rs.summaryIndex;
        const si = p.summaryIndex ?? 0;
        if (si > cur) piece = `\n\n${piece}`;
        partIndex.set(id, Math.max(cur, si));
      }
      let list = pieces.get(id);
      if (!list) pieces.set(id, (list = []));
      list.push(piece);
    }
    for (const [id, list] of pieces) {
      const text = streamedText(this.rows.get(id)!.row.item);
      for (let k = list.length; k > 0; k--) {
        if (text.endsWith(list.slice(0, k).join(""))) {
          this.deltaSkips.set(id, k);
          break;
        }
      }
    }
  }

  /**
   * A waiting notification for a running row the page returned with text. A summary part marker
   * is ignored then: the separator comes with the part's first appended delta (summarySeparator).
   */
  private heldByPage(rowId: string): boolean {
    return this.draining && this.pageHeld.has(rowId);
  }

  // ---- notifications ----

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    for (const method of THREAD_SCOPED_METHODS) {
      this.offs.push(this.rpc.on(method, (params: unknown) => this.onNotification(method, params)));
    }
    this.offs.push(
      this.rpc.onConnected(() => {
        // Subscriptions belong to a connection; a new one starts unsubscribed.
        this.subscribed = false;
        if (this.loaded) this.queueResync("resync");
      }),
    );
  }

  private onNotification(method: ThreadScopedMethod, params: unknown): void {
    if (this.closed) return;
    if ((params as { threadId?: unknown } | null)?.threadId !== this.threadId) return;
    if (this.syncing) {
      this.buffer.push({ method, params });
      return;
    }
    if (!this.loaded) return;
    this.apply(method, params);
  }

  private apply(method: ThreadScopedMethod, params: unknown): void {
    const key = `codex|notif|method=${method}`;
    if (THREAD_METHODS[method] === "hidden") {
      this.count(key, "hidden");
      return;
    }
    switch (method) {
      case "thread/status/changed": {
        const p = params as NotificationParams<"thread/status/changed">;
        this.count(key, "hidden");
        this.status = p.status;
        if (this.thread) this.thread.status = p.status;
        if (p.status.type === "notLoaded") this.subscribed = false;
        this.emitRuntime();
        const active = this.activeTurn();
        if (active) this.emitRun(active);
        this.maybeResubscribe();
        return;
      }
      case "thread/closed":
        this.count(key, "hidden");
        this.status = { type: "notLoaded" };
        this.subscribed = false;
        this.emitRuntime();
        return;
      case "thread/name/updated": {
        const p = params as NotificationParams<"thread/name/updated">;
        this.count(key, "hidden");
        if (this.thread) this.thread.name = p.threadName ?? null;
        this.emit({ t: "thread.patched", threadId: this.key, title: this.title(), state: { nameSource: this.nameSource() } });
        return;
      }
      case "thread/settings/updated": {
        // A turn/start with a model or effort (maru's /model, or another client's) changed them.
        const p = params as NotificationParams<"thread/settings/updated">;
        this.count(key, "hidden");
        const s = p.threadSettings;
        if (this.thread && this.thread.model === s.model && this.thread.reasoningEffort === s.effort) return;
        if (this.thread) {
          this.thread.model = s.model;
          this.thread.reasoningEffort = s.effort;
        }
        this.emit({ t: "thread.patched", threadId: this.key, state: { model: s.model, effort: s.effort } });
        return;
      }
      case "thread/archived":
      case "thread/deleted": {
        this.count(key, "hidden");
        const reason = method === "thread/archived" ? "archived" : "deleted";
        // A snapshot has no field for it: load() sends it after the snapshot.
        if (this.quiet) this.removedDuringLoad = reason;
        else this.emit({ t: "thread.removed", threadId: this.key, reason });
        return;
      }
      case "thread/reverted":
        this.count(key, "hidden");
        this.queueResync("reverted");
        return;
      case "thread/goal/updated": {
        const p = params as NotificationParams<"thread/goal/updated">;
        // state.goal follows every update (tokens and time move while a goal is pursued); the
        // notice row is for a new objective or status only.
        this.goal = goalState(p.goal);
        this.goalSeq++;
        this.emit({ t: "thread.patched", threadId: this.key, state: { goal: this.goal } });
        const sig = `${p.goal.objective}\n${p.goal.status}`;
        if (sig === this.lastGoal) {
          this.count(key, "hidden");
          return;
        }
        this.lastGoal = sig;
        this.count(key, "displayed");
        this.putNotice(key, method, p.turnId, `Goal ${GOAL_STATUS_LABEL[p.goal.status] ?? p.goal.status}: ${p.goal.objective}`, "info", {
          noticeKind: "goal",
          data: { goal: p.goal },
        });
        return;
      }
      case "thread/goal/cleared":
        this.goal = null;
        this.goalSeq++;
        this.emit({ t: "thread.patched", threadId: this.key, state: { goal: null } });
        if (this.lastGoal === null) {
          this.count(key, "hidden");
          return;
        }
        this.lastGoal = null;
        this.count(key, "displayed");
        this.putNotice(key, method, null, "Goal cleared", "info", { noticeKind: "goal" });
        return;
      case "thread/tokenUsage/updated": {
        const p = params as NotificationParams<"thread/tokenUsage/updated">;
        this.count(key, "hidden");
        this.tokenUsage = tokenUsageSnapshot(p.tokenUsage);
        this.emit({ t: "tokenUsage.updated", threadId: this.key, usage: structuredClone(this.tokenUsage) });
        return;
      }
      case "thread/compacted": {
        // Deprecated twin of the contextCompaction item, whose order against it is unknown: the
        // row waits for the turn's end and is made only when no item covered it (7.8).
        const p = params as NotificationParams<"thread/compacted">;
        this.count(key, "hidden");
        this.compactedTurns.add(p.turnId);
        return;
      }
      case "turn/started": {
        const p = params as NotificationParams<"turn/started">;
        this.count(key, "hidden");
        const ts = this.ensureTurn(p.turn.id);
        ts.summary = turnSummary(p.turn);
        this.settleQuestions(true);
        this.emitRun(ts);
        this.emitRuntime();
        void this.refreshSettings();
        return;
      }
      case "turn/completed": {
        const p = params as NotificationParams<"turn/completed">;
        this.onTurnCompleted(key, method, p.turn);
        return;
      }
      case "turn/plan/updated": {
        const p = params as NotificationParams<"turn/plan/updated">;
        this.count(key, "displayed");
        const rowId = `${this.key}:plan:${p.turnId}`;
        const at = nowIso();
        const steps: OrchestrationV2PlanStep[] = p.plan.map((s, i) => ({
          id: String(i),
          text: s.step,
          status: s.status === "inProgress" ? "running" : s.status,
        }));
        this.putRow(
          {
            item: {
              ...baseFields(this.ctxBase(p.turnId, at), rowId, rowId, "completed", null, this.rows.get(rowId)?.row.item.startedAt ?? at, at),
              type: "todo_list",
              planId: rowId,
              steps,
              ...(p.explanation ? { explanation: p.explanation } : {}),
            },
            x: this.xOf(key, method),
          },
          p.turnId,
        );
        return;
      }
      case "turn/diff/updated": {
        const p = params as NotificationParams<"turn/diff/updated">;
        this.count(key, "displayed");
        const rowId = `${this.key}:diff:${p.turnId}`;
        const at = nowIso();
        this.putRow(
          {
            item: {
              ...baseFields(this.ctxBase(p.turnId, at), rowId, rowId, "completed", null, this.rows.get(rowId)?.row.item.startedAt ?? at, at),
              type: "file_change",
              fileName: "turn diff",
              diffStr: p.diff,
              ...diffLineCounts(p.diff),
              changes: diffFiles(p.diff),
            },
            x: this.xOf(key, method),
          },
          p.turnId,
        );
        return;
      }
      case "item/started": {
        // The envelope carries the lifecycle time when the item itself does not.
        const p = params as NotificationParams<"item/started">;
        this.onItem(method, { ...p.item, startedAtMs: p.item.startedAtMs ?? p.startedAtMs }, p.turnId);
        return;
      }
      case "item/completed": {
        const p = params as NotificationParams<"item/completed">;
        this.onItem(method, { ...p.item, completedAtMs: p.item.completedAtMs ?? p.completedAtMs }, p.turnId);
        return;
      }
      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/commandExecution/outputDelta": {
        const p = params as NotificationParams<"item/agentMessage/delta">;
        this.onDelta(key, method, p.turnId, p.itemId, p.delta, 0);
        return;
      }
      case "item/reasoning/summaryTextDelta": {
        const p = params as NotificationParams<"item/reasoning/summaryTextDelta">;
        this.onDelta(key, method, p.turnId, p.itemId, p.delta, p.summaryIndex);
        return;
      }
      case "item/reasoning/summaryPartAdded": {
        const p = params as NotificationParams<"item/reasoning/summaryPartAdded">;
        const rs = this.rows.get(codexItemRowId(this.key, p.itemId));
        if (!rs || rs.row.item.type !== "reasoning" || isTerminal(rs.row.item.status) || this.heldByPage(rs.row.item.id)) {
          this.count(key, "hidden");
          return;
        }
        const sep = this.summarySeparator(rs, p.summaryIndex);
        this.count(key, sep ? "displayed" : "hidden");
        if (sep) {
          rs.row.item.text += sep;
          this.emit({ t: "turnItem.textAppended", threadId: this.key, itemId: rs.row.item.id, field: "text", value: sep });
        }
        return;
      }
      case "item/reasoning/textDelta":
        // Raw reasoning: the row text is the summary (ref-codex-official 2.1). The raw text
        // reaches x.body with item/completed; there is no append event for x.body.
        this.count(key, "hidden");
        return;
      case "item/commandExecution/terminalInteraction": {
        const p = params as NotificationParams<"item/commandExecution/terminalInteraction">;
        const rs = this.rows.get(codexItemRowId(this.key, p.itemId));
        if (!rs || !rs.row.x) {
          this.count(key, "hidden");
          return;
        }
        this.count(key, "displayed");
        rs.row.x.stdin = (rs.row.x.stdin ?? "") + p.stdin;
        this.emitRow(rs);
        return;
      }
      case "item/fileChange/patchUpdated": {
        const p = params as NotificationParams<"item/fileChange/patchUpdated">;
        const rs = this.rows.get(codexItemRowId(this.key, p.itemId));
        if (rs && rs.row.item.type === "file_change") {
          this.count(key, "displayed");
          if (isTerminal(rs.row.item.status)) {
            this.counters.droppedDeltas++;
            return;
          }
          Object.assign(rs.row.item, fileChangeFields(p.changes));
          this.emitRow(rs);
          return;
        }
        this.counters.rowsFromDeltas++;
        this.putItem(key, method, { type: "fileChange", id: p.itemId, changes: p.changes, status: "inProgress" }, p.turnId, "started");
        return;
      }
      case "item/fileChange/outputDelta":
        this.count(key, "hidden");
        return;
      case "item/mcpToolCall/progress": {
        const p = params as NotificationParams<"item/mcpToolCall/progress">;
        const rs = this.rows.get(codexItemRowId(this.key, p.itemId));
        if (!rs || !rs.row.x) {
          this.count(key, "hidden");
          return;
        }
        this.count(key, "displayed");
        rs.row.x.progress = p.message;
        this.emitRow(rs);
        return;
      }
      case "hook/started":
        this.count(key, "hidden");
        return;
      case "hook/completed": {
        const p = params as NotificationParams<"hook/completed">;
        if (p.run.status !== "failed" && p.run.status !== "blocked") {
          this.count(key, "hidden");
          return;
        }
        this.count(key, "displayed");
        const rowId = `${this.key}:hook:${p.turnId ?? "-"}:${p.run.id}`;
        const body = p.run.entries.map((e) => e.text).join("\n");
        const msg = `hook ${p.run.eventName} ${p.run.status}${p.run.statusMessage ? `: ${p.run.statusMessage}` : ""}`;
        this.putNotice(key, method, p.turnId, msg, "warning", { noticeKind: "hook", ...(body ? { body } : {}), data: { run: p.run } }, rowId);
        return;
      }
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed": {
        const p = params as NotificationParams<"item/autoApprovalReview/started">;
        this.count(key, "displayed");
        const r = p.review;
        const msg = `Auto-approval review ${r.status}${r.riskLevel ? ` (${r.riskLevel})` : ""}${r.rationale ? `: ${r.rationale}` : ""}`;
        this.putNotice(key, method, p.turnId, msg, "info", { data: { review: r, action: p.action, targetItemId: p.targetItemId } }, `${this.key}:review:${p.reviewId}`);
        return;
      }
      case "autoApprovalReview/strictReviewRequired": {
        const p = params as NotificationParams<"autoApprovalReview/strictReviewRequired">;
        this.count(key, "displayed");
        this.putNotice(key, method, p.turnId, "Strict approval review required", "warning");
        return;
      }
      case "serverRequest/resolved":
        // No request handler here, so no pending entry to clear.
        this.count(key, "hidden");
        return;
      case "error": {
        const p = params as NotificationParams<"error">;
        this.count(key, "displayed");
        this.onError(key, method, p.turnId, p.error, p.willRetry);
        return;
      }
      case "warning":
      case "guardianWarning": {
        const p = params as NotificationParams<"guardianWarning">;
        this.count(key, "displayed");
        this.putNotice(key, method, null, p.message, "warning");
        return;
      }
      case "mcpServer/startupStatus/updated": {
        const p = params as NotificationParams<"mcpServer/startupStatus/updated">;
        if (p.status !== "failed") {
          this.count(key, "hidden");
          return;
        }
        this.count(key, "displayed");
        this.putNotice(key, method, null, `MCP ${p.name} failed to start${p.error ? `: ${p.error}` : ""}`, "warning", { data: { failureReason: p.failureReason } });
        return;
      }
      case "model/rerouted": {
        const p = params as NotificationParams<"model/rerouted">;
        this.count(key, "displayed");
        this.putNotice(key, method, p.turnId, `Model changed: ${p.fromModel} → ${p.toModel} (${p.reason})`, "warning");
        return;
      }
      case "model/verification": {
        const p = params as NotificationParams<"model/verification">;
        this.count(key, "displayed");
        this.putNotice(key, method, p.turnId, `Model verification: ${p.verifications.join(", ")}`, "info");
        return;
      }
      case "modelProvider/authRecoveryStarted":
      case "modelProvider/authRecoveryCompleted": {
        const p = params as NotificationParams<"modelProvider/authRecoveryStarted">;
        this.count(key, "displayed");
        this.putNotice(key, method, p.turnId, `${p.provider}: ${p.message}`, "info");
        return;
      }
      case "turn/moderationMetadata": {
        const p = params as NotificationParams<"turn/moderationMetadata">;
        this.count(key, "displayed");
        this.putNotice(key, method, p.turnId, "moderation metadata", "info", { data: { metadata: p.metadata } });
        return;
      }
      case "model/safetyBuffering/updated": {
        const p = params as NotificationParams<"model/safetyBuffering/updated">;
        if (!p.showBufferingUi) {
          this.count(key, "hidden");
          return;
        }
        this.count(key, "displayed");
        this.putNotice(key, method, p.turnId, `${p.model} safety buffering${p.reasons.length ? `: ${p.reasons.join(", ")}` : ""}`, "info", {
          data: { useCases: p.useCases, fasterModel: p.fasterModel },
        });
        return;
      }
      default:
        this.count(key, "hidden");
        return;
    }
  }

  private onItem(method: "item/started" | "item/completed", item: ThreadItem, turnId: string): void {
    const lifecycle: ItemLifecycle = method === "item/started" ? "started" : "completed";
    const key = `codex|notif|method=${method}|${codexItemKey(item).slice("codex|item|".length)}`;
    const rowId = codexItemRowId(this.key, item.id);
    const existing = this.rows.get(rowId);
    if (lifecycle === "started" && existing && (isTerminal(existing.row.item.status) || this.draining)) {
      // A waiting item/started for an item the page already has: the page is newer.
      this.count(key, "hidden");
      return;
    }
    this.putItem(key, method, item, turnId, lifecycle);
  }

  /** Map one live item and put its rows. Returns the mapped item. */
  private putItem(key: string, method: string, item: ThreadItem, turnId: string, lifecycle: ItemLifecycle): MappedItem {
    const ts = this.ensureTurn(turnId);
    const rowId = codexItemRowId(this.key, item.id);
    const existing = this.rows.get(rowId)?.row.item;
    const isNewUser = item.type === "userMessage" && !existing;
    const userIdx = existing?.type === "user_message" ? (existing.inputIntent === "turn_start" ? 0 : 1) : ts.userMessages;
    const mapped = mapThreadItem(item, this.ctx(turnId, ts.summary.status, lifecycle, userIdx, nowIso(), key, method));
    this.count(key, mapped.disposition);
    if (isNewUser) ts.userMessages++;
    for (const r of mapped.rows) this.putRow(r, turnId, lastSummaryIndex(item));
    this.applySubagent(mapped, true, true);
    if (mapped.rows.some((r) => r.item.type === "assistant_message")) this.emitRun(ts);
    return mapped;
  }

  private onDelta(key: string, method: ThreadScopedMethod, turnId: string, itemId: string, delta: string, summaryIndex: number): void {
    const rs = this.rows.get(codexItemRowId(this.key, itemId));
    if (!rs) {
      // Subscribed in the middle of the item: start the row from the delta; item/completed fixes it.
      this.counters.rowsFromDeltas++;
      this.putItem(key, method, syntheticItem(method, itemId, delta), turnId, "started");
      return;
    }
    this.count(key, "displayed");
    const item = rs.row.item;
    if (isTerminal(item.status)) {
      this.counters.droppedDeltas++;
      return;
    }
    const skip = this.draining ? (this.deltaSkips.get(item.id) ?? 0) : 0;
    if (skip > 0) {
      // The page text already ends with this waiting delta (planDeltaSkips).
      this.deltaSkips.set(item.id, skip - 1);
      this.counters.droppedDeltas++;
      if (item.type === "reasoning") rs.summaryIndex = Math.max(rs.summaryIndex, summaryIndex);
      return;
    }
    if (method === "item/agentMessage/delta" && item.type === "assistant_message") {
      item.text += delta;
      this.emit({ t: "turnItem.textAppended", threadId: this.key, itemId: item.id, field: "text", value: delta });
    } else if (method === "item/reasoning/summaryTextDelta" && item.type === "reasoning") {
      const value = this.summarySeparator(rs, summaryIndex) + delta;
      item.text += value;
      this.emit({ t: "turnItem.textAppended", threadId: this.key, itemId: item.id, field: "text", value });
    } else if (method === "item/plan/delta" && item.type === "proposed_plan") {
      item.markdown += delta;
      this.emit({ t: "turnItem.textAppended", threadId: this.key, itemId: item.id, field: "markdown", value: delta });
    } else if (method === "item/commandExecution/outputDelta" && item.type === "command_execution") {
      item.output = (item.output ?? "") + delta;
      this.emit({ t: "turnItem.textAppended", threadId: this.key, itemId: item.id, field: "output", value: delta });
    } else {
      this.counters.droppedDeltas++;
    }
  }

  /** "\n\n" when a reasoning summary moves on to a new part that follows text. */
  private summarySeparator(rs: RowState, summaryIndex: number): string {
    if (summaryIndex <= rs.summaryIndex) return "";
    rs.summaryIndex = summaryIndex;
    return rs.row.item.type === "reasoning" && rs.row.item.text.length > 0 ? "\n\n" : "";
  }

  private onTurnCompleted(key: string, method: string, turn: Turn): void {
    const ts = this.ensureTurn(turn.id);
    ts.summary = turnSummary(turn);
    const outcome = this.turnOutcomeRow(turn.id, ts.summary, method, key);
    this.count(`${key}|status=${turn.status}`, outcome ? "displayed" : "hidden");
    // The turn carries its last items (itemsView summary); they fill in what this connection missed.
    for (const item of turn.items) {
      const rs = this.rows.get(codexItemRowId(this.key, item.id));
      if (rs && isTerminal(rs.row.item.status)) continue;
      const mapped = mapThreadItem(item, this.ctx(turn.id, turn.status, "completed", rs ? 1 : ts.userMessages, nowIso(), key, method));
      for (const r of mapped.rows) this.putRow(r, turn.id);
      this.applySubagent(mapped, true, true);
    }
    // Rows still running end with an interrupted or failed turn; streaming text ends with any turn.
    for (const id of ts.rowIds) {
      const rs = this.rows.get(id);
      if (!rs || rs.row.item.status !== "running") continue;
      const item = rs.row.item;
      const streams = item.type === "assistant_message" || item.type === "reasoning" || item.type === "proposed_plan";
      const status: OrchestrationV2TurnItemStatus = settle("running", { turnStatus: turn.status });
      if (status === "running" && !streams) continue;
      item.status = status === "running" ? "completed" : status;
      if (streams) (item as { streaming: boolean }).streaming = false;
      this.emitRow(rs);
    }
    if (this.compactedTurns.delete(turn.id) && !ts.rowIds.some((id) => this.rows.get(id)?.row.item.type === "compaction")) {
      const rowId = `${this.key}:compact:${turn.id}`;
      const at = isoFromSec(turn.completedAt) ?? nowIso();
      this.putRow(
        { item: { ...baseFields(this.ctxBase(turn.id, at), rowId, rowId, "completed", null, at, at), type: "compaction", driver: "codex" }, x: this.xOf("codex|notif|method=thread/compacted", "thread/compacted") },
        turn.id,
      );
    }
    if (outcome) this.putRow(outcome, turn.id);
    this.emitRun(ts);
    this.emitRuntime();
  }

  private onError(key: string, method: string, turnId: string, error: NotificationParams<"error">["error"], willRetry: boolean): void {
    const failure = turnFailure(error, willRetry);
    const at = nowIso();
    if (willRetry) {
      const attempt = (this.retriesByTurn.get(turnId) ?? 0) + 1;
      this.retriesByTurn.set(turnId, attempt);
      const rowId = `${this.key}:note:${this.seq + 1}`;
      this.putRow(
        {
          item: {
            ...baseFields(this.ctxBase(turnId, at), rowId, rowId, "completed", null, at, at),
            type: "error",
            failure,
            retry: { attempt, maxAttempts: null, retryDelayMs: null },
          },
          x: this.xOf(key, method),
        },
        turnId,
      );
      return;
    }
    // Same id as the failed turn's error, so the turn/completed that follows replaces this row.
    this.putRow(this.errorRow(`${this.key}:turn-error:${turnId}`, turnId, failure, at, key, method), turnId);
    this.emitRuntime();
  }

  // ---- history ----

  /**
   * Put a page of turns (newest first, as thread/turns/list returns them) into the state.
   * replace: the view is empty. prepend: older turns. merge: newer turns and turns already held.
   */
  private ingestPage(turnsDesc: Turn[], mode: "replace" | "prepend" | "merge"): { turns: TurnState[]; subagents: Set<string> } {
    const chrono = [...turnsDesc].reverse();
    const added: TurnState[] = [];
    const subagents = new Set<string>();
    const newState = (t: Turn): TurnState => ({ id: t.id, summary: turnSummary(t), rowIds: [], userMessages: 0 });
    if (mode === "prepend") {
      const fresh = chrono.filter((t) => !this.turnById.has(t.id));
      const states = fresh.map(newState);
      for (const s of states) this.turnById.set(s.id, s);
      this.turns = [...states, ...this.turns];
      fresh.forEach((t, i) => this.ingestTurn(states[i]!, t, false, subagents));
      return { turns: states, subagents };
    }
    let seenKnown = mode === "replace";
    for (const t of chrono) {
      let ts = this.turnById.get(t.id);
      if (ts) {
        seenKnown = true;
      } else {
        // In a merge, unknown turns before the first held one are older history (loadOlder's job).
        if (!seenKnown && this.turns.length > 0) continue;
        ts = newState(t);
        this.turnById.set(ts.id, ts);
        this.turns.push(ts);
        added.push(ts);
      }
      this.ingestTurn(ts, t, true, subagents);
    }
    return { turns: added, subagents };
  }

  private ingestTurn(ts: TurnState, turn: Turn, newest: boolean, subagents: Set<string>): void {
    ts.summary = turnSummary(turn);
    const fallbackAt = isoFromSec(turn.startedAt) ?? nowIso();
    const fresh: string[] = [];
    let users = 0;
    const conn = this.rolloutTurns.has(turn.id) ? "rollout" : "thread/turns/list";
    for (const item of turn.items) {
      const key = codexItemKey(item);
      const mapped = mapThreadItem(item, this.ctx(turn.id, turn.status, "history", users, fallbackAt, key, conn));
      if (item.type === "userMessage") users++;
      this.count(key, mapped.disposition);
      for (const r of mapped.rows) {
        this.storeRow(r, turn.id, lastSummaryIndex(item));
        fresh.push(r.item.id);
        if (r.item.status === "running" && streamedText(r.item) !== "") this.pageHeld.add(r.item.id);
      }
      if (mapped.subagent) subagents.add(mapped.subagent.id);
      this.applySubagent(mapped, newest, false);
    }
    ts.userMessages = Math.max(ts.userMessages, users);
    const outcome = this.turnOutcomeRow(turn.id, ts.summary, conn, "codex|turn");
    this.count(`codex|turn|status=${turn.status}`, outcome ? "displayed" : "hidden");
    if (outcome) {
      this.storeRow(outcome, turn.id);
      fresh.push(outcome.item.id);
    }
    // Rows held for this turn that the page does not carry (plan, diff, notices, items the
    // history does not have yet) stay, after the page's rows.
    const freshSet = new Set(fresh);
    const kept = ts.rowIds.filter((id) => !freshSet.has(id) && this.rows.has(id));
    ts.rowIds = [...fresh, ...kept];
  }

  private turnOutcomeRow(turnId: string, s: TurnSummary, method: string, key: string): MappedRow | null {
    const at = isoFromSec(s.completedAt) ?? nowIso();
    if (s.status === "failed") {
      const failure: OrchestrationV2ProviderFailure = s.error
        ? turnFailure(s.error, false)
        : { class: "unknown", message: FAILED_TEXT, code: null, retryable: null };
      return this.errorRow(`${this.key}:turn-error:${turnId}`, turnId, failure, at, key, method);
    }
    if (s.status === "interrupted") {
      const rowId = `${this.key}:interrupt:${turnId}`;
      return {
        item: {
          ...baseFields(this.ctxBase(turnId, at), rowId, rowId, "completed", null, at, at),
          type: "run_interrupt_result",
          message: s.error?.message ? `${INTERRUPTED_TEXT}: ${s.error.message}` : INTERRUPTED_TEXT,
        },
        x: this.xOf(key, method),
      };
    }
    return null;
  }

  private errorRow(rowId: string, turnId: string, failure: OrchestrationV2ProviderFailure, at: IsoDateTime, key: string, method: string): MappedRow {
    return {
      item: { ...baseFields(this.ctxBase(turnId, at), rowId, rowId, "failed", null, at, at), type: "error", failure },
      x: this.xOf(key, method),
    };
  }

  private addForkMarker(): void {
    const from = this.thread?.forkedFromId;
    if (!from || this.olderCursor !== null) return;
    const rowId = `${this.key}:syn:fork:${from}`;
    if (this.rows.has(rowId)) return;
    const at = isoFromSec(this.thread?.createdAt) ?? nowIso();
    const item: OrchestrationV2TurnItem = {
      ...baseFields(this.ctxBase(null, at), rowId, from, "completed", null, at, at),
      type: "fork",
      source: { type: "provider_thread", providerThreadId: from },
      targetThreadId: this.key,
      providerThreadId: this.threadId,
    };
    this.rows.set(rowId, {
      row: { position: 0, visibility: "synthetic", sourceThreadId: this.key, sourceItemId: rowId, item, x: { raw: [], sourceKey: "codex|thread|forkedFromId", link: { threadId: codexThreadKey(this.account, from), evidence: "forkedFrom" } } },
      turnId: null,
      summaryIndex: 0,
    });
    this.headRowIds.unshift(rowId);
  }

  // ---- rows ----

  /**
   * Create or replace a row without emitting. x.stdin and x.progress outlive a replacement.
   * summaryIndex: for a reasoning item, the index of its last summary part.
   */
  private storeRow(r: MappedRow, turnId: string | null, summaryIndex?: number): RowState {
    const id = r.item.id;
    const prev = this.rows.get(id);
    const x: ProjectionExtension = { ...r.x };
    if (prev?.row.x?.stdin !== undefined && x.stdin === undefined) x.stdin = prev.row.x.stdin;
    if (prev?.row.x?.progress !== undefined && x.progress === undefined) x.progress = prev.row.x.progress;
    if (prev?.row.x?.raw) x.raw = [...prev.row.x.raw, ...x.raw];
    const position = prev?.row.position ?? 0;
    const item = { ...r.item, ordinal: position };
    const rs: RowState = {
      row: { position, visibility: "local", sourceThreadId: this.key, sourceItemId: id, item, x },
      turnId,
      summaryIndex: summaryIndex ?? prev?.summaryIndex ?? 0,
    };
    this.rows.set(id, rs);
    return rs;
  }

  /** Create or replace a live row and tell the listeners. */
  private putRow(r: MappedRow, turnId: string | null, summaryIndex?: number): void {
    const known = this.rows.has(r.item.id);
    const rs = this.storeRow(r, turnId, summaryIndex);
    if (known) {
      this.emitRow(rs);
      return;
    }
    const ts = turnId === null ? (this.turns.at(-1) ?? null) : this.ensureTurn(turnId);
    if (ts) ts.rowIds.push(r.item.id);
    else this.headRowIds.push(r.item.id);
    const atEnd = ts === null ? this.turns.length === 0 : ts === this.turns.at(-1);
    if (atEnd) {
      rs.row.position = this.order.length;
      rs.row.item.ordinal = this.order.length;
      this.order.push(r.item.id);
      this.emitRow(rs);
      return;
    }
    this.counters.outOfOrderInserts++;
    this.rebuildOrder();
    this.emit(this.replacedEvent("resync"));
  }

  private putNotice(
    key: string,
    method: string,
    turnId: string | null,
    message: string,
    level: "info" | "warning" | "error",
    extra: Partial<ProjectionExtension> = {},
    rowId = `${this.key}:note:${this.seq + 1}`,
  ): void {
    const at = nowIso();
    const x = { ...this.xOf(key, method), ...extra };
    const prevStart = this.rows.get(rowId)?.row.item.startedAt ?? at;
    // A turn this view does not hold (thread/goal/updated reaches unsubscribed connections too)
    // does not get a turn of its own; the notice goes to the end without a run.
    const turn = turnId !== null && this.turnById.has(turnId) ? turnId : (this.rows.get(rowId)?.turnId ?? null);
    this.putRow(
      { item: { ...baseFields(this.ctxBase(turn, at), rowId, rowId, "completed", null, prevStart, at), type: "system_notice", message, level }, x },
      turn,
    );
  }

  private rebuildOrder(): void {
    this.order = [...this.headRowIds, ...this.turns.flatMap((t) => t.rowIds)].filter((id) => this.rows.has(id));
    this.order.forEach((id, i) => {
      const rs = this.rows.get(id)!;
      rs.row.position = i;
      rs.row.item.ordinal = i;
    });
  }

  private ensureTurn(turnId: string): TurnState {
    let ts = this.turnById.get(turnId);
    if (ts) return ts;
    // An item for a turn this view has not seen start (the official client synthesizes it too).
    ts = {
      id: turnId,
      summary: { id: turnId, rootTurnId: null, status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null },
      rowIds: [],
      userMessages: 0,
    };
    this.turnById.set(turnId, ts);
    this.turns.push(ts);
    this.emitRun(ts);
    return ts;
  }

  // ---- subagents ----

  /** newest: the mapped item is newer than what the view holds (live, or the newest pages). */
  private applySubagent(mapped: MappedItem, newest: boolean, emit: boolean): void {
    const s = mapped.subagent;
    if (s) {
      const child = s.providerThreadId;
      if (child) {
        this.subagentByChild.set(child, s.id);
        const known = this.childStatus.get(child);
        if (known && !newest) {
          // An older page: what newer items said about the child wins, on the record and its row.
          s.status = known;
          const rs = this.rows.get(s.parentNodeId);
          if (rs && rs.row.item.type === "subagent") rs.row.item.status = known;
        } else {
          this.childStatus.set(child, s.status);
        }
      }
      this.subagents.set(s.id, s);
      if (emit) this.emit({ t: "subagent.upserted", threadId: this.key, subagent: structuredClone(s) });
    }
    for (const sig of mapped.subagentSignals) {
      if (!newest && this.childStatus.has(sig.childProviderThreadId)) continue;
      this.childStatus.set(sig.childProviderThreadId, sig.status);
      const id = this.subagentByChild.get(sig.childProviderThreadId);
      const sub = id === undefined ? undefined : this.subagents.get(id);
      if (!sub || sub.status === sig.status) continue;
      sub.status = sig.status;
      sub.updatedAt = nowIso();
      const rs = this.rows.get(sub.parentNodeId);
      if (rs && rs.row.item.type === "subagent") rs.row.item.status = sig.status;
      if (emit) {
        this.emit({ t: "subagent.upserted", threadId: this.key, subagent: structuredClone(sub) });
        if (rs) this.emitRow(rs);
      }
    }
  }

  /**
   * Async questions (agentMessage questions) are answered by a later message: once a later turn
   * exists, the questions of earlier turns are settled. emit: tell the listeners (live).
   */
  private settleQuestions(emit: boolean): void {
    for (const ts of this.turns.slice(0, -1)) {
      for (const id of ts.rowIds) {
        const rs = this.rows.get(id);
        if (!rs || rs.row.item.type !== "user_input_request" || rs.row.item.status !== "waiting") continue;
        rs.row.item.status = "completed";
        if (emit) this.emitRow(rs);
      }
    }
  }

  // ---- side records ----

  private activeTurn(): TurnState | undefined {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const ts = this.turns[i]!;
      if (ts.summary.status === "inProgress") return ts;
    }
    return undefined;
  }

  private runOf(ts: TurnState): ThreadRunSummary {
    let assistantMessageId: string | null = null;
    for (let i = ts.rowIds.length - 1; i >= 0; i--) {
      const item = this.rows.get(ts.rowIds[i]!)?.row.item;
      if (item?.type === "assistant_message") {
        assistantMessageId = item.messageId;
        break;
      }
    }
    const waiting = isWaitingStatus(this.status) && ts === this.activeTurn();
    return turnToRun(this.key, ts.summary, { assistantMessageId, waiting });
  }

  private runtime(): ThreadRuntimeSummary {
    const active = this.status.type === "active" ? this.activeTurn() : undefined;
    return threadRuntime(this.status, {
      providerInstanceId: this.providerInstanceId,
      activeRunId: active ? codexRunId(this.key, active.id) : null,
      activityStartedAt: active ? isoFromSec(active.summary.startedAt) : null,
      lastError: this.lastError(),
    });
  }

  /** The message of the newest error row that is not a retry notice (event-model 2.5). */
  private lastError(): string | null {
    for (let t = this.turns.length - 1; t >= 0; t--) {
      const ids = this.turns[t]!.rowIds;
      for (let i = ids.length - 1; i >= 0; i--) {
        const item = this.rows.get(ids[i]!)?.row.item;
        if (item?.type === "error" && !item.retry) return item.failure.message;
      }
    }
    return null;
  }

  /** The thread's name, a subagent thread's nickname, the first prompt, or the id. */
  private title(): string {
    return this.thread?.name || this.thread?.agentNickname || this.thread?.preview || this.threadId;
  }

  private nameSource(): ThreadProjectionState["nameSource"] {
    if (this.thread?.name) return "codex-name";
    if (this.thread?.agentNickname) return "subagent-meta";
    if (this.thread?.preview) return "codex-preview";
    return "id";
  }

  /**
   * A turn/start with a model or effort changes the thread's for good, and the daemon (0.169.0)
   * announces it with no thread/settings/updated (measured 2026-11-16: turn/start with another
   * model, then thread/read named it, no such notification). So each turn start reads the thread
   * again and patches model and effort when they moved.
   */
  private async refreshSettings(): Promise<void> {
    let t: ThreadReadResponse["thread"];
    try {
      t = ((await this.call("thread/read", { threadId: this.threadId, includeTurns: false })) as ThreadReadResponse).thread;
    } catch {
      return;
    }
    if (this.closed || !this.thread) return;
    if (this.thread.model === t.model && this.thread.reasoningEffort === t.reasoningEffort) return;
    this.thread.model = t.model;
    this.thread.reasoningEffort = t.reasoningEffort;
    this.emit({ t: "thread.patched", threadId: this.key, state: { model: t.model ?? undefined, effort: t.reasoningEffort } });
  }

  private state(): ThreadProjectionState {
    const t = this.thread;
    return {
      ownership: "codex-daemon",
      control: this.readonlyView ? "readonly" : "codex-rpc",
      nameSource: this.nameSource(),
      ...(t?.model ? { model: t.model } : {}),
      ...(t?.reasoningEffort ? { effort: t.reasoningEffort } : {}),
      ...(t?.cwd ? { cwd: t.cwd } : {}),
      ...(t?.gitInfo?.branch ? { gitBranch: t.gitInfo.branch } : {}),
      ...(t?.path ? { transcriptPath: t.path } : {}),
      ...(this.goal !== undefined ? { goal: this.goal } : {}),
      stats: structuredClone(this.records),
    };
  }

  private lineage(): OrchestrationV2AppThreadLineage {
    const t = this.thread;
    const root = codexThreadKey(this.account, t?.sessionId || this.threadId);
    if (t?.parentThreadId) return { parentThreadId: codexThreadKey(this.account, t.parentThreadId), relationshipToParent: "subagent", rootThreadId: root };
    if (t?.forkedFromId) return { parentThreadId: codexThreadKey(this.account, t.forkedFromId), relationshipToParent: "fork", rootThreadId: root };
    return { parentThreadId: null, relationshipToParent: null, rootThreadId: root };
  }

  // ---- emitting ----

  private emit(e: ThreadLiveEvent): void {
    if (this.quiet) return;
    for (const cb of [...this.listeners]) {
      try {
        cb(e);
      } catch {
        this.counters.listenerErrors++;
      }
    }
  }

  private emitRow(rs: RowState): void {
    this.emit({ t: "turnItem.upserted", threadId: this.key, row: structuredClone(rs.row) });
  }

  private emitRun(ts: TurnState): void {
    const run = this.runOf(ts);
    const json = JSON.stringify(run);
    if (this.sentRuns.get(ts.id) === json) return;
    this.sentRuns.set(ts.id, json);
    this.emit({ t: "run.upserted", threadId: this.key, run });
  }

  private emitRuntime(): void {
    const runtime = this.runtime();
    const json = JSON.stringify(runtime);
    if (json === this.sentRuntime) return;
    this.sentRuntime = json;
    this.emit({ t: "runtime.updated", threadId: this.key, runtime });
  }

  private replacedEvent(reason: SyncReason): ThreadLiveEvent {
    return {
      t: "turnItems.replaced",
      threadId: this.key,
      reason,
      visibleTurnItems: this.order.map((id) => structuredClone(this.rows.get(id)!.row)),
      branches: { lanes: [] },
    };
  }

  // ---- helpers ----

  private ctxBase(turnId: string | null, fallbackAt: IsoDateTime): Pick<CodexMapContext, "threadKey" | "providerThreadId" | "turnId" | "fallbackAt"> {
    return { threadKey: this.key, providerThreadId: this.threadId, turnId, fallbackAt };
  }

  private ctx(
    turnId: string,
    turnStatus: TurnStatus,
    lifecycle: ItemLifecycle,
    userMessageIndex: number,
    fallbackAt: IsoDateTime,
    key: string,
    conn: string,
  ): CodexMapContext {
    return {
      threadKey: this.key,
      account: this.account,
      providerThreadId: this.threadId,
      providerInstanceId: this.providerInstanceId,
      turnId,
      turnStatus,
      lifecycle,
      userMessageIndex,
      fallbackAt,
      raw: this.rawRef(key, conn),
    };
  }

  /** The source record: `conn` names the daemon method it came with, `seq` its place among this view's records. */
  private rawRef(key: string, conn: string): RawRef {
    return { source: "codex-rpc", key, conn, seq: ++this.seq };
  }

  private xOf(key: string, method: string): ProjectionExtension {
    return { raw: [this.rawRef(key, method)], sourceKey: key };
  }

  private count(key: string, d: ItemDisposition): void {
    const s = this.records;
    s.linesRead++;
    s.byKey[key] = (s.byKey[key] ?? 0) + 1;
    const bucket = d === "displayed" ? s.displayedByKey : d === "hidden" ? s.hiddenByKey : s.unknownByKey;
    bucket[key] = (bucket[key] ?? 0) + 1;
  }

  private noteError(err: unknown): void {
    this.counters.errors++;
    this.counters.lastError = err instanceof Error ? err.message : String(err);
  }
}

function goalState(g: ThreadGoal): ThreadGoalState {
  return { objective: g.objective, status: g.status, tokenBudget: g.tokenBudget, tokensUsed: g.tokensUsed, timeUsedSeconds: g.timeUsedSeconds };
}

function nowIso(): IsoDateTime {
  return new Date().toISOString();
}

/** The text deltas append to, for the row types that stream. */
function streamedText(item: OrchestrationV2TurnItem): string {
  switch (item.type) {
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "proposed_plan":
      return item.markdown;
    case "command_execution":
      return item.output ?? "";
    default:
      return "";
  }
}

function lastSummaryIndex(item: ThreadItem): number | undefined {
  return item.type === "reasoning" ? Math.max(0, item.summary.length - 1) : undefined;
}

function isTerminal(status: OrchestrationV2TurnItemStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

/** Files named by `diff --git a/<old> b/<new>` headers of a unified diff. */
function diffFiles(diff: string): Array<{ operation: string; path: string; oldPath?: string }> {
  const out: Array<{ operation: string; path: string; oldPath?: string }> = [];
  for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const [, from, to] = m;
    if (!from || !to) continue;
    out.push(from === to ? { operation: "update", path: to } : { operation: "move", path: to, oldPath: from });
  }
  return out;
}

/** A started item built from its first delta, for an item whose item/started this connection missed. */
function syntheticItem(method: string, id: string, delta: string): ThreadItem {
  switch (method) {
    case "item/reasoning/summaryTextDelta":
      return { type: "reasoning", id, summary: [delta], content: [] };
    case "item/plan/delta":
      return { type: "plan", id, text: delta };
    case "item/commandExecution/outputDelta":
      return {
        type: "commandExecution",
        id,
        pluginId: null,
        scriptPath: null,
        command: "",
        cwd: "",
        processId: null,
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: delta,
        exitCode: null,
        durationMs: null,
      };
    default:
      return { type: "agentMessage", id, text: delta, phase: null, moderation: null, memoryCitation: null, delivery: null, questions: null };
  }
}
