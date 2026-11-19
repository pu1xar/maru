import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import { sessionKey } from "@maru/shared";
import type { IndexEvent, SessionSummary } from "@maru/shared";
import { DaemonError, FakeDaemon, makeThread, waitFor } from "./fake-daemon.ts";
import type { Thread } from "./protocol/v2/Thread.ts";
import { STATE_DB_FILE, createCodexSource } from "./source.ts";
import type { CodexSource, CodexSourceOptions } from "./source.ts";

const ACCOUNT = "codex-test";
const FAST: CodexSourceOptions = { backoff: { initialMs: 10, maxMs: 40 }, requestTimeoutMs: 2000, fallbackPollMs: 30 };
const ALL_KINDS = [
  "appServer",
  "cli",
  "exec",
  "subAgent",
  "subAgentCompact",
  "subAgentOther",
  "subAgentReview",
  "subAgentThreadSpawn",
  "unknown",
  "vscode",
];
const READ_METHODS = new Set(["initialize", "initialized", "thread/list", "thread/read"]);

const key = (id: string): string => sessionKey("codex", ACCOUNT, id);

class Sink {
  readonly events: IndexEvent[] = [];
  readonly emit = (e: IndexEvent): void => {
    this.events.push(e);
  };
  state(): Map<string, SessionSummary> {
    const m = new Map<string, SessionSummary>();
    for (const e of this.events) {
      if (e.type === "upsert") m.set(e.session.key, e.session);
      else m.delete(e.key);
    }
    return m;
  }
  get(id: string): SessionSummary | undefined {
    return this.state().get(key(id));
  }
  /** Events after the first n, as sorted "upsert <id>" / "remove <id>" lines. */
  since(n: number): string[] {
    return this.events
      .slice(n)
      .map((e) => (e.type === "upsert" ? `upsert ${e.session.id}` : `remove ${e.key.split(":").at(-1)}`))
      .sort();
  }
}

function assertOnlyReadCalls(d: FakeDaemon): void {
  const methods = new Set(d.received.map((r) => r.method).filter((m) => m !== null));
  for (const m of methods) assert.ok(READ_METHODS.has(m!), `daemon received a non-read call: ${m}`);
}

const DB_COLUMNS = [
  "id",
  "rollout_path",
  "created_at",
  "updated_at",
  "source",
  "cwd",
  "title",
  "archived",
  "first_user_message",
  "preview",
  "name",
  "originator",
  "created_at_ms",
  "updated_at_ms",
] as const;
type DbRow = Partial<Record<(typeof DB_COLUMNS)[number], SQLInputValue>> & { id: string };

function dbRow(r: DbRow): SQLInputValue[] {
  const full: Record<string, SQLInputValue> = {
    rollout_path: `/r/${r.id}.jsonl`,
    created_at: 1_794_000_000,
    updated_at: 1_794_000_100,
    source: "cli",
    cwd: `/work/${r.id}`,
    title: null,
    archived: 0,
    first_user_message: null,
    preview: `p ${r.id}`,
    name: null,
    originator: "codex-tui",
    created_at_ms: 1_794_000_000_000,
    updated_at_ms: 1_794_000_100_000,
    ...r,
  };
  return DB_COLUMNS.map((c) => full[c] ?? null);
}

function writeStateDb(home: string, rows: DbRow[]): string {
  const file = path.join(home, STATE_DB_FILE);
  const db = new DatabaseSync(file);
  db.exec(
    `CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER,
      updated_at INTEGER, source TEXT, cwd TEXT, title TEXT, archived INTEGER NOT NULL DEFAULT 0,
      first_user_message TEXT, preview TEXT, name TEXT, originator TEXT, created_at_ms INTEGER,
      updated_at_ms INTEGER)`,
  );
  const insert = db.prepare(`INSERT INTO threads (${DB_COLUMNS.join(", ")}) VALUES (${DB_COLUMNS.map(() => "?").join(", ")})`);
  for (const r of rows) insert.run(...dbRow(r));
  db.close();
  return file;
}

function execDb(file: string, sql: string, ...rows: DbRow[]): void {
  const db = new DatabaseSync(file);
  if (sql) db.exec(sql);
  const insert = db.prepare(`INSERT INTO threads (${DB_COLUMNS.join(", ")}) VALUES (${DB_COLUMNS.map(() => "?").join(", ")})`);
  for (const r of rows) insert.run(...dbRow(r));
  db.close();
}

const subagentSource = (parent: string): string =>
  JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: "/root/x", agent_nickname: "N", agent_role: null } } });

async function started(
  t: { after: (fn: () => Promise<void>) => void },
  home: string,
  opts: CodexSourceOptions = {},
): Promise<{ src: CodexSource; sink: Sink }> {
  const src = createCodexSource([{ id: ACCOUNT, home }], { ...FAST, ...opts });
  const sink = new Sink();
  await src.start(sink.emit);
  t.after(() => src.stop());
  return { src, sink };
}

const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("daemon snapshot reads every page with all source kinds and maps each thread", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  const a = makeThread("a", { status: { type: "notLoaded" }, name: "named a", createdAt: 100, updatedAt: 200 });
  const bNew = makeThread("b", { status: { type: "idle" }, updatedAt: 300 });
  const bOld = makeThread("b", { status: { type: "idle" }, updatedAt: 250 });
  const c = makeThread("c", { status: { type: "active", activeFlags: [] } });
  const e = makeThread("e", { status: { type: "active", activeFlags: ["waitingOnUserInput"] } });
  const f = makeThread("f", { status: { type: "active", activeFlags: ["waitingOnApproval"] } });
  const g = makeThread("g", { status: { type: "systemError" }, originator: null, source: "exec" });
  const h = makeThread("h", { ephemeral: true });
  const pages: Thread[][] = [[a, bOld], [c, bNew], [e, f], [g, h]];
  d.handlers.set("thread/list", (p) => {
    const i = typeof p.cursor === "string" ? Number(p.cursor) : 0;
    return { data: pages[i], nextCursor: i + 1 < pages.length ? String(i + 1) : null, backwardsCursor: null };
  });
  // A subagent: thread/list leaves it out, the state database names it, thread/read returns it.
  d.threads.set("s", makeThread("s", { parentThreadId: "a", status: { type: "idle" } }));
  writeStateDb(d.home, [{ id: "a" }, { id: "s", source: subagentSource("a") }]);
  await d.listen();

  const own = new Set(["a", "c"]);
  const { src, sink } = await started(t, d.home, { ownThreadIds: () => own });

  const lists = d.calls("thread/list");
  assert.deepEqual(
    lists.map((l) => l.params.cursor),
    [null, "1", "2", "3"],
  );
  for (const l of lists) {
    assert.equal(l.params.archived, false);
    assert.equal(l.params.limit, 100);
    assert.deepEqual([...(l.params.sourceKinds as string[])].sort(), ALL_KINDS);
  }

  assert.equal(sink.events.length, 7);
  assert.ok(sink.events.every((ev) => ev.type === "upsert"));
  const ids = ["a", "b", "c", "e", "f", "g", "s"];
  assert.deepEqual([...sink.state().keys()].sort(), ids.map(key).sort());
  assert.deepEqual(
    ids.map((id) => [id, sink.get(id)!.status, sink.get(id)!.owner]),
    [
      ["a", "closed", "none"],
      ["b", "open-idle", "terminal"],
      ["c", "running", "ui"],
      ["e", "waiting-input", "terminal"],
      ["f", "waiting-input", "terminal"],
      ["g", "error", "terminal"],
      ["s", "open-idle", "terminal"],
    ],
  );
  assert.deepEqual(sink.get("a"), {
    key: key("a"),
    provider: "codex",
    account: ACCOUNT,
    id: "a",
    cwd: "/work/a",
    name: "named a",
    title: null,
    preview: "preview a",
    status: "closed",
    owner: "none",
    pid: null,
    tmuxPane: null,
    parentKey: null,
    updatedAt: 200_000,
    createdAt: 100_000,
    sizeBytes: null,
    entrypoint: "codex-tui",
  });
  assert.equal(sink.get("b")!.updatedAt, 300_000, "the newer of two records with one id wins");
  assert.equal(sink.get("g")!.entrypoint, "exec", "source kind when originator is null");
  assert.equal(sink.get("s")!.parentKey, key("a"));

  const st = src.stats().accounts[0]!;
  assert.equal(st.mode, "daemon");
  assert.deepEqual(
    { pages: st.lastSync?.pages, listed: st.lastSync?.listed, duplicates: st.lastSync?.duplicates, ephemeral: st.lastSync?.ephemeral },
    { pages: 4, listed: 8, duplicates: 1, ephemeral: 1 },
  );
  assert.deepEqual(st.lastSync?.children, { candidates: 1, read: 1, unreadable: 0 });
  assert.equal(st.indexed, 7);
  assertOnlyReadCalls(d);
});

test("notifications update only the thread they name", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  d.threads.set("a", makeThread("a", { status: { type: "idle" }, updatedAt: 1000 }));
  d.threads.set("b", makeThread("b"));
  d.threads.set("u", makeThread("u", { parentThreadId: "a", status: { type: "active", activeFlags: [] } }));
  await d.listen();
  const { src, sink } = await started(t, d.home);
  assert.deepEqual([...sink.state().keys()].sort(), [key("a"), key("b")]);

  // Rename: one upsert. The follow-up thread/read returns the old name; the newer notification wins.
  let n = sink.events.length;
  d.notify("thread/name/updated", { threadId: "a", threadName: "renamed" });
  await waitFor(() => d.calls("thread/read").length === 1, "refresh after rename");
  await settle();
  assert.deepEqual(sink.since(n), ["upsert a"]);
  assert.equal(sink.get("a")!.name, "renamed");

  // Status change: the status at once, then the record's new preview and updatedAt from thread/read.
  d.threads.set("a", makeThread("a", { status: { type: "active", activeFlags: [] }, preview: "fresh", updatedAt: 1050 }));
  d.notify("thread/status/changed", { threadId: "a", status: { type: "active", activeFlags: [] } });
  await waitFor(() => sink.get("a")?.preview === "fresh", "preview from refresh");
  assert.equal(sink.get("a")!.status, "running");
  assert.equal(sink.get("a")!.updatedAt, 1_050_000);
  assert.equal(sink.get("a")!.name, "renamed");

  // A thread this index has not seen (a subagent) is read in.
  d.notify("thread/status/changed", { threadId: "u", status: { type: "active", activeFlags: [] } });
  await waitFor(() => sink.get("u") !== undefined, "subagent read in");
  assert.equal(sink.get("u")!.parentKey, key("a"));
  assert.equal(sink.get("u")!.status, "running");

  n = sink.events.length;
  d.notify("thread/archived", { threadId: "b" });
  d.notify("thread/started", { thread: makeThread("n", { status: { type: "idle" } }) });
  d.notify("thread/started", { thread: makeThread("eph", { ephemeral: true, status: { type: "idle" } }) });
  d.notify("thread/tokenUsage/updated", { threadId: "a" });
  await waitFor(() => sink.get("n") !== undefined && sink.get("b") === undefined, "archive and start");
  assert.deepEqual(sink.since(n), ["remove b", "upsert n"]);
  assert.equal(src.stats().accounts[0]!.ephemeralSkipped, 1);

  d.threads.set("n", makeThread("n", { status: { type: "notLoaded" } }));
  d.notify("thread/closed", { threadId: "n" });
  await waitFor(() => sink.get("n")?.status === "closed", "closed");
  assert.equal(sink.get("n")!.owner, "none");

  d.threads.set("z", makeThread("z", { status: { type: "notLoaded" } }));
  d.notify("thread/unarchived", { threadId: "z" });
  await waitFor(() => sink.get("z") !== undefined, "unarchived read in");

  d.notify("thread/deleted", { threadId: "a" });
  await waitFor(() => sink.get("a") === undefined, "deleted");
  await settle();
  assert.deepEqual([...sink.state().keys()].sort(), ["n", "u", "z"].map(key));
  assert.equal(src.stats().accounts[0]!.rpc.notifications["thread/tokenUsage/updated"], 1);
  assertOnlyReadCalls(d);
});

test("the state database decides archive state and supplies titles in daemon mode", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  // thread/list returns both; the dashboard trash left b's rollout in sessions/ with archived = 1.
  d.threads.set("a", makeThread("a", { status: { type: "notLoaded" } }));
  d.threads.set("b", makeThread("b", { status: { type: "notLoaded" } }));
  writeStateDb(d.home, [{ id: "a", title: "title a" }, { id: "b", archived: 1 }]);
  await d.listen();
  const { src, sink } = await started(t, d.home);
  assert.deepEqual([...sink.state().keys()], [key("a")]);
  assert.equal(sink.get("a")!.title, "title a");
  assert.equal(src.stats().accounts[0]!.lastSync!.archivedInDb, 1);

  // A status refresh of the archived thread keeps it out; an unarchive brings it in.
  d.notify("thread/status/changed", { threadId: "b", status: { type: "idle" } });
  await waitFor(() => d.calls("thread/read").length === 1, "refresh of b");
  await settle();
  assert.equal(sink.get("b"), undefined);
  d.notify("thread/unarchived", { threadId: "b" });
  await waitFor(() => sink.get("b") !== undefined, "unarchived b");
  assertOnlyReadCalls(d);
});

test("an archive right after a status change is not undone by the status refresh", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  d.threads.set("a", makeThread("a", { status: { type: "idle" } }));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await d.listen();
  const { sink } = await started(t, d.home);
  d.handlers.set("thread/read", async (p) => {
    await gate;
    return { thread: d.threads.get(String(p.threadId)) };
  });

  // The daemon's order when archiving: status notLoaded, then archived.
  d.notify("thread/status/changed", { threadId: "a", status: { type: "notLoaded" } });
  d.notify("thread/archived", { threadId: "a" });
  await waitFor(() => sink.get("a") === undefined, "removed");
  release();
  await settle();
  assert.equal(sink.get("a"), undefined);
});

test("notifications during the snapshot are applied after it", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  d.threads.set("a", makeThread("a", { status: { type: "idle" } }));
  d.threads.set("b", makeThread("b", { status: { type: "idle" } }));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  d.handlers.set("thread/list", async () => {
    await gate;
    // The list was taken before the notifications below.
    const data = ["a", "b"].map((id) => makeThread(id, { status: { type: "idle" } }));
    return { data, nextCursor: null, backwardsCursor: null };
  });
  await d.listen();
  const src = createCodexSource([{ id: ACCOUNT, home: d.home }], FAST);
  t.after(() => src.stop());
  const sink = new Sink();
  const starting = src.start(sink.emit);

  await waitFor(() => d.calls("thread/list").length === 1, "list requested");
  d.notify("thread/status/changed", { threadId: "a", status: { type: "active", activeFlags: ["waitingOnApproval"] } });
  d.notify("thread/name/updated", { threadId: "a", threadName: "during" });
  d.notify("thread/archived", { threadId: "b" });
  d.notify("thread/started", { thread: makeThread("c", { status: { type: "idle" } }) });
  await waitFor(() => src.stats().accounts[0]!.rpc.notifications["thread/started"] === 1, "notifications arrived");
  release();
  await starting;

  assert.equal(sink.get("a")!.status, "waiting-input");
  assert.equal(sink.get("a")!.name, "during");
  assert.equal(sink.get("b"), undefined, "archived during the snapshot");
  assert.equal(sink.get("c")!.status, "open-idle", "started during the snapshot");
  // thread/read still says idle with no name; the notifications are newer.
  await waitFor(() => d.calls("thread/read").length >= 1, "refresh");
  await settle();
  assert.equal(sink.get("a")!.status, "waiting-input");
  assert.equal(sink.get("a")!.name, "during");
});

test("a reconnect re-reads the list and emits only the differences", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  for (const id of ["a", "b", "c"]) d.threads.set(id, makeThread(id, { status: { type: "idle" } }));
  d.threads.set("u", makeThread("u", { parentThreadId: "a", status: { type: "idle" } }));
  await d.listen();
  const { src, sink } = await started(t, d.home);
  d.notify("thread/status/changed", { threadId: "u", status: { type: "idle" } });
  await waitFor(() => sink.get("u") !== undefined, "subagent learned from a notification");
  await settle();

  const n = sink.events.length;
  d.threads.set("a", makeThread("a", { status: { type: "idle" }, name: "renamed offline" }));
  d.threads.delete("b");
  d.threads.set("d1", makeThread("d1", { status: { type: "idle" } }));
  d.dropConnections();
  await waitFor(() => src.stats().accounts[0]!.syncs === 2, "second snapshot");

  assert.deepEqual(sink.since(n), ["remove b", "upsert a", "upsert d1"]);
  assert.equal(sink.get("u")!.parentKey, key("a"), "the subagent outside thread/list is kept");
  const st = src.stats().accounts[0]!;
  assert.equal(st.mode, "daemon");
  assert.equal(st.modeSwitches, 0);
  assert.equal(d.calls("initialize").length, 2);
  assertOnlyReadCalls(d);
});

test("without a daemon the state database is read read-only and polled for changes", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cxdb"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const emptyHome = path.join(base, "empty");
  fs.mkdirSync(home);
  fs.mkdirSync(emptyHome);
  const file = writeStateDb(home, [
    { id: "r1", name: "n1", title: "t1", preview: "p1", updated_at_ms: 1_794_000_000_123, created_at_ms: 1_793_000_000_000 },
    { id: "r2", archived: 1 },
    { id: "r3", source: subagentSource("r1"), originator: null, preview: null, first_user_message: "first" },
    { id: "r4", updated_at_ms: null, updated_at: 1_794_000_001, source: "exec", originator: null },
  ]);
  const hash = (): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const before = hash();

  const own = new Set(["r1"]);
  const src = createCodexSource(
    [
      { id: ACCOUNT, home },
      { id: "codex-empty", home: emptyHome },
    ],
    { ...FAST, ownThreadIds: () => own },
  );
  t.after(() => src.stop());
  const sink = new Sink();
  await src.start(sink.emit);

  assert.deepEqual([...sink.state().keys()].sort(), ["r1", "r3", "r4"].map(key));
  assert.deepEqual(sink.get("r1"), {
    key: key("r1"),
    provider: "codex",
    account: ACCOUNT,
    id: "r1",
    cwd: "/work/r1",
    name: "n1",
    title: "t1",
    preview: "p1",
    status: "closed",
    owner: "none",
    pid: null,
    tmuxPane: null,
    parentKey: null,
    updatedAt: 1_794_000_000_123,
    createdAt: 1_793_000_000_000,
    sizeBytes: null,
    entrypoint: "codex-tui",
  });
  assert.equal(sink.get("r3")!.parentKey, key("r1"));
  assert.equal(sink.get("r3")!.preview, "first");
  assert.equal(sink.get("r3")!.entrypoint, "subagent");
  assert.equal(sink.get("r4")!.updatedAt, 1_794_000_001_000);
  assert.equal(sink.get("r4")!.entrypoint, "exec");

  const [main, empty] = src.stats().accounts;
  assert.equal(main!.mode, "fallback");
  assert.equal(main!.lastFallback?.rows, 3);
  assert.equal(main!.rpc.connects, 0);
  assert.equal(empty!.mode, "fallback");
  assert.equal(empty!.lastFallback?.missing, true);
  assert.equal(empty!.indexed, 0);

  // Polls leave the database untouched.
  await waitFor(() => src.stats().accounts[0]!.fallbackReads >= 3, "polls");
  assert.equal(hash(), before);
  assert.deepEqual(fs.readdirSync(home), [STATE_DB_FILE]);

  const n = sink.events.length;
  execDb(file, "UPDATE threads SET name = 'n1b' WHERE id = 'r1'; UPDATE threads SET archived = 1 WHERE id = 'r3';", { id: "r5" });
  await waitFor(() => sink.get("r5") !== undefined, "poll picks up the change");
  await settle(80);
  assert.deepEqual(sink.since(n), ["remove r3", "upsert r1", "upsert r5"]);
  assert.equal(sink.get("r1")!.name, "n1b");
});

test("size is the rollout file's; a subagent thread's title is its nickname (daemon and state database)", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  const rollout = (id: string, bytes: number): string => {
    const file = path.join(d.home, `rollout-${id}.jsonl`);
    fs.writeFileSync(file, "x".repeat(bytes));
    return file;
  };
  const aPath = rollout("a", 1234);
  const sPath = rollout("s", 56);
  d.threads.set("a", makeThread("a", { status: { type: "idle" }, path: aPath }));
  d.threads.set("gone", makeThread("gone", { status: { type: "idle" }, path: path.join(d.home, "missing.jsonl") }));
  // 2026-11-16 ~/.codex: a spawned subagent has agent_nickname and empty title, preview and name.
  d.threads.set("s", makeThread("s", { parentThreadId: "a", status: { type: "idle" }, path: sPath, preview: "", agentNickname: "Kierkegaard the 2nd", agentRole: null }));
  const file = writeStateDb(d.home, [
    { id: "a", rollout_path: aPath },
    { id: "gone" },
    { id: "s", rollout_path: sPath, source: subagentSource("a"), preview: "", title: "" },
  ]);
  execDb(file, "ALTER TABLE threads ADD COLUMN agent_nickname TEXT; UPDATE threads SET agent_nickname = 'Kierkegaard the 2nd' WHERE id = 's';");

  // State database first (no daemon yet).
  const { src, sink } = await started(t, d.home, { backoff: { initialMs: 60_000, maxMs: 60_000 } });
  assert.equal(src.stats().accounts[0]!.mode, "fallback");
  assert.equal(sink.get("a")!.sizeBytes, 1234);
  assert.equal(sink.get("gone")!.sizeBytes, null, "a rollout path that does not exist");
  assert.equal(sink.get("s")!.sizeBytes, 56);
  assert.equal(sink.get("s")!.title, "Kierkegaard the 2nd");

  await d.listen();
  await waitFor(() => src.stats().accounts[0]!.mode === "daemon", "daemon mode");
  await waitFor(() => sink.get("s")?.status === "open-idle", "subagent read from the daemon");
  assert.equal(sink.get("a")!.sizeBytes, 1234);
  assert.equal(sink.get("gone")!.sizeBytes, null);
  assert.equal(sink.get("s")!.sizeBytes, 56);
  assert.equal(sink.get("s")!.title, "Kierkegaard the 2nd");
  assert.equal(sink.get("s")!.name, null, "the nickname is not a name the user gave");

  // A subagent the state database does not name yet: the daemon's nickname.
  d.threads.set("s2", makeThread("s2", { parentThreadId: "a", status: { type: "active", activeFlags: [] }, preview: "", agentNickname: "Hume" }));
  d.notify("thread/status/changed", { threadId: "s2", status: { type: "active", activeFlags: [] } });
  await waitFor(() => sink.get("s2") !== undefined, "s2 read in");
  assert.equal(sink.get("s2")!.title, "Hume");
  assert.equal(sink.get("s2")!.sizeBytes, null, "no path");

  // The rollout grows: the next publish of the thread carries the new size.
  fs.appendFileSync(aPath, "y".repeat(10));
  d.notify("thread/status/changed", { threadId: "a", status: { type: "active", activeFlags: [] } });
  await waitFor(() => sink.get("a")?.sizeBytes === 1244, "size after growth");
  assertOnlyReadCalls(d);
});

test("subagent nickname from the spawn record when the agent_nickname column is absent (older homes)", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cxnick"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeStateDb(home, [{ id: "p" }, { id: "c", source: subagentSource("p"), preview: null, title: null }]);
  const { sink } = await started(t, home);
  assert.equal(sink.get("c")!.title, "N");
  assert.equal(sink.get("p")!.title, null);
});

test("a fallback poll that finds the socket connects without waiting out the backoff", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  writeStateDb(d.home, [{ id: "r1", name: "from db" }]);
  d.threads.set("r1", makeThread("r1", { status: { type: "idle" }, name: "live" }));
  d.threads.set("r9", makeThread("r9"));
  // A retry delay far longer than the test, so only the poll's retryNow can connect in time.
  const { src, sink } = await started(t, d.home, { backoff: { initialMs: 60_000, maxMs: 60_000 } });
  assert.equal(src.stats().accounts[0]!.mode, "fallback");
  assert.equal(sink.get("r1")!.status, "closed");
  assert.equal(sink.get("r1")!.name, "from db");

  const n = sink.events.length;
  await d.listen();
  await waitFor(() => src.stats().accounts[0]!.mode === "daemon", "daemon mode");
  assert.deepEqual(sink.since(n), ["upsert r1", "upsert r9"]);
  assert.equal(sink.get("r1")!.status, "open-idle");
  assert.equal(sink.get("r1")!.name, "live");
  assertOnlyReadCalls(d);
});

test("an account moves back to the database when its daemon goes away", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  writeStateDb(d.home, [{ id: "r1", name: "from db" }]);
  d.threads.set("r1", makeThread("r1", { status: { type: "idle" }, name: "live" }));
  d.threads.set("r9", makeThread("r9"));
  await d.listen();
  const { src, sink } = await started(t, d.home);
  assert.equal(src.stats().accounts[0]!.mode, "daemon");
  assert.equal(sink.get("r1")!.status, "open-idle");

  const n = sink.events.length;
  await d.stopListening();
  await waitFor(() => src.stats().accounts[0]!.mode === "fallback", "fallback again");
  assert.deepEqual(sink.since(n), ["remove r9", "upsert r1"]);
  assert.equal(sink.get("r1")!.status, "closed");
  assert.equal(sink.get("r1")!.name, "from db");
  assert.equal(src.stats().accounts[0]!.modeSwitches, 1);
  assertOnlyReadCalls(d);
});

test("a failed snapshot falls back to the database and retries on a new connection", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  writeStateDb(d.home, [{ id: "r1" }]);
  d.threads.set("r1", makeThread("r1", { status: { type: "idle" } }));
  let lists = 0;
  d.handlers.set("thread/list", () => {
    if (++lists === 1) throw new DaemonError(-32603, "boom");
    return { data: [...d.threads.values()], nextCursor: null, backwardsCursor: null };
  });
  await d.listen();
  const { src, sink } = await started(t, d.home);
  assert.equal(sink.get("r1")!.status, "closed", "the first snapshot came from the database");

  await waitFor(() => src.stats().accounts[0]!.mode === "daemon", "daemon after retry");
  assert.equal(sink.get("r1")!.status, "open-idle");
  const st = src.stats().accounts[0]!;
  assert.equal(st.syncFailures, 1);
  assert.equal(st.rpc.failedConnections, 1);
  assert.match(st.lastError ?? "", /boom/);
});
