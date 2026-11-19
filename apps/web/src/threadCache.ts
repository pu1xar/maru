import type { ThreadSnapshot } from "@maru/shared";
import { newestRows } from "@maru/shared";

/**
 * What the page keeps of the threads it left (DESIGN.md 6r): the last snapshot of each, so coming
 * back draws at once and the server only sends what changed (`thread.subscribe` with `have`). It
 * is a cache of rows the server can send again, so a thread that falls out of it costs one fetch
 * on the next visit and nothing is lost.
 *
 * CACHED_THREADS: the threads kept, least recently left first out. The sidebar lists a user's
 * chosen sessions and a split screen shows a handful at a time, so twelve covers the ones moved
 * between in a sitting.
 * CACHED_ROWS: conversation rows kept per thread (the newest). A first window is 30 rows and each
 * scroll up adds 30; 150 keeps five windows. A full entry of 150 rows measured 0.7 MB (a Claude
 * pentest session), 1.4 and 1.5 MB (two long Claude sessions) and 4.4 MB (a Codex thread, whose
 * rows hold many items) of JSON, so twelve entries stay at about 17 MB typically and 52 MB when
 * all twelve are Codex threads scrolled that far.
 */
export const CACHED_THREADS = 12;
export const CACHED_ROWS = 150;

const cache = new Map<string, ThreadSnapshot>();

/** The kept snapshot of a thread, without taking it. */
export function peekCachedThread(threadId: string): ThreadSnapshot | undefined {
  return cache.get(threadId);
}

/** Keeps a thread's snapshot as the newest entry, dropping the least recently kept one past the limit. */
export function keepThread(snapshot: ThreadSnapshot): void {
  cache.delete(snapshot.threadId);
  cache.set(snapshot.threadId, newestRows(snapshot, CACHED_ROWS));
  while (cache.size > CACHED_THREADS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Forgets a thread (it is held again, or it is gone). */
export function dropCachedThread(threadId: string): void {
  cache.delete(threadId);
}

/** The kept thread ids, least recently kept first (tests and diagnostics). */
export function cachedThreadIds(): string[] {
  return [...cache.keys()];
}

export function clearThreadCache(): void {
  cache.clear();
}
