import type { CodexAccount } from "../config.ts";
import type { SessionIndex } from "../index/store.ts";
import { connect, type CodexRpc } from "../codex/rpc.ts";
import { createCodexThreadView, type CodexThreadView } from "../codex/projection/threadView.ts";
import { openRolloutHistory, rolloutStatsLine } from "../codex/projection/rolloutFallback.ts";
import type { SessionChosen, ThreadLiveEvent, ThreadSearchResult, ThreadSnapshot } from "@maru/shared";
import { THREAD_OLDER_ROWS, deliveredIds, rowsThrough, searchDocsOf, threadSearchResult, windowStartIndex } from "@maru/shared";
import type { ThreadListener, ThreadProvider, ThreadSubscribeOptions } from "./router.ts";
import { ThreadListeners, heldRows, resumeRows } from "./windowed.ts";
import { rowsOfEvents, type DeliveryHooks } from "./delivery.ts";

const THREAD_RE = /^codex:([^:]+):(.+)$/;

/**
 * Turns of the first page and of each older page. A page size, not a cap: older pages stay
 * reachable. Codex turns run long (one 20-turn page of a real thread was 1,640 rows, 4.4 MB).
 */
export const DEFAULT_TURN_PAGE = 5;

interface OpenThread {
  key: string;
  view: CodexThreadView;
  /** Turns of the view's pages; a find reads older pages from this size, doubling. */
  pageSize: number;
  listeners: ThreadListeners;
  off: () => void;
  /** Serializes older pages for this thread. */
  queue: Promise<unknown>;
  /** Sends the view's events still waiting for their microtask batch now. */
  flush: () => void;
  /** Ids the rows of live events showed while older pages were read; reported once the rows have gone out. */
  deliveredWait: Set<string>;
}

/**
 * Codex threads for the UI (DESIGN.md 3.2): one daemon connection per account, shared by every
 * open thread of that account, and one thread view per thread shared by its subscribers (a view
 * per thread per connection: a second view's close would end the first one's subscription).
 * The connections only watch, so server requests stay unanswered for the client that drives the
 * thread (rpc option unhandledRequests "ignore", the default).
 */
/** The model and effort /model chose for a thread's next turn (drive/codexRuns.ts chosenOf, onChosen). */
export interface CodexChosenSource {
  chosenOf(key: string): SessionChosen | null;
  onChosen(listener: (key: string) => void): () => void;
}

export class CodexThreads implements ThreadProvider {
  private accounts: CodexAccount[];
  private index: SessionIndex;
  private chosen: CodexChosenSource | null;
  private rpcs = new Map<string, Promise<CodexRpc>>();
  private open = new Map<string, OpenThread>();
  private opening = new Map<string, Promise<OpenThread>>();
  private offChosen: () => void = () => {};
  private delivery: DeliveryHooks | null;

  constructor(deps: { accounts: CodexAccount[]; index: SessionIndex; chosen?: CodexChosenSource; delivery?: DeliveryHooks }) {
    this.delivery = deps.delivery ?? null;
    this.accounts = deps.accounts;
    this.index = deps.index;
    this.chosen = deps.chosen ?? null;
    // state.chosen is this server's, not the daemon's: it goes to the thread's subscribers as a patch.
    this.offChosen = this.chosen?.onChosen((key) => {
      const t = this.open.get(key);
      if (!t) return;
      const events: ThreadLiveEvent[] = [{ t: "thread.patched", threadId: key, state: { chosen: this.chosen!.chosenOf(key) } }];
      t.listeners.events(events, t.view.hasMoreBefore);
    }) ?? (() => {});
  }

  handles(threadId: string): boolean {
    return THREAD_RE.test(threadId);
  }

  /** The view's snapshot with this server's state.chosen (null when none, so a later patch can clear it). */
  private snapshotOf(threadId: string, t: OpenThread): ThreadSnapshot {
    const s = t.view.snapshot();
    if (!this.chosen || this.index.get(threadId)?.parentKey) return s;
    return { ...s, state: { ...s.state, chosen: this.chosen.chosenOf(threadId) } };
  }

  async subscribe(threadId: string, listener: ThreadListener, opts: ThreadSubscribeOptions = {}): Promise<() => void> {
    const { pageSize = DEFAULT_TURN_PAGE, rows, have } = opts;
    for (;;) {
      const t = await this.get(threadId, pageSize);
      const off = () => {
        t.listeners.delete(listener);
        if (t.listeners.size === 0) void this.close(threadId, t);
      };
      if (rows === undefined) {
        t.listeners.add(listener, this.snapshotOf(threadId, t), t.view.hasMoreBefore);
        this.joined(t);
        return off;
      }
      let added = false;
      await this.serial(t, async () => {
        if (this.open.get(threadId) !== t) return;
        // A client that kept rows from an earlier visit needs them whole from its first row on (windowed.ts resumeRows).
        const resume = have ? resumeRows(t.view.visibleRows(), have) : null;
        if (await this.ensureRows(threadId, t, Math.max(rows, resume ?? 0))) t.listeners.publish(() => this.snapshotOf(threadId, t), t.view.hasMoreBefore);
        if (this.open.get(threadId) !== t) return;
        t.listeners.add(listener, this.snapshotOf(threadId, t), t.view.hasMoreBefore, rows, resume === null ? undefined : have);
        added = true;
      });
      // The last subscriber left while this one waited: the thread closed, open it again.
      if (added) {
        this.joined(t);
        return off;
      }
    }
  }

  /**
   * Older history. A windowed subscriber's window grows by `rows` conversation rows (reading turn
   * pages until they are there); otherwise one more page is read and every plain subscriber gets
   * the new snapshot (the replace event alone does not carry hasMoreBefore).
   */
  async loadOlder(threadId: string, listener?: ThreadListener, rows = THREAD_OLDER_ROWS, until?: string): Promise<void> {
    const t = this.open.get(threadId);
    if (!t) throw new Error(`thread not open: ${threadId}`);
    await this.serial(t, async () => {
      const w = listener ? t.listeners.window(listener) : undefined;
      if (w && listener) {
        const held = heldRows(w, t.view.visibleRows());
        let want = held + rows;
        let read = false;
        if (until !== undefined) {
          // A find's step to an item the client does not hold: turn pages until the item is read.
          read = await this.ensureItem(threadId, t, until);
          const through = rowsThrough(t.view.visibleRows(), until);
          want = through === null ? held : Math.max(want, through);
        }
        w.rows = want;
        read = (await this.ensureRows(threadId, t, w.rows)) || read;
        t.listeners.publish(() => this.snapshotOf(threadId, t), t.view.hasMoreBefore, read ? { requester: listener } : { requester: listener, only: listener });
        return;
      }
      await this.page(threadId, t);
      t.listeners.publish(() => this.snapshotOf(threadId, t), t.view.hasMoreBefore);
    });
  }

  /**
   * Find in an open thread (DESIGN.md 6u). The thread's turns come from the daemon, which names
   * the items, so the view itself reads every older turn page (growing pages) and the search runs
   * over its rows. Windowed subscribers get only the new positions (another reader's pages).
   */
  async search(threadId: string, query: string, reqId: string): Promise<ThreadSearchResult> {
    const t = this.open.get(threadId);
    if (!t) throw new Error(`thread not open: ${threadId}`);
    let rows: ReturnType<CodexThreadView["visibleRows"]> = [];
    await this.serial(t, async () => {
      let turns = t.pageSize;
      let read = false;
      while (t.view.hasMoreBefore) {
        await this.page(threadId, t, turns);
        turns *= 2;
        read = true;
      }
      if (read) t.listeners.publish(() => this.snapshotOf(threadId, t), t.view.hasMoreBefore);
      rows = t.view.visibleRows();
    });
    return threadSearchResult(threadId, reqId, query, searchDocsOf(rows));
  }

  closeAll(): void {
    this.offChosen();
    for (const [id, t] of [...this.open]) void this.close(id, t);
    for (const p of this.rpcs.values()) void p.then((r) => r.close(), () => {});
    this.rpcs.clear();
  }

  /** Older turn pages until the newest `rows` conversation rows are whole (or the thread's start). True when it read any. */
  private async ensureRows(threadId: string, t: OpenThread, rows: number): Promise<boolean> {
    let read = false;
    while (rows > 0 && t.view.hasMoreBefore && !windowStartIndex(t.view.visibleRows(), rows, true).complete) {
      await this.page(threadId, t);
      read = true;
    }
    return read;
  }

  /** Older turn pages, doubling, until item `id` is read (or the thread's start). True when it read any. */
  private async ensureItem(threadId: string, t: OpenThread, id: string): Promise<boolean> {
    let read = false;
    let turns = t.pageSize;
    while (t.view.hasMoreBefore && !t.view.visibleRows().some((r) => r.item.id === id)) {
      await this.page(threadId, t, turns);
      turns *= 2;
      read = true;
    }
    return read;
  }

  /**
   * One older turn page (`turns` of them, else the view's page size). Windowed subscribers hold
   * back their row events (the view's full replacement among them) until the caller's publish
   * (threads/windowed.ts).
   */
  private async page(threadId: string, t: OpenThread, turns?: number): Promise<void> {
    // Events the view made before this point belong to what the subscribers hold: send them first.
    t.flush();
    t.listeners.beginPaging(() => this.snapshotOf(threadId, t));
    await t.view.loadOlder(turns);
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
        if (t.listeners.paging) t.listeners.publish(() => this.snapshotOf(t.key, t), t.view.hasMoreBefore);
      }
      this.reportDelivered(t);
    };
    const run = t.queue.then(step, step);
    t.queue = run.catch(() => {});
    return run;
  }

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

  private async create(sessionKey: string, pageSize: number): Promise<OpenThread> {
    const m = THREAD_RE.exec(sessionKey);
    if (!m) throw new Error(`not a Codex thread id: ${sessionKey}`);
    const [, account, nativeId] = m as unknown as [string, string, string];
    const acct = this.accounts.find((a) => a.id === account);
    if (!acct) throw new Error(`unknown account: ${account}`);
    const rpc = await this.rpcFor(acct);
    const session = this.index.get(sessionKey);
    const view = createCodexThreadView({
      rpc,
      account,
      threadId: nativeId,
      readonly: session?.owner !== "ui",
      // A paginated thread the daemon serves without turns is read from its rollout (rolloutFallback.ts).
      rolloutHistory: (thread) => (thread.path ? openRolloutHistory({ path: thread.path, threadId: thread.id }) : null),
      onRolloutPage: (stats) => console.log(rolloutStatsLine(sessionKey, stats)),
    });
    // The view emits one event at a time; events from the same tick go out as one message.
    let batch: ThreadLiveEvent[] = [];
    const flush = () => {
      if (batch.length === 0) return;
      const events = batch;
      batch = [];
      // During an older page, windowed subscribers skip the row events (threads/windowed.ts).
      t.listeners.events(events, t.view.hasMoreBefore);
      if (!this.delivery) return;
      for (const id of deliveredIds(rowsOfEvents(events))) t.deliveredWait.add(id);
      this.reportDelivered(t);
    };
    const t: OpenThread = { key: sessionKey, view, pageSize, listeners: new ThreadListeners(), off: () => {}, queue: Promise.resolve(), flush, deliveredWait: new Set() };
    t.off = view.onEvent((e) => {
      if (batch.length === 0) queueMicrotask(flush);
      batch.push(e);
    });
    try {
      await view.load({ pageSize });
    } catch (err) {
      t.off();
      await view.close().catch(() => {});
      throw err;
    }
    this.open.set(sessionKey, t);
    return t;
  }

  /**
   * Tells the server which client ids the rows just sent show. It runs after the rows went to the
   * subscribers' sockets, so a waiting message leaves the list after its row has arrived (a socket
   * keeps the order of its sends); rows held back by older pages wait for their publish.
   */
  private reportDelivered(t: OpenThread): void {
    if (t.deliveredWait.size === 0 || t.listeners.paging) return;
    const ids = t.deliveredWait;
    t.deliveredWait = new Set();
    this.delivery?.delivered(t.key, ids);
  }

  /** A subscriber got the snapshot: the ids of the rows the thread holds. */
  private joined(t: OpenThread): void {
    if (!this.delivery) return;
    const ids = deliveredIds(t.view.visibleRows());
    if (ids.size > 0) this.delivery.delivered(t.key, ids);
  }

  private rpcFor(acct: CodexAccount): Promise<CodexRpc> {
    let p = this.rpcs.get(acct.id);
    if (!p) {
      p = connect(acct.home);
      p.catch(() => this.rpcs.delete(acct.id));
      this.rpcs.set(acct.id, p);
    }
    return p;
  }

  private async close(threadId: string, t: OpenThread): Promise<void> {
    if (this.open.get(threadId) !== t) return;
    this.open.delete(threadId);
    t.off();
    await t.view.close().catch(() => {});
  }
}
