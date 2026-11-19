// Names and titles that sit beyond the tail window of a transcript (see "Titles" in meta.ts).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HEAD_MAX_LINES, TAIL_BYTES, newReadCounters, readTranscriptMeta } from "./meta.ts";

const tmpDirs: string[] = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

async function tmpFile(name = "s.jsonl"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-meta-titles-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}

const jl = (objs: object[]): string => objs.map((o) => JSON.stringify(o) + "\n").join("");

const filler = (i: number, bytes = 200) => ({ type: "attachment", n: i, pad: "x".repeat(bytes) });

/** A head of HEAD_MAX_LINES + 5 short lines, so the file is "large" and the head is complete. */
const bigHead = (extra: object[] = []) => [
  { type: "attachment", cwd: "/w", entrypoint: "cli", timestamp: "2026-11-15T00:00:00Z" },
  ...Array.from({ length: HEAD_MAX_LINES + 5 }, (_, i) => filler(i)),
  ...extra,
];

/** One line of about `bytes` bytes, e.g. a tool result larger than the tail window. */
const blob = (bytes: number) => ({ type: "user", pad: "p".repeat(bytes) });

test("no prev: a custom-title far before the end (past the tail window) is found", async () => {
  const file = await tmpFile();
  await fs.writeFile(
    file,
    jl([
      ...bigHead(),
      { type: "custom-title", customTitle: "far-name" },
      { type: "ai-title", aiTitle: "far-ai" },
      blob(3 * 1024 * 1024),
      blob(TAIL_BYTES * 2),
      filler(1),
    ]),
  );
  const e = await readTranscriptMeta(file, undefined, newReadCounters());
  assert.equal(e?.meta.name, "far-name");
  assert.equal(e?.meta.title, "far-ai");
});

test("no prev: a file that was never renamed has name null and keeps its ai-title", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([...bigHead([{ type: "ai-title", aiTitle: "only-ai" }]), blob(TAIL_BYTES * 3), filler(1)]));
  const e = await readTranscriptMeta(file, undefined, newReadCounters());
  assert.equal(e?.meta.name, null);
  assert.equal(e?.meta.title, "only-ai");
  const none = await tmpFile();
  await fs.writeFile(none, jl([...bigHead(), blob(TAIL_BYTES * 3)]));
  const e2 = await readTranscriptMeta(none, undefined, newReadCounters());
  assert.equal(e2?.meta.name, null);
  assert.equal(e2?.meta.title, null);
});

test("grown file: an appended range longer than the tail window is searched whole", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl(bigHead()));
  const e1 = await readTranscriptMeta(file, undefined, newReadCounters());
  assert.equal(e1?.meta.name, null);
  // The rename sits more than TAIL_BYTES before the end of what was appended.
  await fs.appendFile(
    file,
    jl([{ type: "custom-title", customTitle: "mid-append" }, { type: "ai-title", aiTitle: "mid-ai" }, blob(TAIL_BYTES * 4), filler(1)]),
  );
  const e2 = await readTranscriptMeta(file, e1 ?? undefined, newReadCounters());
  assert.equal(e2?.meta.name, "mid-append");
  assert.equal(e2?.meta.title, "mid-ai");
});

test("grown file: an appended range without titles keeps the previous values, however long it is", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([...bigHead(), { type: "custom-title", customTitle: "kept" }, { type: "ai-title", aiTitle: "kept-ai" }]));
  let e = await readTranscriptMeta(file, undefined, newReadCounters());
  assert.equal(e?.meta.name, "kept");
  for (const bytes of [100, TAIL_BYTES * 2, 5 * 1024 * 1024]) {
    await fs.appendFile(file, jl([blob(bytes), filler(1)]));
    const c = newReadCounters();
    e = await readTranscriptMeta(file, e ?? undefined, c);
    assert.equal(e?.meta.name, "kept", `after appending ${bytes} bytes`);
    assert.equal(e?.meta.title, "kept-ai");
    assert.equal(c.headReuses, 1);
  }
});

test("grown file: a rename in the appended range replaces the previous name, an empty one clears it", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([...bigHead(), { type: "custom-title", customTitle: "v1" }]));
  const e1 = await readTranscriptMeta(file, undefined, newReadCounters());
  assert.equal(e1?.meta.name, "v1");
  await fs.appendFile(
    file,
    jl([blob(TAIL_BYTES * 2), { type: "custom-title", customTitle: "v2" }, { type: "custom-title", customTitle: "v3" }, blob(TAIL_BYTES * 2)]),
  );
  const e2 = await readTranscriptMeta(file, e1 ?? undefined, newReadCounters());
  assert.equal(e2?.meta.name, "v3", "the last of several in one range");
  await fs.appendFile(file, jl([{ type: "custom-title", customTitle: "" }, blob(TAIL_BYTES * 2)]));
  const e3 = await readTranscriptMeta(file, e2 ?? undefined, newReadCounters());
  assert.equal(e3?.meta.name, null);
  await fs.appendFile(file, jl([blob(100)]));
  const e4 = await readTranscriptMeta(file, e3 ?? undefined, newReadCounters());
  assert.equal(e4?.meta.name, null, "the cleared name stays cleared");
});

test("a replaced file (new inode) does not inherit the previous file's titles", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([...bigHead(), { type: "custom-title", customTitle: "old-name" }, blob(TAIL_BYTES * 2)]));
  const e1 = await readTranscriptMeta(file, undefined, newReadCounters());
  assert.equal(e1?.meta.name, "old-name");
  const tmp = file + ".new";
  await fs.writeFile(tmp, jl([...bigHead(), { type: "custom-title", customTitle: "new-name" }, blob(TAIL_BYTES * 3), blob(TAIL_BYTES)]));
  await fs.rename(tmp, file);
  const e2 = await readTranscriptMeta(file, e1 ?? undefined, newReadCounters());
  assert.equal(e2?.meta.name, "new-name");
  const tmp2 = file + ".new2";
  await fs.writeFile(tmp2, jl([...bigHead(), blob(TAIL_BYTES * 3)]));
  await fs.rename(tmp2, file);
  const e3 = await readTranscriptMeta(file, e2 ?? undefined, newReadCounters());
  assert.equal(e3?.meta.name, null, "the new file has no rename");
});

test("a file that shrank (same inode) is read again, not continued", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([...bigHead(), { type: "custom-title", customTitle: "before" }, blob(TAIL_BYTES * 4)]));
  const e1 = await readTranscriptMeta(file, undefined, newReadCounters());
  assert.equal(e1?.meta.name, "before");
  const fh = await fs.open(file, "r+");
  await fh.truncate(0);
  await fh.write(jl([...bigHead(), { type: "custom-title", customTitle: "after" }, blob(TAIL_BYTES)]), 0);
  await fh.close();
  const e2 = await readTranscriptMeta(file, e1 ?? undefined, newReadCounters());
  assert.ok(e2 && e2.size < e1!.size);
  assert.equal(e2.meta.name, "after");
  const fh2 = await fs.open(file, "r+");
  await fh2.truncate(0);
  await fh2.write(jl([...bigHead(), blob(TAIL_BYTES)]), 0);
  await fh2.close();
  const e3 = await readTranscriptMeta(file, e2, newReadCounters());
  assert.equal(e3?.meta.name, null);
});

test("the spaced form of the type key (older Claude Code) is read", async () => {
  const file = await tmpFile();
  const spaced = (o: object) => JSON.stringify(o).replace('"type":', '"type": ') + "\n";
  await fs.writeFile(
    file,
    jl(bigHead()) +
      spaced({ type: "custom-title", customTitle: "spaced-name" }) +
      spaced({ type: "ai-title", aiTitle: "spaced-ai" }) +
      jl([blob(TAIL_BYTES * 3)]),
  );
  const e = await readTranscriptMeta(file, undefined, newReadCounters());
  assert.equal(e?.meta.name, "spaced-name");
  assert.equal(e?.meta.title, "spaced-ai");
});

test("a record that only quotes a title line, or nests one, is not a title", async () => {
  const file = await tmpFile();
  await fs.writeFile(
    file,
    jl([
      ...bigHead([
        { type: "custom-title", customTitle: "real" },
        { type: "ai-title", aiTitle: "real-ai" },
      ]),
      // a tool result that contains a transcript line as text: its quotes are escaped
      { type: "user", message: { content: [{ type: "tool_result", content: JSON.stringify({ type: "custom-title", customTitle: "quoted" }) }] } },
      // nested objects with the same type and field: not top-level records
      { type: "attachment", nested: { type: "custom-title", customTitle: "nested" }, other: { type: "ai-title", aiTitle: "nested-ai" } },
      blob(TAIL_BYTES * 2),
    ]),
  );
  const e = await readTranscriptMeta(file, undefined, newReadCounters());
  assert.equal(e?.meta.name, "real");
  assert.equal(e?.meta.title, "real-ai");
});

test("a title line cut by a chunk boundary of the backward search is found", async () => {
  // The first chunk of the search is 16KB from the end; slide the line across that boundary.
  for (let shift = -70; shift <= 70; shift += 7) {
    const file = await tmpFile();
    const title = jl([{ type: "custom-title", customTitle: "straddle" }]);
    const after = 16 * 1024 + shift;
    const padLine = JSON.stringify({ type: "user", pad: "p".repeat(after - 25) }) + "\n";
    assert.equal(Buffer.byteLength(padLine), after);
    await fs.writeFile(file, jl(bigHead()) + title + padLine);
    const e = await readTranscriptMeta(file, undefined, newReadCounters());
    assert.equal(e?.meta.name, "straddle", `shift ${shift}`);
  }
});

test("an unterminated last line is picked up once it is complete", async () => {
  const file = await tmpFile();
  const line = JSON.stringify({ type: "custom-title", customTitle: "late" });
  await fs.writeFile(file, jl(bigHead()) + line.slice(0, 20));
  const e1 = await readTranscriptMeta(file, undefined, newReadCounters());
  assert.equal(e1?.meta.name, null);
  await fs.appendFile(file, line.slice(20) + "\n");
  const e2 = await readTranscriptMeta(file, e1 ?? undefined, newReadCounters());
  assert.equal(e2?.meta.name, "late");
});

test("a small file that grows past the head keeps its titles", async () => {
  const file = await tmpFile();
  await fs.writeFile(file, jl([{ type: "custom-title", customTitle: "small" }, { type: "ai-title", aiTitle: "small-ai" }, filler(0)]));
  const e1 = await readTranscriptMeta(file, undefined, newReadCounters());
  assert.equal(e1?.headComplete, false);
  await fs.appendFile(file, jl(Array.from({ length: HEAD_MAX_LINES + 5 }, (_, i) => filler(i, 2000))));
  const e2 = await readTranscriptMeta(file, e1 ?? undefined, newReadCounters());
  assert.equal(e2?.headComplete, true);
  assert.equal(e2?.meta.name, "small");
  assert.equal(e2?.meta.title, "small-ai");
});
