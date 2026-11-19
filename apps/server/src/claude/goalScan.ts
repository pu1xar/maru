// The goal_status records of a Claude transcript, read backwards from the end of the file apart
// from the thread's page: a goal set long ago (more than a page of lines back) still needs its set
// record for the time and the number of checks, and a turn with a hundred tool calls writes no
// goal_status line until it ends. The scan stops at the newest record that fixes the goal (a set,
// or a met, failed or clear that ends one), so a session with a recent goal reads little; a
// session that never had one is read whole, which is why the caller runs it after the page is out.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { goalEventOf, type GoalEvent } from "./projection/goalState.ts";

const CHUNK = 1024 * 1024;
const MARKER = Buffer.from('"goal_status"');

export interface GoalScan {
  /** Events from the newest goal boundary to the end, oldest first (empty: no goal_status line in the file). */
  events: GoalEvent[];
  /** Byte offset just after the last complete line: the scan covers the file before it. */
  endOffset: number;
}

/** Bytes a scan read from the file (a test and a log can see what a remembered scan saved). */
export interface ScanIo {
  bytes: number;
}

export async function scanGoalEvents(file: string, io: ScanIo = { bytes: 0 }): Promise<GoalScan> {
  const fh = await fs.open(file, "r");
  try {
    const size = (await fh.stat()).size;
    const endOffset = await endOfLastLine(fh, size, io);
    const found: GoalEvent[] = [];
    let pos = endOffset;
    let carry: Buffer = Buffer.alloc(0);
    scan: while (pos > 0) {
      const start = Math.max(0, pos - CHUNK);
      const chunk = Buffer.allocUnsafe(pos - start);
      await readFull(fh, chunk, start, io);
      const buf = carry.length === 0 ? chunk : Buffer.concat([chunk, carry]);
      // The bytes before the first newline may continue a line that began in the next chunk back.
      let bodyStart = start;
      let body = buf;
      carry = Buffer.alloc(0);
      if (start > 0) {
        const nl = buf.indexOf(10);
        if (nl < 0) {
          carry = buf;
          pos = start;
          continue;
        }
        carry = buf.subarray(0, nl);
        body = buf.subarray(nl + 1);
        bodyStart = start + nl + 1;
      }
      pos = start;
      if (!body.includes(MARKER)) continue;
      let end = body.length;
      if (end > 0 && body[end - 1] === 10) end--;
      for (;;) {
        const nl = end === 0 ? -1 : body.lastIndexOf(10, end - 1);
        const line = body.subarray(nl + 1, end);
        if (line.includes(MARKER)) {
          const event = eventOfLine(line, bodyStart + nl + 1);
          if (event !== null) {
            found.push(event);
            if (event.kind !== "unmet") break scan;
          }
        }
        if (nl < 0) break;
        end = nl;
      }
    }
    return { events: found.reverse(), endOffset };
  } finally {
    await fh.close();
  }
}

function eventOfLine(line: Buffer, offset: number): GoalEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (rec.type !== "attachment" || rec.attachment === null || typeof rec.attachment !== "object") return null;
  return goalEventOf(rec.attachment as Record<string, unknown>, typeof rec.timestamp === "string" ? rec.timestamp : null, offset);
}

/** The offset after the file's last newline (an unfinished last line is left to the follower). */
async function endOfLastLine(fh: fs.FileHandle, size: number, io: ScanIo): Promise<number> {
  let pos = size;
  while (pos > 0) {
    const start = Math.max(0, pos - CHUNK);
    const chunk = Buffer.allocUnsafe(pos - start);
    await readFull(fh, chunk, start, io);
    const nl = chunk.lastIndexOf(10);
    if (nl >= 0) return start + nl + 1;
    pos = start;
  }
  return 0;
}

async function readFull(fh: fs.FileHandle, buf: Buffer, position: number, io: ScanIo): Promise<void> {
  io.bytes += buf.length;
  let got = 0;
  while (got < buf.length) {
    const { bytesRead } = await fh.read(buf, got, buf.length - got, position + got);
    if (bytesRead === 0) throw new Error("the transcript ended while it was scanned");
    got += bytesRead;
  }
}

interface Memo {
  dev: number;
  ino: number;
  scan: GoalScan;
  /** Hash of the first and last 4 KB before scan.endOffset: a file rewritten in place (a rehome changes every line) differs here. */
  seal: string;
}

const SEAL_BYTES = 4096;

/**
 * scanGoalEvents with a memory per file: the next scan of an unchanged-so-far file reads only what
 * was appended after the last scan's endOffset and joins it to the remembered events. A file that
 * is another file (dev or ino), shorter than the remembered end, or whose first or last bytes before
 * that end differ was rewritten, and is scanned whole again. What is remembered per file is the
 * events since its newest goal boundary (a set and one record per check, each with the evaluator's
 * reason) and a hash: it grows with the checks of a goal in progress and not with the file.
 */
export class GoalScanner {
  private readonly memo = new Map<string, Memo>();

  async scan(file: string, io: ScanIo = { bytes: 0 }): Promise<GoalScan> {
    const fh = await fs.open(file, "r");
    let stat;
    try {
      stat = await fh.stat();
      const m = this.memo.get(file);
      if (m !== undefined && m.dev === stat.dev && m.ino === stat.ino && stat.size >= m.scan.endOffset && (await seal(fh, m.scan.endOffset, io)) === m.seal) {
        const grown = await readForward(fh, m.scan.endOffset, stat.size, io);
        const events = trimToBoundary([...m.scan.events, ...grown.events]);
        const scan = { events, endOffset: grown.endOffset };
        this.memo.set(file, { dev: stat.dev, ino: stat.ino, scan, seal: await seal(fh, scan.endOffset, io) });
        return scan;
      }
    } finally {
      await fh.close();
    }
    const scan = await scanGoalEvents(file, io);
    const again = await fs.open(file, "r");
    try {
      // The seal of the end the scan reported; a file that changed meanwhile is rescanned next time.
      this.memo.set(file, { dev: stat.dev, ino: stat.ino, scan, seal: await seal(again, scan.endOffset, io) });
    } finally {
      await again.close();
    }
    return scan;
  }
}

/** The events from the newest boundary (a set, met, failed or clear) on; all of them when there is none. */
function trimToBoundary(events: GoalEvent[]): GoalEvent[] {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.kind !== "unmet") return events.slice(i);
  return events;
}

async function seal(fh: fs.FileHandle, end: number, io: ScanIo): Promise<string> {
  const h = createHash("sha1");
  const head = Buffer.allocUnsafe(Math.min(SEAL_BYTES, end));
  await readFull(fh, head, 0, io);
  h.update(head);
  const tailLen = Math.min(SEAL_BYTES, end);
  const tail = Buffer.allocUnsafe(tailLen);
  await readFull(fh, tail, end - tailLen, io);
  h.update(tail);
  return h.digest("hex");
}

/** The goal events of the complete lines in [from, size), and where the last complete line ends. */
async function readForward(fh: fs.FileHandle, from: number, size: number, io: ScanIo): Promise<GoalScan> {
  const events: GoalEvent[] = [];
  let pos = from;
  let carry: Buffer = Buffer.alloc(0);
  let carryStart = from;
  while (pos < size) {
    const len = Math.min(CHUNK, size - pos);
    const chunk = Buffer.allocUnsafe(len);
    await readFull(fh, chunk, pos, io);
    const buf = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(10, start);
      if (nl < 0) break;
      const line = buf.subarray(start, nl);
      if (line.includes(MARKER)) {
        const e = eventOfLine(line, carryStart + start);
        if (e !== null) events.push(e);
      }
      start = nl + 1;
    }
    carryStart += start;
    carry = buf.subarray(start);
    pos += len;
  }
  return { events, endOffset: carryStart };
}
