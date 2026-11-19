import fs from "node:fs";
import path from "node:path";
import type { SearchDoc, SessionSummary, ThreadLiveEvent, ThreadSearchResult, ThreadSnapshot } from "@maru/shared";
import { THREAD_OLDER_ROWS, deliveredIds, rowsThrough, searchDocOf, searchDocsOf, threadSearchResult, windowStartIndex } from "@maru/shared";
import type { ClaudeAccount } from "../config.ts";
import type { SessionIndex } from "../index/store.ts";
import { readTail, type RawRecord } from "../transcript/claudeTranscript.ts";
import type { Subscription, TranscriptHub } from "../transcript/transcriptHub.ts";
import { GoalScanner } from "../claude/goalScan.ts";
import { createClaudeProjector, type ClaudeLiveStatus, type ClaudeProjector, type ClaudeTurnInfo } from "../claude/projection/projector.ts";
import {
  childTranscriptRelativePath, configDirsResolver, configRelativePath, createFsSidecars, sessionRelativeDir,
  type ClaudePathResolver,
} from "../claude/projection/sidecars.ts";

const THREAD_RE = /^claude:([^:]+):([0-9a-f-]{36})(?::agent-([A-Za-z0-9_-]+))?$/;

/** Lines of the first page and of each older page. A page size, not a cap: older pages stay reachable. */
export const DEFAULT_PAGE = 300;

/** How long a subscribe waits for a transcript that does not exist yet, ms. */
const TRANSCRIPT_WAIT_MS = 10_000;

import type { ThreadListener, ThreadProvider, ThreadSubscribeOptions } from "./router.ts";
import { rowsOfEvents, type DeliveryHooks } from "./delivery.ts";
import { ThreadListeners, heldRows, resumeRows } from "./windowed.ts";

interface OpenThread {
  threadId: string;
  /** The projector was built read-only: only a process this server started may answer. */
  readonly: boolean;
  file: string;
  projector: ClaudeProjector;
  startOffset: number;
  hasMoreBefore: boolean;
  pageSize: number;
  listeners: ThreadListeners;
  follow: Subscription;
  stopIndex: () => void;
  stopTurns: () => void;
  sidecarTimer: NodeJS.Timeout;
  /** Serializes page loads and resets for this thread. */
  queue: Promise<unknown>;
  /** The searchable texts of the lines this thread has not read, for a find (searchDocs). */
  searchBase: SearchBase | null;
  searchBuild: Promise<SearchBase> | null;
  /** Ids the rows of live events showed while older pages were read; reported once the rows have gone out. */
  deliveredWait: Set<string>;
  /** End offset of the last transcript line the projector has consumed (the first page, then each live batch). */
  consumedEnd: number;
  /**
   * End offset of the lines whose rows have gone out to the subscribers: `consumedEnd` as it was at
   * the last moment no older-page publish was holding rows back (reportDelivered). A line before
   * it has its row at every subscriber; a line after it may not.
   */
  sentEnd: number;
}

/**
 * The searchable texts of a whole transcript, read once for a find in a thread that holds only its
 * newest lines (DESIGN.md 6u). The projection that read them is dropped; the texts stay.
 *   docsBefore  for every visible item, how many texts come before it: where the thread's own
 *               rows (its newest lines, kept current by live lines) take over
 */
interface SearchBase {
  /** The thread's projector when this was read; a reload makes a new one and this goes stale. */
  projector: ClaudeProjector;
  docs: SearchDoc[];
  docsBefore: Map<string, number>;
}

export class ThreadNotFound extends Error {}

/** The turns of the sessions this server runs (drive/claudeRuns.ts turnInfo, onTurns). */
export interface ClaudeTurnSource {
  turnInfo(sessionKey: string): ClaudeTurnInfo;
  onTurns(listener: (sessionKey: string) => void): () => void;
}

/**
 * Claude threads for the UI (DESIGN.md 3.1, docs/event-model.md): one projector per open
 * transcript, fed by the tail page, live appends from the transcript hub, older pages on request,
 * and the registry status from the session index. Subscribers of one thread share it.
 */
export class ClaudeThreads implements ThreadProvider {
  private accounts: ClaudeAccount[];
  private index: SessionIndex;
  private hub: TranscriptHub<RawRecord[]>;
  private resolve: ClaudePathResolver;
  private open = new Map<string, OpenThread>();
  private opening = new Map<string, Promise<OpenThread>>();
  private transcriptWaitMs: number;
  private turns: ClaudeTurnSource | null;
  private delivery: DeliveryHooks | null;

  constructor(deps: { accounts: ClaudeAccount[]; index: SessionIndex; hub: TranscriptHub<RawRecord[]>; transcriptWaitMs?: number; turns?: ClaudeTurnSource; delivery?: DeliveryHooks }) {
    this.transcriptWaitMs = deps.transcriptWaitMs ?? TRANSCRIPT_WAIT_MS;
    this.turns = deps.turns ?? null;
    this.delivery = deps.delivery ?? null;
    this.accounts = deps.accounts;
    this.index = deps.index;
    this.hub = deps.hub;
    this.resolve = configDirsResolver(deps.accounts.map((a) => a.dir));
  }

  handles(threadId: string): boolean {
    return THREAD_RE.test(threadId);
  }

  /**
   * Subscribe; the listener gets the snapshot first, then live events. Returns the unsubscribe. A
   * windowed subscriber (`rows`) waits until the thread has read lines enough for its window.
   */
  async subscribe(threadId: string, listener: ThreadListener, opts: ThreadSubscribeOptions = {}): Promise<() => void> {
    const { pageSize = DEFAULT_PAGE, rows, have } = opts;
    for (;;) {
      const t = await this.get(threadId, pageSize);
      const off = () => {
        t.listeners.delete(listener);
        if (t.listeners.size === 0) this.close(t);
      };
      if (rows === undefined) {
        t.listeners.add(listener, this.snapshotOf(t), t.hasMoreBefore);
        this.joined(t);
        return off;
      }
      let added = false;
      try {
        await this.serial(t, async () => {
          if (this.open.get(threadId) !== t) return;
          // A client that kept rows from an earlier visit needs them whole from its first row on (windowed.ts resumeRows).
          const resume = have && rows !== undefined ? resumeRows(t.projector.snapshot().visibleTurnItems, have) : null;
          if (await this.ensureRows(t, Math.max(rows, resume ?? 0))) t.listeners.publish(() => this.snapshotOf(t), t.hasMoreBefore);
          if (this.open.get(threadId) !== t) return;
          t.listeners.add(listener, this.snapshotOf(t), t.hasMoreBefore, rows, resume === null ? undefined : have);
          added = true;
        });
      } catch (err) {
        // A thread this subscribe opened and nobody holds is not left following its file.
        if (t.listeners.size === 0) this.close(t);
        throw err;
      }
      // The last subscriber left while this one waited: the thread closed, open it again.
      if (added) {
        this.joined(t);
        return off;
      }
    }
  }

  /**
   * Older history. A windowed subscriber's window grows by `rows` conversation rows (reading lines
   * until they are there); otherwise the previous page is read and every plain subscriber gets the
   * new snapshot. Windowed subscribers follow any lines read (threads/windowed.ts).
   */
  loadOlder(threadId: string, listener?: ThreadListener, rows = THREAD_OLDER_ROWS, until?: string): Promise<void> {
    const t = this.open.get(threadId);
    if (!t) return Promise.reject(new ThreadNotFound(`thread not open: ${threadId}`));
    return this.serial(t, async () => {
      const w = listener ? t.listeners.window(listener) : undefined;
      if (w && listener) {
        const held = heldRows(w, t.projector.snapshot().visibleTurnItems);
        let want = held + rows;
        let read = false;
        if (until !== undefined) {
          // A find's step to an item the client does not hold: lines until the item is read.
          read = await this.ensureItem(t, until);
          const through = rowsThrough(t.projector.snapshot().visibleTurnItems, until);
          want = through === null ? held : Math.max(want, through);
        }
        w.rows = want;
        read = (await this.ensureRows(t, w.rows)) || read;
        t.listeners.publish(() => this.snapshotOf(t), t.hasMoreBefore, read ? { requester: listener } : { requester: listener, only: listener });
        return;
      }
      if (!t.hasMoreBefore) return;
      await this.readOlderPage(t);
      t.listeners.publish(() => this.snapshotOf(t), t.hasMoreBefore);
    });
  }

  /**
   * Find in an open thread (DESIGN.md 6u): the user and assistant texts of the whole transcript,
   * also the lines the thread has not read. Those are read once in one pass by a projection of
   * their own and kept as texts (SearchBase); the thread's newest rows come from the thread itself,
   * so live lines are found without reading the file again.
   */
  async search(threadId: string, query: string, reqId: string): Promise<ThreadSearchResult> {
    const t = this.open.get(threadId);
    if (!t) throw new ThreadNotFound(`thread not open: ${threadId}`);
    return threadSearchResult(threadId, reqId, query, await this.searchDocs(t));
  }

  closeAll(): void {
    for (const t of [...this.open.values()]) this.close(t);
  }

  /** A browser holds the session's thread or one of its subagent threads. */
  isViewed(sessionKey: string): boolean {
    for (const t of this.open.values()) {
      if (t.listeners.size > 0 && (t.threadId === sessionKey || t.threadId.startsWith(`${sessionKey}:agent-`))) return true;
    }
    return false;
  }

  // ---- internals ----

  private get(threadId: string, pageSize: number): Promise<OpenThread> {
    const existing = this.open.get(threadId);
    if (existing) return Promise.resolve(existing);
    let p = this.opening.get(threadId);
    if (!p) {
      p = this.create(threadId, pageSize).finally(() => this.opening.delete(threadId));
      this.opening.set(threadId, p);
    }
    return p;
  }

  private async create(threadId: string, pageSize: number): Promise<OpenThread> {
    const m = THREAD_RE.exec(threadId);
    if (!m) throw new ThreadNotFound(`not a Claude thread id: ${threadId}`);
    const [, account, sessionId, agentId] = m as unknown as [string, string, string, string | undefined];
    const acct = this.accounts.find((a) => a.id === account);
    if (!acct) throw new ThreadNotFound(`unknown account: ${account}`);
    const find = () => (agentId ? this.findChildTranscript(acct, sessionId, agentId) : this.findTranscript(acct, sessionId));
    let file = find();
    // A session this server just started reports its id a moment before the CLI writes the
    // transcript (and a subagent's file appears after its first line); wait briefly for it.
    for (let waited = 0; !file && waited < this.transcriptWaitMs; waited += 200) {
      await new Promise((r) => setTimeout(r, 200));
      file = find();
    }
    if (!file) throw new ThreadNotFound(`transcript not found for ${threadId}`);

    const sessionKey = `claude:${account}:${sessionId}`;
    const session = this.index.get(sessionKey);
    const projector = createClaudeProjector({
      threadId,
      account,
      sessionId,
      ...(agentId ? { agentId } : {}),
      path: file,
      // Only a process this server started may answer; a terminal-owned or closed session is read-only.
      readonly: agentId !== undefined || session?.owner !== "ui",
      sidecars: createFsSidecars(file, this.resolve),
      live: agentId ? null : liveStatusOf(session),
      ...(agentId || !this.turns ? {} : { turns: this.turns.turnInfo(sessionKey) }),
    });
    const page = await readTail(file, { maxRecords: pageSize });
    projector.push(page.records);

    const t: OpenThread = {
      threadId, file, projector, pageSize,
      readonly: agentId !== undefined || session?.owner !== "ui",
      startOffset: page.startOffset,
      hasMoreBefore: page.hasMoreBefore,
      listeners: new ThreadListeners(),
      follow: { unsubscribe() {} },
      stopIndex: () => {},
      stopTurns: () => {},
      sidecarTimer: setInterval(() => this.emit(t, t.projector.refreshSidecars()), 5000),
      queue: Promise.resolve(),
      searchBase: null,
      searchBuild: null,
      deliveredWait: new Set(),
      consumedEnd: page.endOffset,
      sentEnd: page.endOffset,
    };
    t.sidecarTimer.unref();
    t.follow = this.hub.subscribe(file, page.endOffset, {
      onRecords: (records) => this.consume(t, records),
      onReset: () => {
        void this.serial(t, () => this.reload(t));
      },
      onError: (err) => t.listeners.error(errorText(err)),
    });
    if (!agentId) {
      t.stopIndex = this.index.subscribe((e) => {
        if (e.type === "upsert" && e.session.key === sessionKey) {
          // A session this server just started turns "ui"-owned once the driver finds its pid,
          // usually a moment after the first subscribe; the projector is rebuilt writable.
          if ((e.session.owner !== "ui") !== t.readonly) {
            void this.serial(t, () => this.reload(t));
            return;
          }
          this.emit(t, t.projector.setLiveStatus(liveStatusOf(e.session)));
        }
      });
      const turns = this.turns;
      if (turns) {
        t.stopTurns = turns.onTurns((k) => {
          if (k !== sessionKey) return;
          this.emit(t, t.projector.setTurns(turns.turnInfo(k)));
          // A rewind to a line older than the loaded ones (DESIGN.md 6o).
          if (t.projector.needsOlder()) {
            void this.serial(t, async () => {
              if (await this.loadUntilKept(t)) t.listeners.publish(() => this.snapshotOf(t), t.hasMoreBefore);
            });
          }
        });
        // What changed while the first page was read; nobody listens yet.
        t.projector.setTurns(turns.turnInfo(sessionKey));
        await this.loadUntilKept(t);
      }
    }
    this.open.set(threadId, t);
    if (!agentId) void this.scanGoal(t);
    return t;
  }

  /** Remembers each transcript's last goal scan, so a later open reads only what was appended. */
  private readonly goalScanner = new GoalScanner();

  /**
   * The goal_status records of the whole transcript (claude/goalScan.ts), read after the page is
   * out, since a goal set more than a page back or a long turn that has not ended yet leaves the
   * page without the record that fixes it. The projector takes them as the lines before the scan's
   * end and a patch carries any change of state.goal. A projector replaced meanwhile (a reload)
   * is not given a scan of the file it replaced.
   */
  private async scanGoal(t: OpenThread): Promise<void> {
    const projector = t.projector;
    let scan;
    try {
      scan = await this.goalScanner.scan(t.file);
    } catch (err) {
      // A transcript that moved or was cut while read: the reload that follows scans it again.
      console.error(`claude threads: goal scan of ${t.threadId} failed: ${errorText(err)}`);
      return;
    }
    await this.serial(t, async () => {
      if (this.open.get(t.threadId) !== t || t.projector !== projector) return;
      this.emit(t, projector.setGoalHistory(scan));
    });
  }

  /**
   * The file was truncated, replaced or removed: rebuild from its tail and resend the snapshot. A
   * removed file may have moved (a rehome puts the transcript and its subagents in the new folder's
   * project directory), so the thread looks for it again and follows it there.
   */
  private async reload(t: OpenThread): Promise<void> {
    const m = THREAD_RE.exec(t.threadId)!;
    // The old rows are replaced below: until the new snapshot goes out no line counts as sent.
    t.sentEnd = 0;
    if (!fs.existsSync(t.file)) {
      const acct = this.accounts.find((a) => a.id === m[1]);
      const moved = acct ? (m[3] ? this.findChildTranscript(acct, m[2]!, m[3]) : this.findTranscript(acct, m[2]!)) : null;
      if (moved) t.file = moved;
    }
    const session = this.index.get(`claude:${m[1]}:${m[2]}`);
    const projector = createClaudeProjector({
      threadId: t.threadId,
      account: m[1]!,
      sessionId: m[2]!,
      ...(m[3] ? { agentId: m[3] } : {}),
      path: t.file,
      readonly: m[3] !== undefined || session?.owner !== "ui",
      sidecars: createFsSidecars(t.file, this.resolve),
      live: m[3] ? null : liveStatusOf(session),
      ...(m[3] || !this.turns ? {} : { turns: this.turns.turnInfo(`claude:${m[1]}:${m[2]}`) }),
    });
    // Windowed subscribers get the difference once the new projector stands (threads/windowed.ts).
    t.listeners.beginPaging(() => this.snapshotOf(t));
    let page;
    try {
      page = await readTail(t.file, { maxRecords: t.pageSize });
    } catch (err) {
      t.listeners.publish(() => this.snapshotOf(t), t.hasMoreBefore);
      t.listeners.error(`Could not re-read the transcript: ${errorText(err)}`);
      return;
    }
    projector.push(page.records);
    // Turns that changed while the page was read went to the old projector.
    if (!m[3] && this.turns) projector.setTurns(this.turns.turnInfo(`claude:${m[1]}:${m[2]}`));
    t.projector = projector;
    t.readonly = m[3] !== undefined || session?.owner !== "ui";
    t.startOffset = page.startOffset;
    t.hasMoreBefore = page.hasMoreBefore;
    await this.loadUntilKept(t);
    // The windows the subscribers hold, read again (a reload starts from the tail page).
    await this.ensureRows(t, t.listeners.rowsWanted());
    // The hub follows from offset 0 after a reset; restart it at the new tail instead.
    t.follow.unsubscribe();
    t.consumedEnd = page.endOffset;
    t.follow = this.hub.subscribe(t.file, page.endOffset, {
      onRecords: (records) => this.consume(t, records),
      onReset: () => {
        void this.serial(t, () => this.reload(t));
      },
      onError: (err) => t.listeners.error(errorText(err)),
    });
    t.listeners.publish(() => this.snapshotOf(t), t.hasMoreBefore);
    // The new snapshot has gone out (serial reports the rest right after this step).
    t.sentEnd = t.consumedEnd;
    if (!m[3]) void this.scanGoal(t);
  }

  /**
   * Older pages until a waiting rewind's kept line is loaded (or the file's start), so the thread
   * folds what came after it (DESIGN.md 6o). True when it read any.
   */
  private async loadUntilKept(t: OpenThread): Promise<boolean> {
    let read = false;
    while (t.hasMoreBefore && t.projector.needsOlder()) {
      await this.readOlderPage(t);
      read = true;
    }
    return read;
  }

  /**
   * Older pages until the newest `rows` conversation rows are whole (or the file's start). True
   * when it read any. A page is `pageSize` lines, so a window of a few rows reads about one page.
   */
  private async ensureRows(t: OpenThread, rows: number): Promise<boolean> {
    let read = false;
    // Each page of one request doubles: a page refolds every line read (projector prepend), so a
    // window of many rows costs about twice its lines instead of their square.
    let lines = t.pageSize;
    while (rows > 0 && t.hasMoreBefore && !windowStartIndex(t.projector.snapshot().visibleTurnItems, rows, true).complete) {
      await this.readOlderPage(t, lines);
      lines *= 2;
      read = true;
    }
    return read;
  }

  /** Older pages, doubling as ensureRows does, until item `id` is read (or the file's start). True when it read any. */
  private async ensureItem(t: OpenThread, id: string): Promise<boolean> {
    let read = false;
    let lines = t.pageSize;
    while (t.hasMoreBefore && !t.projector.snapshot().visibleTurnItems.some((r) => r.item.id === id)) {
      await this.readOlderPage(t, lines);
      lines *= 2;
      read = true;
    }
    return read;
  }

  /**
   * The searchable texts of the whole thread, in order: those of the lines the thread has not read
   * (SearchBase, up to the thread's first row) and then the thread's own rows.
   */
  private async searchDocs(t: OpenThread): Promise<SearchDoc[]> {
    const rows = t.projector.snapshot().visibleTurnItems;
    if (!t.hasMoreBefore) return searchDocsOf(rows);
    for (let attempt = 0; ; attempt++) {
      if (t.searchBase?.projector !== t.projector) t.searchBase = null;
      const base = t.searchBase ?? (t.searchBase = await this.buildSearchBase(t));
      const first = rows[0]?.item.id;
      const cut = first === undefined ? base.docs.length : base.docsBefore.get(first);
      if (cut !== undefined) return [...base.docs.slice(0, cut), ...searchDocsOf(rows)];
      // The thread's first row is not in what was read (the file changed under it): read once more,
      // then take the texts the thread does not hold, followed by its own.
      if (attempt === 0) {
        t.searchBase = null;
        continue;
      }
      const own = new Set(rows.map((r) => r.item.id));
      return [...base.docs.filter((d) => !own.has(d.id)), ...searchDocsOf(rows)];
    }
  }

  /** One pass over the whole transcript into the texts a find looks at (SearchBase). Shared by concurrent finds. */
  private buildSearchBase(t: OpenThread): Promise<SearchBase> {
    if (t.searchBuild) return t.searchBuild;
    const projectorNow = t.projector;
    const build = async (): Promise<SearchBase> => {
      const m = THREAD_RE.exec(t.threadId)!;
      const sessionKey = `claude:${m[1]}:${m[2]}`;
      const projector = createClaudeProjector({
        threadId: t.threadId,
        account: m[1]!,
        sessionId: m[2]!,
        ...(m[3] ? { agentId: m[3] } : {}),
        path: t.file,
        readonly: true,
        sidecars: createFsSidecars(t.file, this.resolve),
        live: null,
        ...(m[3] || !this.turns ? {} : { turns: this.turns.turnInfo(sessionKey) }),
      });
      const page = await readTail(t.file, { maxRecords: Number.MAX_SAFE_INTEGER });
      projector.push(page.records);
      const docs: SearchDoc[] = [];
      const docsBefore = new Map<string, number>();
      for (const row of projector.snapshot().visibleTurnItems) {
        docsBefore.set(row.item.id, docs.length);
        const doc = searchDocOf(row);
        // A copy of its own: a text sliced from a parsed line would keep the whole line alive (V8 sliced strings).
        if (doc && doc.text.length > 0) docs.push({ ...doc, text: Buffer.from(doc.text, "utf8").toString("utf8") });
      }
      return { projector: projectorNow, docs, docsBefore };
    };
    const p = build().finally(() => {
      if (t.searchBuild === p) t.searchBuild = null;
    });
    t.searchBuild = p;
    return p;
  }

  /**
   * The page of lines before the loaded ones, folded in. Windowed subscribers hold back their row
   * events from here until the caller's publish (threads/windowed.ts).
   */
  private async readOlderPage(t: OpenThread, lines = t.pageSize): Promise<void> {
    t.listeners.beginPaging(() => this.snapshotOf(t));
    const page = await readTail(t.file, { maxRecords: lines, beforeOffset: t.startOffset });
    t.projector.prepend(page.records);
    t.startOffset = page.startOffset;
    t.hasMoreBefore = page.hasMoreBefore;
  }

  /**
   * One step at a time per thread. A step that began reading pages and stopped before its publish
   * (a read failed) still ends the paging, so windowed subscribers get row events again.
   */
  private serial(t: OpenThread, fn: () => Promise<void>): Promise<void> {
    const step = async () => {
      try {
        await fn();
      } finally {
        if (t.listeners.paging) t.listeners.publish(() => this.snapshotOf(t), t.hasMoreBefore);
      }
      this.reportDelivered(t);
    };
    const run = t.queue.then(step, step);
    t.queue = run.catch(() => {});
    return run;
  }

  private snapshotOf(t: OpenThread): ThreadSnapshot {
    return { ...t.projector.snapshot(), hasMoreBefore: t.hasMoreBefore };
  }

  /** A live batch from the transcript follower: the projector consumes it and its rows go out. */
  private consume(t: OpenThread, records: RawRecord[]): void {
    const last = records[records.length - 1];
    const events = t.projector.push(records);
    if (last) t.consumedEnd = last.offset + last.length;
    this.emit(t, events);
  }

  private emit(t: OpenThread, events: ThreadLiveEvent[]): void {
    t.listeners.events(events, t.hasMoreBefore);
    if (this.delivery) for (const id of deliveredIds(rowsOfEvents(events))) t.deliveredWait.add(id);
    // While older pages are read the windowed subscribers get these rows with the publish (serial reports then).
    this.reportDelivered(t);
  }

  /**
   * The transcript offset below which this session's rows have gone out to every subscriber of
   * its thread (DESIGN.md 4.4): the server's transcript scan settles a line below it and leaves a
   * line at or beyond it to the delivery hook. Infinity when no thread holds the session (no one
   * shows its rows). 0 while the thread is being opened: the snapshot the opener waits for was
   * read before this call and the live rows after it are not out yet.
   */
  sentEnd(sessionKey: string): number {
    if (this.opening.has(sessionKey)) return 0;
    const t = this.open.get(sessionKey);
    return t ? t.sentEnd : Infinity;
  }

  /**
   * Tells the server which client ids the rows just sent show. It runs after the rows went to the
   * subscribers' sockets, so a waiting message leaves the list after its row has arrived, never
   * before (a socket keeps the order of its sends). The same moment moves `sentEnd`.
   */
  private reportDelivered(t: OpenThread): void {
    if (t.listeners.paging) return;
    t.sentEnd = t.consumedEnd;
    if (t.deliveredWait.size === 0) return;
    const ids = t.deliveredWait;
    t.deliveredWait = new Set();
    const m = THREAD_RE.exec(t.threadId);
    if (m && !m[3]) this.delivery?.delivered(`claude:${m[1]}:${m[2]}`, ids);
  }

  /** A subscriber got the snapshot: the ids its rows show, then the transcript beyond them. */
  private joined(t: OpenThread): void {
    const m = THREAD_RE.exec(t.threadId);
    if (!this.delivery || !m || m[3]) return;
    const key = `claude:${m[1]}:${m[2]}`;
    const ids = deliveredIds(t.projector.snapshot().visibleTurnItems);
    if (ids.size > 0) this.delivery.delivered(key, ids);
    this.delivery.subscribed?.(key);
  }

  private close(t: OpenThread): void {
    if (this.open.get(t.threadId) !== t) return;
    this.open.delete(t.threadId);
    t.follow.unsubscribe();
    t.stopIndex();
    t.stopTurns();
    clearInterval(t.sidecarTimer);
  }

  private findTranscript(acct: ClaudeAccount, sessionId: string): string | null {
    const projects = path.join(acct.dir, "projects");
    let dirs: string[];
    try {
      dirs = fs.readdirSync(projects);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const f = path.join(projects, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
    return null;
  }

  /**
   * A subagent or workflow agent transcript. It can sit under another account's config dir when
   * the session was resumed there, and a workflow agent sits under its run directory.
   */
  private findChildTranscript(acct: ClaudeAccount, sessionId: string, agentId: string): string | null {
    const parentFile = this.findTranscript(acct, sessionId) ?? this.findAnyTranscript(sessionId);
    if (!parentFile) return null;
    const rel = configRelativePath(parentFile);
    if (!rel) return null;
    const sessionDir = sessionRelativeDir(rel);
    const direct = childTranscriptRelativePath(sessionDir, agentId);
    if (direct) {
      const hits = this.resolve(direct);
      if (hits[0]) return hits[0];
    }
    for (const runsDir of this.resolve(`${sessionDir}/subagents/workflows`)) {
      let runs: string[];
      try {
        runs = fs.readdirSync(runsDir);
      } catch {
        continue;
      }
      for (const run of runs) {
        const f = path.join(runsDir, run, `agent-${agentId}.jsonl`);
        if (fs.existsSync(f)) return f;
      }
    }
    return null;
  }

  private findAnyTranscript(sessionId: string): string | null {
    for (const a of this.accounts) {
      const f = this.findTranscript(a, sessionId);
      if (f) return f;
    }
    return null;
  }
}

/** The projector's registry status (event-model 7.10) from the index summary. */
export function liveStatusOf(s: SessionSummary | undefined): ClaudeLiveStatus {
  if (!s) return null;
  switch (s.status) {
    case "running":
      return "busy";
    case "waiting-input":
      return "waiting";
    case "open-idle":
      return "idle";
    default:
      return null;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
