// Live index of Codex threads across CODEX_HOMEs (accounts).
//
// Each account is read in one of two modes, chosen per account and switched at runtime:
//
// - daemon: the home's app-server daemon answers on its control socket (rpc.ts). The snapshot
//   is `thread/list` read to the last page. After it, the thread notifications that every
//   connection receives without subscribing keep the index current. Each new connection takes
//   a fresh snapshot and emits only what differs from what the index already holds.
// - fallback: no daemon answers. The snapshot is the `threads` table of `<home>/state_5.sqlite`,
//   opened read-only and re-read every fallbackPollMs. No daemon holds a thread then, so every
//   thread is `closed`.
//
// An account is in daemon mode once a connection has completed a snapshot, and moves to
// fallback whenever a connection attempt fails. In fallback the connect loop keeps retrying
// with backoff, and every poll that finds the socket file cuts the wait short.
//
// Only read calls reach the daemon: initialize, thread/list, thread/read.
//
// thread/list never returns subagent threads (threads with a parentThreadId), whatever
// `sourceKinds` asks for (measured with codex-cli 0.169.0). The snapshot therefore also reads,
// through thread/read, every subagent thread the state database lists as unarchived and every
// subagent the index already holds.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import { sessionKey } from "@maru/shared";
import type { IndexEvent, Owner, SessionSource, SessionSummary, UnifiedStatus } from "@maru/shared";
import type { CodexAccount } from "../config.ts";
import type { SessionSource as ThreadOrigin } from "./protocol/v2/SessionSource.ts";
import type { Thread } from "./protocol/v2/Thread.ts";
import type { ThreadListResponse } from "./protocol/v2/ThreadListResponse.ts";
import type { ThreadSourceKind } from "./protocol/v2/ThreadSourceKind.ts";
import type { ThreadStatus } from "./protocol/v2/ThreadStatus.ts";
import { CodexRpc, RpcError, controlSocketExists } from "./rpc.ts";
import type { CodexRpcStats, NotificationParams } from "./rpc.ts";

export interface CodexSourceOptions {
  /** Ids of the threads this server drives (owner "ui"). */
  ownThreadIds?: () => Set<string>;
  /** Interval of the state database re-read while an account has no daemon, ms. Default 30000. */
  fallbackPollMs?: number;
  /**
   * Upper bound for each read request (a thread/list page, a thread/read), ms. A snapshot whose
   * request runs past it gives up the connection and starts over on a new one. Default 60000.
   */
  requestTimeoutMs?: number;
  /** Reconnect delay: starts at initialMs, doubles per failed attempt, capped at maxMs. Default 500 and 30000. */
  backoff?: { initialMs?: number; maxMs?: number };
}

export type CodexAccountMode = "starting" | "daemon" | "fallback" | "stopped";

export interface CodexSyncStats {
  at: number;
  ms: number;
  pages: number;
  /** Threads in all thread/list pages, before de-duplication. */
  listed: number;
  /** Ids listed more than once (one thread id with two rollout files); the newest record is kept. */
  duplicates: number;
  /** Ephemeral threads in the list; they are never indexed. */
  ephemeral: number;
  /** Subagent threads read with thread/read because thread/list does not return them. */
  children: { candidates: number; read: number; unreadable: number };
  /** Threads in the snapshot. */
  indexed: number;
  /** Listed by the daemon but archived = 1 in the state database (trash and archive); not indexed. */
  archivedInDb: number;
}

export interface CodexFallbackStats {
  at: number;
  ms: number;
  /** The state database file does not exist (no threads). */
  missing: boolean;
  /** Rows with archived = 0. */
  rows: number;
  /** Rows without an id. */
  invalidRows: number;
  error: string | null;
}

export interface CodexAccountStats {
  account: string;
  home: string;
  stateDb: string;
  socketPresent: boolean;
  mode: CodexAccountMode;
  modeSwitches: number;
  /** ms from start() until this account's first snapshot was emitted. */
  startMs: number | null;
  indexed: number;
  byStatus: Record<UnifiedStatus, number>;
  syncs: number;
  syncFailures: number;
  lastSync: CodexSyncStats | null;
  fallbackReads: number;
  fallbackErrors: number;
  lastFallback: CodexFallbackStats | null;
  /** thread/read calls made after notifications, and those the daemon answered with an error. */
  refreshes: number;
  readErrors: number;
  /** Ephemeral threads announced by notifications; never indexed. */
  ephemeralSkipped: number;
  /** Thread status types this source does not know (mapped to open-idle). */
  unknownStatusValues: string[];
  emitted: { upserts: number; removes: number };
  rpc: CodexRpcStats;
  lastError: string | null;
}

export interface CodexSourceStats {
  accounts: CodexAccountStats[];
}

export interface CodexSource extends SessionSource {
  stats(): CodexSourceStats;
  /**
   * This server wrote the account's state database (a rename without a daemon). An account in
   * fallback mode re-reads it now instead of at the next poll. In daemon mode the daemon's own
   * notifications carry its changes, and a thread it cannot find is archived, so out of the index.
   */
  reread(accountId: string): void;
  /**
   * This server wrote these threads' rows directly (a restore from the trash, a move between
   * homes, a removal the daemon did not make). Fallback mode re-reads the state database; daemon
   * mode looks each id up there and reads it from the daemon, or drops it when the row is gone or
   * archived. The daemon announces only what it does itself.
   */
  refreshThreads(accountId: string, ids: string[]): void;
  /**
   * ownThreadIds() changed for this thread: publish its entry again so the owner follows now,
   * not at the thread's next daemon notification.
   */
  ownerChanged(accountId: string, threadId: string): void;
}

export const STATE_DB_FILE = "state_5.sqlite";
const PAGE_SIZE = 100;

// Every source kind, so the list is not narrowed to the "interactive" default (which leaves
// out `codex exec` threads). `satisfies` fails the type check when a regenerated protocol adds
// or drops a kind.
const SOURCE_KINDS = {
  cli: true,
  vscode: true,
  exec: true,
  appServer: true,
  subAgent: true,
  subAgentReview: true,
  subAgentCompact: true,
  subAgentThreadSpawn: true,
  subAgentOther: true,
  unknown: true,
} satisfies Record<ThreadSourceKind, true>;
const ALL_SOURCE_KINDS = Object.keys(SOURCE_KINDS) as ThreadSourceKind[];

const HANDLED = [
  "thread/started",
  "thread/status/changed",
  "thread/name/updated",
  "thread/closed",
  "thread/archived",
  "thread/unarchived",
  "thread/deleted",
] as const;
type HandledMethod = (typeof HANDLED)[number];
type IndexNotification = { [M in HandledMethod]: { method: M; params: NotificationParams<M> } }[HandledMethod];

/** Values from notifications that are newer than the thread record they apply to. */
interface Override {
  status?: ThreadStatus;
  name?: string | null;
}

export function createCodexSource(accounts: CodexAccount[], opts: CodexSourceOptions = {}): CodexSource {
  const indexes = accounts.map((a) => new AccountIndex(a, opts));
  return {
    provider: "codex",
    async start(emit: (e: IndexEvent) => void): Promise<void> {
      await Promise.all(indexes.map((ix) => ix.start(emit)));
    },
    async stop(): Promise<void> {
      await Promise.all(indexes.map((ix) => ix.stop()));
    },
    stats(): CodexSourceStats {
      return { accounts: indexes.map((ix) => ix.stats()) };
    },
    reread(accountId: string): void {
      indexes.find((ix) => ix.accountId === accountId)?.rereadStateDb();
    },
    refreshThreads(accountId: string, ids: string[]): void {
      indexes.find((ix) => ix.accountId === accountId)?.refreshThreads(ids);
    },
    ownerChanged(accountId: string, threadId: string): void {
      indexes.find((ix) => ix.accountId === accountId)?.republish(threadId);
    },
  };
}

class AccountIndex {
  private readonly account: CodexAccount;
  private readonly rpc: CodexRpc;
  private readonly dbPath: string;
  private readonly ownThreadIds: () => Set<string>;
  private readonly pollMs: number;
  private readonly requestTimeoutMs: number;

  private mode: CodexAccountMode = "starting";
  private emit: ((e: IndexEvent) => void) | null = null;
  /** What the index holds for this account, by thread id. */
  private readonly published = new Map<string, SessionSummary>();
  /** daemon mode: records from thread/list, thread/read and thread/started, by id. */
  private threads = new Map<string, Thread>();
  /** daemon mode: cleared on every new connection. */
  private readonly overrides = new Map<string, Override>();
  /** Connection counter; work started on an older connection is dropped. */
  private generation = 0;
  /** Notifications wait in `buffer` while a snapshot is being taken (and while disconnected). */
  private syncing = true;
  private buffer: IndexNotification[] = [];
  private syncRun: Promise<void> | null = null;
  private readonly refreshing = new Set<string>();
  private readonly refreshAgain = new Set<string>();
  /** Bumped on every removal, so a thread/read that started before the removal is dropped. */
  private readonly removals = new Map<string, number>();
  private fallbackRun: Promise<void> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  /**
   * daemon mode: ids the state database marks archived. thread/list still returns a thread whose
   * rollout stayed in sessions/ (an earlier dashboard's trash set archived = 1 without moving it), so
   * the database decides, the same as in fallback mode (DESIGN.md 6, archive).
   */
  private dbArchived = new Set<string>();
  /** daemon mode: threads.title by id. The daemon's Thread has no title field. */
  private dbTitles = new Map<string, string>();

  private startedAt = 0;
  private startMs: number | null = null;
  private modeSwitches = 0;
  private syncs = 0;
  private syncFailures = 0;
  private lastSync: CodexSyncStats | null = null;
  private fallbackReads = 0;
  private fallbackErrors = 0;
  private lastFallback: CodexFallbackStats | null = null;
  private refreshes = 0;
  private readErrors = 0;
  private ephemeralSkipped = 0;
  private readonly unknownStatusValues = new Set<string>();
  private readonly emitted = { upserts: 0, removes: 0 };
  private lastError: string | null = null;

  constructor(account: CodexAccount, opts: CodexSourceOptions) {
    this.account = account;
    this.dbPath = path.join(account.home, STATE_DB_FILE);
    this.ownThreadIds = opts.ownThreadIds ?? (() => new Set<string>());
    this.pollMs = opts.fallbackPollMs ?? 30_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.rpc = new CodexRpc(account.home, {
      clientInfo: { name: "maru", title: null, version: "0.0.0" },
      connectTimeoutMs: this.requestTimeoutMs,
      ...(opts.backoff ? { backoff: opts.backoff } : {}),
    });

    for (const method of HANDLED) {
      this.rpc.on(method, (params) => this.onNotification({ method, params } as IndexNotification));
    }
    this.rpc.onConnected(() => {
      this.generation++;
      this.syncRun = this.sync(this.generation);
    });
    this.rpc.onDisconnected(() => {
      this.syncing = true;
      this.buffer = [];
    });
    this.rpc.onConnectFailed(() => {
      void this.enterFallback();
    });
  }

  async start(emit: (e: IndexEvent) => void): Promise<void> {
    this.emit = emit;
    this.startedAt = performance.now();
    const ok = await this.rpc.start();
    if (ok && this.syncRun) await this.syncRun;
    if (this.mode !== "daemon") await this.enterFallback();
    this.startMs = Math.round(performance.now() - this.startedAt);
  }

  async stop(): Promise<void> {
    this.setMode("stopped");
    await this.rpc.close();
  }

  get accountId(): string {
    return this.account.id;
  }

  /** Re-read the state database now when this account is in fallback mode. */
  rereadStateDb(): void {
    if (this.mode === "fallback") this.pollFallback();
  }

  /** Publish one thread again (its owner is computed at publish time). daemon mode only. */
  republish(id: string): void {
    if (this.mode === "daemon" && !this.syncing) this.publishOne(id);
  }

  /** See CodexSource.refreshThreads. */
  refreshThreads(ids: string[]): void {
    if (this.mode === "fallback") {
      this.pollFallback();
      return;
    }
    if (this.mode !== "daemon") return;
    const rows = readRows(this.dbPath, ids);
    for (const id of ids) {
      const row = rows.get(id);
      if (row === undefined || row.archived) {
        if (row?.archived) this.dbArchived.add(id);
        this.remove(id);
        continue;
      }
      this.dbArchived.delete(id);
      if (row.title) this.dbTitles.set(id, row.title);
      this.refresh(id);
    }
  }

  stats(): CodexAccountStats {
    const byStatus: Record<UnifiedStatus, number> = { running: 0, "waiting-input": 0, "open-idle": 0, closed: 0, error: 0 };
    for (const s of this.published.values()) byStatus[s.status]++;
    return {
      account: this.account.id,
      home: this.account.home,
      stateDb: this.dbPath,
      socketPresent: controlSocketExists(this.rpc.socketPath),
      mode: this.mode,
      modeSwitches: this.modeSwitches,
      startMs: this.startMs,
      indexed: this.published.size,
      byStatus,
      syncs: this.syncs,
      syncFailures: this.syncFailures,
      lastSync: this.lastSync,
      fallbackReads: this.fallbackReads,
      fallbackErrors: this.fallbackErrors,
      lastFallback: this.lastFallback,
      refreshes: this.refreshes,
      readErrors: this.readErrors,
      ephemeralSkipped: this.ephemeralSkipped,
      unknownStatusValues: [...this.unknownStatusValues],
      emitted: { ...this.emitted },
      rpc: this.rpc.stats(),
      lastError: this.lastError,
    };
  }

  // ---- modes ----

  private setMode(mode: CodexAccountMode): void {
    if (this.mode === "stopped" || this.mode === mode) return;
    if (this.mode !== "starting") this.modeSwitches++;
    this.mode = mode;
    if (mode !== "fallback") {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.fallbackRun = null;
    }
  }

  private enterFallback(): Promise<void> {
    if (this.mode === "stopped") return Promise.resolve();
    if (this.mode === "fallback" && this.fallbackRun) return this.fallbackRun;
    this.setMode("fallback");
    this.syncing = true;
    this.buffer = [];
    this.overrides.clear();
    this.threads = new Map();
    this.pollTimer = setInterval(() => this.pollFallback(), this.pollMs);
    this.fallbackRun = Promise.resolve().then(() => this.pollFallback());
    return this.fallbackRun;
  }

  private pollFallback(): void {
    if (this.mode !== "fallback") return;
    if (controlSocketExists(this.rpc.socketPath)) this.rpc.retryNow();
    const read = readStateDb(this.account.id, this.dbPath);
    this.fallbackReads++;
    this.lastFallback = read.stats;
    if (read.stats.error !== null) {
      // Keep what the index holds; the next poll tries again.
      this.fallbackErrors++;
      this.lastError = `state db: ${read.stats.error}`;
      return;
    }
    this.publishAll(read.summaries);
  }

  // ---- daemon snapshot ----

  private async sync(gen: number): Promise<void> {
    this.syncing = true;
    this.buffer = [];
    this.overrides.clear();
    const t0 = performance.now();
    try {
      const next = new Map<string, Thread>();
      let pages = 0;
      let listed = 0;
      let duplicates = 0;
      let ephemeral = 0;
      let cursor: string | null = null;
      do {
        const page: ThreadListResponse = await this.rpc.request(
          "thread/list",
          { cursor, limit: PAGE_SIZE, archived: false, sourceKinds: ALL_SOURCE_KINDS },
          { timeoutMs: this.requestTimeoutMs },
        );
        pages++;
        for (const t of page.data) {
          listed++;
          if (t.ephemeral) {
            ephemeral++;
            continue;
          }
          const prev = next.get(t.id);
          if (prev) {
            duplicates++;
            if (prev.updatedAt >= t.updatedAt) continue;
          }
          next.set(t.id, t);
        }
        cursor = page.nextCursor;
      } while (cursor);

      // Subagent threads: thread/list leaves them out, so read each candidate directly.
      const candidates = new Set<string>();
      for (const s of this.published.values()) if (s.parentKey !== null) candidates.add(s.id);
      const db = readStateDb(this.account.id, this.dbPath);
      if (db.stats.error === null) {
        for (const s of db.summaries.values()) if (s.parentKey !== null) candidates.add(s.id);
        this.dbArchived = db.archived;
        this.dbTitles = new Map([...db.summaries.values()].filter((s) => s.title).map((s) => [s.id, s.title!]));
      }
      let archivedInDb = 0;
      for (const id of [...next.keys()]) {
        if (this.dbArchived.has(id)) {
          next.delete(id);
          archivedInDb++;
        }
      }
      const children = { candidates: 0, read: 0, unreadable: 0 };
      for (const id of candidates) {
        if (next.has(id) || this.dbArchived.has(id)) continue;
        children.candidates++;
        const t = await this.read(id);
        if (t && !t.ephemeral) {
          next.set(id, t);
          children.read++;
        } else {
          children.unreadable++;
        }
      }

      if (gen !== this.generation || this.mode === "stopped") return;
      this.threads = next;
      this.setMode("daemon");
      this.publishAll(this.daemonSnapshot());
      this.syncs++;
      this.lastSync = {
        at: Date.now(),
        ms: Math.round(performance.now() - t0),
        pages,
        listed,
        duplicates,
        ephemeral,
        children,
        indexed: next.size,
        archivedInDb,
      };
      const buffered = this.buffer;
      this.buffer = [];
      this.syncing = false;
      for (const n of buffered) this.apply(n);
    } catch (err) {
      if (gen !== this.generation || this.mode === "stopped") return;
      this.syncFailures++;
      this.noteError(err);
      // Drop this connection; the connect loop retries after a growing delay, and the failed
      // attempt moves the account to fallback meanwhile.
      this.rpc.fail(`snapshot: ${errorMessage(err)}`);
    }
  }

  private daemonSnapshot(): Map<string, SessionSummary> {
    const out = new Map<string, SessionSummary>();
    for (const [id, t] of this.threads) out.set(id, this.summarize(t));
    return out;
  }

  /** thread/read without turns. null when the daemon answers with an error (counted); transport errors throw. */
  private async read(id: string): Promise<Thread | null> {
    try {
      const res = await this.rpc.request("thread/read", { threadId: id, includeTurns: false }, { timeoutMs: this.requestTimeoutMs });
      return res.thread;
    } catch (err) {
      if (err instanceof RpcError) {
        this.readErrors++;
        this.noteError(err);
        return null;
      }
      throw err;
    }
  }

  // ---- notifications ----

  private onNotification(n: IndexNotification): void {
    if (this.mode === "stopped") return;
    if (this.syncing) {
      this.buffer.push(n);
      return;
    }
    this.apply(n);
  }

  private apply(n: IndexNotification): void {
    switch (n.method) {
      case "thread/started": {
        const t = n.params.thread;
        if (t.ephemeral) {
          this.ephemeralSkipped++;
          return;
        }
        if (this.threads.has(t.id)) {
          this.refresh(t.id);
          return;
        }
        if (this.dbArchived.has(t.id)) return;
        this.threads.set(t.id, t);
        this.publishOne(t.id);
        return;
      }
      case "thread/status/changed":
        this.override(n.params.threadId, { status: n.params.status });
        return;
      case "thread/closed":
        this.override(n.params.threadId, { status: { type: "notLoaded" } });
        return;
      case "thread/name/updated":
        this.override(n.params.threadId, { name: n.params.threadName ?? null });
        return;
      case "thread/archived":
        this.dbArchived.add(n.params.threadId);
        this.remove(n.params.threadId);
        return;
      case "thread/deleted":
        this.remove(n.params.threadId);
        return;
      case "thread/unarchived":
        this.dbArchived.delete(n.params.threadId);
        this.refresh(n.params.threadId);
        return;
    }
  }

  private override(id: string, o: Override): void {
    this.overrides.set(id, { ...this.overrides.get(id), ...o });
    if (this.threads.has(id)) this.publishOne(id);
    // Picks up what the notification does not carry (updatedAt, preview), and reads a thread
    // this index does not know yet (a subagent, a thread started before this connection).
    this.refresh(id);
  }

  private remove(id: string): void {
    this.threads.delete(id);
    this.overrides.delete(id);
    this.removals.set(id, (this.removals.get(id) ?? 0) + 1);
    this.put(id, null);
  }

  /** Re-read one thread. One read per thread at a time; a request during a read runs once more after it. */
  private refresh(id: string): void {
    if (this.refreshing.has(id)) {
      this.refreshAgain.add(id);
      return;
    }
    this.refreshing.add(id);
    this.refreshes++;
    const removals = this.removals.get(id) ?? 0;
    const gen = this.generation;
    this.read(id).then(
      (t) => this.afterRefresh(id, removals, gen, t),
      (err: unknown) => {
        this.noteError(err);
        this.afterRefresh(id, removals, gen, null);
      },
    );
  }

  private afterRefresh(id: string, removals: number, gen: number, t: Thread | null): void {
    this.refreshing.delete(id);
    const current =
      gen === this.generation && this.mode === "daemon" && !this.syncing && (this.removals.get(id) ?? 0) === removals;
    if (current && t) {
      if (t.ephemeral) {
        this.ephemeralSkipped++;
      } else if (this.dbArchived.has(id)) {
        // archived in the state database: stays out of the index
      } else {
        this.threads.set(id, t);
        this.publishOne(id);
      }
    }
    if (this.refreshAgain.delete(id) && current) this.refresh(id);
  }

  // ---- publishing ----

  private summarize(t: Thread): SessionSummary {
    const o = this.overrides.get(t.id);
    const status = this.mapStatus(o?.status ?? t.status);
    const name = o && "name" in o ? o.name : t.name;
    const account = this.account.id;
    return {
      key: sessionKey("codex", account, t.id),
      provider: "codex",
      account,
      id: t.id,
      cwd: t.cwd || null,
      name: name || null,
      // The daemon's Thread has no title field; threads.title exists only in the state database.
      // A subagent thread's title is the nickname the daemon gave it.
      title: this.dbTitles.get(t.id) ?? (t.agentNickname || null),
      preview: t.preview || null,
      status,
      owner: this.ownerOf(t.id, status),
      pid: null,
      tmuxPane: null,
      parentKey: t.parentThreadId ? sessionKey("codex", account, t.parentThreadId) : null,
      updatedAt: t.updatedAt * 1000,
      createdAt: t.createdAt * 1000,
      sizeBytes: fileSize(t.path),
      entrypoint: t.originator ?? originLabel(t.source),
    };
  }

  private mapStatus(s: ThreadStatus): UnifiedStatus {
    switch (s.type) {
      case "notLoaded":
        return "closed";
      case "idle":
        return "open-idle";
      case "systemError":
        return "error";
      case "active": {
        const flags = s.activeFlags ?? [];
        return flags.includes("waitingOnUserInput") || flags.includes("waitingOnApproval") ? "waiting-input" : "running";
      }
      default:
        this.unknownStatusValues.add(String((s as { type?: unknown }).type));
        return "open-idle";
    }
  }

  private ownerOf(id: string, status: UnifiedStatus): Owner {
    if (status === "closed") return "none";
    return this.ownThreadIds().has(id) ? "ui" : "terminal";
  }

  private publishOne(id: string): void {
    const t = this.threads.get(id);
    this.put(id, t ? this.summarize(t) : null);
  }

  /** Make the index hold exactly `next` for this account, emitting only the differences. */
  private publishAll(next: Map<string, SessionSummary>): void {
    for (const id of [...this.published.keys()]) if (!next.has(id)) this.put(id, null);
    for (const [id, s] of next) this.put(id, s);
  }

  private put(id: string, s: SessionSummary | null): void {
    if (this.mode === "stopped" || this.emit === null) return;
    const prev = this.published.get(id);
    if (s === null) {
      if (!prev) return;
      this.published.delete(id);
      this.emitted.removes++;
      this.emit({ type: "remove", key: prev.key });
      return;
    }
    if (prev && sameSummary(prev, s)) return;
    this.published.set(id, s);
    this.emitted.upserts++;
    this.emit({ type: "upsert", session: s });
  }

  private noteError(err: unknown): void {
    this.lastError = errorMessage(err);
  }
}

// ---- state database (fallback, and subagent candidates) ----

interface StateDbRead {
  summaries: Map<string, SessionSummary>;
  /** Ids with archived = 1. */
  archived: Set<string>;
  stats: CodexFallbackStats;
}

/** Read the unarchived threads of a state database, read-only. Every thread is `closed`. */
export function readStateDb(accountId: string, file: string): StateDbRead {
  const t0 = performance.now();
  const summaries = new Map<string, SessionSummary>();
  const archived = new Set<string>();
  const stats: CodexFallbackStats = { at: Date.now(), ms: 0, missing: false, rows: 0, invalidRows: 0, error: null };
  if (!fs.existsSync(file)) {
    stats.missing = true;
    return { summaries, archived, stats };
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("SELECT * FROM threads WHERE archived = 0").all();
    stats.rows = rows.length;
    for (const row of rows) {
      const s = rowToSummary(accountId, row);
      if (s) summaries.set(s.id, s);
      else stats.invalidRows++;
    }
    for (const row of db.prepare("SELECT id FROM threads WHERE archived != 0").all()) {
      if (typeof row.id === "string") archived.add(row.id);
    }
  } catch (err) {
    stats.error = errorMessage(err);
  } finally {
    db?.close();
  }
  stats.ms = Math.round(performance.now() - t0);
  return { summaries, archived, stats };
}

/** archived and title of these ids, read-only. An id without a row is absent from the map. */
function readRows(file: string, ids: string[]): Map<string, { archived: boolean; title: string | null }> {
  const out = new Map<string, { archived: boolean; title: string | null }>();
  if (ids.length === 0 || !fs.existsSync(file)) return out;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT id, archived, title FROM threads WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids);
    for (const r of rows) out.set(String(r.id), { archived: Number(r.archived) !== 0, title: text(r.title) });
  } finally {
    db.close();
  }
  return out;
}

function rowToSummary(accountId: string, row: Record<string, SQLOutputValue>): SessionSummary | null {
  const id = text(row.id);
  if (id === null) return null;
  const source = text(row.source);
  const parent = subagentParent(source);
  return {
    key: sessionKey("codex", accountId, id),
    provider: "codex",
    account: accountId,
    id,
    cwd: text(row.cwd),
    name: text(row.name),
    // A subagent thread's title is its nickname (agent_nickname, or the spawn record in `source`).
    title: text(row.title) ?? text(row.agent_nickname) ?? subagentNickname(source),
    preview: text(row.preview) ?? text(row.first_user_message),
    status: "closed",
    owner: "none",
    pid: null,
    tmuxPane: null,
    parentKey: parent ? sessionKey("codex", accountId, parent) : null,
    updatedAt: millis(row.updated_at_ms, row.updated_at) ?? 0,
    createdAt: millis(row.created_at_ms, row.created_at),
    sizeBytes: fileSize(text(row.rollout_path)),
    entrypoint: text(row.originator) ?? dbOriginLabel(source),
  };
}

/** Size of a thread's rollout file in bytes, the same measure as a Claude transcript's sizeBytes. */
function fileSize(file: string | null | undefined): number | null {
  if (!file) return null;
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function text(v: SQLOutputValue | undefined): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Prefer the `*_ms` column; fall back to the seconds column. */
function millis(ms: SQLOutputValue | undefined, sec: SQLOutputValue | undefined): number | null {
  if (typeof ms === "number" || typeof ms === "bigint") return Number(ms);
  if (typeof sec === "number" || typeof sec === "bigint") return Number(sec) * 1000;
  return null;
}

/** threads.source is a plain kind ("cli") or JSON such as {"subagent":{"thread_spawn":{"parent_thread_id":...}}}. */
function parseDbSource(source: string | null): Record<string, unknown> | null {
  if (source === null || !source.startsWith("{")) return null;
  try {
    const v: unknown = JSON.parse(source);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type DbThreadSpawn = { parent_thread_id?: unknown; agent_nickname?: unknown };

function threadSpawn(source: string | null): DbThreadSpawn | undefined {
  const obj = parseDbSource(source);
  const sub = (obj?.subagent ?? obj?.subAgent) as { thread_spawn?: DbThreadSpawn } | undefined;
  return sub?.thread_spawn;
}

/** The parent thread id a subagent thread's `threads.source` names, or null for a top-level thread. */
export function subagentParent(source: string | null): string | null {
  const parent = threadSpawn(source)?.parent_thread_id;
  return typeof parent === "string" && parent !== "" ? parent : null;
}

/** The nickname a subagent thread's `threads.source` records, or null. */
export function subagentNickname(source: string | null): string | null {
  const nickname = threadSpawn(source)?.agent_nickname;
  return typeof nickname === "string" && nickname !== "" ? nickname : null;
}

function dbOriginLabel(source: string | null): string | null {
  if (source === null) return null;
  const obj = parseDbSource(source);
  if (obj) return Object.keys(obj)[0] ?? null;
  return source.startsWith("{") ? null : source;
}

function originLabel(source: ThreadOrigin): string | null {
  if (typeof source === "string") return source;
  return Object.keys(source)[0] ?? null;
}

function sameSummary(a: SessionSummary, b: SessionSummary): boolean {
  const keys = Object.keys(a) as (keyof SessionSummary)[];
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
