// Read-only check of the transcript reader against a real transcript.
// Run from the project root: node apps/server/src/transcript/inspect.ts [file] [--page N]
// Without a file it takes the largest top-level transcript under the first account's
// projects/ (~/.claude). Prints:
//   1. one readTail page (the call a screen makes when it opens): time and bytes read
//   2. a backwards paging of the whole file from that page down to offset 0, checking that pages
//      abut and records tile, with counts of records, parse errors and bytes read
//   3. an independent newline count of the same byte range [0, endOffset), by a plain stream
// Compare (2) and (3) with `head -c <endOffset> <file> | wc -l`. Writes nothing.
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_ACCOUNTS } from "../config.ts";
import { CHUNK_BYTES, isParseError, readTail } from "./claudeTranscript.ts";
import type { ReadStats } from "./claudeTranscript.ts";

function largestTranscript(projectsDir: string): string {
  let best: { file: string; size: number } | null = null;
  for (const enc of fs.readdirSync(projectsDir)) {
    const dir = path.join(projectsDir, enc);
    if (!fs.lstatSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const st = fs.lstatSync(path.join(dir, name));
      if (st.isFile() && (best === null || st.size > best.size)) best = { file: path.join(dir, name), size: st.size };
    }
  }
  if (best === null) throw new Error(`no transcript under ${projectsDir}`);
  return best.file;
}

/** Newlines in [0, end), counted without the reader's code. */
async function countNewlines(file: string, end: number): Promise<number> {
  if (end === 0) return 0;
  let n = 0;
  for await (const chunk of fs.createReadStream(file, { start: 0, end: end - 1, highWaterMark: 1024 * 1024 })) {
    const buf = chunk as Buffer;
    let i = buf.indexOf(10);
    while (i !== -1) {
      n++;
      i = buf.indexOf(10, i + 1);
    }
  }
  return n;
}

const args = process.argv.slice(2);
const pageArg = args.indexOf("--page");
const pageSize = pageArg === -1 ? 200 : Number(args[pageArg + 1]);
const fileArg = args.find((a, i) => !a.startsWith("--") && (pageArg === -1 || i !== pageArg + 1));
const file = fileArg ?? largestTranscript(path.join(CLAUDE_ACCOUNTS[0]!.dir, "projects"));
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)}MB`;

const sizeAtStart = fs.statSync(file).size;
console.log(`file: ${file}`);
console.log(`size at start: ${sizeAtStart} bytes (${mb(sizeAtStart)}), chunk ${CHUNK_BYTES} bytes, page ${pageSize}`);

// 1. The first page, as a screen opens the session.
const firstStats: ReadStats = { bytesRead: 0 };
let t0 = performance.now();
const first = await readTail(file, { maxRecords: pageSize, stats: firstStats });
const firstMs = performance.now() - t0;
console.log(
  `first page: ${first.records.length} records in ${firstMs.toFixed(1)}ms, read ${firstStats.bytesRead} bytes ` +
    `(${mb(firstStats.bytesRead)}, ${((firstStats.bytesRead / sizeAtStart) * 100).toFixed(3)}% of the file), ` +
    `range [${first.startOffset}, ${first.endOffset}) = ${first.endOffset - first.startOffset} bytes, ` +
    `unterminated tail ${sizeAtStart - first.endOffset} bytes`,
);

// 2. Page backwards through the whole file.
const allStats: ReadStats = { bytesRead: firstStats.bytesRead };
let records = first.records.length;
let parseErrors = first.records.filter((r) => isParseError(r.value)).length;
let pages = 1;
let tilingErrors = 0;
let longest = 0;
let slowestMs = firstMs;
const checkTiling = (recs: { offset: number; length: number }[], start: number, end: number): void => {
  let at = start;
  for (const r of recs) {
    if (r.offset !== at) tilingErrors++;
    at = r.offset + r.length;
    if (r.length > longest) longest = r.length;
  }
  if (at !== end) tilingErrors++;
};
checkTiling(first.records, first.startOffset, first.endOffset);
let page = first;
t0 = performance.now();
while (page.hasMoreBefore) {
  const before = page.startOffset;
  const tp = performance.now();
  page = await readTail(file, { maxRecords: pageSize, beforeOffset: before, stats: allStats });
  slowestMs = Math.max(slowestMs, performance.now() - tp);
  pages++;
  if (page.endOffset !== before) tilingErrors++;
  checkTiling(page.records, page.startOffset, page.endOffset);
  records += page.records.length;
  for (const r of page.records) if (isParseError(r.value)) parseErrors++;
}
const pagingMs = performance.now() - t0 + firstMs;
console.log(
  `full paging: ${pages} pages, ${records} records, ${parseErrors} parse errors, last page startOffset ${page.startOffset}, ` +
    `tiling errors ${tilingErrors}, longest line ${longest} bytes (${mb(longest)})`,
);
console.log(
  `full paging cost: ${(pagingMs / 1000).toFixed(1)}s, slowest page ${slowestMs.toFixed(1)}ms, read ${mb(allStats.bytesRead)} ` +
    `for ${mb(first.endOffset)} of lines (${(allStats.bytesRead / first.endOffset).toFixed(3)}x)`,
);

// 3. Independent count of the same range.
const newlines = await countNewlines(file, first.endOffset);
console.log(`independent newline count of [0, ${first.endOffset}): ${newlines} -> ${newlines === records ? "MATCH" : "MISMATCH"}`);
console.log(`size now: ${fs.statSync(file).size} bytes (grew ${fs.statSync(file).size - sizeAtStart} during the check)`);
console.log(`compare: head -c ${first.endOffset} '${file}' | wc -l`);
