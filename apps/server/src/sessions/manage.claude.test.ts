import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TRASH_THRESHOLD_BYTES, sessionKey } from "@maru/shared";
import type { SessionSummary } from "@maru/shared";
import type { ClaudeAccount } from "../config.ts";
import { SessionIndex } from "../index/store.ts";
import { ChosenStore } from "../state/chosen.ts";
import { ManageError, SessionManager } from "./manage.ts";
import { TrashStore } from "./trash.ts";

type T = { after: (fn: () => void | Promise<void>) => void };

const ENC = "-work-proj";
const jl = (objs: object[]): string => objs.map((o) => JSON.stringify(o) + "\n").join("");

function tmp(t: T, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Relative path and size of every file under `dir`, sorted: "nothing changed" is an equal snapshot. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)}:${fs.lstatSync(p).size}`);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
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

async function deadPid(): Promise<number> {
  const c = spawn(process.execPath, ["-e", ""]);
  await once(c, "exit");
  return c.pid!;
}

interface Rig {
  root: string;
  accounts: ClaudeAccount[];
  index: SessionIndex;
  chosen: ChosenStore;
  trash: TrashStore;
  held: Set<string>;
  written: Array<[string, string]>;
  /** What each removed() call named (sessions whose state rows may go). */
  removed: string[][];
  manage: SessionManager;
}

function rig(t: T): Rig {
  const root = tmp(t, "manage-claude-");
  const accounts: ClaudeAccount[] = [
    { id: "claude-a", dir: path.join(root, "a") },
    { id: "claude-b", dir: path.join(root, "b") },
  ];
  for (const a of accounts) {
    fs.mkdirSync(path.join(a.dir, "projects", ENC), { recursive: true });
    fs.mkdirSync(path.join(a.dir, "sessions"), { recursive: true });
  }
  const index = new SessionIndex();
  const chosen = new ChosenStore(":memory:");
  t.after(() => chosen.close());
  const trash = new TrashStore({ root: path.join(root, "trash"), claudeAccounts: accounts, codexAccounts: [] });
  const held = new Set<string>();
  const written: Array<[string, string]> = [];
  const removed: string[][] = [];
  const manage = new SessionManager({
    claudeAccounts: accounts, codexAccounts: [], index, chosen, trash,
    heldByServer: (s) => held.has(s),
    claudeWritten: (a, f) => {
      written.push([a, f]);
    },
    removed: (keys) => {
      removed.push(keys);
    },
    stubDir: path.join(root, "stubs"),
    home: root,
    display: (p) => p,
  });
  return { root, accounts, index, chosen, trash, held, written, removed, manage };
}

function writeTranscript(dir: string, enc: string, sid: string, rows: object[]): string {
  const file = path.join(dir, "projects", enc, `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jl(rows));
  return file;
}

function conversation(sid: string, cwd = "/work/proj"): object[] {
  return [
    { type: "user", cwd, sessionId: sid, message: { role: "user", content: "hi" }, timestamp: "2026-11-15T10:00:00.000Z" },
    { type: "assistant", cwd, sessionId: sid, message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
  ];
}

function writeFile(file: string, bytes: number | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof bytes === "string" ? bytes : Buffer.alloc(bytes, 120));
}

function summary(account: string, sid: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    key: sessionKey("claude", account, sid), provider: "claude", account, id: sid, cwd: "/work/proj", name: "이름", title: null,
    preview: null, status: "closed", owner: "none", pid: null, tmuxPane: null, parentKey: null, updatedAt: 1,
    createdAt: null, sizeBytes: null, entrypoint: null, ...over,
  };
}

const del = (sid: string, account = "claude-a") => ({ provider: "claude", account, id: sid });

// ---- delete and the trash ----

test("a small session is removed for good with its subtrees, dead registrations and session-env", async (t) => {
  const r = rig(t);
  const sid = randomUUID();
  const file = writeTranscript(r.accounts[0]!.dir, ENC, sid, conversation(sid));
  writeFile(path.join(r.accounts[1]!.dir, "projects", ENC, sid, "subagents", "agent-0123456789abcdef0.jsonl"), 100);
  const pid = await deadPid();
  writeFile(path.join(r.accounts[1]!.dir, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: sid, status: "busy" }));
  fs.mkdirSync(path.join(r.accounts[0]!.dir, "session-env", sid), { recursive: true });
  writeFile(path.join(r.accounts[0]!.dir, "file-history", sid, "0123456789abcdef@v1"), 50);
  writeFile(path.join(r.accounts[1]!.dir, "file-history", sid, "fedcba9876543210@v1"), 50);
  const otherHistory = randomUUID();
  writeFile(path.join(r.accounts[0]!.dir, "file-history", otherHistory, "aaaaaaaaaaaaaaaa@v1"), 50);
  const other = randomUUID();
  writeTranscript(r.accounts[0]!.dir, ENC, other, conversation(other));

  const res = await r.manage.deleteSession(del(sid));
  assert.equal(res.outcome, "deleted");
  assert.equal(res.trashKey, null);
  assert.ok(!fs.existsSync(file));
  assert.ok(!fs.existsSync(path.join(r.accounts[1]!.dir, "projects", ENC, sid)));
  assert.ok(!fs.existsSync(path.join(r.accounts[1]!.dir, "sessions", `${pid}.json`)), "a dead registration, even one still saying busy, goes too");
  assert.ok(!fs.existsSync(path.join(r.accounts[0]!.dir, "session-env", sid)));
  assert.ok(!fs.existsSync(path.join(r.accounts[0]!.dir, "file-history", sid)), "file-history goes in every account");
  assert.ok(!fs.existsSync(path.join(r.accounts[1]!.dir, "file-history", sid)));
  assert.ok(fs.existsSync(path.join(r.accounts[0]!.dir, "file-history", otherHistory)), "another session's file-history stays");
  assert.ok(fs.existsSync(path.join(r.accounts[0]!.dir, "projects", ENC, `${other}.jsonl`)), "other sessions stay");
  assert.deepEqual(r.written, [["claude-a", file]]);
  assert.deepEqual(r.trash.list().items, []);
  assert.deepEqual(r.removed, [[`claude:${sid}`]], "its state rows may go");
});

test("the trash threshold counts subtrees in every account: a small transcript with a big subtree is trashed, and restore puts each piece back", async (t) => {
  const r = rig(t);
  const sid = randomUUID();
  const file = writeTranscript(r.accounts[0]!.dir, ENC, sid, conversation(sid));
  const subA = path.join(r.accounts[0]!.dir, "projects", ENC, sid, "subagents", "agent-0123456789abcdef0.jsonl");
  const subB = path.join(r.accounts[1]!.dir, "projects", "-other-enc", sid, "subagents", "agent-fedcba98765432100.jsonl");
  writeFile(subA, 1000);
  writeFile(subB, TRASH_THRESHOLD_BYTES);
  assert.ok(fs.statSync(file).size < TRASH_THRESHOLD_BYTES, "the transcript alone is under the threshold");
  const pid = await deadPid();
  writeFile(path.join(r.accounts[0]!.dir, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: sid, status: "idle" }));
  writeFile(path.join(r.accounts[0]!.dir, "file-history", sid, "0123456789abcdef@v1"), 70);
  writeFile(path.join(r.accounts[1]!.dir, "file-history", sid, "fedcba9876543210@v2"), 80);
  r.index.apply({ type: "upsert", session: summary("claude-a", sid, { name: "보관할 세션" }) });
  const before = { a: snapshot(r.accounts[0]!.dir), b: snapshot(r.accounts[1]!.dir) };

  const res = await r.manage.deleteSession(del(sid));
  assert.equal(res.outcome, "trashed");
  assert.deepEqual(r.removed, [], "a trashed session keeps its state rows for a restore");
  assert.ok(res.sizeBytes > TRASH_THRESHOLD_BYTES);
  assert.ok(!fs.existsSync(file) && !fs.existsSync(subA) && !fs.existsSync(subB));
  const list = r.trash.list();
  assert.equal(list.items.length, 1);
  assert.deepEqual(list.unreadable, []);
  const item = list.items[0]!;
  assert.deepEqual([item.key, item.provider, item.account, item.id, item.name, item.threads, item.problem],
    [res.trashKey, "claude", "claude-a", sid, "보관할 세션", 1, null]);
  assert.equal(item.sizeBytes, res.sizeBytes);
  const meta = JSON.parse(fs.readFileSync(path.join(r.trash.entryDir(item.key), "meta.json"), "utf8"));
  assert.equal(meta.claude.subtrees.length, 2);
  assert.equal(meta.claude.registrations.length, 1);
  assert.equal(meta.claude.fileHistory.length, 2);
  assert.ok(!fs.existsSync(path.join(r.accounts[0]!.dir, "file-history", sid)) && !fs.existsSync(path.join(r.accounts[1]!.dir, "file-history", sid)));

  const restored = await r.manage.restoreTrash({ key: item.key });
  assert.deepEqual([restored.provider, restored.account, restored.id], ["claude", "claude-a", sid]);
  assert.deepEqual({ a: snapshot(r.accounts[0]!.dir), b: snapshot(r.accounts[1]!.dir) }, before, "every piece is back in its own account");
  assert.deepEqual(r.trash.list().items, []);
  assert.deepEqual(r.written.at(-1), ["claude-a", file]);
  await rejectsWith(r.manage.restoreTrash({ key: item.key }), 404);
});

test("purging a trash entry names the session, whose state rows may then go", async (t) => {
  const r = rig(t);
  const sid = randomUUID();
  writeTranscript(r.accounts[0]!.dir, ENC, sid, conversation(sid));
  writeFile(path.join(r.accounts[0]!.dir, "projects", ENC, sid, "subagents", "agent-0123456789abcdef0.jsonl"), TRASH_THRESHOLD_BYTES);
  const res = await r.manage.deleteSession(del(sid));
  assert.equal(res.outcome, "trashed");
  assert.deepEqual(r.removed, []);
  const purged = r.manage.purgeTrash({ key: res.trashKey });
  assert.ok(purged.freedBytes > TRASH_THRESHOLD_BYTES);
  assert.deepEqual(r.removed, [[`claude:${sid}`]]);
});

test("restore refuses when the session's place is taken, and keeps the entry", async (t) => {
  const r = rig(t);
  const sid = randomUUID();
  writeTranscript(r.accounts[0]!.dir, ENC, sid, conversation(sid));
  writeFile(path.join(r.accounts[0]!.dir, "projects", ENC, sid, "tool-results", "big.txt"), TRASH_THRESHOLD_BYTES + 1);
  const { trashKey } = await r.manage.deleteSession(del(sid));
  // A new transcript with the same id under another project dir of the same account.
  writeTranscript(r.accounts[0]!.dir, "-elsewhere", sid, conversation(sid));
  await rejectsWith(r.manage.restoreTrash({ key: trashKey }), 409, /already has/);
  assert.equal(r.trash.list().items.length, 1);
  fs.rmSync(path.join(r.accounts[0]!.dir, "projects", "-elsewhere"), { recursive: true });
  // A subtree dir at the target also refuses, before anything moves.
  fs.mkdirSync(path.join(r.accounts[0]!.dir, "projects", ENC, sid));
  await rejectsWith(r.manage.restoreTrash({ key: trashKey }), 409, /subtree/);
  assert.ok(!fs.existsSync(path.join(r.accounts[0]!.dir, "projects", ENC, `${sid}.jsonl`)));

  const purged = r.manage.purgeTrash({ key: trashKey });
  assert.ok(purged.freedBytes > TRASH_THRESHOLD_BYTES);
  assert.deepEqual(r.trash.list().items, []);
  await rejectsWith(() => r.manage.purgeTrash({ key: trashKey }), 404);
  await rejectsWith(() => r.manage.purgeTrash({ key: "../../etc" }), 400);
});

test("a session in the list (locked) or an open one is not deleted, and nothing changes", async (t) => {
  const r = rig(t);
  const sid = randomUUID();
  writeTranscript(r.accounts[0]!.dir, ENC, sid, conversation(sid));
  const before = snapshot(r.root);

  r.chosen.set("claude", sid, true);
  await rejectsWith(r.manage.deleteSession(del(sid)), 409, /locked/);
  r.chosen.set("claude", sid, false);

  // A live process registered under the other account (the session moved, the old process is open).
  writeFile(path.join(r.accounts[1]!.dir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, status: "idle" }));
  await rejectsWith(r.manage.deleteSession(del(sid)), 409, new RegExp(`pid ${process.pid}`));
  fs.rmSync(path.join(r.accounts[1]!.dir, "sessions", `${process.pid}.json`));

  r.held.add(sid);
  await rejectsWith(r.manage.deleteSession(del(sid)), 409, /run by maru/);
  r.held.delete(sid);
  assert.deepEqual(snapshot(r.root), before);
  assert.deepEqual(r.written, []);

  await rejectsWith(r.manage.deleteSession(del(sid, "claude-b")), 404);
  await rejectsWith(r.manage.deleteSession(del(sid.toUpperCase())), 400);
  await rejectsWith(r.manage.deleteSession(del(sid, "claude-x")), 400);
  await rejectsWith(r.manage.deleteSession({ provider: "gemini", account: "claude-a", id: sid }), 400);
  assert.equal((await r.manage.deleteSession(del(sid))).outcome, "deleted");
});

test("a bg session's refusal names the stop command", async (t) => {
  const r = rig(t);
  const sid = randomUUID();
  writeTranscript(r.accounts[0]!.dir, ENC, sid, conversation(sid));
  writeFile(path.join(r.accounts[0]!.dir, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: sid, status: "idle", kind: "bg", jobId: "job123" }));
  await rejectsWith(r.manage.deleteSession(del(sid)), 409, /CLAUDE_CONFIG_DIR=~\/a claude stop job123/);
});

// ---- orphans ----

test("orphans: subtrees with no transcript in any account are listed and removed for good", async (t) => {
  const r = rig(t);
  const orphan = randomUUID();
  const live = randomUUID();
  writeFile(path.join(r.accounts[1]!.dir, "projects", ENC, orphan, "subagents", "agent-0123456789abcdef0.jsonl"), 300);
  writeFile(path.join(r.accounts[0]!.dir, "projects", "-x", orphan, "tool-results", "a.txt"), 200);
  writeTranscript(r.accounts[0]!.dir, ENC, live, conversation(live));
  // The live session's subtree sits in the other account: not an orphan.
  writeFile(path.join(r.accounts[1]!.dir, "projects", ENC, live, "subagents", "agent-1123456789abcdef0.jsonl"), 50);
  fs.mkdirSync(path.join(r.accounts[0]!.dir, "projects", ENC, "memory"));

  const list = r.manage.listOrphans();
  assert.deepEqual(list.sessions.map((s) => [s.provider, s.id, s.files, s.sizeBytes, s.paths.length]), [["claude", orphan, 2, 500, 2]]);
  assert.equal(list.sessions[0]!.account, "claude-a", "the first dir by path names the account");

  r.chosen.set("claude", orphan, true);
  await rejectsWith(r.manage.deleteOrphan({ provider: "claude", account: "claude-a", id: orphan }), 409, /locked/);
  r.chosen.set("claude", orphan, false);
  await rejectsWith(r.manage.deleteOrphan({ provider: "claude", account: "claude-a", id: live }), 409, /not an orphan/);
  const res = await r.manage.deleteOrphan({ provider: "claude", account: "claude-a", id: orphan });
  assert.deepEqual(res, { ok: true, removed: 2, freedBytes: 500 });
  assert.deepEqual(r.removed, [[`claude:${orphan}`]]);
  assert.deepEqual(r.manage.listOrphans().sessions, []);
  assert.ok(fs.existsSync(path.join(r.accounts[1]!.dir, "projects", ENC, live)));
  await rejectsWith(r.manage.deleteOrphan({ provider: "claude", account: "claude-a", id: orphan }), 404);
});

// ---- units ----

test("units: subagents and outermost workflows across accounts, deleted one at a time", async (t) => {
  const r = rig(t);
  const sid = randomUUID();
  writeTranscript(r.accounts[0]!.dir, ENC, sid, conversation(sid));
  const subA = path.join(r.accounts[0]!.dir, "projects", ENC, sid);
  const subB = path.join(r.accounts[1]!.dir, "projects", ENC, sid);
  writeFile(path.join(subA, "subagents", "agent-0123456789abcdef0.jsonl"), 100);
  writeFile(path.join(subA, "subagents", "agent-0123456789abcdef0.meta.json"), 10);
  writeFile(path.join(subB, "subagents", "agent-0123456789abcdef0.jsonl"), 1000);
  writeFile(path.join(subA, "workflows", "wf_12345678-abc.json"), 20);
  writeFile(path.join(subA, "subagents", "workflows", "wf_12345678-abc", "journal.jsonl"), 30);
  writeFile(path.join(subA, "subagents", "workflows", "wf_12345678-abc", "agent-2223456789abcdef0.jsonl"), 40);
  // A nested workflow travels with its parent and is no unit of its own.
  writeFile(path.join(subA, "subagents", "workflows", "wf_12345678-abc", "workflows", "wf_87654321-def", "journal.jsonl"), 5);
  writeFile(path.join(subA, "tool-results", "x.txt"), 7);
  writeFile(path.join(subA, "workflows", "scripts", "s-wf_12345678-abc.js"), 3);
  r.chosen.set("claude", sid, true);

  const units = r.manage.sessionUnits(new URLSearchParams({ provider: "claude", account: "claude-a", id: sid }));
  assert.deepEqual(units.units.map((u) => [u.kind, u.unitId, u.sizeBytes, u.files]), [
    ["subagent", "agent-0123456789abcdef0", 1110, 3],
    ["workflow", "wf_12345678-abc", 95, 4],
  ]);
  assert.deepEqual([units.totalBytes, units.unitBytes, units.remainderBytes, units.locked, units.open], [1215, 1205, 10, true, false]);
  const all = r.manage.allUnits();
  assert.deepEqual(all.units.map((u) => [u.id, u.unitId, u.account]), [[sid, "agent-0123456789abcdef0", "claude-a"], [sid, "wf_12345678-abc", "claude-a"]]);

  // A lock guards the whole session, not its units.
  const w = r.manage.deleteUnit({ provider: "claude", account: "claude-a", id: sid, kind: "workflow", unitId: "wf_12345678-abc" });
  assert.deepEqual(w, { ok: true, removed: 2, freedBytes: 95 });
  assert.ok(!fs.existsSync(path.join(subA, "workflows", "wf_12345678-abc.json")));
  assert.ok(fs.existsSync(path.join(subA, "workflows", "scripts", "s-wf_12345678-abc.js")));
  const s = r.manage.deleteUnit({ provider: "claude", account: "claude-a", id: sid, kind: "subagent", unitId: "agent-0123456789abcdef0" });
  assert.deepEqual(s, { ok: true, removed: 3, freedBytes: 1110 });
  assert.deepEqual(r.manage.sessionUnits(new URLSearchParams({ provider: "claude", account: "claude-a", id: sid })).units, []);

  await rejectsWith(() => r.manage.deleteUnit({ provider: "claude", account: "claude-a", id: sid, kind: "subagent", unitId: "agent-0123456789abcdef0" }), 404);
  await rejectsWith(() => r.manage.deleteUnit({ provider: "claude", account: "claude-a", id: sid, kind: "subagent", unitId: "../x" }), 400);
  await rejectsWith(() => r.manage.deleteUnit({ provider: "claude", account: "claude-a", id: sid, kind: "tool", unitId: "x" }), 400);
  await rejectsWith(() => r.manage.sessionUnits(new URLSearchParams({ provider: "codex", account: "claude-a", id: sid })), 400);
  r.held.add(sid);
  writeFile(path.join(subA, "subagents", "agent-3333456789abcdef0.jsonl"), 1);
  await rejectsWith(() => r.manage.deleteUnit({ provider: "claude", account: "claude-a", id: sid, kind: "subagent", unitId: "agent-3333456789abcdef0" }), 409);
  assert.ok(fs.existsSync(path.join(subA, "subagents", "agent-3333456789abcdef0.jsonl")));
});

// ---- move between accounts ----

test("move: transcript and its subtree go to the other account; a metadata stub there is set aside", async (t) => {
  const r = rig(t);
  const sid = randomUUID();
  const src = writeTranscript(r.accounts[0]!.dir, ENC, sid, conversation(sid));
  writeFile(path.join(r.accounts[0]!.dir, "projects", ENC, sid, "subagents", "agent-0123456789abcdef0.jsonl"), 10);
  writeFile(path.join(r.accounts[0]!.dir, "projects", "-other", sid, "tool-results", "x.txt"), 10);
  const dst = path.join(r.accounts[1]!.dir, "projects", ENC, `${sid}.jsonl`);
  writeTranscript(r.accounts[1]!.dir, ENC, sid, [{ type: "custom-title", customTitle: "x" }, { type: "cost-state" }]);
  r.index.apply({ type: "upsert", session: summary("claude-a", sid, { cwd: "/work/it's here" }) });

  const res = await r.manage.move({ provider: "claude", id: sid, from: "claude-a", to: "claude-b" });
  assert.ok(!fs.existsSync(src));
  assert.equal(JSON.parse(fs.readFileSync(dst, "utf8").split("\n")[0]!).type, "user");
  assert.ok(res.replacedStub && fs.existsSync(res.replacedStub) && res.replacedStub.startsWith(path.join(r.root, "stubs")));
  assert.ok(fs.existsSync(path.join(r.accounts[1]!.dir, "projects", ENC, sid, "subagents", "agent-0123456789abcdef0.jsonl")));
  assert.deepEqual(res.subtreesLeft, [path.join(r.accounts[0]!.dir, "projects", "-other", sid)]);
  assert.equal(res.resumeCommand, `cd -- '/work/it'"'"'s here' && CLAUDE_CONFIG_DIR=${r.accounts[1]!.dir} claude --resume ${sid}`);
  assert.deepEqual(r.written, [["claude-a", src], ["claude-b", dst]]);

  // Back again is refused while the other account holds a real conversation for the id.
  writeTranscript(r.accounts[0]!.dir, ENC, sid, conversation(sid));
  await rejectsWith(r.manage.move({ provider: "claude", id: sid, from: "claude-a", to: "claude-b" }), 409, /already has/);
  await rejectsWith(r.manage.move({ provider: "claude", id: sid, from: "claude-a", to: "claude-a" }), 400);
  writeFile(path.join(r.accounts[0]!.dir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid }));
  await rejectsWith(r.manage.move({ provider: "claude", id: sid, from: "claude-b", to: "claude-a" }), 409, /pid/);
});

// ---- rehome ----

test("rehome: the transcript moves to the new folder's project dir with its top-level cwd rewritten", async (t) => {
  const r = rig(t);
  const sid = randomUUID();
  const given = path.join(r.root, "new place");
  fs.mkdirSync(given);
  // The folder as the system resolves it (the temp root is under a symlink on macOS: /var).
  const newCwd = fs.realpathSync(given);
  const rows = [
    { type: "summary", note: "no cwd" },
    { type: "user", cwd: "/work/proj", sessionId: sid, message: { role: "user", content: "cd /work/proj" } },
    { type: "user", cwd: "/work/proj/sub", sessionId: sid, message: { role: "user", content: "x" } },
    { type: "user", cwd: "/work/project-other", sessionId: sid, message: { role: "user", content: "y" } },
  ];
  const src = writeTranscript(r.accounts[0]!.dir, ENC, sid, rows);
  fs.appendFileSync(src, '{"type":"assistant","cwd":"/work/proj","cut');
  const old = new Date("2026-11-01T00:00:00Z");
  fs.utimesSync(src, old, old);
  writeFile(path.join(r.accounts[0]!.dir, "projects", ENC, sid, "subagents", "agent-0123456789abcdef0.jsonl"), 10);

  const res = await r.manage.rehome({ provider: "claude", account: "claude-a", id: sid, cwd: given + "/" });
  const enc = newCwd.replace(/[^a-zA-Z0-9]/g, "-");
  const dst = path.join(r.accounts[0]!.dir, "projects", enc, `${sid}.jsonl`);
  assert.deepEqual([res.cwd, res.cwdRewritten, res.replacedStub, res.subtreesLeft], [newCwd, 2, null, []]);
  assert.ok(!fs.existsSync(src));
  const lines = fs.readFileSync(dst, "utf8").split("\n");
  assert.equal(lines[0], JSON.stringify(rows[0]), "a line without the cwd is byte for byte");
  assert.equal(JSON.parse(lines[1]!).cwd, newCwd);
  assert.equal(JSON.parse(lines[1]!).message.content, "cd /work/proj", "only the top-level cwd changes");
  assert.equal(JSON.parse(lines[2]!).cwd, `${newCwd}/sub`);
  assert.equal(JSON.parse(lines[3]!).cwd, "/work/project-other", "a sibling with the same prefix stays");
  assert.equal(lines[4], '{"type":"assistant","cwd":"/work/proj","cut', "an unterminated last line is copied as is");
  assert.equal(fs.statSync(dst).mtimeMs, old.getTime(), "the session keeps its last activity time");
  assert.ok(fs.existsSync(path.join(r.accounts[0]!.dir, "projects", enc, sid, "subagents", "agent-0123456789abcdef0.jsonl")));
  assert.equal(res.resumeCommand, `cd -- '${newCwd}' && CLAUDE_CONFIG_DIR=${r.accounts[0]!.dir} claude --resume ${sid}`);
  assert.deepEqual(r.written, [["claude-a", src], ["claude-a", dst]]);
  assert.deepEqual(fs.readdirSync(path.dirname(dst)).filter((n) => n.includes(".tmp")), []);

  await rejectsWith(r.manage.rehome({ provider: "claude", account: "claude-a", id: sid, cwd: newCwd }), 400, /Already in that folder/);
  await rejectsWith(r.manage.rehome({ provider: "claude", account: "claude-a", id: sid, cwd: given }), 400, /Already in that folder/);
  await rejectsWith(r.manage.rehome({ provider: "claude", account: "claude-a", id: sid, cwd: "relative/x" }), 400, /absolute path/);
  await rejectsWith(r.manage.rehome({ provider: "claude", account: "claude-a", id: sid, cwd: path.join(r.root, "nope") }), 400, /Folder not found/);
  await rejectsWith(r.manage.rehome({ provider: "codex", account: "codex-a", id: sid, cwd: newCwd }), 400, /Codex/);
});

test("rehome: a folder given through a symlink is kept as its target, where a resume looks", async (t) => {
  const r = rig(t);
  const sid = randomUUID();
  const target = path.join(r.root, "drive", "real place");
  fs.mkdirSync(target, { recursive: true });
  const link = path.join(r.root, "projects-link");
  fs.symlinkSync(target, link);
  writeTranscript(r.accounts[0]!.dir, ENC, sid, conversation(sid, "/work/proj"));

  const res = await r.manage.rehome({ provider: "claude", account: "claude-a", id: sid, cwd: link });
  const real = fs.realpathSync(target);
  assert.equal(res.cwd, real);
  const dst = path.join(r.accounts[0]!.dir, "projects", real.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
  assert.ok(fs.existsSync(dst));
  const cwds = fs.readFileSync(dst, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).cwd).filter(Boolean);
  assert.ok(cwds.length > 0 && cwds.every((c: string) => c === real));
});

test("resume command: from the index, or the transcript's first cwd", async (t) => {
  const r = rig(t);
  const sid = randomUUID();
  writeTranscript(r.accounts[0]!.dir, ENC, sid, conversation(sid, "/from/file"));
  const q = new URLSearchParams({ provider: "claude", account: "claude-a", id: sid });
  assert.deepEqual(r.manage.resumeCommand(q), { cwd: "/from/file", command: `cd -- /from/file && CLAUDE_CONFIG_DIR=${r.accounts[0]!.dir} claude --resume ${sid}` });
  r.index.apply({ type: "upsert", session: summary("claude-a", sid, { cwd: "/from/index" }) });
  assert.equal(r.manage.resumeCommand(q).cwd, "/from/index");
  await rejectsWith(() => r.manage.resumeCommand(new URLSearchParams({ provider: "claude", account: "claude-b", id: sid })), 404);
});
