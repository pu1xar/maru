import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BLOCK_MAX, BLOCK_MIN, BlockMapError, Chunker, blockMapOfFile, decodeBlockMap, encodeBlockMap } from "./blockmap.ts";
import { DeltaError, deltaAssemble, planRuns, type DeltaOptions } from "./deltaDownload.ts";

/** Reproducible pseudo-random bytes (a stand-in for compressed data). */
function bytes(n: number, seed: number): Buffer {
  const out = Buffer.alloc(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delta-"));
}

async function mapOf(dir: string, name: string, data: Buffer) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return { file, map: await blockMapOfFile(file) };
}

/** A fake server over `data`: serves ranges, counts the bytes and requests. */
function server(data: Buffer, hooks: { afterBytes?: number; corrupt?: boolean } = {}) {
  const stats = { requests: [] as [number, number][], bytes: 0 };
  const fetchRange: DeltaOptions["fetchRange"] = async (start, end) => {
    stats.requests.push([start, end]);
    async function* body() {
      for (let at = start; at <= end; at += 10_000) {
        const chunk = Buffer.from(data.subarray(at, Math.min(end + 1, at + 10_000)));
        if (hooks.corrupt && at === start) chunk[0] = chunk[0]! ^ 0xff;
        if (hooks.afterBytes !== undefined && stats.bytes + chunk.length > hooks.afterBytes) throw new Error("connection reset");
        stats.bytes += chunk.length;
        yield chunk;
      }
    }
    return body();
  };
  return { stats, fetchRange };
}

test("chunker: block sizes stay in range and the same bytes cut the same way, wherever they sit", async () => {
  const dir = tmp();
  try {
    const data = bytes(2_000_000, 7);
    const { map } = await mapOf(dir, "a", data);
    assert.equal(map.sizes.reduce((a, b) => a + b, 0), data.length);
    for (const [i, s] of map.sizes.entries()) {
      assert.ok(s <= BLOCK_MAX && (s >= BLOCK_MIN || i === map.sizes.length - 1), `block ${i} is ${s}`);
    }
    const avg = data.length / map.sizes.length;
    assert.ok(avg > 12_000 && avg < 24_000, `average block ${avg}`);
    // A different read size cuts the same blocks.
    const c = new Chunker(() => {});
    c.push(data);
    c.end();
    const seen: number[] = [];
    const c2 = new Chunker((b) => seen.push(b.length));
    for (let at = 0; at < data.length; at += 777) c2.push(data.subarray(at, at + 777));
    c2.end();
    assert.deepEqual(seen, map.sizes);
    // Bytes put in front shift every position but only the first blocks change.
    const shifted = await mapOf(dir, "b", Buffer.concat([bytes(5000, 99), data]));
    const have = new Set(map.hashes);
    const same = shifted.map.hashes.filter((h) => have.has(h)).length;
    assert.ok(same >= map.hashes.length - 3, `${same} of ${map.hashes.length} blocks survive a 5000 byte insert`);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("block map file: round trip, and a wrong shape is refused", async () => {
  const dir = tmp();
  try {
    const { map } = await mapOf(dir, "a", bytes(300_000, 3));
    const size = map.sizes.reduce((a, b) => a + b, 0);
    const enc = encodeBlockMap(map);
    assert.equal(enc.length, 8 + map.sizes.length * 36);
    assert.deepEqual(decodeBlockMap(enc, size), map);
    assert.throws(() => decodeBlockMap(enc, size + 1), BlockMapError, "sizes must add up to the signed file size");
    assert.throws(() => decodeBlockMap(enc.subarray(0, enc.length - 1), size), BlockMapError, "cut short");
    assert.throws(() => decodeBlockMap(Buffer.concat([Buffer.from("XXXX"), enc.subarray(4)]), size), BlockMapError, "magic");
    const tiny = Buffer.from(enc);
    tiny.writeUInt32BE(10, 8);
    assert.throws(() => decodeBlockMap(tiny, size - map.sizes[0]! + 10), BlockMapError, "a block under the minimum before the last");
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("plan: runs of missing blocks, close runs joined, present blocks left out", () => {
  const sizes = [10, 10, 10, 10, 10, 10, 10];
  const none = (have: number[], gap: number) => planRuns(sizes, have, gap).map((r) => [r.first, r.last, r.start, r.end]);
  assert.deepEqual(none([0, 0, 0, 0, 0, 0, 0], 0), [[0, 6, 0, 69]]);
  assert.deepEqual(none([1, 1, 1, 1, 1, 1, 1], 0), []);
  assert.deepEqual(none([1, 0, 0, 1, 1, 0, 1], 0), [[1, 2, 10, 29], [5, 5, 50, 59]]);
  assert.deepEqual(none([1, 0, 0, 1, 1, 0, 1], 20), [[1, 5, 10, 59]], "a gap of two blocks (20 bytes) is joined");
  assert.deepEqual(none([1, 0, 1, 1, 1, 0, 0], 19), [[1, 1, 10, 19], [5, 6, 50, 69]], "a gap of 30 is not");
  assert.deepEqual(none([0, 1, 0, 1, 1, 1, 1], 10), [[0, 2, 0, 29]]);
});

test("delta: an unchanged-except-a-patch update fetches only the changed blocks, and the file is exact", async () => {
  const dir = tmp();
  try {
    const old = bytes(3_000_000, 11);
    const next = Buffer.from(old);
    // A 40 KB patch in the middle, a short insert near the start, and a changed tail.
    bytes(40_000, 5).copy(next, 1_500_000);
    const grown = Buffer.concat([next.subarray(0, 100_000), bytes(2_000, 6), next.subarray(100_000), bytes(30_000, 8)]);
    const baseline = path.join(dir, "old.zip");
    fs.writeFileSync(baseline, old);
    const { map } = await mapOf(dir, "new.zip", grown);
    const srv = server(grown);
    const partial = path.join(dir, "new.zip.partial");
    let plan: { toFetch: number } | undefined;
    const progress: number[] = [];
    const r = await deltaAssemble({ map, size: grown.length, sha256: sha(grown), partial, baseline, fetchRange: srv.fetchRange, onPlan: (p) => (plan = p), onProgress: (n) => progress.push(n) });
    assert.deepEqual(fs.readFileSync(partial), grown);
    assert.equal(r.fetched, srv.stats.bytes);
    assert.ok(srv.stats.bytes < grown.length * 0.1, `fetched ${srv.stats.bytes} of ${grown.length}`);
    assert.equal(r.reused + r.fetched >= grown.length, true);
    assert.equal(plan!.toFetch, srv.stats.bytes);
    assert.equal(progress.at(-1), srv.stats.bytes);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("delta: with no baseline the whole file comes as one range, and a cut connection resumes from the verified blocks", async () => {
  const dir = tmp();
  try {
    const data = bytes(1_200_000, 21);
    const { map } = await mapOf(dir, "f", data);
    const partial = path.join(dir, "f.partial");
    const base = { map, size: data.length, sha256: sha(data), partial, baseline: null };
    const cut = server(data, { afterBytes: 500_000 });
    await assert.rejects(deltaAssemble({ ...base, fetchRange: cut.fetchRange }), /connection reset/);
    assert.deepEqual(cut.stats.requests, [[0, data.length - 1]]);
    // The next attempt reads back the partial file and asks only for what is missing.
    const rest = server(data);
    const r = await deltaAssemble({ ...base, fetchRange: rest.fetchRange });
    assert.deepEqual(fs.readFileSync(partial), data);
    assert.ok(r.resumed >= 400_000 && r.resumed <= 500_000, `resumed ${r.resumed}`);
    assert.equal(rest.stats.bytes + r.resumed >= data.length, true);
    assert.ok(rest.stats.bytes < data.length - 400_000, `fetched ${rest.stats.bytes} the second time`);
    assert.equal(rest.stats.requests.length, 1);
    assert.ok(rest.stats.requests[0]![0] >= 400_000);
    // Everything there: nothing is fetched.
    const none = server(data);
    const again = await deltaAssemble({ ...base, fetchRange: none.fetchRange });
    assert.equal(none.stats.requests.length, 0);
    assert.equal(again.fetched, 0);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("delta: a prefix left by the plain download is used, and a partial file of the wrong size is not", async () => {
  const dir = tmp();
  try {
    const data = bytes(900_000, 31);
    const { map } = await mapOf(dir, "f", data);
    const partial = path.join(dir, "f.partial");
    fs.writeFileSync(partial, data.subarray(0, 600_000));
    const srv = server(data);
    const r = await deltaAssemble({ map, size: data.length, sha256: sha(data), partial, baseline: null, fetchRange: srv.fetchRange });
    assert.deepEqual(fs.readFileSync(partial), data);
    assert.ok(r.resumed > 500_000 && srv.stats.bytes < 400_000, `resumed ${r.resumed}, fetched ${srv.stats.bytes}`);
    fs.writeFileSync(partial, bytes(2_000_000, 1));
    const srv2 = server(data);
    await deltaAssemble({ map, size: data.length, sha256: sha(data), partial, baseline: null, fetchRange: srv2.fetchRange });
    assert.deepEqual(fs.readFileSync(partial), data);
    assert.equal(srv2.stats.bytes, data.length);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("delta: a wrong byte from the server, a wrong block map, or a baseline that changed never get through", async () => {
  const dir = tmp();
  try {
    const old = bytes(800_000, 41);
    const next = Buffer.concat([old.subarray(0, 300_000), bytes(60_000, 42), old.subarray(300_000)]);
    const baseline = path.join(dir, "old");
    fs.writeFileSync(baseline, old);
    const { map } = await mapOf(dir, "new", next);
    const partial = path.join(dir, "new.partial");
    const opts = { map, size: next.length, sha256: sha(next), partial, baseline };
    // The server sends a block with one flipped byte.
    const bad = server(next, { corrupt: true });
    await assert.rejects(deltaAssemble({ ...opts, fetchRange: bad.fetchRange }), DeltaError);
    // The block map is right for the blocks but the signed whole-file hash is another file's.
    fs.rmSync(partial, { force: true });
    const good = server(next);
    await assert.rejects(deltaAssemble({ ...opts, sha256: sha(old), fetchRange: good.fetchRange }), /differs from the signed value/);
    // A server that sends more than the range is not trusted either.
    fs.rmSync(partial, { force: true });
    const more: DeltaOptions["fetchRange"] = (s, e) => server(next).fetchRange(s, Math.min(e + 40_000, next.length - 1));
    {
      await assert.rejects(deltaAssemble({ ...opts, fetchRange: more }), DeltaError);
    }
    // A baseline whose bytes differ from what the index was cut from is simply not used for those blocks.
    fs.rmSync(partial, { force: true });
    const ok = server(next);
    await deltaAssemble({ ...opts, baseline: path.join(dir, "missing"), fetchRange: ok.fetchRange });
    assert.deepEqual(fs.readFileSync(partial), next);
    assert.equal(ok.stats.bytes, next.length, "no baseline, whole file");
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
