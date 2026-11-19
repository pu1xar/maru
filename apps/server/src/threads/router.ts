import type { ThreadHave, ThreadLiveEvent, ThreadOlder, ThreadResumed, ThreadSearchResult, ThreadSnapshot } from "@maru/shared";

export type ThreadListener = (msg: {
  snapshot?: ThreadSnapshot; events?: ThreadLiveEvent[]; older?: ThreadOlder; resumed?: ThreadResumed; error?: string;
}) => void;

export interface ThreadSubscribeOptions {
  /** Lines (Claude) or turns (Codex) the provider reads first and per older page. */
  pageSize?: number;
  /** A windowed subscriber: the newest `rows` conversation rows first (threads/windowed.ts, DESIGN.md 6r). */
  rows?: number;
  /** With `rows`: the rows the client kept from an earlier visit (threads/windowed.ts resumeWindow, DESIGN.md 6r). */
  have?: ThreadHave;
}

/** One provider's conversation threads. */
export interface ThreadProvider {
  handles(threadId: string): boolean;
  /** The listener gets the snapshot first, then live updates. Returns the unsubscribe. */
  subscribe(threadId: string, listener: ThreadListener, opts?: ThreadSubscribeOptions): Promise<() => void>;
  /**
   * Older history for `listener`: `rows` more conversation rows for a windowed subscriber, else
   * the previous page for the thread (every plain subscriber receives the new state). `until`: an
   * item id a windowed subscriber's window must reach (a find's step, DESIGN.md 6u).
   */
  loadOlder(threadId: string, listener?: ThreadListener, rows?: number, until?: string): Promise<void>;
  /** Find in an open thread: every matching item of the whole thread (threadSearch.ts, DESIGN.md 6u). */
  search(threadId: string, query: string, reqId: string): Promise<ThreadSearchResult>;
  closeAll(): void;
}

/** Sends each thread id to the provider that owns it. */
export class ThreadRouter implements ThreadProvider {
  private providers: ThreadProvider[];

  constructor(providers: ThreadProvider[]) {
    this.providers = providers;
  }

  handles(threadId: string): boolean {
    return this.providers.some((p) => p.handles(threadId));
  }

  subscribe(threadId: string, listener: ThreadListener, opts?: ThreadSubscribeOptions): Promise<() => void> {
    const p = this.providers.find((x) => x.handles(threadId));
    if (!p) return Promise.reject(new Error(`unknown thread id: ${threadId}`));
    return p.subscribe(threadId, listener, opts);
  }

  loadOlder(threadId: string, listener?: ThreadListener, rows?: number, until?: string): Promise<void> {
    const p = this.providers.find((x) => x.handles(threadId));
    if (!p) return Promise.reject(new Error(`unknown thread id: ${threadId}`));
    return p.loadOlder(threadId, listener, rows, until);
  }

  search(threadId: string, query: string, reqId: string): Promise<ThreadSearchResult> {
    const p = this.providers.find((x) => x.handles(threadId));
    if (!p) return Promise.reject(new Error(`unknown thread id: ${threadId}`));
    return p.search(threadId, query, reqId);
  }

  closeAll(): void {
    for (const p of this.providers) p.closeAll();
  }
}
