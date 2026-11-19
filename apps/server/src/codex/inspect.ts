// Read-only check of the Codex source against the real accounts in config.ts: start() once,
// print what the first snapshot holds and how it was read, then stop().
//
//   node apps/server/src/codex/inspect.ts
//
// The daemon receives only initialize, thread/list and thread/read; state databases are
// opened read-only.

import type { IndexEvent, SessionSummary } from "@maru/shared";
import { CODEX_ACCOUNTS } from "../config.ts";
import { createCodexSource } from "./source.ts";

function count<T>(items: T[], keyOf: (item: T) => string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = keyOf(it) ?? "(null)";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const events: IndexEvent[] = [];
const source = createCodexSource(CODEX_ACCOUNTS);
const t0 = performance.now();
await source.start((e) => events.push(e));
const totalMs = Math.round(performance.now() - t0);

const sessions = new Map<string, SessionSummary>();
for (const e of events) {
  if (e.type === "upsert") sessions.set(e.session.key, e.session);
  else sessions.delete(e.key);
}

console.log(`start() resolved in ${totalMs} ms; events: ${events.length} (${events.filter((e) => e.type === "remove").length} removes)`);
for (const st of source.stats().accounts) {
  const mine = [...sessions.values()].filter((s) => s.account === st.account);
  console.log(`\n== ${st.account}  (${st.home})`);
  console.log(`mode: ${st.mode}   socket present: ${st.socketPresent}   first snapshot: ${st.startMs} ms`);
  console.log(`threads: ${st.indexed}   by status: ${JSON.stringify(st.byStatus)}`);
  if (st.lastSync) {
    const s = st.lastSync;
    console.log(
      `daemon snapshot: ${s.ms} ms, ${s.pages} page(s), listed ${s.listed}, duplicate ids ${s.duplicates}, ` +
        `ephemeral ${s.ephemeral}, subagents via thread/read ${s.children.read}/${s.children.candidates} ` +
        `(unreadable ${s.children.unreadable})`,
    );
  }
  if (st.lastFallback) {
    const f = st.lastFallback;
    console.log(
      `state db: ${f.missing ? "missing" : `${f.rows} unarchived row(s)`}, invalid ${f.invalidRows}, ${f.ms} ms` +
        (f.error ? `, error: ${f.error}` : ""),
    );
  }
  console.log(`subagents (parentKey set): ${mine.filter((s) => s.parentKey !== null).length}`);
  console.log(`named: ${mine.filter((s) => s.name !== null).length}   with title: ${mine.filter((s) => s.title !== null).length}`);
  console.log(`entrypoint: ${JSON.stringify(count(mine, (s) => s.entrypoint))}`);
  console.log(`owner: ${JSON.stringify(count(mine, (s) => s.owner))}`);
  console.log(
    `rpc: connects ${st.rpc.connects}, failed attempts ${st.rpc.failedAttempts}, requests ${st.rpc.requests}, ` +
      `error answers ${st.rpc.errorResponses}, notifications ${JSON.stringify(st.rpc.notifications)}`,
  );
  if (st.lastError) console.log(`last error: ${st.lastError}`);
  if (st.unknownStatusValues.length) console.log(`unknown status values: ${st.unknownStatusValues.join(", ")}`);
}

await source.stop();
