// The differential download of a shell update file (DESIGN.md 2e), after electron-updater's
// DifferentialDownloader: the new file is put together from blocks the app already has and only the
// blocks it lacks come over the network (HTTP Range).
//
// Where blocks come from, all of them checked against the signed block map before they count:
//   1. the part of the file already written (a download cut off earlier resumes here: no record of
//      progress is kept, the partial file itself is read back and each block's SHA-256 decides)
//   2. the baseline: the update file this app was installed from, cut with the same function
//      (blockmap.ts), so a block of the old file that the new file contains is copied, not fetched
//   3. the server, by byte ranges that cover the missing blocks
// The caller compares the finished file's SHA-256 with the signed manifest before it installs.
import crypto from "node:crypto";
import fs from "node:fs";
import { BLOCK_MAX, blockMapOfFile, blockOffsets, type BlockMap } from "./blockmap.ts";

/** The differential path cannot continue and the caller should download the whole file the plain way. */
export class DeltaError extends Error {}

export interface DeltaPlan {
  /** Bytes of blocks to fetch (what the progress bar counts). */
  toFetch: number;
  /** Bytes taken from the baseline. */
  reused: number;
  /** Bytes already in the partial file from an earlier attempt. */
  resumed: number;
  /** Byte ranges the plan asks the server for. */
  ranges: number;
}

export interface DeltaOptions {
  map: BlockMap;
  /** The file's size (the signed manifest's). */
  size: number;
  /** Hex SHA-256 of the whole file (the signed manifest's). */
  sha256: string;
  /** Where the file is put together; kept when an attempt fails so the next one resumes. */
  partial: string;
  /** The update file of the build now running, or null. */
  baseline: string | null;
  /** Bytes `start` to `end` (inclusive) of the file; the stream must hold exactly that many. */
  fetchRange: (start: number, end: number) => Promise<AsyncIterable<Uint8Array>>;
  onPlan?: (plan: DeltaPlan) => void;
  /** Bytes fetched so far (of `plan.toFetch`). */
  onProgress?: (fetched: number) => void;
  /** Requests in flight at once. */
  concurrency?: number;
  /** Two missing stretches closer than this many bytes are fetched as one range (the blocks between them come along). */
  mergeGap?: number;
}

const sha256 = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

interface Run {
  first: number;
  last: number;
  start: number;
  /** Inclusive. */
  end: number;
}

/**
 * The ranges that cover the blocks not yet `have`: runs of missing blocks, two runs joined when
 * the blocks between them add up to at most `mergeGap` bytes (one request instead of two, those
 * few bytes fetched again).
 */
export function planRuns(sizes: number[], have: ArrayLike<number>, mergeGap: number): Run[] {
  const offsets = blockOffsets(sizes);
  const runs: Run[] = [];
  let i = 0;
  while (i < sizes.length) {
    if (have[i]) {
      i++;
      continue;
    }
    const first = i;
    let last = i;
    let j = i + 1;
    // Extend over missing blocks, and over a short stretch of present blocks when more missing ones follow it.
    for (;;) {
      while (j < sizes.length && !have[j]) last = j++;
      let k = j;
      let gap = 0;
      while (k < sizes.length && have[k] && gap <= mergeGap) gap += sizes[k++]!;
      if (k < sizes.length && !have[k] && gap <= mergeGap) {
        j = k;
        continue;
      }
      break;
    }
    runs.push({ first, last, start: offsets[first]!, end: offsets[last + 1]! - 1 });
    i = last + 1;
  }
  return runs;
}

async function readAt(fd: fs.promises.FileHandle, buf: Buffer, length: number, at: number): Promise<Buffer> {
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fd.read(buf, got, length - got, at + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

/** Puts the file together at `partial`; resolves when every block is in place and the whole file's SHA-256 is `sha256`. */
export async function deltaAssemble(o: DeltaOptions): Promise<DeltaPlan & { fetched: number }> {
  const { map } = o;
  const n = map.sizes.length;
  const offsets = blockOffsets(map.sizes);
  if (offsets[n] !== o.size) throw new DeltaError("The block map and the file size do not match");
  const have = new Uint8Array(n);

  // A partial file from an earlier attempt is read back block by block. One cut short by the plain
  // download (a prefix of the file) is stretched to full size; its blocks still hash right where
  // they are. Anything longer than the file is not this file's partial.
  let fresh = false;
  try {
    const have = fs.statSync(o.partial).size;
    if (have > o.size || have === 0) fresh = true;
    else if (have < o.size) fs.truncateSync(o.partial, o.size);
  } catch {
    fresh = true;
  }
  if (fresh) {
    fs.rmSync(o.partial, { force: true });
    fs.closeSync(fs.openSync(o.partial, "w"));
    fs.truncateSync(o.partial, o.size);
  }
  const fd = await fs.promises.open(o.partial, "r+");
  try {
    const buf = Buffer.allocUnsafe(BLOCK_MAX);
    let resumed = 0;
    if (!fresh) {
      for (let i = 0; i < n; i++) {
        const b = await readAt(fd, buf, map.sizes[i]!, offsets[i]!);
        if (b.length === map.sizes[i] && sha256(b) === map.hashes[i]) {
          have[i] = 1;
          resumed += b.length;
        }
      }
    }

    let reused = 0;
    if (o.baseline && fs.existsSync(o.baseline)) {
      const old = await blockMapOfFile(o.baseline);
      const oldOffsets = blockOffsets(old.sizes);
      const index = new Map<string, number>();
      old.hashes.forEach((h, i) => {
        if (!index.has(h)) index.set(h, i);
      });
      const src = await fs.promises.open(o.baseline, "r");
      try {
        for (let i = 0; i < n; i++) {
          if (have[i]) continue;
          const j = index.get(map.hashes[i]!);
          if (j === undefined) continue;
          const b = await readAt(src, buf, old.sizes[j]!, oldOffsets[j]!);
          // The baseline may have changed since it was cut; a block counts only if it still hashes right.
          if (b.length !== map.sizes[i] || sha256(b) !== map.hashes[i]) continue;
          await fd.write(b, 0, b.length, offsets[i]!);
          have[i] = 1;
          reused += b.length;
        }
      } finally {
        await src.close();
      }
    }

    const runs = planRuns(map.sizes, have, o.mergeGap ?? 32 * 1024);
    const toFetch = runs.reduce((s, r) => s + (r.end - r.start + 1), 0);
    const plan: DeltaPlan = { toFetch, reused, resumed, ranges: runs.length };
    o.onPlan?.(plan);

    let fetched = 0;
    let failed: unknown = null;
    let next = 0;
    const worker = async () => {
      while (failed === null) {
        const run = runs[next++];
        if (!run) return;
        try {
          await fetchRun(run);
        } catch (e) {
          failed ??= e;
        }
      }
    };
    const fetchRun = async (run: Run) => {
      const stream = await o.fetchRange(run.start, run.end);
      let bi = run.first;
      let filled = 0;
      let block = Buffer.allocUnsafe(map.sizes[bi]!);
      let received = 0;
      for await (const chunk of stream) {
        if (failed !== null) return;
        received += chunk.length;
        if (received > run.end - run.start + 1) throw new DeltaError("The server sent more than the requested range");
        let at = 0;
        while (at < chunk.length) {
          const take = Math.min(chunk.length - at, block.length - filled);
          block.set(chunk.subarray(at, at + take), filled);
          filled += take;
          at += take;
          if (filled === block.length) {
            if (sha256(block) !== map.hashes[bi]) throw new DeltaError(`The SHA-256 of received block ${bi} differs from the signed block map`);
            await fd.write(block, 0, block.length, offsets[bi]!);
            have[bi] = 1;
            bi++;
            filled = 0;
            if (bi <= run.last) block = Buffer.allocUnsafe(map.sizes[bi]!);
          }
        }
        fetched += chunk.length;
        o.onProgress?.(fetched);
      }
      if (bi !== run.last + 1) throw new DeltaError("The server did not send the whole range");
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 4, runs.length)) }, worker));
    if (failed !== null) throw failed;
    if (have.some((h) => !h)) throw new DeltaError("Some blocks were not received");

    // The blocks agree with the signed map; the whole file must agree with the signed manifest too.
    const whole = crypto.createHash("sha256");
    for (let at = 0; at < o.size; ) {
      const b = await readAt(fd, buf, Math.min(BLOCK_MAX, o.size - at), at);
      if (b.length === 0) break;
      whole.update(b);
      at += b.length;
    }
    if (whole.digest("hex") !== o.sha256) throw new DeltaError("The SHA-256 of the assembled file differs from the signed value");
    return { ...plan, fetched };
  } finally {
    await fd.close();
  }
}
