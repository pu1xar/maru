// Rewind (DESIGN.md 6o): gates, the order of the steps, the marker, and Codex targets.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "@maru/shared";
import type { Turn } from "../codex/protocol/v2/Turn.ts";
import { SessionRewindStore } from "../state/sessionRewinds.ts";
import { claudeBlocked, claudeParts, codexTargets, RewindError, SessionRewind, type SessionRewindDeps } from "./sessionRewind.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const KEY = `claude:acct:${SID}`;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    key: KEY, provider: "claude", account: "acct", id: SID, cwd: os.tmpdir(), name: null, title: null, preview: null,
    status: "closed", owner: "none", pid: null, tmuxPane: null, parentKey: null, updatedAt: 1, createdAt: null, sizeBytes: null, entrypoint: "maru", ...over,
  };
}

type State = NonNullable<ReturnType<SessionRewindDeps["runs"]["rewindState"]>>;
const idle: State = { busy: false, pending: false, backgroundTasks: 0, closing: false, fileCheckpointing: true };

test("claudeBlocked: subagent, terminal, question, turn, host", () => {
  assert.equal(claudeBlocked(summary(), null, true), null);
  assert.match(claudeBlocked(summary({ parentKey: "x" }), null, true)!, /subagent/);
  assert.match(claudeBlocked(summary({ owner: "terminal", status: "open-idle" }), null, true)!, /terminal/);
  assert.equal(claudeBlocked(summary({ owner: "terminal", status: "closed" }), null, true), null);
  assert.match(claudeBlocked(summary({ owner: "ui", status: "waiting-input" }), { ...idle, pending: true }, true)!, /question/);
  assert.match(claudeBlocked(summary({ owner: "ui", status: "running" }), { ...idle, busy: true }, true)!, /turn/);
  assert.match(claudeBlocked(summary(), null, false)!, /host/);
});

test("claudeParts: first message, checkpoint, the setting, background tasks", () => {
  const t = { parentUuid: U(1), checkpoint: true };
  const on = { checkpointingOn: true, rewindWaits: false };
  assert.deepEqual(claudeParts(t, null, on), { conversation: { enabled: true, reason: null }, code: { enabled: true, reason: null } });
  assert.match(claudeParts({ ...t, parentUuid: null }, null, on).conversation.reason!, /first message/);
  assert.match(claudeParts({ ...t, checkpoint: false }, null, on).code.reason!, /checkpoint/);
  assert.match(claudeParts(t, null, { ...on, checkpointingOn: false }).code.reason!, /fileCheckpointingEnabled/);
  const bg = claudeParts(t, { ...idle, backgroundTasks: 1 }, on);
  assert.match(bg.conversation.reason!, /[Bb]ackground/);
  assert.equal(bg.code.enabled, true, "a process that keeps checkpoints restores without being replaced");
  assert.match(claudeParts(t, { ...idle, backgroundTasks: 1, fileCheckpointing: false }, on).code.reason!, /[Bb]ackground/);
  assert.match(claudeParts(t, { ...idle, backgroundTasks: 1 }, { ...on, rewindWaits: true }).code.reason!, /[Bb]ackground/, "a waiting rewind needs a whole-conversation process");
});

test("codexTargets: a turn's first message goes back, a steer and a running turn do not", () => {
  const turn = (id: string, status: Turn["status"], texts: string[]): Turn => ({
    id, rootTurnId: null, itemsView: "summary", status, error: null, startedAt: 1_800_000_000, completedAt: null, durationMs: null,
    items: texts.map((text, i) => ({ type: "userMessage", id: `${id}-u${i}`, clientId: null, content: [{ type: "text", text, text_elements: [] }] })) as unknown as Turn["items"],
  });
  const targets = codexTargets([turn("t1", "completed", ["one", "steer"]), turn("t2", "inProgress", ["two"])]);
  assert.deepEqual(targets.map((x) => [x.id, x.text, x.conversation.enabled]), [["t1", "one", true], ["t1:t1-u1", "steer", false], ["t2", "two", false]]);
  assert.equal(targets[0]!.code.enabled, false);
  assert.equal(targets[0]!.createdAt, new Date(1_800_000_000_000).toISOString());
});

/** A session with two messages, the second with a checkpoint and an edit after it. */
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rewind-"));
  const dir = path.join(home, "projects", "-w");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SID}.jsonl`);
  const lines = [
    { parentUuid: null, type: "user", message: { role: "user", content: "first" }, uuid: U(1) },
    { parentUuid: U(1), type: "assistant", message: { role: "assistant", content: [] }, uuid: U(2) },
    { parentUuid: U(2), type: "user", message: { role: "user", content: "second" }, uuid: U(3) },
    { type: "file-history-snapshot", messageId: U(3), snapshot: { messageId: U(3), trackedFileBackups: {} } },
    { parentUuid: U(3), type: "assistant", message: { role: "assistant", content: [] }, uuid: U(4) },
    { parentUuid: U(4), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "" }] }, uuid: U(5), toolUseResult: { type: "create", filePath: "/w/b.txt", content: "bee\n", structuredPatch: [] } },
  ];
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const log: string[] = [];
  let state: State | null = null;
  let s = summary();
  /** What open() leaves (a turn the CLI starts on its own can make it busy). */
  let opened: State = { ...idle };
  const store = new SessionRewindStore(":memory:");
  const deps: SessionRewindDeps = {
    claudeAccounts: [{ id: "acct", dir: home }],
    index: { get: (key) => (key === KEY ? s : undefined) },
    runs: {
      rewindState: () => state,
      async open(_key: string, opts?: { fullResume?: boolean }) { log.push(opts?.fullResume ? "open:full" : "open"); state = { ...opened }; },
      async close() { log.push("close"); state = null; },
      async call<T>(_key: string, method: string, ...args: unknown[]) {
        log.push(`${method}:${(args[1] as { dryRun?: boolean } | undefined)?.dryRun ? "dry" : "real"}`);
        return { canRewind: true, filesChanged: ["/w/b.txt"], insertions: 0, deletions: 1 } as T;
      },
      refreshTurns() { log.push("refresh"); },
      async exclusive<T>(_key: string, fn: () => Promise<T>) {
        log.push("exclusive");
        try {
          return await fn();
        } finally {
          log.push("/exclusive");
        }
      },
    },
    codexRuns: { async rewindTurns() { throw new Error("no codex"); }, async revert() {} },
    store,
    hostUp: () => true,
  };
  return {
    file, log, store, rewind: new SessionRewind(deps), setState: (v: State | null) => (state = v), setSummary: (v: SessionSummary) => (s = v),
    setOpened: (v: State) => (opened = v), cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

test("list: the targets with what can go back for each", async () => {
  const f = fixture();
  try {
    const list = await f.rewind.list(KEY);
    assert.equal(list.blocked, null);
    assert.deepEqual(list.targets.map((t) => [t.text, t.conversation.enabled, t.code.enabled]), [["first", false, false], ["second", true, true]]);
    assert.deepEqual(list.targets[1]!.restore, { files: ["/w/b.txt"], insertions: 1, deletions: 0 });
  } finally {
    f.cleanup();
  }
});

test("both: restores the code on a process with checkpoints, ends it, then marks the kept line", async () => {
  const f = fixture();
  try {
    const res = await f.rewind.rewind({ key: KEY, id: U(3), mode: "both" });
    assert.deepEqual(f.log, ["exclusive", "open:full", "rewindFiles:dry", "rewindFiles:real", "close", "refresh", "/exclusive"]);
    assert.equal(res.prefill, "second");
    assert.deepEqual(res.restored, { files: ["/w/b.txt"], insertions: 0, deletions: 1 });
    assert.match(res.notice, /Code and conversation rewound, 1 file -1$/);
    const marker = f.store.get(SID)!;
    assert.deepEqual([marker.atUuid, marker.keepUuid, marker.lastUuid], [U(3), U(2), U(5)]);
    // The next process resumes up to the kept line, and the list ends there.
    assert.equal(await f.rewind.resumeAt(SID, f.file), U(2));
    assert.deepEqual((await f.rewind.list(KEY)).targets.map((t) => t.text), ["first"]);
    // While it waits, a code restore runs on a whole-conversation process that is closed after.
    f.log.length = 0;
    await assert.rejects(f.rewind.rewind({ key: KEY, id: U(3), mode: "code" }), (e: unknown) => e instanceof RewindError && e.status === 404, "the rewound message is out of the list");
    // Once a message went on (an opener after the last line), the marker is dropped.
    fs.appendFileSync(f.file, `${JSON.stringify({ parentUuid: U(2), type: "user", message: { role: "user", content: "second, again" }, uuid: U(9) })}\n`);
    assert.equal(await f.rewind.resumeAt(SID, f.file), null);
    assert.equal(f.store.get(SID), null);
  } finally {
    f.cleanup();
  }
});

test("a process without checkpoints is replaced for code; conversation alone needs no process", async () => {
  const f = fixture();
  try {
    f.setState({ ...idle, fileCheckpointing: false });
    await f.rewind.rewind({ key: KEY, id: U(3), mode: "code" });
    assert.deepEqual(f.log, ["exclusive", "close", "open:full", "rewindFiles:dry", "rewindFiles:real", "/exclusive"]);
    assert.equal(f.store.get(SID), null, "a code rewind leaves the conversation");
    f.log.length = 0;
    f.setState(null);
    const res = await f.rewind.rewind({ key: KEY, id: U(3), mode: "conversation" });
    assert.deepEqual(f.log, ["exclusive", "refresh", "/exclusive"]);
    assert.equal(res.restored, null);
    // Code on the first message while that rewind waits: a whole-conversation process, closed after.
    f.log.length = 0;
    await f.rewind.rewind({ key: KEY, id: U(1), mode: "code" }).catch((e: unknown) => assert.match(String(e), /checkpoint/));
    assert.deepEqual(f.log, ["exclusive", "/exclusive"], "the first message has no checkpoint here: refused before any process");
  } finally {
    f.cleanup();
  }
});

test("a turn that starts on its own while the rewind opens a process stops it before the files change", async () => {
  const f = fixture();
  try {
    f.setOpened({ ...idle, busy: true });
    await assert.rejects(f.rewind.rewind({ key: KEY, id: U(3), mode: "both" }), (e: unknown) => e instanceof RewindError && e.status === 409 && /turn/.test(e.message));
    assert.deepEqual(f.log, ["exclusive", "open:full", "/exclusive"]);
    assert.equal(f.store.get(SID), null);
  } finally {
    f.cleanup();
  }
});

test("preview: the dry run on a running process that keeps checkpoints, else nothing (no process is started)", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.rewind.preview(KEY, U(3)), { restore: null, error: null });
    f.setState({ ...idle, fileCheckpointing: false });
    assert.deepEqual(await f.rewind.preview(KEY, U(3)), { restore: null, error: null });
    assert.deepEqual(f.log, [], "neither opened nor called");
    f.setState({ ...idle });
    assert.deepEqual(await f.rewind.preview(KEY, U(3)), { restore: { files: ["/w/b.txt"], insertions: 0, deletions: 1 }, error: null });
    assert.deepEqual(f.log, ["rewindFiles:dry"]);
  } finally {
    f.cleanup();
  }
});

test("refusals: a running turn, a part that is off, an unknown message", async () => {
  const f = fixture();
  try {
    f.setSummary(summary({ owner: "ui", status: "running" }));
    f.setState({ ...idle, busy: true });
    await assert.rejects(f.rewind.rewind({ key: KEY, id: U(3), mode: "both" }), (e: unknown) => e instanceof RewindError && e.status === 409 && /turn/.test(e.message));
    f.setSummary(summary());
    f.setState(null);
    await assert.rejects(f.rewind.rewind({ key: KEY, id: U(1), mode: "conversation" }), /first message/);
    await assert.rejects(f.rewind.rewind({ key: KEY, id: U(7), mode: "conversation" }), (e: unknown) => e instanceof RewindError && e.status === 404);
    await assert.rejects(f.rewind.rewind({ key: KEY, id: U(3), mode: "nope" as never }), (e: unknown) => e instanceof RewindError && e.status === 400);
    assert.deepEqual(f.log.filter((l) => !l.includes("exclusive")), [], "no process was touched");
  } finally {
    f.cleanup();
  }
});
