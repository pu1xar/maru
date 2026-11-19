// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/timelineScrollAnchoring.ts (RememberedTimelinePosition,
// readTimelinePosition, rememberTimelinePosition).
// Local changes: the positions outlive the list itself (maru mounts a list per visit, so a trip to
// settings or another session unmounts it), the map has no size bound, a position also names the
// oldest row the list held (how far a restore reads older history back), and a session that moves
// to another account takes its threads' positions to its new key (moveTimelinePositions).
import type { WorkGroupViewState } from "./timelineRowContext.ts";

/** Where the reader left a thread: the row at the top of the viewport, or the live end. */
export interface RememberedTimelinePosition {
  readonly rowId: string;
  /** How far the viewport's top sits below the row's top (px). */
  readonly offsetWithinRow: number;
  /** The list's scroll offset then; used when the row is gone. */
  readonly scrollOffset: number;
  /** The reader was at the end (or following it): the thread reopens at its end, new rows included. */
  readonly atEnd: boolean;
  /**
   * The oldest row the list held then. A restore reads older history until that row is back; past
   * it, a missing saved row is gone (folded, rewritten) rather than not read yet.
   */
  readonly oldestRowId?: string | undefined;
  readonly disclosures?: {
    /** Finished turns the reader folded (turns show their work by default). */
    readonly collapsedRuns: ReadonlySet<string>;
    readonly workGroups: ReadonlySet<string>;
    readonly attempts: ReadonlySet<string>;
    readonly workGroupState: WorkGroupViewState;
  };
}

/**
 * Positions by thread id, for this page. A thread id is a session key or a subagent thread under
 * it (`<session key>:agent-<id>`). One small record per thread the reader has scrolled.
 */
const rememberedTimelinePositions = new Map<string, RememberedTimelinePosition>();

export function readTimelinePosition(threadKey: string): RememberedTimelinePosition | undefined {
  return rememberedTimelinePositions.get(threadKey);
}

/** `liveFollowEnabled`: the list follows the end, so the thread counts as at its end. */
export function rememberTimelinePosition(
  threadKey: string,
  position: RememberedTimelinePosition,
  liveFollowEnabled: boolean,
): void {
  rememberedTimelinePositions.set(threadKey, {
    ...position,
    atEnd: liveFollowEnabled || position.atEnd,
  });
}

/** The thread id under a session's new key: the session itself, or one of its subagent threads. */
export function movedThreadKey(threadKey: string, from: string, to: string): string | null {
  if (threadKey === from) return to;
  return threadKey.startsWith(`${from}:`) ? to + threadKey.slice(from.length) : null;
}

/**
 * An id of a row, run, work group or entry under the thread's new key. Ids carry their thread id,
 * at the start (`<thread id>:uuid:...`) or after a kind (`turn-fold:<thread id>:...`,
 * `work-group:<entry id>`), so every `<from>:` in the id is renamed.
 */
export function movedTimelineId(id: string, from: string, to: string): string {
  return id === from ? to : id.split(`${from}:`).join(`${to}:`);
}

/** A position under the thread's new key, its ids renamed (movedTimelineId). */
export function movedTimelinePosition(position: RememberedTimelinePosition, from: string, to: string): RememberedTimelinePosition {
  const id = (value: string) => movedTimelineId(value, from, to);
  const ids = (values: ReadonlySet<string>) => new Set([...values].map(id));
  const d = position.disclosures;
  return {
    ...position,
    rowId: id(position.rowId),
    oldestRowId: position.oldestRowId === undefined ? undefined : id(position.oldestRowId),
    ...(d
      ? {
          disclosures: {
            collapsedRuns: ids(d.collapsedRuns),
            workGroups: ids(d.workGroups),
            attempts: ids(d.attempts),
            workGroupState: {
              scrollPositions: new Map(
                [...d.workGroupState.scrollPositions].map(([key, anchor]) => [id(key), { ...anchor, entryId: id(anchor.entryId) }]),
              ),
              expandedEntries: ids(d.workGroupState.expandedEntries),
            },
          },
        }
      : {}),
  };
}

/**
 * A session moved to another account (its key carries the account): its threads' positions follow.
 * A position the new key already has stays.
 */
export function moveTimelinePositions(from: string, to: string): void {
  for (const [key, position] of [...rememberedTimelinePositions]) {
    const next = movedThreadKey(key, from, to);
    if (next === null) continue;
    rememberedTimelinePositions.delete(key);
    if (!rememberedTimelinePositions.has(next)) rememberedTimelinePositions.set(next, movedTimelinePosition(position, from, to));
  }
}

/**
 * The older history a restore asked for: the rows shown when it asked (a request that ends with the
 * same rows added nothing), and whether it stopped asking.
 */
export interface OlderHistoryForRestore {
  readonly identity: string;
  readonly rows: unknown;
  readonly gaveUp: boolean;
}

/**
 * The next step of restoring a position away from the end. A view reads the thread's newest page,
 * so the saved row may sit in older history: ask for older pages while the row is missing, the
 * history has more, and the oldest row the list held when the reader left is not back yet. Then
 * scroll (to the row, or to the remembered offset when it never showed).
 */
export function timelineRestoreStep(input: {
  readonly restoring: boolean;
  readonly rowFound: boolean;
  readonly hasMoreHistory: boolean;
  /** The oldest row the list held when the position was remembered is loaded again. */
  readonly historyReached: boolean;
  readonly gaveUp: boolean;
}): "none" | "load-older" | "scroll" {
  if (!input.restoring) return "none";
  return input.rowFound || !input.hasMoreHistory || input.historyReached || input.gaveUp ? "scroll" : "load-older";
}

/** For tests: forget every position. */
export function clearTimelinePositions(): void {
  rememberedTimelinePositions.clear();
}
