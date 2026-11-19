// The window of a conversation a client holds (DESIGN.md 6r). A windowed subscriber gets the
// newest THREAD_FIRST_ROWS conversation rows first and THREAD_OLDER_ROWS more each time it asks
// for older history, until the thread's start. The server cuts the window (conversationRowStarts,
// windowStartIndex); the client puts older rows in front (prependOlder).
import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2TurnItem, ThreadSnapshot } from "./turnItems.ts";

/** Conversation rows a client opens a thread with (user decision 2026-11-16: 30). */
export const THREAD_FIRST_ROWS = 30;
/** Conversation rows each older-history request adds. */
export const THREAD_OLDER_ROWS = 30;

/** The snapshot fields besides the rows that a `thread.older` may bring. */
export type ThreadOlderFields = Partial<Omit<ThreadSnapshot, "threadId" | "visibleTurnItems" | "hasMoreBefore">>;

/**
 * Older rows for a windowed subscriber, and those of the thread's other fields that changed (the
 * older lines add runs, subagents, usage). The rows go in front of the ones the client holds;
 * `positionShift` is added to the positions the client holds, since the server numbers rows from
 * the oldest one it has read and older lines move them.
 */
export interface ThreadOlder extends ThreadOlderFields {
  threadId: string;
  hasMoreBefore: boolean;
  /** Rows before the first row the client holds, oldest first. Empty when only positions or the other fields changed. */
  visibleTurnItems: OrchestrationV2ProjectedTurnItem[];
  positionShift: number;
  /** The answer to this client's `thread.loadOlder` (false: another reader's request moved the positions). */
  requested: boolean;
}

/**
 * Whether an item opens a conversation row of its own. A conversation row is what a reader counts
 * as one in the timeline: a user message, an assistant message, or the run of other items (tool
 * calls, thinking, notices) between two messages, which the timeline draws as one work group.
 */
function isMessage(row: OrchestrationV2ProjectedTurnItem): boolean {
  return row.item.type === "user_message" || row.item.type === "assistant_message";
}

/** Index of the first item of each conversation row, in order. */
export function conversationRowStarts(items: readonly OrchestrationV2ProjectedTurnItem[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (i === 0 || isMessage(items[i]!) || isMessage(items[i - 1]!)) starts.push(i);
  }
  return starts;
}

/**
 * Where the window of the newest `rows` conversation rows starts in `items`, and whether that is
 * the whole request. `moreBefore`: lines or turns exist before `items[0]` that the server has not
 * read, so the first row may be cut and is not counted (its start is in the unread part).
 *   complete  the window holds `rows` rows, or every row there is
 *   start     index of the window's first item (0 when the window takes everything)
 */
export function windowStartIndex(
  items: readonly OrchestrationV2ProjectedTurnItem[],
  rows: number,
  moreBefore: boolean,
): { start: number; complete: boolean } {
  const starts = conversationRowStarts(items);
  // A cut first row is not a row of the window: it waits until its start is read.
  const whole = moreBefore ? starts.slice(1) : starts;
  if (whole.length > rows) return { start: whole[whole.length - rows]!, complete: true };
  if (whole.length === rows) return { start: whole[0] ?? items.length, complete: true };
  return { start: moreBefore ? (whole[0] ?? items.length) : 0, complete: !moreBefore };
}

/**
 * Conversation rows from the row that holds item `id` to the end of `items`, or null when no item
 * has that id: the window a client needs to show that item (a find's `thread.loadOlder` `until`).
 */
export function rowsThrough(items: readonly OrchestrationV2ProjectedTurnItem[], id: string): number | null {
  const k = items.findIndex((r) => r.item.id === id);
  if (k < 0) return null;
  const starts = conversationRowStarts(items);
  let n = 0;
  for (let i = starts.length - 1; i >= 0; i--) {
    n++;
    if (starts[i]! <= k) return n;
  }
  return n;
}

/**
 * A snapshot with the older rows in front: what the client holds after a `thread.older`. A Codex
 * row numbers `item.ordinal` like its position, so an ordinal equal to the position moves with it
 * (a Claude ordinal comes from the line's offset and stays).
 */
export function prependOlder(snapshot: ThreadSnapshot, older: ThreadOlder): ThreadSnapshot {
  if (older.threadId !== snapshot.threadId) return snapshot;
  const { visibleTurnItems: rows, positionShift, requested: _requested, ...fields } = older;
  const shift = (row: OrchestrationV2ProjectedTurnItem): OrchestrationV2ProjectedTurnItem => ({
    ...row,
    position: row.position + positionShift,
    ...(row.item.ordinal === row.position ? { item: { ...row.item, ordinal: row.item.ordinal + positionShift } as OrchestrationV2TurnItem } : {}),
  });
  const held = positionShift === 0 ? snapshot.visibleTurnItems : snapshot.visibleTurnItems.map(shift);
  return {
    ...snapshot,
    ...fields,
    visibleTurnItems: rows.length === 0 && positionShift === 0 ? snapshot.visibleTurnItems : [...rows, ...held],
  };
}

// ---- resuming a thread the client already holds (DESIGN.md 6r) ----

/**
 * A row's content apart from where it stands. Codex numbers `item.ordinal` like the position, so an
 * ordinal equal to the position moves with it; a Claude ordinal comes from the line's offset.
 */
export function rowContent(row: OrchestrationV2ProjectedTurnItem): string {
  const { position, ...rest } = row;
  const item = row.item.ordinal === position ? { ...row.item, ordinal: 0 } : row.item;
  return JSON.stringify({ ...rest, item });
}

/** A 53-bit string hash (cyrb53), base 36. Not a security hash: it only tells whether a row changed. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The snapshot fields besides the rows and the thread id, which a resume sends only when they changed. */
export const SNAPSHOT_FIELDS = ["lineage", "providerInstanceId", "title", "state", "runtime", "runs", "branches", "subagents", "tokenUsage"] as const;

/** A hash of each of the snapshot's other fields, to tell which of them the client already holds. */
export function fieldDigests(snapshot: Pick<ThreadSnapshot, (typeof SNAPSHOT_FIELDS)[number]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SNAPSHOT_FIELDS) out[k] = hashText(JSON.stringify(snapshot[k]));
  return out;
}

/** What the server compares to tell whether the client holds a row's current content. */
export function rowDigest(row: OrchestrationV2ProjectedTurnItem): string {
  return hashText(rowContent(row));
}

/** The longest prefix every string starts with (row ids of one thread share the thread id). */
export function commonPrefix(texts: readonly string[]): string {
  if (texts.length === 0) return "";
  let prefix = texts[0]!;
  for (const t of texts) {
    let n = 0;
    while (n < prefix.length && n < t.length && prefix.charCodeAt(n) === t.charCodeAt(n)) n++;
    prefix = prefix.slice(0, n);
    if (prefix === "") break;
  }
  return prefix;
}

/**
 * The rows a client holds for a thread it left and comes back to, as `thread.subscribe` carries
 * them. A row's digest covers its id and content (rowContent), so the digests alone say which rows
 * the client holds; the ids of the first and last row place them in the thread.
 */
export interface ThreadHave {
  /** Id of the client's first row (where the answer's window starts). */
  first: string;
  /** Id of the client's newest row. */
  last: string;
  /** One digest per item the client holds, oldest first. */
  digests: string[];
  /** The conversation rows those items make. */
  rows: number;
  /** Per snapshot field (SNAPSHOT_FIELDS); a field without a digest is always sent. */
  fields?: Record<string, string>;
}

export function threadHave(items: readonly OrchestrationV2ProjectedTurnItem[], fields?: Record<string, string>): ThreadHave {
  return {
    first: items[0]?.item.id ?? "",
    last: items.at(-1)?.item.id ?? "",
    digests: items.map(rowDigest),
    rows: conversationRowStarts(items).length,
    ...(fields ? { fields } : {}),
  };
}

/** Whether `have` is well formed. */
export function validHave(have: unknown): have is ThreadHave {
  if (typeof have !== "object" || have === null) return false;
  const h = have as Record<string, unknown>;
  return (
    typeof h.first === "string" && h.first !== "" && typeof h.last === "string" && h.last !== "" &&
    Array.isArray(h.digests) && h.digests.length > 0 && h.digests.every((x) => typeof x === "string") &&
    typeof h.rows === "number" && Number.isFinite(h.rows) &&
    (h.fields === undefined || (typeof h.fields === "object" && h.fields !== null && Object.values(h.fields).every((x) => typeof x === "string")))
  );
}

/**
 * The answer to a `thread.subscribe` that carried `have`: the window the client shows now, with
 * only the rows it does not hold in their current content. The window starts at the client's first
 * row and runs to the thread's end.
 */
export interface ThreadResumed {
  threadId: string;
  /** `hasMoreBefore`, and each of the other snapshot fields (SNAPSHOT_FIELDS) the client does not hold as it is. */
  snapshot: Partial<Omit<ThreadSnapshot, "visibleTurnItems">> & { hasMoreBefore: boolean };
  /**
   * The window's row ids, oldest first: the first `keep` are the client's own first `keep` ids
   * (same ids, same content, same order), `ids` are the rest, each without `idPrefix`, which they
   * all start with.
   */
  keep: number;
  idPrefix: string;
  ids: string[];
  /** Each window row's position in the server's numbering now (`keep` plus `ids.length` of them). */
  positions: number[];
  /** The window's rows the client lacks or holds in another content, as the window has them. */
  rows: OrchestrationV2ProjectedTurnItem[];
}

/**
 * The snapshot a client holds after a `thread.resumed`: the window's rows, each from `rows` or,
 * when the server left it out, the client's own row (moved to its new position). Null when the
 * answer does not fit what the client holds (the client then asks for a plain snapshot).
 */
export function applyResumed(held: ThreadSnapshot | null, resumed: ThreadResumed): ThreadSnapshot | null {
  if (!held || held.threadId !== resumed.threadId) return null;
  const mine = held.visibleTurnItems;
  if (resumed.keep > mine.length || resumed.keep + resumed.ids.length !== resumed.positions.length) return null;
  const byId = new Map(mine.map((r) => [r.item.id, r]));
  const sent = new Map(resumed.rows.map((r) => [r.item.id, r]));
  const items: OrchestrationV2ProjectedTurnItem[] = [];
  for (let i = 0; i < resumed.positions.length; i++) {
    const id = i < resumed.keep ? mine[i]!.item.id : resumed.idPrefix + resumed.ids[i - resumed.keep]!;
    const position = resumed.positions[i]!;
    const fresh = sent.get(id);
    if (fresh) {
      items.push(fresh);
      continue;
    }
    const row = byId.get(id);
    if (!row) return null;
    if (row.position === position) {
      items.push(row);
      continue;
    }
    items.push({
      ...row,
      position,
      ...(row.item.ordinal === row.position ? { item: { ...row.item, ordinal: position } as OrchestrationV2TurnItem } : {}),
    });
  }
  return { ...held, ...resumed.snapshot, visibleTurnItems: items };
}

/**
 * The newest `rows` conversation rows of a snapshot, for a client that keeps it while it is away.
 * What is cut comes back from the server on demand (`hasMoreBefore`).
 */
export function newestRows(snapshot: ThreadSnapshot, rows: number): ThreadSnapshot {
  const starts = conversationRowStarts(snapshot.visibleTurnItems);
  if (starts.length <= rows) return snapshot;
  return { ...snapshot, visibleTurnItems: snapshot.visibleTurnItems.slice(starts[starts.length - rows]!), hasMoreBefore: true };
}
