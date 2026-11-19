import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { TRASH_THRESHOLD_BYTES, sessionKey } from "@maru/shared";
import type { SessionSummary } from "@maru/shared";
import type { CodexAccount } from "../config.ts";
import { SessionIndex } from "../index/store.ts";
import { ChosenStore } from "../state/chosen.ts";
import { DaemonError, FakeDaemon, makeThread } from "../codex/fake-daemon.ts";
import { STATE_DB_FILE } from "../codex/source.ts";
import { ManageError, SessionManager } from "./manage.ts";
import { TrashStore } from "./trash.ts";

type T = { after: (fn: () => void | Promise<void>) => void };

function tmp(t: T, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function rejectsWith(p: Promise<unknown> | (() => unknown), status: number, message?: RegExp): Promise<void> {
  const run = typeof p === "function" ? (async () => p())() : p;
  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof ManageError, `expected ManageError, got ${String(err)}`);
    assert.equal(err.status, status, err.message);
    if (message) assert.match(err.message, message);
    return true;
  });
}

// ---- state database fixture ----

function makeDb(home: string, extraColumns: string[] = []): void {
  fs.mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(path.join(home, STATE_DB_FILE));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, source TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, name TEXT, created_at_ms INTEGER, updated_at_ms INTEGER,
    preview TEXT NOT NULL DEFAULT ''${extraColumns.map((c) => `, ${c}`).join("")});
    CREATE TABLE thread_dynamic_tools (thread_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, input_schema TEXT NOT NULL, PRIMARY KEY(thread_id, position),
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);`);
  db.close();
}

interface ThreadOpts {
  parent?: string;
  /** Record the child in thread_spawn_edges (default true for a child). */
  edge?: boolean;
  /** Name the parent in `source` (default true for a child). */
  sourceParent?: string | null;
  name?: string | null;
  bytes?: number;
  extra?: Record<string, string | number>;
  archived?: number;
}

function addThread(home: string, id: string, o: ThreadOpts = {}): string {
  const rollout = path.join(home, "sessions", "2026", "11", "15", `rollout-2026-11-15T10-00-00-${id}.jsonl`);
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, Buffer.alloc(o.bytes ?? 200, id.charCodeAt(0)));
  const sourceParent = o.sourceParent === undefined ? o.parent : o.sourceParent;
  const source = sourceParent ? JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: sourceParent, depth: 1 } } }) : "cli";
  const extra = o.extra ?? {};
  const cols = ["id", "rollout_path", "created_at", "updated_at", "source", "cwd", "title", "archived", "name", "created_at_ms", "updated_at_ms", ...Object.keys(extra)];
  const db = new DatabaseSync(path.join(home, STATE_DB_FILE));
  db.prepare(`INSERT INTO threads (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(
    id, rollout, 1794000000, 1794000100, source, `/work/${id.slice(0, 4)}`, `first message ${id}`, o.archived ?? 0, o.name ?? null,
    1794000000123, 1794000100456, ...Object.values(extra),
  );
  if (o.parent && o.edge !== false) {
    db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'open')").run(o.parent, id);
  }
  db.close();
  return rollout;
}

function addTool(home: string, threadId: string): void {
  const db = new DatabaseSync(path.join(home, STATE_DB_FILE));
  db.prepare("INSERT INTO thread_dynamic_tools VALUES (?, 0, 'tool', 'desc', '{}')").run(threadId);
  db.close();
}

function rows(home: string, table = "threads"): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path.join(home, STATE_DB_FILE), { readOnly: true });
  try {
    const order = table === "threads" ? "id" : table === "thread_spawn_edges" ? "child_thread_id" : "thread_id";
    return db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

/** What the real daemon's thread/delete does (measured): the thread and its descendants, rows and rollouts. */
function cascadeDelete(home: string, id: string): string[] {
  const db = new DatabaseSync(path.join(home, STATE_DB_FILE));
  const gone: string[] = [];
  try {
    const queue = [id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(cur);
      if (!row) continue;
      for (const e of db.prepare("SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ?").all(cur)) queue.push(String(e.child_thread_id));
      db.prepare("DELETE FROM thread_spawn_edges WHERE child_thread_id = ? OR parent_thread_id = ?").run(cur, cur);
      db.prepare("DELETE FROM thread_dynamic_tools WHERE thread_id = ?").run(cur);
      db.prepare("DELETE FROM threads WHERE id = ?").run(cur);
      fs.rmSync(String(row.rollout_path), { force: true });
      gone.push(cur);
    }
  } finally {
    db.close();
  }
  return gone;
}

interface Rig {
  accounts: CodexAccount[];
  index: SessionIndex;
  chosen: ChosenStore;
  trash: TrashStore;
  open: Set<string>;
  written: Array<[string, string[]]>;
  /** What each removed() call named (sessions whose state rows may go). */
  removed: string[][];
  manage: SessionManager;
}

function rig(t: T, homes: string[]): Rig {
  const accounts: CodexAccount[] = homes.map((home, i) => ({ id: `codex-${"ab"[i]}`, home }));
  const index = new SessionIndex();
  const chosen = new ChosenStore(":memory:");
  t.after(() => chosen.close());
  const trash = new TrashStore({ root: path.join(tmp(t, "manage-trash-"), "trash"), claudeAccounts: [], codexAccounts: accounts });
  const open = new Set<string>();
  const written: Array<[string, string[]]> = [];
  const removed: string[][] = [];
  const manage = new SessionManager({
    claudeAccounts: [], codexAccounts: accounts, index, chosen, trash,
    codexOpenFiles: async () => open,
    codexWritten: (a, ids) => {
      written.push([a, ids]);
    },
    removed: (keys) => {
      removed.push(keys);
    },
    stubDir: tmp(t, "manage-stubs-"),
    display: (p) => p,
  });
  return { accounts, index, chosen, trash, open, written, removed, manage };
}

/** Parent P with child C (edge and source) and grandchild G (edge only), plus an unrelated U. */
function family(home: string, parentBytes = 200): { P: string; C: string; G: string; U: string; files: Record<string, string> } {
  const [P, C, G, U] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const files: Record<string, string> = {};
  files[P] = addThread(home, P, { name: "부모", bytes: parentBytes });
  files[C] = addThread(home, C, { parent: P });
  files[G] = addThread(home, G, { parent: C, sourceParent: null });
  files[U] = addThread(home, U);
  addTool(home, P);
  return { P, C, G, U, files };
}

const del = (id: string, account = "codex-a") => ({ provider: "codex", account, id });

// ---- delete ----

test("without a daemon, a small family is removed directly: rows, edges, tools and rollouts", async (t) => {
  const home = tmp(t, "manage-codex-");
  makeDb(home);
  const f = family(home);
  const r = rig(t, [home]);
  const res = await r.manage.deleteSession(del(f.P));
  assert.deepEqual([res.outcome, res.trashKey, res.ids], ["deleted", null, [f.P, f.C, f.G]]);
  assert.deepEqual(rows(home).map((x) => x.id), [f.U]);
  assert.deepEqual(rows(home, "thread_spawn_edges"), []);
  assert.deepEqual(rows(home, "thread_dynamic_tools"), []);
  for (const id of [f.P, f.C, f.G]) assert.ok(!fs.existsSync(f.files[id]!));
  assert.ok(fs.existsSync(f.files[f.U]!));
  assert.deepEqual(r.written, [["codex-a", [f.P, f.C, f.G]]]);
});

test("a big family goes to the trash with its rows and rollouts and comes back as it was", async (t) => {
  const home = tmp(t, "manage-codex-");
  makeDb(home);
  const f = family(home, TRASH_THRESHOLD_BYTES);
  const r = rig(t, [home]);
  const before = { threads: rows(home), edges: rows(home, "thread_spawn_edges"), tools: rows(home, "thread_dynamic_tools") };
  const content = Object.fromEntries([f.P, f.C, f.G].map((id) => [id, fs.readFileSync(f.files[id]!)]));

  const res = await r.manage.deleteSession(del(f.P));
  assert.equal(res.outcome, "trashed");
  assert.deepEqual(r.removed, [], "a trashed family keeps its state rows for a restore");
  assert.equal(res.sizeBytes, TRASH_THRESHOLD_BYTES + 400);
  assert.deepEqual(rows(home).map((x) => x.id), [f.U]);
  const item = r.trash.list().items[0]!;
  assert.deepEqual([item.provider, item.account, item.id, item.name, item.threads, item.problem], ["codex", "codex-a", f.P, "부모", 3, null]);

  await r.manage.restoreTrash({ key: item.key });
  assert.deepEqual({ threads: rows(home), edges: rows(home, "thread_spawn_edges"), tools: rows(home, "thread_dynamic_tools") }, before);
  for (const id of [f.P, f.C, f.G]) assert.deepEqual(fs.readFileSync(f.files[id]!), content[id]);
  assert.deepEqual(r.trash.list().items, []);
  assert.deepEqual(r.written.at(-1), ["codex-a", [f.P, f.C, f.G]]);

  // Again, and the restore refuses while a row with the id is back in the home.
  const again = await r.manage.deleteSession(del(f.P));
  addThread(home, f.P);
  await rejectsWith(r.manage.restoreTrash({ key: again.trashKey }), 409, /already has/);
  assert.equal(r.trash.list().items.length, 1);
  assert.ok(!fs.existsSync(f.files[f.C]!), "nothing moved back");
});

test("with a daemon, thread/delete on the root removes the family and the trash keeps the rollouts through hard links", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  makeDb(d.home);
  const f = family(d.home, TRASH_THRESHOLD_BYTES);
  for (const id of [f.P, f.C, f.G, f.U]) d.threads.set(id, makeThread(id));
  d.handlers.set("thread/delete", (p) => {
    for (const id of cascadeDelete(d.home, String(p.threadId))) d.notify("thread/deleted", { threadId: id });
    return {};
  });
  await d.listen();
  const content = fs.readFileSync(f.files[f.P]!);
  const r = rig(t, [d.home]);

  const res = await r.manage.deleteSession(del(f.P));
  assert.equal(res.outcome, "trashed");
  assert.deepEqual(d.calls("thread/delete").map((c) => c.params.threadId), [f.P], "the children go with the root");
  assert.deepEqual(rows(d.home).map((x) => x.id), [f.U]);
  const entry = r.trash.entryDir(res.trashKey!);
  assert.deepEqual(fs.readFileSync(path.join(entry, "rollouts", "0.jsonl")), content);
  assert.equal(fs.readdirSync(path.join(entry, "rollouts")).length, 3);
});

test("a loaded thread, an open rollout or an open index status refuses the delete, and nothing changes", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  makeDb(d.home);
  const f = family(d.home, TRASH_THRESHOLD_BYTES);
  d.threads.set(f.P, makeThread(f.P, { status: { type: "idle" } }));
  await d.listen();
  const r = rig(t, [d.home]);
  const before = rows(d.home);

  await rejectsWith(r.manage.deleteSession(del(f.P)), 409, /has this thread loaded/);
  d.threads.set(f.P, makeThread(f.P));
  d.threads.set(f.C, makeThread(f.C, { status: { type: "idle" }, parentThreadId: f.P }));
  await rejectsWith(r.manage.deleteSession(del(f.P)), 409, new RegExp(`subagent thread of this thread \\(${f.C}\\)`));
  d.threads.delete(f.C);
  r.open.add(f.files[f.G]!);
  await rejectsWith(r.manage.deleteSession(del(f.P)), 409, /rollout open/);
  r.open.clear();
  const s: SessionSummary = {
    key: sessionKey("codex", "codex-a", f.P), provider: "codex", account: "codex-a", id: f.P, cwd: null, name: null, title: null,
    preview: null, status: "running", owner: "terminal", pid: null, tmuxPane: null, parentKey: null, updatedAt: 1, createdAt: null,
    sizeBytes: null, entrypoint: null,
  };
  r.index.apply({ type: "upsert", session: s });
  await rejectsWith(r.manage.deleteSession(del(f.P)), 409, /running/);
  r.index.apply({ type: "remove", key: s.key });
  r.chosen.set("codex", f.P, true);
  await rejectsWith(r.manage.deleteSession(del(f.P)), 409, /locked/);

  assert.equal(d.calls("thread/delete").length, 0);
  assert.deepEqual(rows(d.home), before);
  assert.deepEqual(r.trash.list().items, []);
  for (const file of Object.values(f.files)) assert.ok(fs.existsSync(file));
});

test("a daemon that loaded the thread meanwhile and refuses is not bypassed: 502, the entry goes, the thread stays", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  makeDb(d.home);
  const f = family(d.home, TRASH_THRESHOLD_BYTES);
  let lists = 0;
  d.handlers.set("thread/loaded/list", () => ({ data: lists++ === 0 ? [] : [f.P], nextCursor: null }));
  d.handlers.set("thread/delete", () => {
    throw new DaemonError(-1, "boom");
  });
  await d.listen();
  const r = rig(t, [d.home]);
  const before = rows(d.home);
  await rejectsWith(r.manage.deleteSession(del(f.P)), 502, /boom/);
  assert.deepEqual(rows(d.home), before);
  assert.deepEqual(r.trash.list().items, []);
  assert.deepEqual(fs.readdirSync(r.trash.root), []);
  for (const file of Object.values(f.files)) assert.ok(fs.existsSync(file));
});

test("a thread the daemon cannot find and has not loaded (archived) is removed directly", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  makeDb(d.home);
  const id = randomUUID();
  const file = addThread(d.home, id, { archived: 1 });
  d.handlers.set("thread/delete", (p) => {
    throw new DaemonError(-32600, `no rollout found for thread id ${String(p.threadId)}`);
  });
  await d.listen();
  const r = rig(t, [d.home]);
  const res = await r.manage.deleteSession(del(id));
  assert.equal(res.outcome, "deleted");
  assert.deepEqual(r.removed, [[`codex:${id}`]], "its state rows may go");
  assert.equal(d.calls("thread/delete").length, 1);
  assert.deepEqual(rows(d.home), []);
  assert.ok(!fs.existsSync(file));
});

// ---- move between homes ----

test("move: the family goes to the other home, written with the columns both tables have", async (t) => {
  const a = tmp(t, "manage-codex-a-");
  const b = tmp(t, "manage-codex-b-");
  makeDb(a, ["creator_user_id TEXT"]);
  makeDb(b, ["memory_mode TEXT NOT NULL DEFAULT 'enabled'"]);
  const P = randomUUID();
  const C = randomUUID();
  const pFile = addThread(a, P, { name: "옮길 이름", extra: { creator_user_id: "u1" } });
  addThread(a, C, { parent: P });
  addTool(a, P);
  const content = fs.readFileSync(pFile);
  const r = rig(t, [a, b]);

  const res = await r.manage.move({ provider: "codex", id: P, from: "codex-a", to: "codex-b" });
  assert.deepEqual(res.ids, [P, C]);
  assert.equal(res.resumeCommand, `cd -- /work/${P.slice(0, 4)} && CODEX_HOME=${b} codex resume ${P}`);
  assert.deepEqual(rows(a), []);
  assert.ok(!fs.existsSync(pFile));
  const moved = rows(b);
  assert.deepEqual(moved.map((x) => x.id).sort(), [P, C].sort());
  const p = moved.find((x) => x.id === P)!;
  assert.equal(p.rollout_path, path.join(b, path.relative(a, pFile)));
  assert.equal(p.name, "옮길 이름");
  assert.equal(p.memory_mode, "enabled", "a column the source lacks takes the target's default");
  assert.ok(!("creator_user_id" in p), "a column the target lacks is left out");
  assert.equal(p.created_at_ms, 1794000000123);
  assert.equal(typeof p.created_at_ms, "number");
  assert.deepEqual(fs.readFileSync(String(p.rollout_path)), content);
  assert.deepEqual(rows(b, "thread_spawn_edges").map((e) => [e.parent_thread_id, e.child_thread_id]), [[P, C]]);
  assert.equal(rows(b, "thread_dynamic_tools").length, 1);
  const idx = fs.readFileSync(path.join(b, "session_index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(idx.map((x) => [x.id, x.thread_name]), [[P, "옮길 이름"]]);
  assert.deepEqual(r.written, [["codex-a", [P, C]], ["codex-b", [P, C]]]);

  await rejectsWith(r.manage.move({ provider: "codex", id: C, from: "codex-b", to: "codex-a" }), 409, /subagent/);
  addThread(a, P);
  await rejectsWith(r.manage.move({ provider: "codex", id: P, from: "codex-b", to: "codex-a" }), 409, /already has/);
  await rejectsWith(r.manage.move({ provider: "codex", id: P, from: "codex-b", to: "codex-b" }), 400);
  fs.rmSync(path.join(a, STATE_DB_FILE));
  await rejectsWith(r.manage.move({ provider: "codex", id: P, from: "codex-b", to: "codex-a" }), 409, /state DB/);
});

test("move: when the source cannot be cleared the copy in the target is undone", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  makeDb(d.home);
  const b = tmp(t, "manage-codex-b-");
  makeDb(b);
  const P = randomUUID();
  const pFile = addThread(d.home, P);
  let lists = 0;
  d.handlers.set("thread/loaded/list", () => ({ data: lists++ === 0 ? [] : [P], nextCursor: null }));
  d.handlers.set("thread/delete", () => {
    throw new DaemonError(-1, "busy");
  });
  await d.listen();
  const r = rig(t, [d.home, b]);
  await rejectsWith(r.manage.move({ provider: "codex", id: P, from: "codex-a", to: "codex-b" }), 502, /busy/);
  assert.deepEqual(rows(b), []);
  assert.ok(!fs.existsSync(path.join(b, path.relative(d.home, pFile))));
  assert.equal(rows(d.home).length, 1);
  assert.ok(fs.existsSync(pFile));
});

// ---- orphans, resume ----

test("codex orphans: rollouts with no row for their thread id; a home without a state database is skipped", async (t) => {
  const home = tmp(t, "manage-codex-");
  makeDb(home);
  const X = randomUUID();
  addThread(home, X);
  const stray = path.join(home, "sessions", "2026", "11", "14", `rollout-2026-11-14T10-00-00-${X}.jsonl`);
  const Y = randomUUID();
  const orphan = path.join(home, "sessions", "2026", "11", "14", `rollout-2026-11-14T11-00-00-${Y}_${randomUUID()}.jsonl`);
  for (const f of [stray, orphan]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "x".repeat(10));
  }
  const empty = tmp(t, "manage-codex-nodb-");
  fs.mkdirSync(path.join(empty, "sessions"));
  fs.writeFileSync(path.join(empty, "sessions", `rollout-${randomUUID()}.jsonl`), "x");
  const r = rig(t, [home, empty]);

  const list = r.manage.listOrphans();
  assert.deepEqual(list.sessions.map((s) => [s.provider, s.account, s.id, s.paths, s.sizeBytes]), [["codex", "codex-a", Y, [orphan], 10]]);
  assert.deepEqual(list.skipped.map((s) => s.account), ["codex-b"]);
  r.open.add(orphan);
  await rejectsWith(r.manage.deleteOrphan(del(Y)), 409);
  r.open.clear();
  assert.deepEqual(await r.manage.deleteOrphan(del(Y)), { ok: true, removed: 1, freedBytes: 10 });
  assert.ok(!fs.existsSync(orphan) && fs.existsSync(stray));
  await rejectsWith(r.manage.deleteOrphan(del(Y)), 404);
  await rejectsWith(r.manage.deleteOrphan(del(X)), 404);
});

test("a symlinked home whose rows hold resolved paths: no false orphans, and trash, restore and move still match", async (t) => {
  const real = tmp(t, "manage-codex-real-");
  const home = path.join(tmp(t, "manage-codex-link-"), "h");
  fs.symlinkSync(real, home);
  makeDb(real);
  const P = randomUUID();
  const file = addThread(fs.realpathSync(real), P, { bytes: TRASH_THRESHOLD_BYTES + 1 });
  const b = tmp(t, "manage-codex-b-");
  makeDb(b);
  const r = rig(t, [home, b]);
  assert.deepEqual(r.manage.listOrphans().sessions, []);
  const d = await r.manage.deleteSession(del(P));
  assert.equal(d.outcome, "trashed");
  await r.manage.restoreTrash({ key: d.trashKey });
  assert.ok(fs.existsSync(file));
  const mv = await r.manage.move({ provider: "codex", id: P, from: "codex-a", to: "codex-b" });
  assert.deepEqual(mv.ids, [P]);
  assert.equal(rows(b)[0]!.rollout_path, path.join(b, path.relative(fs.realpathSync(real), file)));
});

test("codex resume command reads the cwd from the state database", async (t) => {
  const home = tmp(t, "manage-codex-");
  makeDb(home);
  const X = randomUUID();
  addThread(home, X);
  const r = rig(t, [home]);
  assert.deepEqual(r.manage.resumeCommand(new URLSearchParams({ provider: "codex", account: "codex-a", id: X })),
    { cwd: `/work/${X.slice(0, 4)}`, command: `cd -- /work/${X.slice(0, 4)} && CODEX_HOME=${home} codex resume ${X}` });
  await rejectsWith(() => r.manage.resumeCommand(new URLSearchParams({ provider: "codex", account: "codex-a", id: randomUUID() })), 404);
});
