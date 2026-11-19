// Summary fields of one Claude transcript (`projects/<enc>/<sid>.jsonl`), read from the head
// and the tail only. Transcripts reach hundreds of MB, and every field the session list needs
// sits near one of the two ends:
//   - cwd, entrypoint, the first timestamp and the first prompt are written at the start
//     (measured: within the first 21 lines in all 76 transcripts on 2026-11-15)
//   - a running TUI re-appends custom-title and ai-title with every request batch, and a
//     rename of a closed session appends them, so the current names sit near the end
//     (near, not within a fixed window: a tool result or attachment between two batches can
//     push the last title lines megabytes away from the end, see "Titles" below)
//
// Titles: the name is the last custom-title line of the whole file, the title the last ai-title
// line. They are found without parsing every line: a byte search for the `custom-title"` marker
// (the quotes inside a JSON string are escaped, so a raw hit ends a real string), then a parse
// of that one line. The search runs backwards over only the bytes not yet examined:
//   - a file that only grew (same inode, size not smaller) is searched from where the previous
//     read stopped, and the previous values stand when the new bytes hold no title line
//   - any other read searches from the end of the head back to the head, so a title that sits
//     far before the end is found
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export const HEAD_MAX_LINES = 120;
export const TAIL_BYTES = 32 * 1024;
export const PREVIEW_MAX_CHARS = 200;
const CHUNK_BYTES = 64 * 1024;

/**
 * A user line whose text starts with one of these is a wrapper the client or a hook wrote,
 * not a prompt the user typed. Union of the brief's list and an earlier dashboard's preview skip list,
 * plus `<task-notification` (background task results, measured as the first "prompt" of 2
 * transcripts on 2026-11-15).
 */
export const PREVIEW_SKIP_PREFIXES: readonly string[] = [
  "<command-", // <command-name>, <command-message>, <command-args>, <command-stdout>
  "<local-command",
  "<system-reminder",
  "<persisted",
  "<task-notification",
  "Caveat:",
  "[Request interrupted",
  "This session is being continued",
];

export interface TranscriptMeta {
  cwd: string | null;
  /** Last custom-title (the user's name). */
  name: string | null;
  /** Last ai-title (Claude's generated title). */
  title: string | null;
  preview: string | null;
  entrypoint: string | null;
  createdAt: number | null;
  /** File mtime, ms. */
  updatedAt: number;
  sizeBytes: number;
}

/** Facts gathered from one window of lines. "first" fields keep the first value seen. */
interface Facts {
  cwd: string | null;
  entrypoint: string | null;
  firstTimestamp: string | null;
  preview: string | null;
  /** undefined: no custom-title line in the window. */
  customTitle: string | undefined;
  aiTitle: string | undefined;
}

/**
 * The last custom-title and ai-title of the file up to byte `scannedTo` (just past the last
 * complete line examined). A later read of the same, grown file continues from `scannedTo`.
 */
export interface TitleScan {
  scannedTo: number;
  /** undefined: no custom-title line in [0, scannedTo). */
  customTitle: string | undefined;
  aiTitle: string | undefined;
}

/** One read of a transcript. Passed back as `prev` so the next read can skip work. */
export interface MetaCacheEntry {
  ino: number;
  birthtimeMs: number;
  mtimeMs: number;
  size: number;
  head: Facts;
  titles: TitleScan;
  /** Byte offset just past the last complete head line. */
  headEnd: number;
  /**
   * The head holds HEAD_MAX_LINES complete lines. Transcripts are append-only, so such a
   * head stays the same while the same file keeps growing, and the next read reuses it.
   */
  headComplete: boolean;
  meta: TranscriptMeta;
}

/** Cumulative counters, shared with the source's stats(). */
export interface ReadCounters {
  /** Transcript reads that touched the file content. */
  metaReads: number;
  /** Reads answered from the cache (same inode, mtime and size). */
  cacheHits: number;
  /** Reads that reused the head of a grown file and read only the tail. */
  headReuses: number;
  /** Bytes read from transcripts, head and tail together. */
  bytesRead: number;
  /** Complete lines that failed to parse as a JSON object. */
  badJsonLines: number;
  /** Unterminated last lines that failed to parse (usually a write in progress). */
  partialLines: number;
  /** Tail windows that held no complete line (one line longer than TAIL_BYTES at the end). */
  tailsWithoutLine: number;
}

export function newReadCounters(): ReadCounters {
  return {
    metaReads: 0,
    cacheHits: 0,
    headReuses: 0,
    bytesRead: 0,
    badJsonLines: 0,
    partialLines: 0,
    tailsWithoutLine: 0,
  };
}

function emptyFacts(): Facts {
  return {
    cwd: null,
    entrypoint: null,
    firstTimestamp: null,
    preview: null,
    customTitle: undefined,
    aiTitle: undefined,
  };
}

/**
 * Read the summary fields of a transcript. Returns null when the file does not exist (deleted
 * or moved between the event and the read). Other I/O errors are thrown.
 */
export async function readTranscriptMeta(
  file: string,
  prev: MetaCacheEntry | undefined,
  counters: ReadCounters,
): Promise<MetaCacheEntry | null> {
  let fh: FileHandle;
  try {
    fh = await fs.open(file, "r");
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  try {
    const st = await fh.stat();
    const sameFile = prev !== undefined && prev.ino === st.ino && prev.birthtimeMs === st.birthtimeMs;
    if (sameFile && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      counters.cacheHits++;
      return prev;
    }
    counters.metaReads++;
    // Reads stop at the size seen by this stat. Bytes appended meanwhile trigger another
    // change event and another read.
    const size = st.size;

    let head: Facts;
    let headEnd: number;
    let headComplete: boolean;
    if (sameFile && prev.headComplete && size >= prev.size) {
      counters.headReuses++;
      head = prev.head;
      headEnd = prev.headEnd;
      headComplete = true;
    } else {
      head = emptyFacts();
      const seg = await readLines(fh, 0, size, HEAD_MAX_LINES, counters);
      for (const line of seg.lines) absorbLine(line, head, counters, false);
      if (seg.rest !== null) absorbLine(seg.rest, head, counters, true);
      headEnd = seg.end;
      headComplete = seg.lines.length >= HEAD_MAX_LINES;
    }

    // Without a complete head, the head read ran to the end of the file: it saw every line and
    // its last titles are the file's last titles.
    let tail = emptyFacts();
    let titles: TitleScan = { scannedTo: headEnd, customTitle: head.customTitle, aiTitle: head.aiTitle };
    if (headComplete && size > headEnd) {
      // The tail only backs up cwd and entrypoint, so it is read only when the head lacks one.
      if (head.cwd === null || head.entrypoint === null) tail = await readTail(fh, headEnd, size, counters);
      const grown = sameFile && size >= prev.size;
      // A grown file continues from the previous scan, anything else starts at the head's end.
      const base: TitleScan = grown ? prev.titles : titles;
      titles = await scanTitles(fh, base, size, counters);
    }

    const name = titles.customTitle ? titles.customTitle : null;
    const title = titles.aiTitle ? titles.aiTitle : null;
    const created = head.firstTimestamp === null ? NaN : Date.parse(head.firstTimestamp);
    const meta: TranscriptMeta = {
      // cwd and entrypoint fall back to the tail only when the head lacks them. createdAt and
      // preview mean "first", which only the head can tell.
      cwd: head.cwd ?? tail.cwd,
      name,
      title,
      preview: head.preview,
      entrypoint: head.entrypoint ?? tail.entrypoint,
      createdAt: Number.isNaN(created) ? null : created,
      updatedAt: Math.floor(st.mtimeMs),
      sizeBytes: size,
    };
    return {
      ino: st.ino,
      birthtimeMs: st.birthtimeMs,
      mtimeMs: st.mtimeMs,
      size,
      head,
      titles,
      headEnd,
      headComplete,
      meta,
    };
  } finally {
    await fh.close();
  }
}

/** The first chunk of a backward search; each next chunk doubles, up to the max (a read size, not a limit on how far back the search goes). */
const TITLE_SCAN_FIRST_CHUNK = 16 * 1024;
const TITLE_SCAN_MAX_CHUNK = 2 * 1024 * 1024;
const LINE_PROBE_BYTES = 4 * 1024;
// The type name with its closing quote, so `"type":"ai-title"` and the spaced `"type": "ai-title"`
// (older Claude Code versions) both match. A quote inside a JSON string is escaped (`\"`), so
// the raw bytes occur only where a string ends right after the name; the line parse decides.
const CUSTOM_MARKER = Buffer.from('custom-title"');
const AI_MARKER = Buffer.from('ai-title"');

/**
 * The last custom-title and ai-title in [base.scannedTo, size), falling back to base's values
 * for the one the range lacks. An empty custom-title is a value (it clears the name).
 */
async function scanTitles(fh: FileHandle, base: TitleScan, size: number, counters: ReadCounters): Promise<TitleScan> {
  const from = base.scannedTo;
  let customTitle = base.customTitle;
  let aiTitle = base.aiTitle;
  let foundCustom = false;
  let foundAi = false;
  let lineEnd: number | undefined;
  const overlap = Math.max(CUSTOM_MARKER.length, AI_MARKER.length) - 1;
  const buf = Buffer.allocUnsafe(Math.min(size - from, TITLE_SCAN_MAX_CHUNK) + overlap);
  let end = size;
  let chunk = TITLE_SCAN_FIRST_CHUNK;
  while (end > from && (!foundCustom || !foundAi || lineEnd === undefined)) {
    const start = Math.max(from, end - chunk);
    chunk = Math.min(chunk * 2, TITLE_SCAN_MAX_CHUNK);
    // Read past `end` by the overlap so a marker that straddles `end` is whole in the buffer.
    // Markers that begin at or after `end` were handled with the later chunk.
    const readEnd = Math.min(size, end + overlap);
    const n = await readFully(fh, buf, start, readEnd, counters);
    const own = Math.min(end - start, n);
    if (lineEnd === undefined && own > 0) {
      const nl = buf.subarray(0, own).lastIndexOf(10);
      if (nl !== -1) lineEnd = start + nl + 1;
    }
    if (!foundCustom) {
      const v = await lastTitleIn(fh, buf, n, own, start, CUSTOM_MARKER, "custom-title", "customTitle", from, size, counters);
      if (v !== undefined) {
        customTitle = v;
        foundCustom = true;
      }
    }
    if (!foundAi) {
      const v = await lastTitleIn(fh, buf, n, own, start, AI_MARKER, "ai-title", "aiTitle", from, size, counters);
      if (v !== undefined) {
        aiTitle = v;
        foundAi = true;
      }
    }
    end = start;
  }
  // No newline in the range: nothing in it is complete yet, so the next read starts over here.
  return { scannedTo: lineEnd ?? from, customTitle, aiTitle };
}

/** Read [start, end) into buf, returning the byte count (fewer only if the file shrank). */
async function readFully(fh: FileHandle, buf: Buffer, start: number, end: number, counters: ReadCounters): Promise<number> {
  let got = 0;
  while (start + got < end) {
    const { bytesRead } = await fh.read(buf, got, end - start - got, start + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  counters.bytesRead += got;
  return got;
}

/**
 * The value of the last line in buf[0, own) (file offset `base`) whose top-level `type` is
 * `type`, or undefined. `n` is the valid length of buf, which may run past `own`.
 */
async function lastTitleIn(
  fh: FileHandle,
  buf: Buffer,
  n: number,
  own: number,
  base: number,
  marker: Buffer,
  type: string,
  field: string,
  from: number,
  size: number,
  counters: ReadCounters,
): Promise<string | undefined> {
  let at = own - 1;
  while (at >= 0) {
    const i = buf.subarray(0, n).lastIndexOf(marker, at);
    if (i === -1) return undefined;
    const line = await readLineAround(fh, base + i, marker.length, from, size, counters);
    if (line !== null) {
      try {
        const o: unknown = JSON.parse(line);
        if (typeof o === "object" && o !== null && !Array.isArray(o)) {
          const r = o as Record<string, unknown>;
          if (r.type === type && typeof r[field] === "string") return r[field];
        }
      } catch {
        // an unterminated last line still being written, or a line that only quotes the marker
      }
    }
    at = i - 1;
  }
  return undefined;
}

/** The whole line holding the byte offset `pos` (lines never start before `from`). */
async function readLineAround(
  fh: FileHandle,
  pos: number,
  markerLen: number,
  from: number,
  size: number,
  counters: ReadCounters,
): Promise<string | null> {
  const probe = Buffer.allocUnsafe(LINE_PROBE_BYTES);
  let lineStart = from;
  for (let hi = pos; hi > from; ) {
    const lo = Math.max(from, hi - LINE_PROBE_BYTES);
    const n = await readFully(fh, probe, lo, hi, counters);
    const nl = probe.subarray(0, n).lastIndexOf(10);
    if (nl !== -1) {
      lineStart = lo + nl + 1;
      break;
    }
    hi = lo;
  }
  let lineEnd = size;
  for (let lo = pos + markerLen; lo < size; ) {
    const hi = Math.min(size, lo + LINE_PROBE_BYTES);
    const n = await readFully(fh, probe, lo, hi, counters);
    const nl = probe.subarray(0, n).indexOf(10);
    if (nl !== -1) {
      lineEnd = lo + nl;
      break;
    }
    lo = hi;
  }
  const out = Buffer.allocUnsafe(lineEnd - lineStart);
  const n = await readFully(fh, out, lineStart, lineEnd, counters);
  return n === out.length ? out.toString("utf8") : null;
}

async function readTail(fh: FileHandle, headEnd: number, size: number, counters: ReadCounters): Promise<Facts> {
  const facts = emptyFacts();
  const start = Math.max(headEnd, size - TAIL_BYTES);
  if (start === headEnd) {
    // Starts on a line boundary: every line is whole.
    const seg = await readLines(fh, start, size, Infinity, counters);
    for (const line of seg.lines) absorbLine(line, facts, counters, false);
    if (seg.rest !== null) absorbLine(seg.rest, facts, counters, true);
    return facts;
  }
  // Start one byte early: if that byte is a newline, the first line in the window is whole and
  // the dropped "line" below is empty. Otherwise the dropped line is a fragment.
  const seg = await readLines(fh, start - 1, size, Infinity, counters);
  if (seg.lines.length === 0) {
    // One line runs through the whole window; `rest` is a fragment of it.
    counters.tailsWithoutLine++;
    return facts;
  }
  for (const line of seg.lines.slice(1)) absorbLine(line, facts, counters, false);
  if (seg.rest !== null) absorbLine(seg.rest, facts, counters, true);
  if (seg.lines.length === 1 && seg.rest === null) counters.tailsWithoutLine++;
  return facts;
}

interface Segment {
  /** Complete lines without the newline. */
  lines: string[];
  /** Offset just past the last complete line. */
  end: number;
  /** Bytes after the last newline when the read reached `limit` (an unterminated line). */
  rest: string | null;
}

/** Read lines from [start, limit) in chunks, stopping after maxLines complete lines. */
async function readLines(
  fh: FileHandle,
  start: number,
  limit: number,
  maxLines: number,
  counters: ReadCounters,
): Promise<Segment> {
  const lines: string[] = [];
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let pos = start;
  let end = start;
  let parts: Buffer[] = [];
  while (pos < limit && lines.length < maxLines) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK_BYTES, limit - pos), pos);
    if (bytesRead === 0) break; // the file shrank under us
    counters.bytesRead += bytesRead;
    let i = 0;
    while (i < bytesRead && lines.length < maxLines) {
      const nl = buf.indexOf(10, i);
      if (nl === -1 || nl >= bytesRead) {
        // The buffer is reused for the next chunk, so keep a copy of the partial line.
        parts.push(Buffer.from(buf.subarray(i, bytesRead)));
        break;
      }
      parts.push(buf.subarray(i, nl));
      lines.push(Buffer.concat(parts).toString("utf8"));
      parts = [];
      i = nl + 1;
      end = pos + i;
    }
    pos += bytesRead;
  }
  const rest = lines.length < maxLines && parts.length > 0 ? Buffer.concat(parts).toString("utf8") : null;
  return { lines, end, rest };
}

function absorbLine(line: string, facts: Facts, counters: ReadCounters, unterminated: boolean): void {
  if (line.trim() === "") return;
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    if (unterminated) counters.partialLines++;
    else counters.badJsonLines++;
    return;
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) {
    if (unterminated) counters.partialLines++;
    else counters.badJsonLines++;
    return;
  }
  absorbRecord(o as Record<string, unknown>, facts);
}

function absorbRecord(o: Record<string, unknown>, facts: Facts): void {
  if (facts.cwd === null && typeof o.cwd === "string") facts.cwd = o.cwd;
  if (facts.entrypoint === null && typeof o.entrypoint === "string") facts.entrypoint = o.entrypoint;
  if (facts.firstTimestamp === null && typeof o.timestamp === "string") facts.firstTimestamp = o.timestamp;
  if (o.type === "custom-title" && typeof o.customTitle === "string") facts.customTitle = o.customTitle;
  if (o.type === "ai-title" && typeof o.aiTitle === "string") facts.aiTitle = o.aiTitle;
  if (facts.preview === null) {
    const text = userPromptText(o);
    if (text !== null) facts.preview = clip(text, PREVIEW_MAX_CHARS);
  }
}

/** The text the user typed on this line, or null when the line is not a typed prompt. */
export function userPromptText(o: Record<string, unknown>): string | null {
  // isMeta user lines are written by Claude Code itself (local command caveats, skill loads,
  // "Continue from where you left off").
  if (o.type !== "user" || o.isMeta === true) return null;
  const message = o.message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>).content;
  let text: string | null = null;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_result") return null;
      if (text === null && b.type === "text" && typeof b.text === "string") text = b.text;
    }
  }
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  for (const prefix of PREVIEW_SKIP_PREFIXES) {
    if (trimmed.startsWith(prefix)) return null;
  }
  return trimmed;
}

/** First `max` characters by code point, so a surrogate pair is never split. */
function clip(text: string, max: number): string {
  const head = text.slice(0, max * 2);
  const chars = Array.from(head);
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : head;
}

export function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
