// Raw record layer for Claude transcripts: `projects/<enc>/<sid>.jsonl` and the subagent files
// under `<sid>/subagents/`. It hands out each JSON line of a transcript with its byte position,
// in file order. What a record means is decided by a transform injected one layer up
// (transcriptHub.ts); this file only finds, splits and parses lines.
//
//   readTail          a page of the complete lines before an offset, read backwards in chunks,
//                     so a page of a 600MB transcript costs about the bytes of that page
//   readRange         the complete lines inside a byte range (re-reading a known page, or one
//                     large record the UI expands later)
//   followTranscript  lines appended after an offset, as they are written
//
// Record rules, shared by all three:
//   - a record is one newline-terminated line. `length` counts the newline, so records tile the
//     file: a record's offset + length is the next record's offset
//   - an unterminated last line is a write in progress and is left for a later read
//   - a line that fails JSON.parse (a blank line too) is still a record, with the value
//     `{ __parseError: true, raw }`, so record counts equal newline counts (`wc -l`)
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { isNotFound } from "../claude/meta.ts";

/** Bytes per read. A line longer than this is assembled from several chunks. */
export const CHUNK_BYTES = 256 * 1024;
/** Characters of a broken line kept in its ParseErrorValue. */
export const PARSE_ERROR_RAW_CHARS = 200;
export const DEFAULT_DEBOUNCE_MS = 50;
export const DEFAULT_POLL_MS = 1000;

const NEWLINE = 0x0a;

export interface RawRecord {
  /** Byte offset of the line's first byte. */
  offset: number;
  /** Bytes of the line, newline included. */
  length: number;
  /** 1-based line number, known only when the read started at offset 0 (else null). */
  line: number | null;
  /** JSON.parse result, or a ParseErrorValue for a line that is not JSON. */
  value: unknown;
}

export interface ParseErrorValue {
  __parseError: true;
  /** The first PARSE_ERROR_RAW_CHARS characters of the line. */
  raw: string;
}

export interface Page {
  /** Oldest first. */
  records: RawRecord[];
  /** Offset of the first record. Pass it as `beforeOffset` to read the previous page. */
  startOffset: number;
  /** Offset just past the last record. Follow from here. */
  endOffset: number;
  /** A complete line ends before startOffset. */
  hasMoreBefore: boolean;
}

/** Cumulative counters a caller may pass in to measure what the reads cost. */
export interface ReadStats {
  bytesRead: number;
}

export interface ReadTailOptions {
  /** Page size: the most records to return. Older records stay readable through beforeOffset. */
  maxRecords: number;
  /** Read the lines that end before this offset. Default: the file size. */
  beforeOffset?: number;
  stats?: ReadStats;
}

/**
 * truncated  the file is shorter than the bytes already read
 * replaced   the path names a different file (inode or device changed)
 * missing    the file is gone (deleted, or moved by a rehome); a file that appears at the path
 *            later is followed from offset 0
 * rewritten  the byte before the follow position is no longer a newline: earlier content changed
 *            in place, or fromOffset was not a line boundary
 */
export type ResetReason = "truncated" | "replaced" | "missing" | "rewritten";

export interface ResetInfo {
  reason: ResetReason;
}

export interface FollowOptions {
  /** File events are collected for this long before a read, ms. Default 50. */
  debounceMs?: number;
  /** Interval of the stat check that catches missed file events, ms. Default 1000. */
  pollMs?: number;
  /** Called before the records of a fresh read from offset 0. */
  onReset?: (info: ResetInfo) => void;
  /** I/O errors and errors thrown by the callbacks. Default: console.error. */
  onError?: (err: unknown) => void;
  stats?: ReadStats;
}

export interface Follower {
  stop(): void;
}

export function isParseError(value: unknown): value is ParseErrorValue {
  return typeof value === "object" && value !== null && (value as { __parseError?: unknown }).__parseError === true;
}

// ---- readTail ----

/**
 * The last complete lines before `beforeOffset` (default: the end of the file), at most
 * `maxRecords` of them. Reads backwards in CHUNK_BYTES steps and stops once the page is full.
 * Bytes after the last newline before `beforeOffset` (a line in progress, or the rest of a line
 * that `beforeOffset` cuts) are not part of the page.
 */
export async function readTail(file: string, opts: ReadTailOptions): Promise<Page> {
  const { maxRecords } = opts;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
    throw new RangeError(`maxRecords must be a positive integer, got ${maxRecords}`);
  }
  const fh = await fsp.open(file, "r");
  try {
    const size = (await fh.stat()).size;
    const before = opts.beforeOffset ?? size;
    assertOffset("beforeOffset", before);
    if (before > size) {
      throw new RangeError(`beforeOffset ${before} is past the end of ${file} (${size} bytes)`);
    }
    return await tailPage(fh, before, maxRecords, opts.stats);
  } finally {
    await fh.close();
  }
}

async function tailPage(fh: FileHandle, end: number, maxRecords: number, stats: ReadStats | undefined): Promise<Page> {
  const newestFirst: RawRecord[] = [];
  /** Offset of the newline that ends the line being assembled; -1 until the first one is found. */
  let lineEnd = -1;
  let endOffset = 0;
  let startOffset = 0;
  /** Bytes of the line being assembled, in file order. */
  let parts: Buffer[] = [];
  let full = false;
  let pos = end;
  while (pos > 0 && !full) {
    const chunkStart = Math.max(0, pos - CHUNK_BYTES);
    const buf = await readAt(fh, chunkStart, pos - chunkStart, stats);
    let i = buf.length; // bytes [0, i) of this chunk are not consumed yet
    while (i > 0) {
      const nl = buf.lastIndexOf(NEWLINE, i - 1);
      if (nl === -1) break;
      if (lineEnd === -1) {
        // The last newline before `end`. Whatever follows it is dropped.
        endOffset = chunkStart + nl + 1;
      } else {
        parts.unshift(buf.subarray(nl + 1, i));
        newestFirst.push(makeRecord(parts, chunkStart + nl + 1, null));
        parts = [];
        if (newestFirst.length >= maxRecords) {
          full = true;
          startOffset = chunkStart + nl + 1;
          break;
        }
      }
      lineEnd = chunkStart + nl;
      i = nl;
    }
    if (!full && lineEnd !== -1 && i > 0) parts.unshift(buf.subarray(0, i));
    pos = chunkStart;
  }
  if (!full && lineEnd !== -1) {
    // Reached the start of the file: the bytes before the earliest newline are line 1.
    newestFirst.push(makeRecord(parts, 0, null));
    startOffset = 0;
  }
  newestFirst.reverse();
  return { records: newestFirst, startOffset, endOffset, hasMoreBefore: startOffset > 0 };
}

// ---- readRange ----

/**
 * The complete lines inside [start, end). `start` is normally a record offset; when it falls
 * inside a line, the rest of that line is skipped. A line that `end` cuts is not included, and
 * an `end` past the end of the file reads to the end.
 */
export async function readRange(file: string, start: number, end: number, stats?: ReadStats): Promise<RawRecord[]> {
  assertOffset("start", start);
  assertOffset("end", end);
  if (end < start) throw new RangeError(`end ${end} is before start ${start}`);
  const fh = await fsp.open(file, "r");
  try {
    const stop = Math.min(end, (await fh.stat()).size);
    if (start >= stop) return [];
    let skipping = false;
    if (start > 0) {
      const prev = await readAt(fh, start - 1, 1, stats);
      skipping = prev[0] !== NEWLINE;
    }
    const splitter = newSplitter(start, start === 0 ? 1 : null, skipping);
    const out: RawRecord[] = [];
    while (splitter.next < stop) {
      const buf = await readAt(fh, splitter.next, Math.min(CHUNK_BYTES, stop - splitter.next), stats);
      feed(splitter, buf, out);
    }
    return out;
  } finally {
    await fh.close();
  }
}

// ---- followTranscript ----

/**
 * Hand out the complete lines written after `fromOffset`, as they appear. `fromOffset` is a
 * line boundary (a Page's endOffset); lines already past it when following starts are handed
 * out on the first read.
 *
 * Reads are triggered by fs.watch on the file (collected for `debounceMs`) and by a stat check
 * every `pollMs`, which catches events fs.watch misses and finds a file that reappears. When the
 * file shrinks, is replaced or disappears, `onReset` is called and following restarts at offset
 * 0 of the file at the path.
 */
export function followTranscript(
  file: string,
  fromOffset: number,
  onRecords: (records: RawRecord[]) => void,
  opts: FollowOptions = {},
): Follower {
  assertOffset("fromOffset", fromOffset);
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const onError = opts.onError ?? ((err: unknown) => console.error(`followTranscript ${file}:`, err));

  /** The file being followed; null before the first open and after it went missing. */
  let identity: { dev: number; ino: number } | null = null;
  // splitter.lineStart: end of the last line handed out. splitter.next: end of the bytes read,
  // the unterminated line in between is held in the splitter until its newline arrives.
  let splitter = newSplitter(fromOffset, fromOffset === 0 ? 1 : null, false);
  let stopped = false;
  let running = false;
  let again = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  const pollTimer = setInterval(kick, pollMs);

  function report(err: unknown): void {
    if (!stopped) onError(err);
  }

  /** Run check(); a kick during a check runs it once more afterwards. */
  function kick(): void {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        do {
          again = false;
          try {
            await check();
          } catch (err) {
            report(err);
          }
        } while (again && !stopped);
      } finally {
        running = false;
      }
    })();
  }

  // A "rename" event (the path may now name another file, or none) needs nothing extra: check()
  // compares the inode and replaces the watcher, or closes it when the file is gone.
  function onWatchEvent(): void {
    if (debounceTimer !== null || stopped) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      kick();
    }, debounceMs);
  }

  /** Returns true when it started a new watcher. */
  function ensureWatcher(): boolean {
    if (watcher !== null || stopped) return false;
    try {
      const w = fs.watch(file, onWatchEvent);
      w.on("error", (err) => {
        if (watcher === w) watcher = null;
        w.close();
        if (!isNotFound(err)) report(err);
        kick();
      });
      watcher = w;
      return true;
    } catch (err) {
      // A missing file is found again by the poll.
      if (!isNotFound(err)) report(err);
      return false;
    }
  }

  function closeWatcher(): void {
    watcher?.close();
    watcher = null;
  }

  function reset(reason: ResetReason): void {
    splitter = newSplitter(0, 1, false);
    if (stopped) return;
    try {
      opts.onReset?.({ reason });
    } catch (err) {
      report(err);
    }
  }

  function emit(records: RawRecord[]): void {
    if (stopped || records.length === 0) return;
    try {
      onRecords(records);
    } catch (err) {
      report(err);
    }
  }

  async function check(): Promise<void> {
    let fh: FileHandle;
    try {
      fh = await fsp.open(file, "r");
    } catch (err) {
      if (!isNotFound(err)) throw err;
      closeWatcher();
      // The file the offsets refer to is gone. At start this also covers a caller whose page
      // came from a file that has since disappeared.
      if (identity !== null || splitter.next > 0) {
        identity = null;
        reset("missing");
      }
      return;
    }
    try {
      const st = await fh.stat();
      if (stopped) return;
      if (identity === null) {
        identity = { dev: st.dev, ino: st.ino };
      } else if (identity.dev !== st.dev || identity.ino !== st.ino) {
        identity = { dev: st.dev, ino: st.ino };
        closeWatcher();
        reset("replaced");
      }
      // A write between the stat above and the watcher's start raises no event: one more pass
      // after a new watcher starts picks it up instead of the next poll.
      if (ensureWatcher()) again = true;
      if (st.size < splitter.next) reset("truncated");
      if (st.size === splitter.next) return;
      if (splitter.lineStart > 0) {
        const prev = await readUpTo(fh, splitter.lineStart - 1, 1, opts.stats);
        if (prev.length === 0) {
          again = true; // shrank since the stat; the next pass resets
          return;
        }
        if (prev[0] !== NEWLINE) reset("rewritten");
      }
      // Reads stop at the size seen by this stat; later appends bring another event or poll.
      while (splitter.next < st.size && !stopped) {
        const want = Math.min(CHUNK_BYTES, st.size - splitter.next);
        const buf = await readUpTo(fh, splitter.next, want, opts.stats);
        const out: RawRecord[] = [];
        feed(splitter, buf, out);
        emit(out);
        if (buf.length < want) {
          again = true;
          break;
        }
      }
    } finally {
      await fh.close();
    }
  }

  kick();
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(pollTimer);
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = null;
      closeWatcher();
    },
  };
}

// ---- paths ----

/** One path segment: an agentId comes from a parent record (toolUseResult.agentId). */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Transcript of a subagent the session started:
 * `<dir>/<sid>.jsonl` -> `<dir>/<sid>/subagents/agent-<agentId>.jsonl`.
 * The result is read with the same functions as the session file.
 */
export function subagentTranscriptPath(sessionFile: string, agentId: string): string {
  if (!sessionFile.endsWith(".jsonl")) throw new Error(`not a transcript path: ${sessionFile}`);
  if (!AGENT_ID.test(agentId)) throw new Error(`invalid agentId: ${JSON.stringify(agentId)}`);
  const dir = path.dirname(sessionFile);
  const sid = path.basename(sessionFile, ".jsonl");
  return path.join(dir, sid, "subagents", `agent-${agentId}.jsonl`);
}

// ---- line splitting ----

/** Splits bytes read in file order into records, holding an unterminated line between feeds. */
interface Splitter {
  /** Offset of the next byte to feed. */
  next: number;
  /** Offset of the line being assembled (the end of the last complete line). */
  lineStart: number;
  /** Line number of the line being assembled, null when unknown. */
  line: number | null;
  /** Bytes of the line being assembled. */
  parts: Buffer[];
  /** Drop bytes through the next newline: the read started inside a line. */
  skipping: boolean;
}

function newSplitter(start: number, line: number | null, skipping: boolean): Splitter {
  return { next: start, lineStart: start, line, parts: [], skipping };
}

function feed(s: Splitter, buf: Buffer, out: RawRecord[]): void {
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(NEWLINE, i);
    if (nl === -1) {
      // Every read gets a fresh buffer, so holding a view of it is safe.
      if (!s.skipping) s.parts.push(buf.subarray(i));
      break;
    }
    if (s.skipping) {
      s.skipping = false;
    } else {
      s.parts.push(buf.subarray(i, nl));
      out.push(makeRecord(s.parts, s.lineStart, s.line));
      if (s.line !== null) s.line++;
    }
    s.parts = [];
    s.lineStart = s.next + nl + 1;
    i = nl + 1;
  }
  s.next += buf.length;
}

/** `parts` are the line's bytes without the newline. */
function makeRecord(parts: Buffer[], offset: number, line: number | null): RawRecord {
  const bytes = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  return { offset, length: bytes.length + 1, line, value: parseLine(bytes) };
}

function parseLine(bytes: Buffer): unknown {
  const text = bytes.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    const broken: ParseErrorValue = { __parseError: true, raw: clipChars(text, PARSE_ERROR_RAW_CHARS) };
    return broken;
  }
}

/** First `max` characters by code point, so a surrogate pair is never split. */
function clipChars(text: string, max: number): string {
  return Array.from(text.slice(0, max * 2)).slice(0, max).join("");
}

// ---- I/O ----

/** Up to `length` bytes at `position`, fewer when the file ends first. Always a fresh buffer. */
async function readUpTo(fh: FileHandle, position: number, length: number, stats: ReadStats | undefined): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await fh.read(buf, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  if (stats) stats.bytesRead += filled;
  return filled === length ? buf : buf.subarray(0, filled);
}

/** Exactly `length` bytes at `position`; throws when the file shrank under the read. */
async function readAt(fh: FileHandle, position: number, length: number, stats: ReadStats | undefined): Promise<Buffer> {
  const buf = await readUpTo(fh, position, length, stats);
  if (buf.length < length) {
    throw new Error(`file shrank during the read: wanted ${length} bytes at ${position}, got ${buf.length}`);
  }
  return buf;
}

function assertOffset(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
}
