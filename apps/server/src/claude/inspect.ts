// Read-only check of the Claude index against the real config dirs.
// Run from the project root: node apps/server/src/claude/inspect.ts
// Prints the first snapshot (counts by status, owner, entrypoint), the source's stats, and an
// independent count of top-level transcripts to compare with the index. Writes nothing.
import fs from "node:fs";
import path from "node:path";
import type { SessionSummary } from "@maru/shared";
import { CLAUDE_ACCOUNTS } from "../config.ts";
import { createClaudeSource } from "./source.ts";

function countBy<T>(items: T[], f: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of items) out[f(x)] = (out[f(x)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort());
}

/** Counted without the source's code: plain readdir/stat of projects/<enc>/<sid>.jsonl. */
function independentCount(): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const acc of CLAUDE_ACCOUNTS) {
    const projects = path.join(acc.dir, "projects");
    if (!fs.existsSync(projects)) continue;
    for (const enc of fs.readdirSync(projects)) {
      const dir = path.join(projects, enc);
      if (!fs.lstatSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const st = fs.lstatSync(path.join(dir, name));
        if (!st.isFile()) continue;
        files++;
        bytes += st.size;
      }
    }
  }
  return { files, bytes };
}

// `--watch <seconds>` keeps the source running after the snapshot and logs live events.
const watchArg = process.argv.indexOf("--watch");
const watchSec = watchArg === -1 ? 0 : Number(process.argv[watchArg + 1] ?? 30);

const sessions: SessionSummary[] = [];
let snapshotDone = false;
const live: string[] = [];
const source = createClaudeSource(CLAUDE_ACCOUNTS);
const t0 = performance.now();
await source.start((e) => {
  if (!snapshotDone) {
    if (e.type === "upsert") sessions.push(e.session);
    return;
  }
  const at = ((performance.now() - t0) / 1000).toFixed(1);
  live.push(
    e.type === "upsert"
      ? `  +${at}s upsert ${e.session.key} ${e.session.status} owner=${e.session.owner} size=${e.session.sizeBytes}`
      : `  +${at}s remove ${e.key}`,
  );
});
snapshotDone = true;
const elapsedMs = performance.now() - t0;
const snapshotStats = source.stats();
if (watchSec > 0) await new Promise((r) => setTimeout(r, watchSec * 1000));
const stats = source.stats();
await source.stop();

const indep = independentCount();
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;

console.log(`first snapshot: ${sessions.length} sessions in ${elapsedMs.toFixed(0)}ms`);
console.log("by account:", countBy(sessions, (s) => s.account));
console.log("by status:", countBy(sessions, (s) => s.status));
console.log("by owner:", countBy(sessions, (s) => s.owner));
console.log("by entrypoint:", countBy(sessions, (s) => s.entrypoint ?? "(null)"));
console.log("null fields:", {
  cwd: sessions.filter((s) => s.cwd === null).length,
  name: sessions.filter((s) => s.name === null).length,
  title: sessions.filter((s) => s.title === null).length,
  preview: sessions.filter((s) => s.preview === null).length,
  createdAt: sessions.filter((s) => s.createdAt === null).length,
  nameAndTitle: sessions.filter((s) => s.name === null && s.title === null).length,
});
console.log("open sessions:");
for (const s of sessions.filter((x) => x.status !== "closed")) {
  console.log(`  ${s.key} ${s.status} owner=${s.owner} pid=${s.pid} pane=${s.tmuxPane} entry=${s.entrypoint}`);
}
console.log(
  `independent count: ${indep.files} transcripts, ${mb(indep.bytes)}; indexed ${snapshotStats.indexed}; ` +
    `snapshot read ${mb(snapshotStats.reads.bytesRead)} ` +
    `(${((snapshotStats.reads.bytesRead / indep.bytes) * 100).toFixed(2)}% of total)`,
);
console.log("snapshot stats:", JSON.stringify(snapshotStats, null, 2));
if (watchSec > 0) {
  console.log(`live events over ${watchSec}s (${live.length}):`);
  for (const line of live) console.log(line);
  console.log("stats after watching:", JSON.stringify({ reads: stats.reads, watch: stats.watch, emitted: stats.emitted, sweeps: stats.sweeps, lastError: stats.lastError }, null, 2));
}
