import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ThreadLiveEvent,
  ThreadOlder,
  ThreadResumed,
  ThreadRunSummary,
  ThreadSnapshot,
} from "@maru/shared";
import { applyResumed, prependOlder } from "@maru/shared";

/** One open thread as the UI holds it: the last snapshot with live events applied. */
export interface ThreadViewState {
  threadId: string;
  /** null until the first snapshot arrives. */
  snapshot: ThreadSnapshot | null;
  /** Last `thread.error` for this thread; a snapshot clears it. */
  error: string | null;
  /** A `thread.loadOlder` is in flight. */
  loadingOlder: boolean;
  /** The server reported the thread gone (`thread.removed`). */
  removed: "deleted" | "archived" | null;
  /**
   * The snapshot is the one kept from an earlier visit (or from before a reconnect) and the
   * subscribe that carries its rows is not answered yet. Live messages wait for that answer, which
   * is computed after them, and `loadingOlder` is set meanwhile (DESIGN.md 6r).
   */
  resuming: boolean;
  /** The server's answer did not fit the kept rows: the thread has to be subscribed again without them. */
  needsFull: boolean;
}

export type ThreadAction =
  | { type: "reset"; threadId: string }
  | { type: "snapshot"; snapshot: ThreadSnapshot }
  | { type: "events"; threadId: string; events: ThreadLiveEvent[] }
  | { type: "error"; threadId: string; error: string }
  | { type: "loadOlderRequested"; threadId: string }
  /** A subscribe that carries the kept rows went out. */
  | { type: "resuming"; threadId: string }
  /** `thread.resumed`: the window from the kept first row, minus the rows already held. */
  | { type: "resumed"; resumed: ThreadResumed }
  /** The plain subscribe that answers `needsFull` went out. */
  | { type: "fullRequested"; threadId: string }
  /** `thread.older`: older rows in front (a windowed subscription, DESIGN.md 6r). */
  | { type: "older"; older: ThreadOlder };

export function initialThreadState(threadId: string): ThreadViewState {
  return { threadId, snapshot: null, error: null, loadingOlder: false, removed: null, resuming: false, needsFull: false };
}

/**
 * The state of a thread that comes back with the snapshot kept from an earlier visit. It waits for
 * the server's answer from the start, and counts as loading older rows meanwhile: a scroll restore
 * (DESIGN.md 6p) reads that as a request in flight instead of one that ended with nothing.
 */
export function keptThreadState(snapshot: ThreadSnapshot): ThreadViewState {
  return { ...initialThreadState(snapshot.threadId), snapshot, resuming: true, loadingOlder: true };
}

export function threadReducer(state: ThreadViewState, action: ThreadAction): ThreadViewState {
  if (action.type === "reset") return initialThreadState(action.threadId);
  if (action.type === "snapshot") {
    if (action.snapshot.threadId !== state.threadId) return state;
    return { ...state, snapshot: action.snapshot, error: null, loadingOlder: false, resuming: false, needsFull: false };
  }
  if (action.type === "resumed") {
    if (action.resumed.threadId !== state.threadId) return state;
    const snapshot = applyResumed(state.snapshot, action.resumed);
    if (!snapshot) return { ...state, snapshot: null, loadingOlder: false, resuming: false, needsFull: true };
    return { ...state, snapshot, error: null, loadingOlder: false, resuming: false, needsFull: false };
  }
  if (action.type === "older") {
    if (action.older.threadId !== state.threadId || !state.snapshot || state.resuming) return state;
    // Another reader's request only moved the positions: this view's own request still waits.
    return {
      ...state,
      snapshot: prependOlder(state.snapshot, action.older),
      ...(action.older.requested ? { error: null, loadingOlder: false } : {}),
    };
  }
  if (action.threadId !== state.threadId) return state;
  switch (action.type) {
    case "error":
      return { ...state, error: action.error, loadingOlder: false, resuming: false };
    case "loadOlderRequested":
      return { ...state, loadingOlder: true };
    case "resuming":
      return state.snapshot && !state.resuming ? { ...state, resuming: true, loadingOlder: true } : state;
    case "fullRequested":
      return state.needsFull ? { ...state, needsFull: false } : state;
    case "events": {
      if (state.resuming) return state;
      let next = state;
      for (const ev of action.events) {
        if (ev.t === "thread.removed" && ev.threadId === state.threadId) next = { ...next, removed: ev.reason };
        if (ev.t === "turnItems.replaced" && ev.threadId === state.threadId) next = { ...next, loadingOlder: false };
      }
      if (!next.snapshot) return next;
      const snapshot = applyThreadEvents(next.snapshot, action.events);
      return snapshot === next.snapshot && next === state ? state : { ...next, snapshot };
    }
  }
}

type AppendField = "text" | "markdown" | "output";

/**
 * Applies a batch of live events (docs/event-model.md 6.3) to a snapshot without mutating it.
 * Arrays are copied at most once per batch, and only an item that changed gets a new object, so
 * the timeline can tell a text-only streaming update from a structural one.
 */
export function applyThreadEvents(snapshot: ThreadSnapshot, events: readonly ThreadLiveEvent[]): ThreadSnapshot {
  let next = snapshot;
  // Assigned inside the helpers below; the casts keep TypeScript from narrowing them to null.
  let rows = null as OrchestrationV2ProjectedTurnItem[] | null;
  let rowIndexById = null as Map<string, number> | null;
  let rowsNeedSort = false;
  let runs: ThreadRunSummary[] | null = null;
  let subagents: OrchestrationV2Subagent[] | null = null;

  const editableRows = (): OrchestrationV2ProjectedTurnItem[] => {
    if (rows === null) rows = [...next.visibleTurnItems];
    return rows;
  };
  const indexOfItem = (itemId: string): number => {
    const list = editableRows();
    if (rowIndexById === null) {
      rowIndexById = new Map();
      list.forEach((row, index) => rowIndexById!.set(row.item.id, index));
    }
    return rowIndexById.get(itemId) ?? -1;
  };
  const patch = (fields: Partial<ThreadSnapshot>) => {
    next = { ...next, ...fields };
  };

  for (const ev of events) {
    if ("threadId" in ev && ev.threadId !== snapshot.threadId) continue;
    switch (ev.t) {
      case "turnItem.upserted": {
        const list = editableRows();
        let index = indexOfItem(ev.row.item.id);
        if (index === -1) index = list.findIndex((row) => row.position === ev.row.position);
        if (index === -1) {
          list.push(ev.row);
          rowsNeedSort = rowsNeedSort || (list.length > 1 && list.at(-2)!.position > ev.row.position);
          rowIndexById?.set(ev.row.item.id, list.length - 1);
        } else {
          const previousId = list[index]!.item.id;
          list[index] = ev.row;
          if (previousId !== ev.row.item.id) {
            rowIndexById?.delete(previousId);
            rowIndexById?.set(ev.row.item.id, index);
          }
        }
        break;
      }
      case "turnItem.textAppended": {
        const index = indexOfItem(ev.itemId);
        if (index === -1) break;
        const list = editableRows();
        const row = list[index]!;
        list[index] = { ...row, item: appendItemText(row.item, ev.field, ev.value) };
        break;
      }
      case "turnItems.replaced":
        rows = [...ev.visibleTurnItems];
        rowIndexById = null;
        rowsNeedSort = false;
        // A windowed subscription's replacement holds the window and says whether older rows exist.
        patch({ branches: ev.branches, ...(ev.hasMoreBefore === undefined ? {} : { hasMoreBefore: ev.hasMoreBefore }) });
        break;
      case "run.upserted": {
        if (runs === null) runs = [...next.runs];
        const index = runs.findIndex((run) => run.runId === ev.run.runId);
        if (index === -1) runs.push(ev.run);
        else runs[index] = ev.run;
        break;
      }
      case "subagent.upserted": {
        if (subagents === null) subagents = [...next.subagents];
        const index = subagents.findIndex((s) => s.id === ev.subagent.id);
        if (index === -1) subagents.push(ev.subagent);
        else subagents[index] = ev.subagent;
        break;
      }
      case "runtime.updated":
        patch({ runtime: ev.runtime });
        break;
      case "thread.patched":
        patch({
          ...(ev.title !== undefined ? { title: ev.title } : {}),
          ...(ev.state !== undefined ? { state: { ...next.state, ...ev.state } } : {}),
        });
        break;
      case "tokenUsage.updated":
        patch({ tokenUsage: ev.usage });
        break;
      case "thread.removed":
      case "pending.updated":
      case "usageLimits.updated":
        // Read-only view: pending requests and account limits are not drawn here; removal is
        // tracked by the reducer.
        break;
    }
  }

  if (rows !== null) {
    if (rowsNeedSort) rows.sort((a, b) => a.position - b.position);
    patch({ visibleTurnItems: rows });
  }
  if (runs !== null) patch({ runs });
  if (subagents !== null) patch({ subagents });
  return next;
}

function appendItemText(item: OrchestrationV2TurnItem, field: AppendField, value: string): OrchestrationV2TurnItem {
  const record = item as unknown as Record<string, unknown>;
  const current = record[field];
  const base = typeof current === "string" ? current : "";
  return { ...item, [field]: base + value } as OrchestrationV2TurnItem;
}
