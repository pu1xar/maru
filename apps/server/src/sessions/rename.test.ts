import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { sessionKey } from "@maru/shared";
import type { RenameSession, SessionSummary } from "@maru/shared";
import type { ClaudeAccount, CodexAccount } from "../config.ts";
import { SessionIndex } from "../index/store.ts";
import { newReadCounters, readTranscriptMeta } from "../claude/meta.ts";
import { createClaudeSource } from "../claude/source.ts";
import { DaemonError, FakeDaemon, makeThread, waitFor } from "../codex/fake-daemon.ts";
import { controlSocketPath } from "../codex/rpc.ts";
import { STATE_DB_FILE, createCodexSource } from "../codex/source.ts";
import { MARU_ONLY_NOTICE, RenameError, SESSION_INDEX_FILE, SessionRenamer } from "./rename.ts";
import type { RenameDeps } from "./rename.ts";
import { SessionNameStore } from "../state/sessionNames.ts";

type T = { after: (fn: () => void | Promise<void>) => void };

const ENC = "-work-proj";
const CLAUDE = "claude-a";
const CODEX = "codex-a";

const jl = (objs: object[]): string => objs.map((o) => JSON.stringify(o) + "\n").join("");

function tmp(t: T, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function rejectsWith(p: Promise<unknown>, status: number, message?: RegExp): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof RenameError, `expected RenameError, got ${String(err)}`);
    assert.equal(err.status, status, err.message);
    if (message) assert.match(err.message, message);
    return true;
  });
}

// ---- Claude ----

interface ClaudeRig {
  accounts: ClaudeAccount[];
  sid: string;
  file: string;
  held: Set<string>;
  own: Set<number>;
  written: Array<[string, string]>;
  names: SessionNameStore;
  renamer: SessionRenamer;
}

function claudeRig(t: T, deps: Partial<RenameDeps> = {}): ClaudeRig {
  const root = tmp(t, "rename-claude-");
  const accounts: ClaudeAccount[] = [
    { id: CLAUDE, dir: path.join(root, "a") },
    { id: "claude-b", dir: path.join(root, "b") },
  ];
  for (const a of accounts) {
    fs.mkdirSync(path.join(a.dir, "projects", ENC), { recursive: true });
    fs.mkdirSync(path.join(a.dir, "sessions"), { recursive: true });
  }
  const sid = randomUUID();
  const file = path.join(accounts[0]!.dir, "projects", ENC, `${sid}.jsonl`);
  fs.writeFileSync(file, jl([
    { type: "user", cwd: "/work/proj", message: { role: "user", content: "hi" }, timestamp: "2026-11-15T10:00:00.000Z" },
    { type: "ai-title", aiTitle: "generated", sessionId: sid },
  ]));
  const held = new Set<string>();
  const own = new Set<number>();
  const written: Array<[string, string]> = [];
  const names = new SessionNameStore(":memory:");
  t.after(() => names.close());
  const renamer = new SessionRenamer({
    names,
    claudeAccounts: accounts,
    codexAccounts: [],
    index: new SessionIndex(),
    heldByServer: (s) => held.has(s),
    ownPids: () => own,
    claudeWritten: (a, f) => {
      written.push([a, f]);
    },
    ...deps,
  });
  return { accounts, sid, file, held, own, written, names, renamer };
}

const claudeReq = (id: string, name: string, account = CLAUDE): RenameSession => ({ provider: "claude", account, id, name });

function writeReg(dir: string, pid: number, sessionId: string): void {
  fs.writeFileSync(path.join(dir, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, status: "idle", entrypoint: "cli" }));
}

async function deadPid(): Promise<number> {
  const c = spawn(process.execPath, ["-e", ""]);
  await once(c, "exit");
  return c.pid!;
}

test("claude: appends the custom-title and agent-name pair the CLI writes, and the meta reads the name", async (t) => {
  const r = claudeRig(t);
  const res = await r.renamer.rename(claudeReq(r.sid, "  새 이름  "));
  assert.deepEqual(res, { ok: true, name: "새 이름", stored: "transcript" });
  const lines = fs.readFileSync(r.file, "utf8").split("\n");
  assert.deepEqual(lines.slice(-3), [
    `{"type":"custom-title","customTitle":"새 이름","sessionId":"${r.sid}"}`,
    `{"type":"agent-name","agentName":"새 이름","sessionId":"${r.sid}"}`,
    "",
  ]);
  assert.deepEqual(r.written, [[CLAUDE, r.file]]);

  // An ai-title written later (an open TUI keeps appending its generated title) leaves the name.
  fs.appendFileSync(r.file, jl([{ type: "ai-title", aiTitle: "later generated", sessionId: r.sid }]));
  const meta = (await readTranscriptMeta(r.file, undefined, newReadCounters()))!.meta;
  assert.equal(meta.name, "새 이름");
  assert.equal(meta.title, "later generated");
});

test("claude: an open session is named in maru only, and the transcript is left alone", async (t) => {
  const r = claudeRig(t);
  const before = fs.readFileSync(r.file, "utf8");
  // A registration under the other account: the session was moved, the old process is still open.
  writeReg(r.accounts[1]!.dir, process.pid, r.sid);
  const res = await r.renamer.rename(claudeReq(r.sid, "x"));
  assert.deepEqual(res, { ok: true, name: "x", stored: "maru", notice: MARU_ONLY_NOTICE });
  assert.equal(fs.readFileSync(r.file, "utf8"), before);
  assert.deepEqual(r.written, []);
  assert.equal(r.names.get("claude", r.sid)?.name, "x");

  r.own.add(process.pid);
  assert.equal((await r.renamer.rename(claudeReq(r.sid, "y"))).stored, "maru");
  assert.equal(fs.readFileSync(r.file, "utf8"), before);
  assert.equal(r.names.get("claude", r.sid)?.name, "y");
});

test("claude: a run of this server holds the session before its process registers", async (t) => {
  const r = claudeRig(t);
  r.held.add(r.sid);
  assert.equal((await r.renamer.rename(claudeReq(r.sid, "x"))).stored, "maru");
  r.held.delete(r.sid);
  assert.equal((await r.renamer.rename(claudeReq(r.sid, "x"))).stored, "transcript");
});

test("claude: a registration left by a dead process does not block", async (t) => {
  const r = claudeRig(t);
  writeReg(r.accounts[0]!.dir, await deadPid(), r.sid);
  fs.writeFileSync(path.join(r.accounts[0]!.dir, "sessions", "77.json"), "{broken");
  assert.equal((await r.renamer.rename(claudeReq(r.sid, "x"))).stored, "transcript");
});

test("claude: a cut-off last line gets its newline before the name lines", async (t) => {
  const r = claudeRig(t);
  fs.appendFileSync(r.file, '{"type":"assistant","mess');
  await r.renamer.rename(claudeReq(r.sid, "n"));
  const lines = fs.readFileSync(r.file, "utf8").split("\n");
  assert.deepEqual(lines.slice(-4), [
    '{"type":"assistant","mess',
    `{"type":"custom-title","customTitle":"n","sessionId":"${r.sid}"}`,
    `{"type":"agent-name","agentName":"n","sessionId":"${r.sid}"}`,
    "",
  ]);
});

test("rejects bad requests and missing sessions without writing", async (t) => {
  const r = claudeRig(t);
  const before = fs.readFileSync(r.file, "utf8");
  await rejectsWith(r.renamer.rename({ ...claudeReq(r.sid, "x"), provider: "gemini" as never }), 400, /provider/);
  await rejectsWith(r.renamer.rename(claudeReq(`../../${r.sid}`, "x")), 400, /session ID/);
  await rejectsWith(r.renamer.rename(claudeReq(r.sid.toUpperCase(), "x")), 400, /session ID/);
  await rejectsWith(r.renamer.rename(claudeReq(r.sid, "   ")), 400, /empty/);
  await rejectsWith(r.renamer.rename({ provider: "claude", account: CLAUDE, id: r.sid } as RenameSession), 400, /name/);
  await rejectsWith(r.renamer.rename(claudeReq(r.sid, "x", "claude-nope")), 400, /claude-nope/);
  // The transcript lives under claude-a; claude-b has none.
  await rejectsWith(r.renamer.rename(claudeReq(r.sid, "x", "claude-b")), 404, /transcript/);
  await rejectsWith(r.renamer.rename(claudeReq(randomUUID(), "x")), 404);
  await rejectsWith(r.renamer.rename({ provider: "codex", account: "codex-nope", id: r.sid, name: "x" }), 400, /codex-nope/);
  assert.equal(fs.readFileSync(r.file, "utf8"), before);
});

test("claude: the index takes the new name at once through ClaudeSource.reread", async (t) => {
  const index = new SessionIndex();
  // Watcher events wait a minute, so only reread() can bring the name in during this test.
  let source: ReturnType<typeof createClaudeSource> | null = null;
  const r = claudeRig(t, { index, claudeWritten: (a, f) => source!.reread(a, f) });
  source = createClaudeSource(r.accounts, { debounceMs: 60_000, sweepMs: 60_000 });
  t.after(() => source!.stop());
  await source.start((e) => index.apply(e));
  const key = sessionKey("claude", CLAUDE, r.sid);
  assert.equal(index.get(key)?.name, null);
  await r.renamer.rename(claudeReq(r.sid, "indexed name"));
  assert.equal(index.get(key)?.name, "indexed name");
  assert.equal(index.get(key)?.title, "generated");
});

// ---- Codex ----

interface DbThread {
  id: string;
  rollout_path?: string | null;
  source?: string;
  name?: string | null;
  archived?: number;
}

function writeDb(home: string, rows: DbThread[]): string {
  const file = path.join(home, STATE_DB_FILE);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER,
    updated_at INTEGER, source TEXT, cwd TEXT, title TEXT, archived INTEGER NOT NULL DEFAULT 0, preview TEXT,
    name TEXT, created_at_ms INTEGER, updated_at_ms INTEGER)`);
  const insert = db.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived,
    preview, name, created_at_ms, updated_at_ms) VALUES (?, ?, 1794000000, 1794000100, ?, ?, ?, ?, ?, ?, 1794000000000, 1794000100000)`);
  for (const r of rows) {
    insert.run(r.id, r.rollout_path === undefined ? `/r/${r.id}.jsonl` : r.rollout_path, r.source ?? "cli", `/work/${r.id}`,
      `first message ${r.id}`, r.archived ?? 0, `p ${r.id}`, r.name ?? null);
  }
  db.close();
  return file;
}

function dbName(home: string, id: string): string | null {
  const db = new DatabaseSync(path.join(home, STATE_DB_FILE), { readOnly: true });
  try {
    const row = db.prepare("SELECT name, title FROM threads WHERE id = ?").get(id);
    assert.equal(row?.title, `first message ${id}`, "the title column is never touched");
    return (row?.name as string | null) ?? null;
  } finally {
    db.close();
  }
}

function sessionIndexLines(home: string): Array<Record<string, unknown>> {
  const file = path.join(home, SESSION_INDEX_FILE);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

function codexRenamer(home: string, deps: Partial<RenameDeps> = {}): SessionRenamer {
  const accounts: CodexAccount[] = [{ id: CODEX, home }];
  return new SessionRenamer({
    names: new SessionNameStore(":memory:"),
    claudeAccounts: [],
    codexAccounts: accounts,
    index: new SessionIndex(),
    codexOpenFiles: async () => new Set(),
    ...deps,
  });
}

const codexReq = (id: string, name: string): RenameSession => ({ provider: "codex", account: CODEX, id, name });

async function daemon(t: T, threads: string[]): Promise<FakeDaemon> {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  for (const id of threads) d.threads.set(id, makeThread(id));
  await d.listen();
  return d;
}

test("codex: the daemon's thread/name/set renames the thread, and the index follows its notification", async (t) => {
  const id = randomUUID();
  const d = await daemon(t, [id]);
  writeDb(d.home, [{ id }]);
  const index = new SessionIndex();
  const src = createCodexSource([{ id: CODEX, home: d.home }], { backoff: { initialMs: 10, maxMs: 40 } });
  t.after(() => src.stop());
  await src.start((e) => index.apply(e));
  const key = sessionKey("codex", CODEX, id);
  assert.equal(index.get(key)?.name, null);

  const res = await codexRenamer(d.home, { index }).rename(codexReq(id, "codex name"));
  assert.deepEqual(res, { ok: true, name: "codex name", stored: "daemon" });
  assert.deepEqual(d.calls("thread/name/set").map((c) => c.params), [{ threadId: id, name: "codex name" }]);
  assert.equal(dbName(d.home, id), null, "the daemon owns the write");
  assert.deepEqual(sessionIndexLines(d.home), []);
  await waitFor(() => index.get(key)?.name === "codex name", "index name from thread/name/updated");
});

test("codex: without a daemon the name goes to threads.name and session_index.jsonl, and a fallback index re-reads now", async (t) => {
  const home = tmp(t, "rename-codex-");
  const id = randomUUID();
  const other = randomUUID();
  writeDb(home, [{ id }, { id: other, name: "keep" }]);
  const index = new SessionIndex();
  const src = createCodexSource([{ id: CODEX, home }], { fallbackPollMs: 60_000, backoff: { initialMs: 60_000, maxMs: 60_000 } });
  t.after(() => src.stop());
  await src.start((e) => index.apply(e));
  const written: string[] = [];
  const renamer = codexRenamer(home, {
    index,
    codexWritten: (a) => {
      written.push(a);
      src.reread(a);
    },
  });

  const t0 = Date.now();
  const res = await renamer.rename(codexReq(id, "직접 이름"));
  assert.deepEqual(res, { ok: true, name: "직접 이름", stored: "direct" });
  assert.equal(dbName(home, id), "직접 이름");
  assert.equal(dbName(home, other), "keep");
  const [rec, ...rest] = sessionIndexLines(home);
  assert.deepEqual(rest, []);
  assert.deepEqual(Object.keys(rec!), ["id", "thread_name", "updated_at"]);
  assert.equal(rec!.id, id);
  assert.equal(rec!.thread_name, "직접 이름");
  assert.ok(Date.parse(String(rec!.updated_at)) >= t0 - 1000 && String(rec!.updated_at).endsWith("Z"));
  assert.deepEqual(written, [CODEX]);
  assert.equal(index.get(sessionKey("codex", CODEX, id))?.name, "직접 이름");
});

test("codex: a thread the daemon cannot find and has not loaded (archived) is written directly", async (t) => {
  const id = randomUUID();
  const d = await daemon(t, []);
  writeDb(d.home, [{ id, archived: 1, rollout_path: `/h/archived_sessions/${id}.jsonl` }]);
  const res = await codexRenamer(d.home).rename(codexReq(id, "archived name"));
  assert.equal(res.stored, "direct");
  assert.equal(d.calls("thread/name/set").length, 1);
  assert.equal(d.calls("thread/loaded/list").length, 1);
  assert.equal(dbName(d.home, id), "archived name");
  assert.equal(sessionIndexLines(d.home).length, 1);
});

test("codex: a daemon error on a loaded thread is not bypassed (every loaded page is read), maru keeps the name", async (t) => {
  const id = randomUUID();
  const d = await daemon(t, []);
  writeDb(d.home, [{ id }]);
  d.handlers.set("thread/name/set", () => {
    throw new DaemonError(-1, "boom");
  });
  d.handlers.set("thread/loaded/list", (p) =>
    p.cursor ? { data: [id], nextCursor: null } : { data: [randomUUID()], nextCursor: "2" });
  const res = await codexRenamer(d.home).rename(codexReq(id, "x"));
  assert.equal(res.stored, "maru", "a daemon refusal leaves the name in maru only");
  assert.equal(d.calls("thread/loaded/list").length, 2);
  assert.equal(dbName(d.home, id), null);
  assert.deepEqual(sessionIndexLines(d.home), []);
});

test("codex: a rollout a codex process has open is not written directly", async (t) => {
  const home = tmp(t, "rename-codex-");
  const id = randomUUID();
  const rollout = path.join(home, "archived_sessions", `rollout-${id}.jsonl`);
  writeDb(home, [{ id, rollout_path: rollout }]);
  const renamer = codexRenamer(home, { codexOpenFiles: async () => new Set([rollout]) });
  assert.equal((await renamer.rename(codexReq(id, "x"))).stored, "maru");
  assert.equal(dbName(home, id), null);
  assert.deepEqual(sessionIndexLines(home), []);

  const failing = codexRenamer(home, { codexOpenFiles: async () => { throw new Error("lsof gone"); } });
  assert.equal((await failing.rename(codexReq(id, "x"))).stored, "maru");
  assert.equal(dbName(home, id), null);
});

test("codex: subagent threads are refused, by the index or by the state database", async (t) => {
  const home = tmp(t, "rename-codex-");
  const parent = randomUUID();
  const child = randomUUID();
  const listed = randomUUID();
  const source = JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } });
  writeDb(home, [{ id: parent }, { id: child, source }, { id: listed }]);
  const index = new SessionIndex();
  const summary: SessionSummary = {
    key: sessionKey("codex", CODEX, listed), provider: "codex", account: CODEX, id: listed, cwd: null, name: null,
    title: null, preview: null, status: "closed", owner: "none", pid: null, tmuxPane: null,
    parentKey: sessionKey("codex", CODEX, parent), updatedAt: 1, createdAt: null, sizeBytes: null, entrypoint: null,
  };
  index.apply({ type: "upsert", session: summary });
  const renamer = codexRenamer(home, { index });
  await rejectsWith(renamer.rename(codexReq(child, "x")), 409, /subagent/);
  await rejectsWith(renamer.rename(codexReq(listed, "x")), 409, /subagent/);
  assert.equal(dbName(home, child), null);
  assert.equal((await renamer.rename(codexReq(parent, "x"))).stored, "direct");
});

test("codex: a socket file with no daemon behind it counts as no daemon; an unknown thread is 404", async (t) => {
  const home = tmp(t, "rename-codex-");
  const id = randomUUID();
  writeDb(home, [{ id }]);
  fs.mkdirSync(path.dirname(controlSocketPath(home)), { recursive: true });
  fs.writeFileSync(controlSocketPath(home), "");
  const renamer = codexRenamer(home);
  assert.equal((await renamer.rename(codexReq(id, "x"))).stored, "direct");
  await rejectsWith(renamer.rename(codexReq(randomUUID(), "x")), 404, /thread/);

  const empty = tmp(t, "rename-codex-empty-");
  await rejectsWith(codexRenamer(empty).rename(codexReq(id, "x")), 404);
  assert.deepEqual(fs.readdirSync(empty), [], "nothing is created in a home without a state database");
});

// ---- maru's own names ----

test("claude: after a transcript write the row exists, and a name typed in the CLI later wins", async (t) => {
  let source: ReturnType<typeof createClaudeSource> | null = null;
  const names = new SessionNameStore(":memory:");
  t.after(() => names.close());
  // The server's annotate (main.ts): maru's name over the provider's.
  const annotated = new SessionIndex((s) => ({ ...s, providerName: s.name, name: names.resolve(s.provider, s.id, s.name) }));
  const r = claudeRig(t, { names, index: annotated, claudeWritten: (a, f) => source!.reread(a, f) });
  source = createClaudeSource(r.accounts, { debounceMs: 60_000, sweepMs: 60_000 });
  t.after(() => source!.stop());
  await source.start((e) => annotated.apply(e));
  const key = sessionKey("claude", CLAUDE, r.sid);
  await r.renamer.rename(claudeReq(r.sid, "from maru"));
  assert.equal(annotated.get(key)?.name, "from maru");
  assert.equal(names.get("claude", r.sid)?.name, "from maru");

  // The CLI renames later: its name is not one the row was written next to, so it wins and the row goes.
  fs.appendFileSync(r.file, jl([{ type: "custom-title", customTitle: "from cli", sessionId: r.sid }]));
  await source.reread(CLAUDE, r.file);
  assert.equal(annotated.get(key)?.name, "from cli");
  assert.equal(names.get("claude", r.sid), null);
});
