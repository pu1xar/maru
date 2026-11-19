import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CHUNK_BYTES,
  PARSE_ERROR_RAW_CHARS,
  followTranscript,
  isParseError,
  readRange,
  readTail,
  subagentTranscriptPath,
} from "./claudeTranscript.ts";
import type { FollowOptions, Page, RawRecord, ResetInfo } from "./claudeTranscript.ts";

// ---- helpers ----

/**
 * Every follower a test starts, stopped after the test even when it fails: a follower's timer
 * and watcher would otherwise keep the test process alive and hang the whole run.
 */
const live = new Set<() => void>();
afterEach(() => {
  for (const stop of live) stop();
  live.clear();
});

/** Temp dirs of this file, removed after its tests (some tests write over 10MB). */
const tmpDirs: string[] = [];
after(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function tmpFile(name = "s.jsonl"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "transcript-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}

const jl = (objs: unknown[]): string => objs.map((o) => JSON.stringify(o) + "\n").join("");

interface RefLine {
  offset: number;
  length: number;
  text: string;
}

/**
 * Reference split, independent of the reader: every newline-terminated line of the whole
 * buffer, by a plain forward scan. The unterminated tail is not a line.
 */
function refLines(buf: Buffer): RefLine[] {
  const out: RefLine[] = [];
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(10, start);
    if (nl === -1) return out;
    out.push({ offset: start, length: nl - start + 1, text: buf.subarray(start, nl).toString("utf8") });
    start = nl + 1;
  }
}

function refValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { __parseError: true, raw: Array.from(text).slice(0, PARSE_ERROR_RAW_CHARS).join("") };
  }
}

/** Compare records with reference lines: offset, length and value of each. */
function assertSameLines(records: RawRecord[], ref: RefLine[], label: string): void {
  assert.equal(records.length, ref.length, `${label}: record count`);
  for (let i = 0; i < ref.length; i++) {
    const r = records[i]!;
    const e = ref[i]!;
    assert.equal(r.offset, e.offset, `${label}: offset of #${i}`);
    assert.equal(r.length, e.length, `${label}: length of #${i}`);
    assert.deepEqual(r.value, refValue(e.text), `${label}: value of #${i}`);
  }
}

/** Page backwards from the end until the start; return all records oldest first and the pages. */
async function pageAll(file: string, maxRecords: number, beforeOffset?: number): Promise<{ records: RawRecord[]; pages: Page[] }> {
  const pages: Page[] = [];
  let before = beforeOffset;
  for (;;) {
    const page = await readTail(file, before === undefined ? { maxRecords } : { maxRecords, beforeOffset: before });
    pages.push(page);
    assert.ok(page.records.length <= maxRecords);
    if (!page.hasMoreBefore) break;
    assert.ok(page.records.length === maxRecords, "a page that is not the last is full");
    before = page.startOffset;
  }
  pages.reverse();
  // Pages must abut: each page ends where the next (newer) page starts.
  for (let i = 1; i < pages.length; i++) {
    assert.equal(pages[i]!.startOffset, pages[i - 1]!.endOffset, `page ${i} starts where page ${i - 1} ends`);
  }
  return { records: pages.flatMap((p) => p.records), pages };
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixed content: short and huge JSON lines, blank lines, broken lines, non-object JSON, Korean. */
function mixedContent(seed: number, lines: number): string {
  const r = rng(seed);
  let s = "";
  for (let i = 0; i < lines; i++) {
    const k = r();
    if (k < 0.04) s += "\n";
    else if (k < 0.08) s += "{not json " + "깨".repeat(Math.floor(r() * 300)) + "\n";
    else if (k < 0.1) s += "[1,2,3]\n";
    else if (k < 0.14) s += JSON.stringify({ i, big: "y".repeat(CHUNK_BYTES + Math.floor(r() * CHUNK_BYTES * 3)) }) + "\n";
    else s += JSON.stringify({ i, type: "assistant", text: "한글 text ".repeat(Math.floor(r() * 400)) }) + "\n";
  }
  return s;
}

async function waitFor(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

interface Collected {
  /** Records since the last reset (a reset clears them, as a screen would). */
  records: RawRecord[];
  batches: number;
  resets: ResetInfo[];
  errors: unknown[];
}

function follow(file: string, from: number, extra: FollowOptions = {}): { c: Collected; stop: () => void } {
  const c: Collected = { records: [], batches: 0, resets: [], errors: [] };
  const f = followTranscript(
    file,
    from,
    (rs) => {
      c.batches++;
      c.records.push(...rs);
    },
    {
      debounceMs: 10,
      pollMs: 50,
      onReset: (info) => {
        c.resets.push(info);
        c.records = [];
      },
      onError: (err) => c.errors.push(err),
      ...extra,
    },
  );
  live.add(() => f.stop());
  return { c, stop: () => f.stop() };
}

// ---- readTail ----

test("readTail: small file, all records, tiling, offsets and values", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([{ a: 1 }, { b: "두 번째" }, { c: [1, 2] }]));
  const buf = await fs.readFile(file);
  const page = await readTail(file, { maxRecords: 10 });
  assertSameLines(page.records, refLines(buf), "small");
  assert.equal(page.startOffset, 0);
  assert.equal(page.endOffset, buf.length);
  assert.equal(page.hasMoreBefore, false);
  assert.ok(page.records.every((r) => r.line === null), "a tail read does not know line numbers");
});

test("readTail: a 1MB line across chunk boundaries is assembled whole", async () => {
  const file = await tmpFile();
  const big = { type: "user", blob: "z".repeat(1024 * 1024), tail: "끝" };
  await fs.writeFile(file, jl([{ n: 1 }, big, { n: 2 }]));
  const buf = await fs.readFile(file);
  const page = await readTail(file, { maxRecords: 100 });
  assertSameLines(page.records, refLines(buf), "1MB");
  assert.deepEqual(page.records[1]!.value, big);

  // The page that ends right after the big line holds just that line.
  const one = await readTail(file, { maxRecords: 1, beforeOffset: page.records[2]!.offset });
  assert.equal(one.records.length, 1);
  assert.deepEqual(one.records[0]!.value, big);
  assert.equal(one.startOffset, page.records[1]!.offset);
  assert.equal(one.hasMoreBefore, true);
});

test("readTail: newline exactly at, before and after a chunk boundary", async () => {
  // The last line is CHUNK_BYTES + delta bytes long, which puts the newline before it at
  // chunk-relative positions 1, 0, -1, -2, -3 of the first backwards chunk.
  for (let delta = -2; delta <= 2; delta++) {
    const file = await tmpFile();
    const lastLen = CHUNK_BYTES + delta; // including its newline
    const emptyLen = JSON.stringify({ p: "" }).length; // `{"p":""}`
    const lastLine = JSON.stringify({ p: "x".repeat(lastLen - 1 - emptyLen) }) + "\n";
    assert.equal(Buffer.byteLength(lastLine), lastLen);
    await fs.writeFile(file, jl([{ first: 1 }, { second: 2 }]) + lastLine);
    const buf = await fs.readFile(file);
    for (const maxRecords of [1, 2, 3]) {
      const { records } = await pageAll(file, maxRecords);
      assertSameLines(records, refLines(buf), `delta ${delta} max ${maxRecords}`);
    }
  }
});

test("readTail: an unterminated last line is not part of the page", async () => {
  const file = await tmpFile();
  const done = jl([{ a: 1 }, { b: 2 }]);
  await fs.writeFile(file, done + '{"c":3, "partial": "only half');
  const page = await readTail(file, { maxRecords: 10 });
  assert.equal(page.records.length, 2);
  assert.equal(page.endOffset, Buffer.byteLength(done));
  assert.deepEqual(
    page.records.map((r) => r.value),
    [{ a: 1 }, { b: 2 }],
  );
});

test("readTail: broken and blank lines are records with __parseError and raw clipped to 200 chars", async () => {
  const file = await tmpFile();
  const longBroken = "{" + "😀".repeat(300); // surrogate pairs: clipping must not split one
  await fs.writeFile(file, ['{"ok":1}', "not json", "", longBroken, "[1,2]", "42", '"str"', '{"ok":2}'].join("\n") + "\n");
  const page = await readTail(file, { maxRecords: 100 });
  assert.equal(page.records.length, 8, "one record per newline");
  const v = page.records.map((r) => r.value);
  assert.deepEqual(v[0], { ok: 1 });
  assert.deepEqual(v[1], { __parseError: true, raw: "not json" });
  assert.deepEqual(v[2], { __parseError: true, raw: "" });
  assert.ok(isParseError(v[3]));
  assert.equal(Array.from((v[3] as { raw: string }).raw).length, 200);
  assert.equal((v[3] as { raw: string }).raw, "{" + "😀".repeat(199));
  assert.deepEqual(v[4], [1, 2], "valid JSON that is not an object is a value, not an error");
  assert.equal(v[5], 42);
  assert.equal(v[6], "str");
  assert.equal(page.records.filter((r) => isParseError(r.value)).length, 3);
});

test("readTail: paging backwards covers every line exactly once (mixed content, many page sizes)", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, mixedContent(7, 400) + '{"in":"progress"');
  const buf = await fs.readFile(file);
  const ref = refLines(buf);
  assert.ok(buf.length > 8 * CHUNK_BYTES, `content spans many chunks (${buf.length} bytes)`);
  for (const maxRecords of [1, 3, 7, 50, 1000]) {
    const { records, pages } = await pageAll(file, maxRecords);
    assertSameLines(records, ref, `max ${maxRecords}`);
    assert.equal(pages[0]!.startOffset, 0);
    assert.equal(pages[pages.length - 1]!.endOffset, ref[ref.length - 1]!.offset + ref[ref.length - 1]!.length);
  }
});

test("readTail: file starting with a newline, empty file, file without any newline", async () => {
  const a = await tmpFile();
  await fs.writeFile(a, "\n" + jl([{ x: 1 }]));
  assertSameLines((await pageAll(a, 1)).records, refLines(await fs.readFile(a)), "leading newline");

  const b = await tmpFile();
  await fs.writeFile(b, "");
  assert.deepEqual(await readTail(b, { maxRecords: 5 }), { records: [], startOffset: 0, endOffset: 0, hasMoreBefore: false });

  const c = await tmpFile();
  await fs.writeFile(c, '{"never":"terminated"' + "q".repeat(CHUNK_BYTES * 2));
  assert.deepEqual(await readTail(c, { maxRecords: 5 }), { records: [], startOffset: 0, endOffset: 0, hasMoreBefore: false });
});

test("readTail: beforeOffset inside a line ends the page at the line before it", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([{ a: 1 }, { b: 2 }, { c: 3 }]));
  const all = await readTail(file, { maxRecords: 10 });
  const cut = all.records[2]!.offset + 3; // inside the third line
  const page = await readTail(file, { maxRecords: 10, beforeOffset: cut });
  assert.deepEqual(
    page.records.map((r) => r.value),
    [{ a: 1 }, { b: 2 }],
  );
  assert.equal(page.endOffset, all.records[2]!.offset);
});

test("readTail: reads about one page of bytes, not the file", async () => {
  const file = await tmpFile();
  const line = JSON.stringify({ pad: "p".repeat(1000) }) + "\n";
  const tenMB = line.repeat(Math.ceil((10 * 1024 * 1024) / line.length));
  const big = JSON.stringify({ last: "L".repeat(1024 * 1024) }) + "\n";
  await fs.writeFile(file, tenMB + big);
  const stats = { bytesRead: 0 };
  const page = await readTail(file, { maxRecords: 10, stats });
  assert.equal(page.records.length, 10);
  // the 1MB last line (5 chunks) plus the chunk that holds the 9 short lines before it
  assert.ok(stats.bytesRead <= Buffer.byteLength(big) + 2 * CHUNK_BYTES, `read ${stats.bytesRead} bytes`);
});

test("readTail: invalid arguments throw", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([{ a: 1 }]));
  await assert.rejects(readTail(file, { maxRecords: 0 }), RangeError);
  await assert.rejects(readTail(file, { maxRecords: 1.5 }), RangeError);
  await assert.rejects(readTail(file, { maxRecords: 1, beforeOffset: 10_000 }), RangeError);
  await assert.rejects(readTail(file, { maxRecords: 1, beforeOffset: -1 }), RangeError);
  await assert.rejects(readTail(file + ".missing", { maxRecords: 1 }), { code: "ENOENT" });
});

// ---- readRange ----

test("readRange: exact ranges, line numbers from offset 0, cut lines at either end", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, mixedContent(11, 120) + '{"partial":');
  const buf = await fs.readFile(file);
  const ref = refLines(buf);

  const whole = await readRange(file, 0, buf.length);
  assertSameLines(whole, ref, "whole");
  assert.deepEqual(
    whole.map((r) => r.line),
    ref.map((_, i) => i + 1),
    "1-based line numbers from offset 0",
  );

  // From a record offset: same records, line unknown.
  const from = ref[40]!.offset;
  const to = ref[60]!.offset;
  const mid = await readRange(file, from, to);
  assertSameLines(mid, ref.slice(40, 60), "mid");
  assert.ok(mid.every((r) => r.line === null));

  // Start inside line 40 and end inside line 60: both cut lines are left out.
  const cut = await readRange(file, from + 1, to + 1);
  assertSameLines(cut, ref.slice(41, 60), "cut");

  // end past the end of the file reads to the end; empty ranges are empty.
  assertSameLines(await readRange(file, ref[100]!.offset, buf.length + 1000), ref.slice(100), "past end");
  assert.deepEqual(await readRange(file, 5, 5), []);
  assert.deepEqual(await readRange(file, buf.length + 10, buf.length + 20), []);
  await assert.rejects(readRange(file, 10, 5), RangeError);
});

test("readRange: newline exactly at a forward chunk boundary", async () => {
  for (let delta = -2; delta <= 2; delta++) {
    const file = await tmpFile();
    const firstLen = CHUNK_BYTES + delta;
    const firstLine = JSON.stringify({ p: "x".repeat(firstLen - 1 - '{"p":""}'.length) }) + "\n";
    await fs.writeFile(file, firstLine + jl([{ a: 1 }, { b: 2 }]));
    const buf = await fs.readFile(file);
    assertSameLines(await readRange(file, 0, buf.length), refLines(buf), `delta ${delta}`);
  }
});

// ---- followTranscript ----

test("follow: appended lines arrive with offsets; lines already past fromOffset come first", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([{ n: 0 }, { n: 1 }]));
  const page = await readTail(file, { maxRecords: 1, beforeOffset: Buffer.byteLength(jl([{ n: 0 }])) });
  const f = follow(file, page.endOffset);
  try {
    await waitFor(() => f.c.records.length === 1, "the line already past fromOffset");
    assert.deepEqual(f.c.records[0]!.value, { n: 1 });
    await fs.appendFile(file, jl([{ n: 2 }, { n: 3 }]));
    await waitFor(() => f.c.records.length === 3, "appended lines");
    assertSameLines(f.c.records, refLines(await fs.readFile(file)).slice(1), "follow");
    assert.ok(f.c.records.every((r) => r.line === null), "line numbers are unknown from a non-zero offset");
    assert.deepEqual(f.c.resets, []);
    assert.deepEqual(f.c.errors, []);
  } finally {
    f.stop();
  }
});

test("follow: from offset 0 numbers lines; a partial write is held until its newline", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, "");
  const f = follow(file, 0);
  try {
    await fs.appendFile(file, jl([{ n: 1 }]) + '{"n":2,"text":"반쯤');
    await waitFor(() => f.c.records.length === 1, "first line");
    await sleep(300); // several polls and watch events
    assert.equal(f.c.records.length, 1, "the unterminated line is not handed out");
    await fs.appendFile(file, ' 씀"}\n');
    await waitFor(() => f.c.records.length === 2, "completed line");
    assert.deepEqual(f.c.records[1]!.value, { n: 2, text: "반쯤 씀" });
    assert.deepEqual(
      f.c.records.map((r) => r.line),
      [1, 2],
    );
    assertSameLines(f.c.records, refLines(await fs.readFile(file)), "partial");
    assert.deepEqual(f.c.errors, []);
  } finally {
    f.stop();
  }
});

test("follow: a 1MB line written in pieces arrives once, whole", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([{ head: 1 }]));
  const start = (await fs.stat(file)).size;
  const f = follow(file, start);
  try {
    const line = JSON.stringify({ big: "b".repeat(1024 * 1024) }) + "\n";
    const fh = await fs.open(file, "a");
    for (let i = 0; i < line.length; i += 300 * 1024) {
      await fh.write(line.slice(i, i + 300 * 1024));
      await sleep(30);
    }
    await fh.close();
    await waitFor(() => f.c.records.length === 1, "the big line");
    await sleep(150);
    assert.equal(f.c.records.length, 1);
    assert.equal(f.c.records[0]!.offset, start);
    assert.equal(f.c.records[0]!.length, Buffer.byteLength(line));
    assert.ok(!isParseError(f.c.records[0]!.value));
  } finally {
    f.stop();
  }
});

test("follow: truncation resets and restarts from offset 0", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([{ old: 1 }, { old: 2 }]));
  const f = follow(file, (await fs.stat(file)).size);
  try {
    await sleep(100);
    await fs.truncate(file, 0);
    await waitFor(() => f.c.resets.length === 1, "reset after truncate");
    assert.equal(f.c.resets[0]!.reason, "truncated");
    await fs.appendFile(file, jl([{ fresh: 1 }, { fresh: 2 }]));
    await waitFor(() => f.c.records.length === 2, "lines of the new content");
    assertSameLines(f.c.records, refLines(await fs.readFile(file)), "after truncate");
    assert.deepEqual(
      f.c.records.map((r) => r.line),
      [1, 2],
    );
    assert.equal(f.c.resets.length, 1);
  } finally {
    f.stop();
  }
});

test("follow: an in-place overwrite that never shrinks the file resets as rewritten", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([{ old: 1 }]));
  const f = follow(file, (await fs.stat(file)).size);
  try {
    await sleep(100);
    // Same inode, written over from offset 0 without truncating: the size only grows, and the
    // byte before the old follow position is no longer a newline.
    const fh = await fs.open(file, "r+");
    await fh.write(jl([{ rewritten: "x".repeat(50) }, { rewritten: 2 }]), 0);
    await fh.close();
    await waitFor(() => f.c.records.length === 2, "the rewritten content from 0");
    assert.deepEqual(f.c.resets, [{ reason: "rewritten" }]);
    assertSameLines(f.c.records, refLines(await fs.readFile(file)), "rewrite");
  } finally {
    f.stop();
  }
});

test("follow: delete and recreate resets once and follows the new file", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([{ old: 1 }, { old: 2 }]));
  const f = follow(file, (await fs.stat(file)).size);
  try {
    await sleep(100);
    await fs.unlink(file);
    await fs.writeFile(file, jl([{ new: 1 }, { new: 2 }, { new: 3 }]));
    await waitFor(() => f.c.records.length === 3, "lines of the recreated file");
    await sleep(150);
    assert.equal(f.c.resets.length, 1, JSON.stringify(f.c.resets));
    assert.ok(["missing", "replaced"].includes(f.c.resets[0]!.reason));
    assertSameLines(f.c.records, refLines(await fs.readFile(file)), "recreated");
    // The new file is watched too.
    await fs.appendFile(file, jl([{ new: 4 }]));
    await waitFor(() => f.c.records.length === 4, "append to the recreated file");
  } finally {
    f.stop();
  }
});

test("follow: moved away (rehome) resets as missing; a file appearing later is read from 0", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([{ a: 1 }]));
  const f = follow(file, (await fs.stat(file)).size);
  try {
    await sleep(100);
    await fs.rename(file, file + ".moved");
    await waitFor(() => f.c.resets.length === 1, "reset after the move");
    assert.equal(f.c.resets[0]!.reason, "missing");
    await sleep(150);
    await fs.writeFile(file, jl([{ back: 1 }]));
    await waitFor(() => f.c.records.length === 1, "the file at the path again");
    assert.equal(f.c.resets.length, 1, "no second reset when the path is filled again");
    assert.equal(f.c.records[0]!.offset, 0);
    assert.equal(f.c.records[0]!.line, 1);
  } finally {
    f.stop();
  }
});

test("follow: the poll alone delivers when watch events are not acted on", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, "");
  // A debounce longer than the test leaves only the 50ms poll to read.
  const f = follow(file, 0, { debounceMs: 60_000 });
  try {
    await fs.appendFile(file, jl([{ polled: 1 }]));
    await waitFor(() => f.c.records.length === 1, "a record through the poll", 2000);
  } finally {
    f.stop();
  }
});

test("follow: fs.watch alone delivers, and re-watches a file replaced by rename", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, "");
  // A poll longer than the test leaves only fs.watch to trigger reads.
  const f = follow(file, 0, { pollMs: 60_000 });
  try {
    await sleep(50); // the first read has opened the file and started the watcher
    await fs.appendFile(file, jl([{ watched: 1 }]));
    await waitFor(() => f.c.records.length === 1, "a record through fs.watch", 2000);
    // Atomic replace: the watcher on the old inode reports a rename.
    await fs.writeFile(file + ".tmp", jl([{ replaced: 1 }]));
    await fs.rename(file + ".tmp", file);
    await waitFor(() => f.c.resets.length === 1 && f.c.records.length === 1, "reset and the new file", 2000);
    assert.equal(f.c.resets[0]!.reason, "replaced");
    await fs.appendFile(file, jl([{ replaced: 2 }]));
    await waitFor(() => f.c.records.length === 2, "an append to the new inode through fs.watch", 2000);
  } finally {
    f.stop();
  }
});

test("follow: fromOffset past the end of the file, or a missing file, resets", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([{ a: 1 }]));
  const f = follow(file, 10_000);
  try {
    await waitFor(() => f.c.records.length === 1, "the file from 0");
    assert.equal(f.c.resets[0]!.reason, "truncated");
  } finally {
    f.stop();
  }
  const gone = await tmpFile("gone.jsonl");
  const g = follow(gone, 500);
  try {
    await waitFor(() => g.c.resets.length === 1, "reset for a missing file");
    assert.equal(g.c.resets[0]!.reason, "missing");
    await fs.writeFile(gone, jl([{ created: 1 }]));
    await waitFor(() => g.c.records.length === 1, "the created file from 0");
  } finally {
    g.stop();
  }
});

test("follow: no callbacks after stop", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, "");
  const f = follow(file, 0);
  await fs.appendFile(file, jl([{ a: 1 }]));
  await waitFor(() => f.c.records.length === 1, "first record");
  f.stop();
  await fs.appendFile(file, jl([{ b: 2 }]));
  await fs.truncate(file, 0);
  await sleep(250);
  assert.equal(f.c.records.length, 1);
  assert.equal(f.c.resets.length, 0);
});

test("follow: stop during a long read hands out nothing more", async () => {
  const file = await tmpFile();
  const line = JSON.stringify({ pad: "p".repeat(1000) }) + "\n";
  await fs.writeFile(file, line.repeat(8000)); // ~8MB, about 32 chunk reads
  let batches = 0;
  let atStop = -1;
  const f = followTranscript(
    file,
    0,
    () => {
      batches++;
      // Stop from outside the callback, while the next chunk read is in flight.
      if (batches === 1)
        setImmediate(() => {
          atStop = batches;
          f.stop();
        });
    },
    { debounceMs: 10, pollMs: 50 },
  );
  live.add(() => f.stop());
  await waitFor(() => atStop !== -1, "stop");
  await sleep(200);
  assert.ok(atStop < 32, `stopped after ${atStop} batches, before the read finished`);
  assert.equal(batches, atStop, "no batch after stop");
});

test("follow: an error thrown by onRecords is reported and following continues", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, "");
  const errors: unknown[] = [];
  const got: RawRecord[] = [];
  let first = true;
  const f = followTranscript(
    file,
    0,
    (rs) => {
      got.push(...rs);
      if (first) {
        first = false;
        throw new Error("consumer bug");
      }
    },
    { debounceMs: 10, pollMs: 50, onError: (e) => errors.push(e) },
  );
  live.add(() => f.stop());
  try {
    await fs.appendFile(file, jl([{ a: 1 }]));
    await waitFor(() => got.length === 1, "first");
    await fs.appendFile(file, jl([{ b: 2 }]));
    await waitFor(() => got.length === 2, "second");
    assert.equal(errors.length, 1);
  } finally {
    f.stop();
  }
});

// ---- paths ----

test("subagentTranscriptPath: sibling <sid>/subagents/agent-<id>.jsonl; rejects path segments", () => {
  const session = "/x/.claude/projects/-Users-a/e933053f-64da-4fff-b331-5462905dd820.jsonl";
  assert.equal(
    subagentTranscriptPath(session, "aefe4d21a58019ee3"),
    "/x/.claude/projects/-Users-a/e933053f-64da-4fff-b331-5462905dd820/subagents/agent-aefe4d21a58019ee3.jsonl",
  );
  for (const bad of ["", "../x", "a/b", ".hidden", "a\\b", "a\0b"]) {
    assert.throws(() => subagentTranscriptPath(session, bad), /invalid agentId/, bad);
  }
  assert.throws(() => subagentTranscriptPath("/x/session.json", "abc"), /not a transcript path/);
});

test("subagent transcripts are read by the same functions", async () => {
  const session = await tmpFile("11111111-2222-3333-4444-555555555555.jsonl");
  await fs.writeFile(session, jl([{ type: "user" }]));
  const sub = subagentTranscriptPath(session, "a0123456789abcdef");
  await fs.mkdir(path.dirname(sub), { recursive: true });
  await fs.writeFile(sub, jl([{ agent: 1 }, { agent: 2 }]));
  const page = await readTail(sub, { maxRecords: 10 });
  assert.deepEqual(
    page.records.map((r) => r.value),
    [{ agent: 1 }, { agent: 2 }],
  );
});
