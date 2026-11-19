// Fork from a message (DESIGN.md 6q): the cut line, the gates, the new session's name, list place and Group.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RenameSession, SessionSummary } from "@maru/shared";
import { SessionRewindStore } from "../state/sessionRewinds.ts";
import { ForkError, forkName, SessionFork, type SessionForkDeps } from "./sessionFork.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const NEW = "99999999-2222-4333-8444-555555555555";
const KEY = `claude:acct:${SID}`;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    key: KEY, provider: "claude", account: "acct", id: SID, cwd: os.tmpdir(), name: "Work", title: null, preview: "first",
    status: "closed", owner: "none", pid: null, tmuxPane: null, parentKey: null, updatedAt: 1, createdAt: null, sizeBytes: null, entrypoint: "maru", ...over,
  };
}

test("forkName: the mark, the next number, and what a name falls back to", () => {
  const n = (name: string | null, title: string | null = null, preview: string | null = null) => forkName({ name, title, preview });
  assert.equal(n("Work"), "Work (fork)");
  assert.equal(n("Work (fork)"), "Work (fork 2)");
  assert.equal(n("Work (fork 2)"), "Work (fork 3)");
  assert.equal(n("Work (fork) notes"), "Work (fork) notes (fork)", "a mark inside the name is not the trailing one");
  assert.equal(n(null, "Generated title"), "Generated title (fork)");
  assert.equal(n(null, null, "line one\n  line two"), "line one line two (fork)");
  assert.equal(n(null), "(fork)");
});

test("forkName: three forks of one original count up, a fork of a fork stays in the family", () => {
  const original = { name: "Work", title: null, preview: null };
  const names: string[] = ["Work", "Other (fork)"];
  const fork = (o: { name: string | null; title: string | null; preview: string | null }) => {
    const n = forkName(o, names);
    names.push(n);
    return n;
  };
  assert.equal(fork(original), "Work (fork)");
  assert.equal(fork(original), "Work (fork 2)");
  assert.equal(fork(original), "Work (fork 3)");
  // Forking the first fork (name "Work (fork)") continues the same family.
  assert.equal(fork({ name: "Work (fork)", title: null, preview: null }), "Work (fork 4)");
  // An original that already ends with (fork 2) numbers by the family too, not by its own suffix.
  assert.equal(fork({ name: "Work (fork 2)", title: null, preview: null }), "Work (fork 5)");
});

test("forkName: an original ending in (fork 2) with no siblings listed gives (fork 3), names are matched whole", () => {
  assert.equal(forkName({ name: "x (fork 2)", title: null, preview: null }, ["x (fork 2)"]), "x (fork 3)");
  assert.equal(forkName({ name: "x", title: null, preview: null }, ["xy (fork)", "x (fork) notes", "a x (fork)"]), "x (fork)");
  assert.equal(forkName({ name: "a.b", title: null, preview: null }, ["aXb (fork)"]), "a.b (fork)", "the base is not a pattern");
  assert.equal(forkName({ name: "x", title: null, preview: null }, ["x (fork 4)"]), "x (fork 5)", "the highest number plus one");
  assert.equal(forkName({ name: "x", title: null, preview: null }, ["x  (fork 2)"]), "x (fork 3)", "whitespace runs are one space");
});

type State = ReturnType<SessionForkDeps["runs"]["rewindState"]>;

/** A Claude session of two messages (lines 1 to 4 and 5 to 8), the second with a reply. */
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fork-"));
  const dir = path.join(home, "projects", "-w");
  fs.mkdirSync(dir, { recursive: true });
  const line = (n: number, parent: number | null, type: "user" | "assistant" | "attachment", content: unknown = []) => ({
    parentUuid: parent === null ? null : U(parent), type, uuid: U(n), message: { role: type, content },
  });
  const lines = [
    line(1, null, "user", "first"), line(2, 1, "assistant"), line(3, 2, "attachment"),
    line(4, 3, "user", "second"), line(5, 4, "assistant"),
  ];
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const calls: string[] = [];
  const joined: string[] = [];
  const assigned: string[] = [];
  const renamed: RenameSession[] = [];
  let state: State = null;
  let s = summary();
  let project: string | null = "grp";
  let renameError: Error | null = null;
  const store = new SessionRewindStore(":memory:");
  const deps: SessionForkDeps = {
    claudeAccounts: [{ id: "acct", dir: home }],
    index: { get: (key) => (key === KEY ? s : undefined), snapshot: () => [s] },
    runs: { rewindState: () => state },
    codexRuns: { async forkAt(key, turnId) { calls.push(`forkAt:${key}:${turnId}`); return "codex:acct2:new-thread"; } },
    store,
    chosen: { set: (provider, id, v) => { joined.push(`${provider}:${id}:${v}`); } },
    projects: {
      projectOf: () => project,
      assign: (provider, id, p) => { assigned.push(`${provider}:${id}:${p}`); },
    },
    rename: async (req) => {
      renamed.push(req);
      if (renameError) throw renameError;
      return { ok: true, name: req.name, stored: "transcript" };
    },
    claudeWritten: async (account, file) => { calls.push(`written:${account}:${path.basename(file)}`); },
    forkTranscript: async (_account, sessionId, upTo) => {
      calls.push(`fork:${sessionId}:${upTo}`);
      // What forkSession leaves: a new transcript beside the original.
      fs.writeFileSync(path.join(dir, `${NEW}.jsonl`), "{}\n");
      return NEW;
    },
  };
  return {
    calls, joined, assigned, renamed, store, fork: new SessionFork(deps),
    setState: (v: State) => (state = v), setSummary: (v: SessionSummary) => (s = v), setProject: (v: string | null) => (project = v),
    failRename: (e: Error) => (renameError = e), cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

test("a Claude fork keeps the message and its answer, joins the list and the Group, and is named", async () => {
  const f = fixture();
  try {
    const res = await f.fork.fork({ key: KEY, id: U(1) });
    // Message 1 stretches to line 3, the line before message 4.
    assert.deepEqual(f.calls, [`fork:${SID}:${U(3)}`, `written:acct:${NEW}.jsonl`]);
    assert.deepEqual(res, { ok: true, key: `claude:acct:${NEW}`, name: "Work (fork)", notice: null });
    assert.deepEqual(f.joined, [`claude:${NEW}:true`]);
    assert.deepEqual(f.assigned, [`claude:${NEW}:grp`]);
    assert.deepEqual(f.renamed, [{ provider: "claude", account: "acct", id: NEW, name: "Work (fork)" }]);
  } finally {
    f.cleanup();
  }
});

test("the newest message while its turn runs is refused; an earlier one is forked from a running session", async () => {
  const f = fixture();
  try {
    f.setSummary(summary({ status: "running", owner: "ui" }));
    f.setState({ busy: true, pending: false, backgroundTasks: 0, closing: false, fileCheckpointing: true });
    await assert.rejects(f.fork.fork({ key: KEY, id: U(4) }), (e: unknown) => e instanceof ForkError && e.status === 409 && /its turn is running/.test(e.message));
    assert.deepEqual(f.calls, []);
    await f.fork.fork({ key: KEY, id: U(1) });
    assert.equal(f.calls[0], `fork:${SID}:${U(3)}`);
    // A terminal's running turn counts the same.
    f.calls.length = 0;
    f.setState(null);
    f.setSummary(summary({ status: "running", owner: "terminal" }));
    await assert.rejects(f.fork.fork({ key: KEY, id: U(4) }), /its turn is running/);
    // Idle, the newest message forks to the conversation's end.
    f.setSummary(summary());
    await f.fork.fork({ key: KEY, id: U(4) });
    assert.equal(f.calls[0], `fork:${SID}:${U(5)}`);
  } finally {
    f.cleanup();
  }
});

test("a waiting rewind ends the fork at its kept line; a rewound message is not forkable", async () => {
  const f = fixture();
  try {
    f.store.set(SID, { atUuid: U(4), keepUuid: U(3), lastUuid: U(5), createdAt: 1 });
    await assert.rejects(f.fork.fork({ key: KEY, id: U(4) }), (e: unknown) => e instanceof ForkError && e.status === 404);
    await f.fork.fork({ key: KEY, id: U(1) });
    assert.equal(f.calls[0], `fork:${SID}:${U(3)}`);
  } finally {
    f.cleanup();
  }
});

test("refusals: bad request, unknown session, subagent, a message that is not there", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.fork.fork({ key: KEY, id: "" }), (e: unknown) => e instanceof ForkError && e.status === 400);
    await assert.rejects(f.fork.fork({ key: "claude:acct:nope", id: U(1) }), (e: unknown) => e instanceof ForkError && e.status === 404);
    await assert.rejects(f.fork.fork({ key: KEY, id: U(77) }), (e: unknown) => e instanceof ForkError && e.status === 404);
    f.setSummary(summary({ parentKey: "claude:acct:parent" }));
    await assert.rejects(f.fork.fork({ key: KEY, id: U(1) }), (e: unknown) => e instanceof ForkError && e.status === 409 && /subagent/.test(e.message));
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.joined, []);
  } finally {
    f.cleanup();
  }
});

test("no Group stays in Unsorted; a failed name keeps the fork and says so", async () => {
  const f = fixture();
  try {
    f.setProject(null);
    f.failRename(new Error("This session is run by maru"));
    const res = await f.fork.fork({ key: KEY, id: U(1) });
    assert.deepEqual(f.assigned, []);
    assert.deepEqual(f.joined, [`claude:${NEW}:true`]);
    assert.match(res.notice!, /The fork was created but could not be named: This session is run by maru/);
  } finally {
    f.cleanup();
  }
});

test("the Codex daemon's refusals become reasons", async () => {
  const key = "codex:acct2:thread-1";
  const make = (message: string) => new SessionFork({
    claudeAccounts: [],
    index: { get: () => summary({ key, provider: "codex", account: "acct2", id: "thread-1" }), snapshot: () => [] },
    runs: { rewindState: () => null },
    codexRuns: { async forkAt() { throw new Error(message); } },
    store: new SessionRewindStore(":memory:"),
    chosen: { set: () => {} }, projects: { projectOf: () => null, assign: () => {} },
    rename: async (req) => ({ ok: true, name: req.name, stored: "daemon" }),
    claudeWritten: async () => {},
  });
  await assert.rejects(make("Codex daemon refused: thread/fork: lastTurnId 't' identifies an in-progress turn (code -32600)").fork({ key, id: "t" }),
    (e: unknown) => e instanceof ForkError && e.status === 409 && /its turn is running/.test(e.message));
  await assert.rejects(make("Codex daemon refused: thread/fork: turn not found: t (code -32600)").fork({ key, id: "t" }),
    (e: unknown) => e instanceof ForkError && e.status === 404);
  await assert.rejects(make("Codex daemon connection lost").fork({ key, id: "t" }), /connection lost/);
});

test("a Codex fork goes through the turn (a steer message's turn too) and is named", async () => {
  const f = fixture();
  try {
    const key = "codex:acct2:thread-1";
    f.setSummary(summary({ key, provider: "codex", account: "acct2", id: "thread-1", name: null, title: "Auth refactor" }));
    // The fixture's index answers only KEY; give the Codex session its own lookup.
    const codex = new SessionFork({
      claudeAccounts: [],
      index: { get: (k) => (k === key ? summary({ key, provider: "codex", account: "acct2", id: "thread-1", name: null, title: "Auth refactor" }) : undefined), snapshot: () => [] },
      runs: { rewindState: () => null },
      codexRuns: { async forkAt(k, turnId) { f.calls.push(`forkAt:${k}:${turnId}`); return "codex:acct2:new-thread"; } },
      store: new SessionRewindStore(":memory:"),
      chosen: { set: () => { throw new Error("CodexRuns joins the list"); } },
      projects: { projectOf: () => null, assign: () => { throw new Error("CodexRuns assigns the Group"); } },
      rename: async (req) => { f.renamed.push(req); return { ok: true, name: req.name, stored: "daemon" }; },
      claudeWritten: async () => {},
    });
    const res = await codex.fork({ key, id: "turn-2:item-9" });
    assert.deepEqual(f.calls, ["forkAt:codex:acct2:thread-1:turn-2"]);
    assert.deepEqual(res, { ok: true, key: "codex:acct2:new-thread", name: "Auth refactor (fork)", notice: null });
    assert.deepEqual(f.renamed, [{ provider: "codex", account: "acct2", id: "new-thread", name: "Auth refactor (fork)" }]);
  } finally {
    f.cleanup();
  }
});
