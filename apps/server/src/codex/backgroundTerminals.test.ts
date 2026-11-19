import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexBackgroundTerminals, endOfItem, type TerminalRpc } from "./backgroundTerminals.ts";
import { RpcError } from "./rpc.ts";

const TID = "11111111-2222-4333-8444-555555555555";
const KEY = `codex:cx:${TID}`;

interface Term { itemId: string; processId: string; command: string; cwd: string }
const term = (n: number, command = `sleep ${n}`): Term => ({ itemId: `exec-${n}`, processId: String(100 + n), command, cwd: "/w" });

/** A daemon that lists `running`, answers `items` newest first in pages of `pageSize`, and records calls. */
function fake(state: { running: Term[]; items: unknown[]; unloaded?: boolean; pageSize?: number; terminated?: string[] }) {
  const calls: string[] = [];
  const rpc: TerminalRpc = {
    async request(method: string, params: any): Promise<any> {
      calls.push(method);
      if (method === "thread/backgroundTerminals/list") {
        if (state.unloaded) throw new RpcError(method, -32600, `thread not found: ${params.threadId}`);
        return { data: state.running.map((t) => ({ ...t, osPid: null, cpuPercent: null, rssKb: null })), nextCursor: null };
      }
      if (method === "thread/items/list") {
        const size = state.pageSize ?? 50;
        const from = params.cursor ? Number(params.cursor) : 0;
        const data = state.items.slice(from, from + size);
        return { data, nextCursor: from + size < state.items.length ? String(from + size) : null };
      }
      if (method === "thread/backgroundTerminals/terminate") {
        const hit = state.running.some((t) => t.processId === params.processId);
        if (hit) state.terminated?.push(params.processId);
        return { terminated: hit };
      }
      throw new Error(`unexpected ${method}`);
    },
    async close() {},
  } as TerminalRpc;
  return { rpc, calls };
}

function service(state: Parameters<typeof fake>[0], now: { t: number }) {
  const f = fake(state);
  const svc = new CodexBackgroundTerminals({ accounts: [{ id: "cx", home: "/h" }], open: async () => f.rpc, now: () => now.t });
  return { svc, ...f };
}

const exec = (n: number, over: Record<string, unknown>, completedAtMs: number, durationMs = 5000) => ({
  turnId: "t", startedAtMs: completedAtMs - durationMs, completedAtMs,
  item: { type: "commandExecution", id: `exec-${n}`, status: "completed", exitCode: 0, durationMs, aggregatedOutput: null, ...over },
});

test("a running terminal is a running row without a start time; its first sighting orders it", async () => {
  const now = { t: 1_000_000 };
  const { svc } = service({ running: [term(1, "python3 -c 'x'\nsecond line")], items: [] }, now);
  const rows = await svc.rows(KEY);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { id: rows[0]!.id, kind: rows[0]!.kind, title: rows[0]!.title, status: rows[0]!.status, startedAt: rows[0]!.startedAt, cwd: rows[0]!.cwd, command: rows[0]!.command },
    { id: "exec-1", kind: "shell", title: "python3 -c 'x'", status: "running", startedAt: null, cwd: "/w", command: "python3 -c 'x'\nsecond line" },
  );
  assert.equal(rows[0]!.updatedAt, new Date(1_000_000).toISOString());
  now.t += 5000;
  assert.equal((await svc.rows(KEY))[0]!.updatedAt, new Date(1_000_000).toISOString(), "a later read keeps the first sighting");
});

test("a terminal that leaves the list ends as its item says: completed with exit code, duration and output", async () => {
  const now = { t: 1_000_000 };
  const state = { running: [term(1)], items: [] as unknown[] };
  const { svc } = service(state, now);
  await svc.rows(KEY);
  now.t = 1_009_000;
  state.running = [];
  state.items = [exec(1, { aggregatedOutput: "done-second\n" }, 1_008_500, 8950)];
  const [row] = await svc.rows(KEY);
  assert.equal(row!.status, "completed");
  assert.equal(row!.exitCode, 0);
  assert.equal(row!.completedAt, new Date(1_008_500).toISOString());
  assert.equal(row!.startedAt, new Date(1_008_500 - 8950).toISOString());
  assert.deepEqual(svc.output(KEY, "exec-1"), { output: "done-second\n", totalBytes: 12, truncated: false });
});

test("exit code -1 on a failed item is a killed terminal (중단됨); another failure is failed", async () => {
  assert.equal(endOfItem(exec(1, { status: "failed", exitCode: -1 }, 10), 99)!.status, "cancelled");
  const failed = endOfItem(exec(1, { status: "failed", exitCode: 3 }, 10), 99)!;
  assert.deepEqual([failed.status, failed.exitCode], ["failed", 3]);
  assert.equal(endOfItem({ item: { type: "agentMessage", id: "x" } }, 99), null);
});

test("an item not found ends as interrupted, and is looked up again for a short while", async () => {
  const now = { t: 1_000_000 };
  const state = { running: [term(1)], items: [] as unknown[] };
  const { svc } = service(state, now);
  await svc.rows(KEY);
  state.running = [];
  now.t += 2000;
  assert.equal((await svc.rows(KEY))[0]!.status, "interrupted");
  // The item reaches the thread's items a moment later: the row takes its end.
  state.items = [exec(1, { status: "failed", exitCode: -1 }, now.t + 500)];
  now.t += 2000;
  assert.equal((await svc.rows(KEY))[0]!.status, "cancelled");
});

test("an interrupted row is final once the settle window has passed", async () => {
  const now = { t: 1_000_000 };
  const state = { running: [term(1)], items: [] as unknown[] };
  const { svc, calls } = service(state, now);
  await svc.rows(KEY);
  state.running = [];
  now.t += 2000;
  await svc.rows(KEY);
  now.t += 20_000;
  await svc.rows(KEY);
  const itemReads = calls.filter((c) => c === "thread/items/list").length;
  await svc.rows(KEY);
  assert.equal(calls.filter((c) => c === "thread/items/list").length, itemReads, "no more lookups for it");
});

test("the item walk pages newest first and stops at items older than the first sighting", async () => {
  const now = { t: 1_000_000 };
  const old = Array.from({ length: 5 }, (_, i) => exec(50 + i, {}, 900_000 - i));
  const state = { running: [term(1)], items: [] as unknown[], pageSize: 2 };
  const { svc, calls } = service(state, now);
  await svc.rows(KEY);
  state.running = [];
  now.t += 1000;
  // Newest first: a later terminal's item, then the older ones that completed before the sighting.
  state.items = [exec(9, {}, 1_000_900), ...old, exec(1, {}, 800_000)];
  const [row] = await svc.rows(KEY);
  assert.equal(row!.status, "interrupted", "its item is not among the ones newer than the sighting");
  assert.equal(calls.filter((c) => c === "thread/items/list").length, 2, "stopped after the first page whose items all predate the sighting");
});

test("the walk follows the cursor to an item on a later page", async () => {
  const now = { t: 1_000_000 };
  const state = { running: [term(1)], items: [] as unknown[], pageSize: 2 };
  const { svc } = service(state, now);
  await svc.rows(KEY);
  state.running = [];
  now.t += 1000;
  state.items = [exec(7, {}, 1_000_900), exec(8, {}, 1_000_800), exec(1, {}, 1_000_700), exec(6, {}, 1_000_100)];
  assert.equal((await svc.rows(KEY))[0]!.status, "completed");
});

test("an unloaded thread (thread not found) lists nothing and still resolves what was seen", async () => {
  const now = { t: 1_000_000 };
  const state: Parameters<typeof fake>[0] = { running: [term(1)], items: [] };
  const { svc } = service(state, now);
  await svc.rows(KEY);
  state.unloaded = true;
  state.items = [exec(1, { status: "failed", exitCode: -1 }, 1_050_000, 62_227)];
  now.t += 60_000;
  const [row] = await svc.rows(KEY);
  assert.equal(row!.status, "cancelled");
  assert.equal(svc.output(KEY, "exec-1"), null, "a killed terminal has no output");
});

test("a read that fails for another reason rejects instead of showing an empty list", async () => {
  const f = fake({ running: [], items: [] });
  const svc = new CodexBackgroundTerminals({
    accounts: [{ id: "cx", home: "/h" }],
    open: async () => ({ ...f.rpc, request: async () => { throw new RpcError("x", -32603, "boom"); } }) as TerminalRpc,
  });
  await assert.rejects(svc.rows(KEY), /boom/);
});

test("terminate names the daemon's process id for a row it saw; a finished one answers false", async () => {
  const now = { t: 1_000_000 };
  const terminated: string[] = [];
  const state = { running: [term(1), term(2)], items: [] as unknown[], terminated };
  const { svc } = service(state, now);
  await svc.rows(KEY);
  assert.equal(await svc.terminate(KEY, "exec-2"), true);
  assert.deepEqual(terminated, ["102"]);
  state.running = state.running.filter((t) => t.itemId !== "exec-2");
  assert.equal(await svc.terminate(KEY, "exec-2"), false);
  assert.equal(await svc.terminate(KEY, "nope"), false, "a row this server never saw");
  assert.equal(svc.knows(KEY, "exec-1"), true);
  assert.equal(svc.knows(KEY, "nope"), false);
});

test("output keeps the end of a long output and says it cut", async () => {
  const text = `${"x".repeat(70_000)}\nlast line\n`;
  const end = endOfItem(exec(1, { aggregatedOutput: text }, 10), 99)!;
  assert.equal(end.output!.truncated, true);
  assert.equal(end.output!.totalBytes, Buffer.byteLength(text));
  assert.ok(end.output!.text.endsWith("last line\n"));
  assert.ok(Buffer.byteLength(end.output!.text) <= 64 * 1024);
});

test("reads of one key made together make one daemon read", async () => {
  const now = { t: 1_000_000 };
  const { svc, calls } = service({ running: [term(1)], items: [] }, now);
  await Promise.all([svc.rows(KEY), svc.rows(KEY), svc.rows(KEY)]);
  assert.equal(calls.filter((c) => c === "thread/backgroundTerminals/list").length, 1);
});

test("an account whose daemon cannot be reached gives no rows and is tried again at the next read", async () => {
  let opens = 0;
  const svc = new CodexBackgroundTerminals({ accounts: [{ id: "cx", home: "/h" }], open: async () => { opens++; return null; } });
  assert.deepEqual(await svc.rows(KEY), []);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await svc.rows(KEY), []);
  assert.equal(opens, 2);
});
