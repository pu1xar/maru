import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readTail } from "./claudeTranscript.ts";
import type { RawRecord, ResetInfo } from "./claudeTranscript.ts";
import { createTranscriptHub } from "./transcriptHub.ts";
import type { TranscriptListener } from "./transcriptHub.ts";

/** Temp dirs of this file, removed after its tests (one test writes about 33MB). */
const tmpDirs: string[] = [];
after(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function tmpFile(name = "s.jsonl"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "transcript-hub-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}

const jl = (objs: unknown[]): string => objs.map((o) => JSON.stringify(o) + "\n").join("");

async function waitFor(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

interface Got<T> {
  batches: T[];
  resets: ResetInfo[];
  errors: unknown[];
}

function collector<T>(): { got: Got<T>; listener: TranscriptListener<T> } {
  const got: Got<T> = { batches: [], resets: [], errors: [] };
  return {
    got,
    listener: {
      onRecords: (b) => got.batches.push(b),
      onReset: (info) => got.resets.push(info),
      onError: (err) => got.errors.push(err),
    },
  };
}

const values = (batches: RawRecord[][]): unknown[] => batches.flat().map((r) => r.value);
const fast = { debounceMs: 10, pollMs: 50 };

/**
 * Every hub a test creates, closed after the test even when it fails: a follower's timer and
 * watcher would otherwise keep the test process alive and hang the whole run.
 */
const hubs = new Set<{ close(): void }>();
afterEach(() => {
  for (const h of hubs) h.close();
  hubs.clear();
});
function track<H extends { close(): void }>(hub: H): H {
  hubs.add(hub);
  return hub;
}

test("hub: one follower per file, refcounted; the last unsubscribe stops it", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([{ n: 0 }]));
  const end = (await fs.stat(file)).size;
  const hub = track(createTranscriptHub(fast));
  try {
    const a = collector<RawRecord[]>();
    const b = collector<RawRecord[]>();
    const sa = hub.subscribe(file, end, a.listener);
    // A different spelling of the same path shares the follower (concatenated: path.join would
    // normalize the "." away before the hub sees it).
    const sb = hub.subscribe(path.dirname(file) + "/./" + path.basename(file), end, b.listener);
    assert.equal(hub.stats().files, 1);
    assert.equal(hub.stats().followersStarted, 1);
    assert.equal(hub.subscriberCount(file), 2);

    await fs.appendFile(file, jl([{ n: 1 }, { n: 2 }]));
    await waitFor(() => values(a.got.batches).length === 2 && values(b.got.batches).length === 2, "both subscribers");
    assert.deepEqual(values(a.got.batches), [{ n: 1 }, { n: 2 }]);
    assert.deepEqual(values(b.got.batches), [{ n: 1 }, { n: 2 }]);

    sa.unsubscribe();
    sa.unsubscribe(); // idempotent: must not take b's reference
    assert.equal(hub.subscriberCount(file), 1);
    assert.equal(hub.stats().followersStopped, 0);
    await fs.appendFile(file, jl([{ n: 3 }]));
    await waitFor(() => values(b.got.batches).length === 3, "b keeps receiving");
    await sleep(100);
    assert.equal(values(a.got.batches).length, 2, "an unsubscribed listener gets nothing");

    sb.unsubscribe();
    assert.deepEqual(
      { files: hub.stats().files, subscribers: hub.stats().subscribers, stopped: hub.stats().followersStopped },
      { files: 0, subscribers: 0, stopped: 1 },
    );

    // Subscribing again starts a new follower.
    const c = collector<RawRecord[]>();
    const sc = hub.subscribe(file, (await fs.stat(file)).size, c.listener);
    assert.equal(hub.stats().followersStarted, 2);
    await fs.appendFile(file, jl([{ n: 4 }]));
    await waitFor(() => values(c.got.batches).length === 1, "new follower");
    sc.unsubscribe();
  } finally {
    hub.close();
  }
});

test("hub: different files get separate followers", async () => {
  const f1 = await tmpFile("a.jsonl");
  const f2 = await tmpFile("b.jsonl");
  await fs.writeFile(f1, "");
  await fs.writeFile(f2, "");
  const hub = track(createTranscriptHub(fast));
  try {
    const a = collector<RawRecord[]>();
    const b = collector<RawRecord[]>();
    hub.subscribe(f1, 0, a.listener);
    hub.subscribe(f2, 0, b.listener);
    assert.equal(hub.stats().files, 2);
    await fs.appendFile(f1, jl([{ file: 1 }]));
    await fs.appendFile(f2, jl([{ file: 2 }]));
    await waitFor(() => a.got.batches.length > 0 && b.got.batches.length > 0, "both files");
    assert.deepEqual(values(a.got.batches), [{ file: 1 }]);
    assert.deepEqual(values(b.got.batches), [{ file: 2 }]);
  } finally {
    hub.close();
  }
  assert.equal(hub.stats().files, 0);
});

test("hub: a subscriber joining behind the follower catches up without gaps or duplicates", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([{ n: 0 }]));
  const hub = track(createTranscriptHub(fast));
  try {
    // An older screen: its page ended after n=0.
    const oldPage = await readTail(file, { maxRecords: 50 });
    const first = collector<RawRecord[]>();
    hub.subscribe(file, oldPage.endOffset, first.listener);
    await fs.appendFile(file, jl([{ n: 1 }, { n: 2 }]));
    await waitFor(() => values(first.got.batches).length === 2, "first subscriber");

    // A second screen subscribes with the same old offset: the follower is past it.
    const late = collector<RawRecord[]>();
    hub.subscribe(file, oldPage.endOffset, late.listener);
    // Lines appended while the catch-up read runs must come after it, once.
    await fs.appendFile(file, jl([{ n: 3 }]));
    await waitFor(() => values(late.got.batches).length === 3, "late subscriber");
    await sleep(150);
    assert.deepEqual(values(late.got.batches), [{ n: 1 }, { n: 2 }, { n: 3 }]);
    assert.deepEqual(values(first.got.batches), [{ n: 1 }, { n: 2 }, { n: 3 }]);
    assert.equal(hub.stats().catchUps, 1);
    // Offsets tile with no gap.
    const recs = late.got.batches.flat();
    for (let i = 1; i < recs.length; i++) assert.equal(recs[i]!.offset, recs[i - 1]!.offset + recs[i - 1]!.length);
    assert.equal(recs[0]!.offset, oldPage.endOffset);
  } finally {
    hub.close();
  }
});

test("hub: a subscriber ahead of the follower skips records before its offset", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, "");
  // A slow follower, so the second screen joins before it reads n=1 and n=2.
  const hub = track(createTranscriptHub({ debounceMs: 300, pollMs: 300 }));
  try {
    const early = collector<RawRecord[]>();
    hub.subscribe(file, 0, early.listener);
    await sleep(100); // the follower's first read (empty file) is done
    await fs.appendFile(file, jl([{ n: 1 }, { n: 2 }]));
    const ahead = collector<RawRecord[]>();
    hub.subscribe(file, (await fs.stat(file)).size, ahead.listener);
    await waitFor(() => early.got.batches.length === 1, "the follower reads n=1, n=2");
    assert.deepEqual(values(early.got.batches), [{ n: 1 }, { n: 2 }], "one batch with both lines");
    assert.equal(ahead.got.batches.length, 0, "the batch before its offset is skipped");
    await fs.appendFile(file, jl([{ n: 3 }]));
    await waitFor(() => values(early.got.batches).length === 3 && values(ahead.got.batches).length === 1, "both");
    await sleep(100);
    assert.deepEqual(values(ahead.got.batches), [{ n: 3 }]);
  } finally {
    hub.close();
  }
});

test("hub: live batches arriving during a long catch-up wait behind it", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, "");
  const hub = track(createTranscriptHub(fast));
  try {
    const first = collector<RawRecord[]>();
    hub.subscribe(file, 0, first.listener);
    const n = 40_000;
    const pad = "p".repeat(800);
    await fs.appendFile(file, jl(Array.from({ length: n }, (_, i) => ({ i, pad }))));
    await waitFor(() => values(first.got.batches).length === n, "first subscriber reads ~33MB", 20_000);

    // Catch-up of the whole file from 0 takes a while; lines appended now arrive meanwhile.
    const late = collector<RawRecord[]>();
    hub.subscribe(file, 0, late.listener);
    await fs.appendFile(file, jl([{ i: n }]));
    await sleep(30);
    await fs.appendFile(file, jl([{ i: n + 1 }]));
    await waitFor(() => values(late.got.batches).length === n + 2, "late subscriber", 20_000);
    await sleep(100);
    const got = values(late.got.batches) as { i: number }[];
    assert.equal(got.length, n + 2);
    assert.ok(
      got.every((v, k) => v.i === k),
      "every line once, in order",
    );
    assert.ok(hub.stats().queuedBatches >= 1, `queued ${hub.stats().queuedBatches}`);
  } finally {
    hub.close();
  }
});

test("hub: the injected transform runs once per batch for subscribers at the same position", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, "");
  let calls = 0;
  const hub = track(
    createTranscriptHub({
      ...fast,
      transform: (records: RawRecord[], f: string) => {
        calls++;
        return { file: f, kinds: records.map((r) => (r.value as { type: string }).type) };
      },
    }),
  );
  try {
    const a = collector<{ file: string; kinds: string[] }>();
    const b = collector<{ file: string; kinds: string[] }>();
    hub.subscribe(file, 0, a.listener);
    hub.subscribe(file, 0, b.listener);
    await fs.appendFile(file, jl([{ type: "user" }, { type: "assistant" }]));
    await waitFor(() => a.got.batches.length > 0 && b.got.batches.length > 0, "transformed batches");
    assert.deepEqual(a.got.batches, [{ file: path.resolve(file), kinds: ["user", "assistant"] }]);
    assert.equal(a.got.batches[0], b.got.batches[0], "the same transformed object");
    assert.equal(calls, 1);
  } finally {
    hub.close();
  }
});

test("hub: a transform or listener error goes to that subscriber's onError only", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, "");
  const hub = track(
    createTranscriptHub({
      ...fast,
      transform: (records: RawRecord[]) => {
        if (records.some((r) => (r.value as { boom?: boolean }).boom)) throw new Error("transform failed");
        return records.length;
      },
    }),
  );
  try {
    const good = collector<number>();
    let thrown = 0;
    const bad: TranscriptListener<number> = {
      onRecords: () => {
        thrown++;
        throw new Error("listener bug");
      },
      onError: (e) => good.got.errors.push(["bad", e]),
    };
    hub.subscribe(file, 0, good.listener);
    hub.subscribe(file, 0, bad);
    await fs.appendFile(file, jl([{ ok: 1 }]));
    await waitFor(() => good.got.batches.length === 1 && thrown === 1, "first batch");
    assert.equal(good.got.errors.length, 1, "the listener bug is reported to its own onError");
    await fs.appendFile(file, jl([{ boom: true }]));
    await waitFor(() => good.got.errors.length === 3, "transform error for both subscribers");
    await fs.appendFile(file, jl([{ ok: 2 }]));
    await waitFor(() => good.got.batches.length === 2, "following continues");
  } finally {
    hub.close();
  }
});

test("hub: a reset reaches every subscriber, then records from offset 0", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([{ old: 1 }]));
  const end = (await fs.stat(file)).size;
  const hub = track(createTranscriptHub(fast));
  try {
    const a = collector<RawRecord[]>();
    const b = collector<RawRecord[]>();
    hub.subscribe(file, end, a.listener);
    hub.subscribe(file, end, b.listener);
    await sleep(100);
    await fs.truncate(file, 0);
    await waitFor(() => a.got.resets.length === 1 && b.got.resets.length === 1, "resets");
    await fs.appendFile(file, jl([{ fresh: 1 }]));
    await waitFor(() => a.got.batches.length === 1 && b.got.batches.length === 1, "records after reset");
    assert.equal(a.got.batches[0]![0]!.offset, 0);
    assert.deepEqual(values(b.got.batches), [{ fresh: 1 }]);
    assert.equal(hub.stats().resets, 1);
  } finally {
    hub.close();
  }
});

test("hub: close stops every follower; no callbacks afterwards", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, "");
  const hub = track(createTranscriptHub(fast));
  const a = collector<RawRecord[]>();
  hub.subscribe(file, 0, a.listener);
  hub.close();
  assert.deepEqual(
    { files: hub.stats().files, started: hub.stats().followersStarted, stopped: hub.stats().followersStopped },
    { files: 0, started: 1, stopped: 1 },
  );
  await fs.appendFile(file, jl([{ late: 1 }]));
  await sleep(200);
  assert.equal(a.got.batches.length, 0);
});
