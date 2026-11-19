// Turn pages read from a thread's rollout file, for a paginated thread the daemon serves without
// turns (DESIGN.md 3.2).
//
// Why: for a paginated thread the daemon answers thread/read and thread/turns/list from its
// history projection (`thread_history_1.sqlite`), and it fills that projection from the rollout
// only while it holds the thread. A thread written before the projection existed, or whose
// projection rows are gone, reads as zero turns until something resumes it, and resuming starts
// its MCP servers and hooks. Measured on codex-cli 0.169.0 with a scratch CODEX_HOME: every
// paginated thread read 0 turns before thread/resume and its full history after.
//
// What: the view (threadView.ts) asks the daemon first. When the newest page is empty, it asks
// this history, which returns the same shape thread/turns/list does (Turn[], newest first, and a
// cursor), so the existing projection draws it unchanged. Cursors start with ROLLOUT_CURSOR; the
// view sends a rollout cursor back here and any other cursor to the daemon.
//
// How: records are read backwards from the end of the file in readTail batches (the batch is an
// I/O step: the page continues until it holds `limit` turns or the history starts).
// - task_started opens a turn; task_complete ends it completed, turn_aborted interrupted. A turn
//   without an end reads as interrupted, as the daemon serves it.
// - item_completed carries the turn id. An item of an older turn written after a newer turn
//   started is kept until that turn's task_started is reached, across pages.
// - thread_rolled_back {num_turns} drops that many turns before it.
// - A rollout whose session_meta has history_base continues an earlier rollout: the records of
//   that file before ordinal end_ordinal_exclusive come first (the daemon serves them the same
//   way; findBaseFile).
// Every record is counted as used or ignored, and every item as mapped, unknown or dropped.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ThreadItem } from "../protocol/v2/ThreadItem.ts";
import type { ThreadTurnsListResponse } from "../protocol/v2/ThreadTurnsListResponse.ts";
import type { Turn } from "../protocol/v2/Turn.ts";
import type { TurnStatus } from "../protocol/v2/TurnStatus.ts";
import { isParseError, readRange, readTail, type RawRecord, type ReadStats } from "../../transcript/claudeTranscript.ts";
import { mapRolloutItem, rolloutItemKey, turnError } from "./rolloutItems.ts";

export const ROLLOUT_CURSOR = "rollout:";

/** Records per readTail call: an I/O step, not a page size. */
const READ_BATCH_RECORDS = 256;

/** Bytes read for the first line of a rollout (session_meta) per step. */
const META_CHUNK_BYTES = 64 * 1024;

export function isRolloutCursor(cursor: string | null | undefined): cursor is string {
  return typeof cursor === "string" && cursor.startsWith(ROLLOUT_CURSOR);
}

export interface RolloutHistoryStats {
  /** The thread's current rollout. */
  path: string;
  /**
   * Oldest first; the last is the current rollout. endOffset: where an earlier file's part ends;
   * recordedEndOffset: the history_base offset, which differs when the file was rewritten since.
   */
  segments: Array<{ path: string; endOffset: number | null; recordedEndOffset: number | null }>;
  /** A history_base whose file was not found: the history starts after it. */
  unresolvedBase: { threadId: string; endOrdinalExclusive: number | null; endByteOffset: number | null } | null;
  pages: number;
  turns: number;
  /** Bytes before the oldest record read so far, over all segments (0 once the history start is reached). */
  unreadBytes: number;
  bytesRead: number;
  /** Records consumed by page reads. A newest page read again (a re-read after a reconnect) counts again. */
  records: number;
  parseFailures: number;
  /** Records by `type`, `event_msg/<type>` for events: what the turns are built from, and the rest. */
  usedRecords: Record<string, number>;
  ignoredRecords: Record<string, number>;
  /** item_completed items by rolloutItemKey: mapped to a ThreadItem, unknown (shown as unknown rows), dropped (`<reason>|<key>`). */
  mappedItems: Record<string, number>;
  unknownItems: Record<string, number>;
  droppedItems: Record<string, number>;
}

export interface RolloutHistory {
  /** One page of turns, newest first. cursor null: the newest turns. */
  page(cursor: string | null, limit: number): Promise<ThreadTurnsListResponse>;
  stats(): RolloutHistoryStats;
}

export function openRolloutHistory(opts: { path: string; threadId: string }): RolloutHistory {
  return new FileRolloutHistory(opts.path, opts.threadId);
}

/** One log line: what the pages so far used, and what they left out. */
export function rolloutStatsLine(threadKey: string, s: RolloutHistoryStats): string {
  const j = (o: Record<string, number>) => JSON.stringify(o);
  return (
    `codex rollout fallback ${threadKey}: page ${s.pages}, turns ${s.turns}, unread ${s.unreadBytes} bytes, ` +
    `items mapped ${j(s.mappedItems)} unknown ${j(s.unknownItems)} dropped ${j(s.droppedItems)}, ` +
    `records used ${j(s.usedRecords)} ignored ${j(s.ignoredRecords)} parseFailures ${s.parseFailures}` +
    (s.unresolvedBase ? `, history_base not found ${JSON.stringify(s.unresolvedBase)}` : "")
  );
}

interface Segment {
  path: string;
  /** Exclusive end for an earlier file (where its record end_ordinal_exclusive starts); null for the current file. */
  end: number | null;
  /** history_base.end_byte_offset as recorded; differs from `end` when the file was rewritten since. */
  recordedEnd?: number | null;
}

interface PendingTurn {
  /** Items in file order. */
  items: ThreadItem[];
  /** item ids already held, newest record first (a later record of the same item wins). */
  ids: Set<string>;
  end: Record<string, unknown> | null;
}

/** What a page leaves for the next one: turns whose start is older than the cursor. */
interface Carry {
  pending: Map<string, PendingTurn>;
  /** Turns still to drop for a thread_rolled_back seen after them. */
  rollback: number;
}

type Obj = Record<string, unknown>;

class FileRolloutHistory implements RolloutHistory {
  private readonly file: string;
  private readonly threadId: string;
  private segments: Segment[] | null = null;
  private readonly carries = new Map<string, Carry>();
  private readonly readStats: ReadStats = { bytesRead: 0 };
  private readonly counters: RolloutHistoryStats;

  constructor(file: string, threadId: string) {
    this.file = file;
    this.threadId = threadId;
    this.counters = {
      path: file,
      segments: [],
      unresolvedBase: null,
      pages: 0,
      turns: 0,
      unreadBytes: 0,
      bytesRead: 0,
      records: 0,
      parseFailures: 0,
      usedRecords: {},
      ignoredRecords: {},
      mappedItems: {},
      unknownItems: {},
      droppedItems: {},
    };
  }

  stats(): RolloutHistoryStats {
    return structuredClone({ ...this.counters, bytesRead: this.readStats.bytesRead });
  }

  async page(cursor: string | null, limit: number): Promise<ThreadTurnsListResponse> {
    const segs = await this.resolveSegments();
    let seg: number;
    let pos: number;
    let carry: Carry;
    if (cursor === null) {
      seg = segs.length - 1;
      pos = (await fsp.stat(this.file)).size;
      carry = { pending: new Map(), rollback: 0 };
    } else {
      const m = /^rollout:(\d+):(\d+)$/.exec(cursor);
      const saved = this.carries.get(cursor);
      if (!m || !saved) throw new Error(`unknown rollout cursor ${cursor}`);
      seg = Number(m[1]);
      pos = Number(m[2]);
      carry = copyCarry(saved);
    }
    const max = Math.max(1, Math.floor(limit));
    const turns: Turn[] = [];
    let next: string | null = null;
    outer: while (seg >= 0) {
      if (pos <= 0) {
        seg--;
        if (seg >= 0) pos = await this.segmentEnd(segs[seg]!);
        continue;
      }
      const batch = await readTail(segs[seg]!.path, { maxRecords: READ_BATCH_RECORDS, beforeOffset: pos, stats: this.readStats });
      if (batch.records.length === 0) {
        pos = 0;
        continue;
      }
      for (let i = batch.records.length - 1; i >= 0; i--) {
        const rec = batch.records[i]!;
        pos = rec.offset;
        const turn = this.consume(rec, carry);
        if (!turn) continue;
        turns.push(turn);
        if (turns.length < max) continue;
        const older = batch.records.slice(0, i);
        if (seg > 0 || batch.hasMoreBefore || older.some(startsTurn)) {
          next = `${ROLLOUT_CURSOR}${seg}:${rec.offset}`;
          break outer;
        }
        // No turn starts before this one: read the rest of the file now, so the last page says so.
        for (let j = older.length - 1; j >= 0; j--) this.consume(older[j]!, carry);
        pos = 0;
        seg = 0;
        break outer;
      }
      pos = batch.startOffset;
    }
    if (next !== null) {
      this.carries.set(next, copyCarry(carry));
    } else {
      // The history starts here: items whose turn never started are not served (the daemon drops them too).
      for (const p of carry.pending.values()) for (const it of p.items) this.bump(this.counters.droppedItems, `noTurnStart|${it.type}`);
    }
    this.counters.pages++;
    this.counters.turns += turns.length;
    this.counters.unreadBytes = next === null ? 0 : await this.bytesBefore(segs, seg, pos);
    return { data: turns, nextCursor: next, backwardsCursor: null };
  }

  /** Apply one record (newest first). Returns the turn its task_started completes, if any. */
  private consume(rec: RawRecord, carry: Carry): Turn | null {
    this.counters.records++;
    const v = rec.value;
    if (isParseError(v) || typeof v !== "object" || v === null) {
      this.counters.parseFailures++;
      return null;
    }
    const r = v as Obj;
    const type = typeof r.type === "string" ? r.type : "(missing)";
    const payload = isObj(r.payload) ? r.payload : {};
    if (type !== "event_msg") {
      this.bump(type === "session_meta" ? this.counters.usedRecords : this.counters.ignoredRecords, type);
      return null;
    }
    const ev = typeof payload.type === "string" ? payload.type : "(missing)";
    const key = `event_msg/${ev}`;
    switch (ev) {
      case "item_completed": {
        this.bump(this.counters.usedRecords, key);
        const itemKey = rolloutItemKey(payload.item);
        const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
        if (turnId === null) {
          this.bump(this.counters.droppedItems, `noTurnId|${itemKey}`);
          return null;
        }
        const p = pendingOf(carry, turnId);
        const rawId = isObj(payload.item) && typeof payload.item.id === "string" ? payload.item.id : null;
        if (rawId !== null && p.ids.has(rawId)) {
          // An older record of an item a newer record already holds: the newer content stays, at
          // this earlier position.
          const at = p.items.findIndex((x) => x.id === rawId);
          const [held] = p.items.splice(at, 1);
          p.items.unshift(held!);
          this.bump(this.counters.droppedItems, `superseded|${itemKey}`);
          return null;
        }
        const times = { startedAtMs: num(payload.started_at_ms), completedAtMs: num(payload.completed_at_ms) };
        let item = mapRolloutItem(payload.item, times);
        if (item) this.bump(this.counters.mappedItems, itemKey);
        else {
          this.bump(this.counters.unknownItems, itemKey);
          item = unknownItem(payload.item, itemKey, times);
        }
        p.ids.add(item.id);
        p.items.unshift(item);
        return null;
      }
      case "task_complete":
      case "turn_aborted": {
        this.bump(this.counters.usedRecords, key);
        const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
        if (turnId === null) return null;
        const p = pendingOf(carry, turnId);
        // The newest end record of a turn wins.
        if (p.end === null) p.end = payload;
        return null;
      }
      case "thread_rolled_back": {
        this.bump(this.counters.usedRecords, key);
        carry.rollback += Math.max(0, num(payload.num_turns) ?? 0);
        return null;
      }
      case "task_started": {
        this.bump(this.counters.usedRecords, key);
        const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
        if (turnId === null) return null;
        const p = carry.pending.get(turnId) ?? { items: [], ids: new Set<string>(), end: null };
        carry.pending.delete(turnId);
        if (carry.rollback > 0) {
          carry.rollback--;
          for (const it of p.items) this.bump(this.counters.droppedItems, `rolledBack|${it.type}`);
          return null;
        }
        return turnOf(turnId, payload, p);
      }
      default:
        this.bump(this.counters.ignoredRecords, key);
        return null;
    }
  }

  /** The current rollout and the earlier files its history_base chain names, oldest first. */
  private async resolveSegments(): Promise<Segment[]> {
    if (this.segments) return this.segments;
    const segs: Segment[] = [{ path: this.file, end: null }];
    const seen = new Set<string>([path.resolve(this.file)]);
    let meta = await readSessionMeta(this.file);
    while (meta && isObj(meta.history_base)) {
      const hb = meta.history_base;
      const base = await findBaseFile(this.file, hb, seen);
      if (!base) {
        this.counters.unresolvedBase = {
          threadId: String(hb.thread_id ?? this.threadId),
          endOrdinalExclusive: num(hb.end_ordinal_exclusive),
          endByteOffset: num(hb.end_byte_offset),
        };
        break;
      }
      segs.unshift({ path: base.path, end: base.end, recordedEnd: num(hb.end_byte_offset) });
      seen.add(path.resolve(base.path));
      meta = await readSessionMeta(base.path);
    }
    this.segments = segs;
    this.counters.segments = segs.map((s) => ({ path: s.path, endOffset: s.end, recordedEndOffset: s.recordedEnd ?? null }));
    return segs;
  }

  private async segmentEnd(s: Segment): Promise<number> {
    return s.end ?? (await fsp.stat(s.path)).size;
  }

  private async bytesBefore(segs: Segment[], seg: number, pos: number): Promise<number> {
    let n = Math.max(0, pos);
    for (let i = 0; i < seg; i++) n += await this.segmentEnd(segs[i]!);
    return n;
  }

  private bump(bucket: Record<string, number>, key: string): void {
    bucket[key] = (bucket[key] ?? 0) + 1;
  }
}

/** A carry a later page can change without touching the saved one (a cursor can be read again). */
function copyCarry(c: Carry): Carry {
  const pending = new Map<string, PendingTurn>();
  for (const [id, p] of c.pending) pending.set(id, { items: [...p.items], ids: new Set(p.ids), end: p.end });
  return { pending, rollback: c.rollback };
}

function startsTurn(rec: RawRecord): boolean {
  const v = rec.value;
  return isObj(v) && v.type === "event_msg" && isObj(v.payload) && v.payload.type === "task_started";
}

function pendingOf(carry: Carry, turnId: string): PendingTurn {
  let p = carry.pending.get(turnId);
  if (!p) {
    p = { items: [], ids: new Set(), end: null };
    carry.pending.set(turnId, p);
  }
  return p;
}

function turnOf(id: string, started: Obj, p: PendingTurn): Turn {
  const end = p.end;
  const error = end?.type === "task_complete" ? turnError(end.error) : null;
  const status: TurnStatus = end === null || end.type !== "task_complete" ? "interrupted" : error ? "failed" : "completed";
  return {
    id,
    rootTurnId: typeof started.root_turn_id === "string" ? started.root_turn_id : null,
    items: p.items,
    itemsView: "full",
    status,
    error,
    startedAt: num(started.started_at) ?? num(end?.started_at),
    completedAt: num(end?.completed_at),
    durationMs: num(end?.duration_ms),
  };
}

/** An item type mapRolloutItem does not know, as an item mapItems shows as an unknown row. */
function unknownItem(raw: unknown, key: string, times: { startedAtMs: number | null; completedAtMs: number | null }): ThreadItem {
  const o = isObj(raw) ? raw : {};
  const id = typeof o.id === "string" ? o.id : `rollout-unknown:${key}:${times.startedAtMs ?? ""}`;
  return { ...o, id, type: `rollout/${key}`, ...times } as unknown as ThreadItem;
}

/** The first line of a rollout, when it is a session_meta record. */
export async function readSessionMeta(file: string): Promise<Obj | null> {
  let fh;
  try {
    fh = await fsp.open(file, "r");
  } catch {
    return null;
  }
  try {
    const parts: Buffer[] = [];
    let pos = 0;
    for (;;) {
      const buf = Buffer.alloc(META_CHUNK_BYTES);
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) return null;
      const chunk = buf.subarray(0, bytesRead);
      const nl = chunk.indexOf(0x0a);
      if (nl >= 0) {
        parts.push(chunk.subarray(0, nl));
        break;
      }
      parts.push(chunk);
      pos += bytesRead;
    }
    const rec = JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
    if (!isObj(rec) || rec.type !== "session_meta" || !isObj(rec.payload)) return null;
    return rec.payload;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

/**
 * The earlier rollout a history_base names, and where its part ends: a rollout of `thread_id`
 * under the same sessions or archived_sessions tree, cut before the record with ordinal
 * end_ordinal_exclusive. The record ending at end_byte_offset normally has the ordinal before it;
 * when it does not (the first line was rewritten after the history_base was recorded: measured,
 * a session_meta cwd edit moved every later record by 18 bytes), the cut is found by ordinal.
 */
async function findBaseFile(current: string, hb: Obj, seen: Set<string>): Promise<{ path: string; end: number } | null> {
  const threadId = typeof hb.thread_id === "string" ? hb.thread_id : null;
  const endByte = num(hb.end_byte_offset);
  const endOrdinal = num(hb.end_ordinal_exclusive);
  if (!threadId || endByte === null || endByte <= 0) return null;
  const candidates: string[] = [];
  for (const root of rolloutRoots(current)) {
    let names: string[];
    try {
      names = (await fsp.readdir(root, { recursive: true })) as string[];
    } catch {
      continue;
    }
    for (const n of names) {
      const base = path.basename(n);
      if (!base.startsWith("rollout-") || !base.includes(threadId) || !/\.jsonl$/.test(base)) continue;
      const full = path.join(root, n);
      if (!seen.has(path.resolve(full))) candidates.push(full);
    }
  }
  // Newest name first: the nearest earlier segment.
  candidates.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
  for (const c of candidates) {
    try {
      const size = (await fsp.stat(c)).size;
      if (size >= endByte) {
        const page = await readTail(c, { maxRecords: 1, beforeOffset: endByte });
        const last = page.records[0];
        const ord = last && isObj(last.value) ? num(last.value.ordinal) : null;
        if (last && last.offset + last.length === endByte && (endOrdinal === null || ord === endOrdinal - 1)) return { path: c, end: endByte };
      }
      if (endOrdinal === null) continue;
      const cut = await offsetOfOrdinal(c, endOrdinal, size);
      if (cut !== null) return { path: c, end: cut };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The offset of the first record whose ordinal is at least `ordinal`, read forward from the start
 * (a window that grows until it holds a whole line). null when the file has no such record.
 */
async function offsetOfOrdinal(file: string, ordinal: number, size: number): Promise<number | null> {
  let start = 0;
  let window = META_CHUNK_BYTES * 16;
  while (start < size) {
    const recs = await readRange(file, start, start + window);
    if (recs.length === 0) {
      if (start + window >= size) return null;
      window *= 2;
      continue;
    }
    for (const r of recs) {
      const ord = isObj(r.value) ? num(r.value.ordinal) : null;
      if (ord !== null && ord >= ordinal) return r.offset;
    }
    const last = recs.at(-1)!;
    start = last.offset + last.length;
  }
  return null;
}

/** `<home>/sessions` and `<home>/archived_sessions` for a rollout under either. */
function rolloutRoots(file: string): string[] {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    const name = path.basename(dir);
    if (name === "sessions" || name === "archived_sessions") {
      const home = path.dirname(dir);
      return [path.join(home, "sessions"), path.join(home, "archived_sessions")].filter((d) => fs.existsSync(d));
    }
    const up = path.dirname(dir);
    if (up === dir) return [path.dirname(path.resolve(file))];
    dir = up;
  }
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
