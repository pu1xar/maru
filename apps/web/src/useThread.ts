import { useCallback, useSyncExternalStore } from "react";
import { THREAD_FIRST_ROWS, THREAD_OLDER_ROWS, fieldDigests, threadHave } from "@maru/shared";

import { socketHub, type ThreadSubscription } from "./lib/socket.ts";
import { dropCachedThread, keepThread, peekCachedThread } from "./threadCache.ts";
import { initialThreadState, keptThreadState, threadReducer, type ThreadAction, type ThreadViewState } from "./threadState.ts";

/**
 * One thread's state for the whole page, shared by every view that shows it (the conversation and
 * the right panel's agents tab), so a view that mounts later still starts from the snapshot the
 * first one received. The first holder subscribes over the shared /ws hub, the last one releases
 * and the page keeps the thread's snapshot for its next visit (threadCache.ts, DESIGN.md 6r).
 */
interface Entry {
  state: ThreadViewState;
  holders: number;
  listeners: Set<() => void>;
  stop: () => void;
}

const entries = new Map<string, Entry>();
/**
 * Stable states for ids nobody holds yet (useSyncExternalStore needs a stable snapshot): the
 * snapshot kept from an earlier visit when there is one, so the first render already draws it.
 */
const idle = new Map<string, ThreadViewState>();

function idleState(threadId: string): ThreadViewState {
  let s = idle.get(threadId);
  if (!s) {
    const kept = peekCachedThread(threadId);
    s = kept ? keptThreadState(kept) : initialThreadState(threadId);
    idle.set(threadId, s);
  }
  return s;
}

/**
 * What the subscribe sends for a thread this page holds: the newest rows, and the rows already
 * held (the kept snapshot of an earlier visit, or the live state before a reconnect) so the server
 * answers with what changed since (DESIGN.md 6r). Called as the subscribe goes out.
 */
function subscriptionOf(threadId: string): ThreadSubscription {
  const snapshot = entries.get(threadId)?.state.snapshot;
  if (!snapshot || snapshot.visibleTurnItems.length === 0) return { rows: THREAD_FIRST_ROWS };
  dispatch(threadId, { type: "resuming", threadId });
  return { rows: THREAD_FIRST_ROWS, have: threadHave(snapshot.visibleTurnItems, fieldDigests(snapshot)) };
}

function dispatch(threadId: string, action: ThreadAction): void {
  const entry = entries.get(threadId);
  if (!entry) return;
  const next = threadReducer(entry.state, action);
  if (next === entry.state) return;
  entry.state = next;
  for (const l of [...entry.listeners]) l();
  // The server's answer did not fit the kept rows: ask again without them.
  if (next.needsFull) {
    dispatch(threadId, { type: "fullRequested", threadId });
    socketHub().resubscribe(threadId, { rows: THREAD_FIRST_ROWS });
  }
}

function hold(threadId: string, listener: () => void): () => void {
  let entry = entries.get(threadId);
  if (!entry) {
    const hub = socketHub();
    const offMessages = hub.onMessage((msg) => {
      switch (msg.type) {
        case "thread.snapshot":
          if (msg.snapshot.threadId === threadId) dispatch(threadId, { type: "snapshot", snapshot: msg.snapshot });
          break;
        case "thread.older":
          if (msg.older.threadId === threadId) dispatch(threadId, { type: "older", older: msg.older });
          break;
        case "thread.resumed":
          if (msg.resumed.threadId === threadId) dispatch(threadId, { type: "resumed", resumed: msg.resumed });
          break;
        case "thread.events":
          if (msg.threadId === threadId) dispatch(threadId, { type: "events", threadId, events: msg.events });
          break;
        case "thread.error":
          if (msg.threadId === threadId) dispatch(threadId, { type: "error", threadId, error: msg.error });
          break;
      }
    });
    // The state starts from the snapshot kept for this thread, which now belongs to this entry.
    const state = idleState(threadId);
    idle.delete(threadId);
    dropCachedThread(threadId);
    entry = { state, holders: 0, listeners: new Set(), stop: () => offMessages() };
    entries.set(threadId, entry);
    // The newest rows first; older ones come as the reader scrolls up (DESIGN.md 6r). The rows
    // already held go along (DESIGN.md 6r).
    const release = hub.retainThread(threadId, () => subscriptionOf(threadId));
    entry.stop = () => {
      release();
      offMessages();
    };
  }
  const held = entry;
  held.holders++;
  held.listeners.add(listener);
  return () => {
    held.listeners.delete(listener);
    held.holders--;
    if (held.holders > 0) return;
    held.stop();
    if (entries.get(threadId) === held) entries.delete(threadId);
    // What was received stays for the next visit; a gone or failed thread starts over.
    const { snapshot, removed, error } = held.state;
    if (snapshot && !removed && !error) keepThread(snapshot);
  };
}

const holdNothing = () => () => {};

/**
 * The thread's state while `threadId` is set; null holds nothing. For a view that needs the state
 * only now and then (a composer without a conversation opening a picker): the thread is held,
 * shared with any other view of it, and let go once the id goes back to null.
 */
export function useThreadWhile(threadId: string | null): ThreadViewState | null {
  const subscribe = useCallback(
    (listener: () => void) => (threadId === null ? holdNothing() : hold(threadId, listener)),
    [threadId],
  );
  return useSyncExternalStore(subscribe, () => (threadId === null ? null : entries.get(threadId)?.state ?? idleState(threadId)));
}

/**
 * Subscribes to one thread over the shared /ws connection: a snapshot of the newest conversation
 * rows, then live events (docs/event-model.md 6.3), and older rows on `loadOlder` (DESIGN.md 6r).
 * After a reconnect the hub subscribes again and the fresh snapshot replaces this state.
 */
export function useThread(threadId: string): {
  state: ThreadViewState;
  loadOlder: () => void;
  /**
   * Older rows until item `itemId` is among them (a find's step, DESIGN.md 6u). False when no
   * request went out (one is in flight, nothing older, or the socket is closed).
   */
  loadOlderUntil: (itemId: string) => boolean;
} {
  const subscribe = useCallback((listener: () => void) => hold(threadId, listener), [threadId]);
  const state = useSyncExternalStore(subscribe, () => entries.get(threadId)?.state ?? idleState(threadId));
  const canLoadOlder = state.snapshot?.hasMoreBefore === true && !state.loadingOlder && !state.resuming;

  const loadOlder = useCallback(() => {
    if (!canLoadOlder) return;
    if (socketHub().send({ type: "thread.loadOlder", threadId, rows: THREAD_OLDER_ROWS })) {
      dispatch(threadId, { type: "loadOlderRequested", threadId });
    }
  }, [canLoadOlder, threadId]);

  const loadOlderUntil = useCallback((itemId: string) => {
    if (!canLoadOlder) return false;
    if (!socketHub().send({ type: "thread.loadOlder", threadId, rows: THREAD_OLDER_ROWS, until: itemId })) return false;
    dispatch(threadId, { type: "loadOlderRequested", threadId });
    return true;
  }, [canLoadOlder, threadId]);

  return { state, loadOlder, loadOlderUntil };
}
