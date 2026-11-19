// The subscribers of one open thread (DESIGN.md 6r). A windowed subscriber (thread.subscribe
// `rows`) holds the newest conversation rows and asks for older ones; the server keeps what each
// one holds (WindowState) so live events, older rows and the changes of a refold reach it as small
// messages. A plain subscriber gets every row the provider has read, as before.
//
// Older lines or turns are read in pages, and each page renumbers the rows (positions count from
// the oldest row read) and may change rows already shown (a turn whose opener was unread gets its
// run, an orphan tool result joins its call, line numbers become known at the file's start). So
// while pages are read the windowed subscribers get no row events; afterwards each gets the
// difference between the thread before the pages (what it holds) and after: older rows, the
// position shift, and the held rows that changed or came new.
import type {
  OrchestrationV2ProjectedTurnItem, ThreadHave, ThreadLiveEvent, ThreadOlder, ThreadOlderFields, ThreadResumed, ThreadSnapshot,
} from "@maru/shared";
import { SNAPSHOT_FIELDS, commonPrefix, conversationRowStarts, hashText, rowContent, rowDigest, windowStartIndex } from "@maru/shared";
import type { ThreadListener } from "./router.ts";

/** What a windowed subscriber holds, as the server tracks it. */
export interface WindowState {
  /** Conversation rows the window should hold: the first window, then each older request's total. */
  rows: number;
  /** Ids of the rows the client holds, oldest first. */
  ids: string[];
  held: Set<string>;
  /** The position the client has for its first row; null while it holds none. */
  firstPosition: number | null;
}

export type ListenerMessage = Parameters<ThreadListener>[0];

function holding(rows: number, items: readonly OrchestrationV2ProjectedTurnItem[]): WindowState {
  const ids = items.map((r) => r.item.id);
  return { rows, ids, held: new Set(ids), firstPosition: items[0]?.position ?? null };
}

/** The windowed snapshot of `rows` conversation rows, and what the client then holds. */
export function openWindow(full: ThreadSnapshot, rows: number, moreBefore: boolean): { snapshot: ThreadSnapshot; state: WindowState } {
  const { start } = windowStartIndex(full.visibleTurnItems, rows, moreBefore);
  return windowFrom(full, start, rows, moreBefore);
}

function windowFrom(full: ThreadSnapshot, start: number, rows: number, moreBefore: boolean): { snapshot: ThreadSnapshot; state: WindowState } {
  const items = full.visibleTurnItems.slice(start);
  return { snapshot: { ...full, visibleTurnItems: items, hasMoreBefore: start > 0 || moreBefore }, state: holding(rows, items) };
}

function indexOfId(list: readonly OrchestrationV2ProjectedTurnItem[], id: string | undefined): number {
  return id === undefined ? -1 : list.findIndex((r) => r.item.id === id);
}

/** Conversation rows from the client's first row to the end of `list` (its held rows and newer ones). */
export function heldRows(state: WindowState, list: readonly OrchestrationV2ProjectedTurnItem[]): number {
  const j = indexOfId(list, state.ids[0]);
  return j < 0 ? state.rows : conversationRowStarts(list.slice(j)).length;
}


/**
 * The fields besides the rows that differ between what the client holds (`before`) and `after`.
 * Without `before` no page was read and the live events kept them: none.
 */
function changedFields(before: ThreadSnapshot | null, after: ThreadSnapshot): ThreadOlderFields {
  const out: Record<string, unknown> = {};
  if (!before) return out;
  for (const k of SNAPSHOT_FIELDS) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = after[k];
  }
  return out as ThreadOlderFields;
}

/**
 * Live events for a windowed subscriber: a row before its window is left out (it comes with the
 * window when the client asks for it), and a full replacement is cut to the window. Updates `state`
 * to what the client holds after the events.
 */
export function windowEvents(state: WindowState, events: readonly ThreadLiveEvent[], moreBefore: boolean): ThreadLiveEvent[] {
  const out: ThreadLiveEvent[] = [];
  for (const ev of events) {
    if (ev.t === "turnItem.upserted") {
      const id = ev.row.item.id;
      if (state.held.has(id)) {
        out.push(ev);
      } else if (state.firstPosition === null || ev.row.position >= state.firstPosition) {
        // A new row: rows inserted inside the list come as a replacement, so a new one is the newest.
        state.ids.push(id);
        state.held.add(id);
        state.firstPosition ??= ev.row.position;
        out.push(ev);
      }
    } else if (ev.t === "turnItem.textAppended") {
      if (state.held.has(ev.itemId)) out.push(ev);
    } else if (ev.t === "turnItems.replaced") {
      const list = ev.visibleTurnItems;
      const j = indexOfId(list, state.ids[0]);
      // From the held first row while it is there (a rewind keeps the reader's place), else the newest rows.
      const start = j >= 0 ? j : windowStartIndex(list, state.rows, moreBefore).start;
      const items = list.slice(start);
      Object.assign(state, holding(state.rows, items));
      out.push({ ...ev, visibleTurnItems: items, hasMoreBefore: start > 0 || moreBefore });
    } else {
      out.push(ev);
    }
  }
  return out;
}

/**
 * What one windowed subscriber is sent after the thread's rows changed outside live events.
 * `before`: the rows as the subscriber holds them (the thread before the pages were read), or null
 * when no page was read (its held rows are as the live events left them). `requested`: the
 * subscriber asked for older rows, so its window grows to `state.rows` rows and it always gets an
 * answer.
 *   older + events  its held rows are still there in the same order: older rows in front, the
 *                   position shift, then the held rows that changed and the rows after them
 *   snapshot        a held row is gone or moved: the window again, from its first row when that is
 *                   still there
 */
export function publishTo(
  state: WindowState,
  before: ThreadSnapshot | null,
  after: ThreadSnapshot,
  moreBefore: boolean,
  requested: boolean,
): ListenerMessage[] {
  const list = after.visibleTurnItems;
  const j = indexOfId(list, state.ids[0]);
  const target = windowStartIndex(list, state.rows, moreBefore).start;
  const start = j < 0 ? target : requested ? Math.min(target, j) : j;
  const contiguous = j >= 0 && state.ids.every((id, k) => list[j + k]?.item.id === id);
  if (!contiguous) {
    const w = windowFrom(after, start, state.rows, moreBefore);
    Object.assign(state, w.state);
    return [{ snapshot: w.snapshot }];
  }
  const rows = list.slice(start, j);
  const tail = list.slice(j + state.ids.length);
  const changed: ThreadLiveEvent[] = [];
  if (before) {
    const was = new Map(before.visibleTurnItems.filter((r) => state.held.has(r.item.id)).map((r) => [r.item.id, r]));
    for (let k = 0; k < state.ids.length; k++) {
      const now = list[j + k]!;
      const prev = was.get(now.item.id);
      if (!prev || rowContent(prev) !== rowContent(now)) changed.push({ t: "turnItem.upserted", threadId: after.threadId, row: now });
    }
  }
  for (const row of tail) changed.push({ t: "turnItem.upserted", threadId: after.threadId, row });
  const older: ThreadOlder = {
    ...changedFields(before, after), threadId: after.threadId, visibleTurnItems: rows,
    positionShift: list[j]!.position - state.firstPosition!, requested, hasMoreBefore: start > 0 || moreBefore,
  };
  Object.assign(state, holding(state.rows, list.slice(start)));
  return changed.length ? [{ older }, { events: changed }] : [{ older }];
}

/**
 * How many conversation rows a thread must hold whole for a client's `have` to be placed, or null
 * when neither the client's newest row nor its first is in `list` (the client's rows are too old or
 * the thread was rewritten: it gets the usual first window). Counted from the newest of the two
 * that is there: the rows after it, plus the client's own rows before it, plus one for a first row
 * cut at the page edge.
 */
export function resumeRows(list: readonly OrchestrationV2ProjectedTurnItem[], have: ThreadHave): number | null {
  const last = indexOfId(list, have.last);
  if (last >= 0) return conversationRowStarts(list.slice(last)).length + Math.min(have.rows, have.digests.length);
  const first = indexOfId(list, have.first);
  return first >= 0 ? conversationRowStarts(list.slice(first)).length + 1 : null;
}

/**
 * The thread as a client that holds `have` should see it: from its first row to the end, with only
 * the rows whose digest the client does not hold. Null when the client's first row is not in
 * `full` (the caller then opens the usual window). `state` is what the client holds afterwards.
 */
export function resumeWindow(
  full: ThreadSnapshot,
  have: ThreadHave,
  rows: number,
  moreBefore: boolean,
): { resumed: ThreadResumed; state: WindowState } | null {
  const list = full.visibleTurnItems;
  const j = indexOfId(list, have.first);
  if (j < 0) return null;
  const items = list.slice(j);
  const digests = items.map(rowDigest);
  const known = new Set(have.digests);
  // The window starts as the client's rows do: those equal one by one need no id.
  let keep = 0;
  while (keep < digests.length && keep < have.digests.length && digests[keep] === have.digests[keep]) keep++;
  const rest = items.slice(keep).map((r) => r.item.id);
  const idPrefix = commonPrefix(rest);
  // The other fields come only when they differ from what the client holds.
  const fields: ThreadResumed["snapshot"] = { hasMoreBefore: j > 0 || moreBefore };
  for (const k of SNAPSHOT_FIELDS) {
    if (have.fields?.[k] !== hashText(JSON.stringify(full[k]))) Object.assign(fields, { [k]: full[k] });
  }
  const resumed: ThreadResumed = {
    threadId: full.threadId,
    snapshot: fields,
    keep,
    idPrefix,
    ids: idPrefix === "" ? rest : rest.map((id) => id.slice(idPrefix.length)),
    positions: items.map((r) => r.position),
    rows: items.filter((_, k) => !known.has(digests[k]!)),
  };
  return { resumed, state: holding(Math.max(rows, conversationRowStarts(items).length), items) };
}

/**
 * The subscribers of one thread. Plain ones (`rows` unset) get the provider's events and full
 * snapshots as they are; windowed ones go through the functions above.
 */
export class ThreadListeners {
  private subs = new Map<ThreadListener, WindowState | null>();
  /** The thread as the windowed subscribers hold it while older pages are read; null otherwise. */
  private before: ThreadSnapshot | null = null;
  private pagingNow = false;

  /** Pages are being read and windowed subscribers wait for the publish. */
  get paging(): boolean {
    return this.pagingNow;
  }

  get size(): number {
    return this.subs.size;
  }

  /**
   * Adds a subscriber and sends it the thread: the whole of `full`, or the newest `rows` rows of it.
   * A windowed subscriber with `have` gets the thread from its first row on, minus the rows it
   * holds (resumeWindow), unless that row is gone.
   */
  add(listener: ThreadListener, full: ThreadSnapshot, moreBefore: boolean, rows?: number, have?: ThreadHave): void {
    if (rows === undefined) {
      this.subs.set(listener, null);
      listener({ snapshot: full });
      return;
    }
    const resumed = have ? resumeWindow(full, have, rows, moreBefore) : null;
    if (resumed) {
      this.subs.set(listener, resumed.state);
      listener({ resumed: resumed.resumed });
      return;
    }
    const w = openWindow(full, rows, moreBefore);
    this.subs.set(listener, w.state);
    listener({ snapshot: w.snapshot });
  }

  delete(listener: ThreadListener): void {
    this.subs.delete(listener);
  }

  /** The window of a windowed subscriber; null for a plain one, undefined for a stranger. */
  window(listener: ThreadListener): WindowState | null | undefined {
    return this.subs.get(listener);
  }

  /** The most rows a windowed subscriber's window asks for (0 without one). */
  rowsWanted(): number {
    let n = 0;
    for (const w of this.subs.values()) if (w) n = Math.max(n, w.rows);
    return n;
  }

  /**
   * Older pages are about to be read (or the thread read again). `full` is the thread now, which
   * the windowed subscribers hold; until `publish` they get no row events.
   */
  beginPaging(full: () => ThreadSnapshot): void {
    // Only windowed subscribers hold back; without one (a thread opening, plain readers) nothing waits.
    if (this.paging || ![...this.subs.values()].some((w) => w !== null)) return;
    this.pagingNow = true;
    this.before = full();
  }

  /** Live events. While pages are read, windowed subscribers skip row events (publish sends the difference). */
  events(events: ThreadLiveEvent[], moreBefore: boolean): void {
    if (events.length === 0) return;
    for (const [listener, w] of [...this.subs]) {
      if (!this.subs.has(listener)) continue;
      if (!w) {
        listener({ events });
        continue;
      }
      const mine = this.paging
        ? events.filter((e) => e.t !== "turnItem.upserted" && e.t !== "turnItem.textAppended" && e.t !== "turnItems.replaced")
        : windowEvents(w, events, moreBefore);
      if (mine.length) listener({ events: mine });
    }
  }

  /**
   * The rows changed outside live events (pages read, the thread read again), or a windowed
   * subscriber asked for older rows. Plain subscribers get the new snapshot; windowed ones their
   * difference (publishTo). `requester` grows its window and always gets an answer; `only` limits
   * the send to one subscriber (a request that read nothing changes nobody else).
   */
  publish(full: () => ThreadSnapshot, moreBefore: boolean, opts: { requester?: ThreadListener; only?: ThreadListener } = {}): void {
    const before = this.before;
    this.before = null;
    this.pagingNow = false;
    let snap: ThreadSnapshot | null = null;
    const get = () => (snap ??= full());
    for (const [listener, w] of [...this.subs]) {
      if (opts.only && listener !== opts.only) continue;
      if (!this.subs.has(listener)) continue;
      if (!w) {
        listener({ snapshot: get() });
        continue;
      }
      for (const msg of publishTo(w, before, get(), moreBefore, listener === opts.requester)) listener(msg);
    }
  }

  error(error: string): void {
    for (const listener of [...this.subs.keys()]) listener({ error });
  }
}
