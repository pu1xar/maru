import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ClaudeAccount, CodexAccount } from "../config.ts";
import { ProjectStore } from "../projects/store.ts";
import { ChosenStore } from "../state/chosen.ts";
import { SessionChoiceStore } from "../state/sessionChoices.ts";
import { SessionNameStore } from "../state/sessionNames.ts";
import { forgetGoneSessions, forgetReportLine, goneKeys, readPresence } from "./presence.ts";

type T = { after: (fn: () => void | Promise<void>) => void };

function tmp(t: T): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presence-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function touch(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n");
}

function stateDb(home: string, rows: Array<{ id: string; archived: number }>): void {
  fs.mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, archived INTEGER NOT NULL DEFAULT 0)");
  for (const r of rows) db.prepare("INSERT INTO threads (id, archived) VALUES (?, ?)").run(r.id, r.archived);
  db.close();
}

interface World {
  claude: ClaudeAccount[];
  codex: CodexAccount[];
  trashRoot: string;
}

function world(t: T): World {
  const root = tmp(t);
  const w: World = {
    claude: [{ id: "claude-a", dir: path.join(root, "a") }, { id: "claude-b", dir: path.join(root, "b") }],
    codex: [{ id: "codex-a", home: path.join(root, "ca") }, { id: "codex-b", home: path.join(root, "cb") }],
    trashRoot: path.join(root, "trash"),
  };
  // The account folders exist (an account with no projects folder yet is fine).
  for (const dir of [...w.claude.map((a) => a.dir), ...w.codex.map((a) => a.home)]) fs.mkdirSync(dir, { recursive: true });
  return w;
}

const deps = (w: World) => ({ claudeAccounts: w.claude, codexAccounts: w.codex, trashRoot: w.trashRoot });

test("a session counts as present in any of its places: transcript, thread row (archived too), rollout, trash entry", (t) => {
  const w = world(t);
  const [inA, inB, trashedClaude, rowLive, rowArchived, rolloutOnly, archivedRollout, trashedCodex] = Array.from({ length: 8 }, () => randomUUID() as string) as [string, string, string, string, string, string, string, string];
  touch(path.join(w.claude[0]!.dir, "projects", "-p", `${inA}.jsonl`));
  touch(path.join(w.claude[1]!.dir, "projects", "-q", `${inB}.jsonl`));
  // A subtree alone is no session (an orphan).
  touch(path.join(w.claude[1]!.dir, "projects", "-q", randomUUID(), "subagents", "agent-a.jsonl"));
  stateDb(w.codex[0]!.home, [{ id: rowLive, archived: 0 }, { id: rowArchived, archived: 1 }]);
  touch(path.join(w.codex[1]!.home, "sessions", "2026", "11", "16", `rollout-2026-11-16T10-00-00-${rolloutOnly}.jsonl`));
  touch(path.join(w.codex[0]!.home, "archived_sessions", `rollout-2026-11-01T10-00-00-${archivedRollout}.jsonl`));
  fs.mkdirSync(path.join(w.trashRoot, `${trashedClaude}__claude-claude-a`), { recursive: true });
  // An entry whose meta cannot be read still holds its session.
  fs.mkdirSync(path.join(w.trashRoot, `${trashedCodex}__codex-codex-a-2`), { recursive: true });

  const p = readPresence(deps(w));
  assert.deepEqual(p.unread, []);
  assert.deepEqual([...p.claude!].sort(), [inA, inB, trashedClaude].sort());
  assert.deepEqual([...p.codex!].sort(), [rowLive, rowArchived, rolloutOnly, archivedRollout, trashedCodex].sort());

  const gone = randomUUID();
  const keys = [`claude:${inA}`, `claude:${gone}`, `codex:${rowArchived}`, `codex:${gone}`, `codex:${trashedCodex}`];
  assert.deepEqual(goneKeys(keys, p), [`claude:${gone}`, `codex:${gone}`]);
  assert.deepEqual(goneKeys(keys, p, (k) => k === `codex:${gone}`), [`claude:${gone}`], "the live index holds a session too");
});

test("a place that cannot be read leaves every session of that provider standing", (t) => {
  const w = world(t);
  const projects = path.join(w.claude[0]!.dir, "projects");
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(w.codex[0]!.home, { recursive: true });
  fs.writeFileSync(path.join(w.codex[0]!.home, "state_5.sqlite"), "not a database");

  fs.chmodSync(projects, 0o000);
  let p;
  try {
    p = readPresence(deps(w));
  } finally {
    fs.chmodSync(projects, 0o755);
  }
  assert.equal(p.claude, null);
  assert.equal(p.codex, null);
  assert.deepEqual(p.unread.map((u) => u.provider), ["claude", "codex"]);
  assert.deepEqual(goneKeys([`claude:${randomUUID()}`, `codex:${randomUUID()}`], p), []);
});

test("a missing account folder is a place not read, not an account with no sessions", (t) => {
  const w = world(t);
  fs.rmSync(w.claude[1]!.dir, { recursive: true });
  fs.rmSync(w.codex[0]!.home, { recursive: true });
  const p = readPresence(deps(w));
  assert.equal(p.claude, null);
  assert.equal(p.codex, null);
  assert.deepEqual(p.unread.map((u) => u.provider), ["claude", "codex"]);
  assert.match(p.unread[0]!.reason, /account folder/);
  assert.deepEqual(goneKeys([`claude:${randomUUID()}`, `codex:${randomUUID()}`], p), []);
});

test("an unreadable trash leaves both providers standing", (t) => {
  const w = world(t);
  fs.mkdirSync(w.trashRoot, { recursive: true });
  fs.chmodSync(w.trashRoot, 0o000);
  let p;
  try {
    p = readPresence(deps(w));
  } finally {
    fs.chmodSync(w.trashRoot, 0o755);
  }
  assert.equal(p.claude, null);
  assert.equal(p.codex, null);
  assert.deepEqual(p.unread.map((u) => u.provider), ["claude", "codex"]);
});

test("forgetGoneSessions drops assignment, position, pin, list place and choice of gone sessions only", (t) => {
  const w = world(t);
  const projects = new ProjectStore(":memory:");
  const chosen = new ChosenStore(":memory:");
  const choices = new SessionChoiceStore(":memory:");
  const names = new SessionNameStore(":memory:");
  t.after(() => {
    projects.close();
    chosen.close();
    choices.close();
    names.close();
  });
  const kept = randomUUID();
  const gone = randomUUID();
  const goneCodex = randomUUID();
  touch(path.join(w.claude[0]!.dir, "projects", "-p", `${kept}.jsonl`));
  const group = projects.create({ name: "g" });
  for (const id of [kept, gone]) {
    projects.assign("claude", id, group.id);
    projects.ensurePosition("claude", id, 5);
    projects.pin("claude", id, true);
    projects.archive("claude", id, true);
    chosen.set("claude", id, true);
    choices.merge("claude", id, { model: "haiku" });
    names.set("claude", id, `name ${id}`, [null]);
  }
  projects.ensurePosition("codex", goneCodex, 7);
  const changes: string[][] = [];
  projects.onChange((c) => {
    if (c.kind === "assignments") changes.push(c.keys);
  });
  const left: string[][] = [];
  chosen.onChange((keys) => left.push(keys));

  const r = forgetGoneSessions("all", { ...deps(w), stores: { projects, chosen, choices, names } });
  assert.equal(r.checked, 3);
  assert.deepEqual(r.gone.sort(), [`claude:${gone}`, `codex:${goneCodex}`].sort());
  assert.deepEqual(r.rows, { assignments: 1, positions: 2, pins: 1, archived: 1, chosen: 1, choices: 1, names: 1 });
  assert.deepEqual([...projects.keys()], [`claude:${kept}`]);
  assert.equal(projects.projectOf("claude", kept), group.id);
  assert.equal(projects.pinOf("claude", kept), 0);
  assert.equal(projects.pinOf("claude", gone), null);
  assert.equal(projects.archivedOf("claude", gone), null);
  assert.notEqual(projects.archivedOf("claude", kept), null);
  assert.deepEqual(chosen.keys(), [`claude:${kept}`]);
  assert.deepEqual(choices.keys(), [`claude:${kept}`]);
  assert.deepEqual(names.keys(), [`claude:${kept}`]);
  assert.deepEqual(changes.map((c) => c.sort()), [[`claude:${gone}`, `codex:${goneCodex}`].sort()], "the index re-reads what changed");
  assert.deepEqual(left, [[`claude:${gone}`]]);
  assert.match(forgetReportLine(r, "start") ?? "", /2 of 3 sessions gone, dropped assignments 1, positions 2, pins 1, archived 1, chosen 1, choices 1, names 1/);

  // Named keys only: a later session that went is not looked at.
  const again = forgetGoneSessions([`claude:${kept}`], { ...deps(w), stores: { projects, chosen, choices, names } });
  assert.deepEqual([again.checked, again.gone], [1, []]);
  assert.equal(forgetReportLine(again, "delete"), null);
});

test("the rows stay in the database too: a new store reads only what was kept", (t) => {
  const w = world(t);
  const file = path.join(tmp(t), "state.sqlite");
  const gone = randomUUID();
  const kept = randomUUID();
  touch(path.join(w.claude[0]!.dir, "projects", "-p", `${kept}.jsonl`));
  {
    const projects = new ProjectStore(file);
    const chosen = new ChosenStore(file);
    const choices = new SessionChoiceStore(file);
    const names = new SessionNameStore(file);
    for (const id of [kept, gone]) {
      projects.ensurePosition("claude", id, 1);
      projects.pin("claude", id, true);
      chosen.set("claude", id, true);
    }
    forgetGoneSessions("all", { ...deps(w), stores: { projects, chosen, choices, names } });
    projects.close();
    chosen.close();
    choices.close();
    names.close();
  }
  const projects = new ProjectStore(file);
  const chosen = new ChosenStore(file);
  t.after(() => {
    projects.close();
    chosen.close();
  });
  assert.deepEqual([...projects.keys()], [`claude:${kept}`]);
  assert.deepEqual(chosen.keys(), [`claude:${kept}`]);
});
