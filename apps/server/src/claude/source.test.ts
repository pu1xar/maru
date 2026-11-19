import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IndexEvent, SessionSummary } from "@maru/shared";
import { createClaudeSource } from "./source.ts";
import type { ClaudeSource } from "./source.ts";

const ACC = "claude-test";
const ENC = "-work-proj";

let root: string;
let accDir: string;
let projDir: string;
let sessDir: string;
const children: ChildProcess[] = [];

const key = (sid: string) => `claude:${ACC}:${sid}`;
const jl = (objs: object[]): string => objs.map((o) => JSON.stringify(o) + "\n").join("");

function transcript(cwd: string, prompt: string, title: string): string {
  return jl([
    { type: "attachment", cwd, entrypoint: "cli", timestamp: "2026-11-15T10:00:00.000Z" },
    { type: "user", message: { role: "user", content: prompt }, cwd, timestamp: "2026-11-15T10:00:01.000Z" },
    { type: "ai-title", aiTitle: title },
  ]);
}

async function writeReg(pid: number, sessionId: string, status: string | null, tmux: string | null = null) {
  const body: Record<string, unknown> = { pid, sessionId, entrypoint: "cli", tmux, name: "n", updatedAt: Date.now() };
  if (status !== null) body.status = status;
  await fs.writeFile(path.join(sessDir, `${pid}.json`), JSON.stringify(body));
}

function sleeper(): ChildProcess {
  const c = spawn("sleep", ["300"], { stdio: "ignore" });
  children.push(c);
  return c;
}

async function deadPid(): Promise<number> {
  const c = spawn(process.execPath, ["-e", ""]);
  await once(c, "exit");
  return c.pid as number;
}

async function waitFor<T>(what: string, fn: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-source-"));
  accDir = path.join(root, "acc");
  projDir = path.join(accDir, "projects", ENC);
  sessDir = path.join(accDir, "sessions");
  await fs.mkdir(projDir, { recursive: true });
  await fs.mkdir(sessDir, { recursive: true });
});

after(async () => {
  for (const c of children) c.kill("SIGKILL");
  await fs.rm(root, { recursive: true, force: true });
});

test("snapshot, live changes and the pid sweep", async () => {
  const busy = sleeper();
  const idleUi = sleeper();
  const waiting = sleeper();
  const odd = sleeper();
  const dead = await deadPid();

  for (const [sid, title] of [
    ["s-busy", "busy one"],
    ["s-dead", "dead one"],
    ["s-none", "never opened"],
    ["s-multi", "two holders"],
    ["s-odd", "odd status"],
  ] as const) {
    await fs.writeFile(path.join(projDir, `${sid}.jsonl`), transcript("/work/proj", `prompt ${sid}`, title));
  }
  await writeReg(busy.pid!, "s-busy", "busy", "per:@3.%7");
  await writeReg(dead, "s-dead", "busy", "per:@3.%8");
  await writeReg(idleUi.pid!, "s-multi", "idle");
  await writeReg(waiting.pid!, "s-multi", "waiting", "per:@1.%2");
  await writeReg(odd.pid!, "s-odd", "future-status");
  await writeReg(999_999_0, "s-ghost", "busy"); // a live-looking file for a session with no transcript
  await fs.writeFile(path.join(sessDir, `${busy.pid}.abcdef.key`), "secret");
  await fs.writeFile(path.join(sessDir, "123.json"), "{broken");
  // Entries the index skips: a subagent tree and a memory symlink.
  await fs.mkdir(path.join(projDir, "s-busy", "subagents"), { recursive: true });
  await fs.writeFile(path.join(projDir, "s-busy", "subagents", "agent-a.jsonl"), jl([{ type: "user" }]));
  await fs.symlink(root, path.join(projDir, "memory"));

  const events: IndexEvent[] = [];
  const latest = new Map<string, SessionSummary | null>();
  const upserts = new Map<string, number>();
  const own = new Set<number>([idleUi.pid!]);
  const source: ClaudeSource = createClaudeSource(
    [
      { id: ACC, dir: accDir },
      { id: "claude-missing", dir: path.join(root, "no-such-dir") },
    ],
    { ownPids: () => own, sweepMs: 100, debounceMs: 30 },
  );
  try {
    await source.start((e) => {
      events.push(e);
      if (e.type === "upsert") {
        latest.set(e.session.key, e.session);
        upserts.set(e.session.key, (upserts.get(e.session.key) ?? 0) + 1);
      } else {
        latest.set(e.key, null);
      }
    });

    // ---- snapshot ----
    assert.equal(events.length, 5, "one upsert per transcript");
    const sBusy = latest.get(key("s-busy"))!;
    assert.equal(sBusy.status, "running");
    assert.equal(sBusy.owner, "terminal");
    assert.equal(sBusy.pid, busy.pid);
    assert.equal(sBusy.tmuxPane, "%7");
    assert.equal(sBusy.title, "busy one");
    assert.equal(sBusy.preview, "prompt s-busy");
    assert.equal(sBusy.cwd, "/work/proj");
    assert.equal(sBusy.entrypoint, "cli");
    assert.equal(sBusy.parentKey, null);

    const sDead = latest.get(key("s-dead"))!;
    assert.deepEqual([sDead.status, sDead.owner, sDead.pid, sDead.tmuxPane], ["closed", "none", null, null]);
    assert.equal(latest.get(key("s-none"))!.status, "closed");

    const sMulti = latest.get(key("s-multi"))!;
    assert.equal(sMulti.status, "waiting-input", "the most active holder decides the status");
    assert.equal(sMulti.owner, "ui", "a holder this server started makes it ui");
    assert.equal(sMulti.pid, idleUi.pid);

    assert.equal(latest.get(key("s-odd"))!.status, "open-idle");

    const st = source.stats();
    assert.deepEqual(st.accounts.missing, ["claude-missing"]);
    assert.equal(st.indexed, 5);
    assert.equal(st.projects.transcripts, 5);
    assert.equal(st.projects.skippedSubtreeDirs, 1);
    assert.equal(st.projects.skippedSymlinks, 1);
    assert.equal(st.registrations.keyFilesIgnored, 1);
    assert.equal(st.registrations.unreadable, 1);
    assert.equal(st.registrations.unknownStatus, 1);
    assert.deepEqual(st.registrations.unknownStatusValues, ["future-status"]);
    assert.equal(st.registrations.dead, 2, "the exited pid and the made-up one");
    assert.equal(st.registrations.live, 4);
    assert.equal(st.registrations.files, 7, "six parsed registrations and the broken one");
    assert.equal(st.registrations.liveWithoutTranscript, 0);

    // ---- transcript add, modify, delete ----
    const newFile = path.join(projDir, "s-new.jsonl");
    await fs.writeFile(newFile, transcript("/work/new", "new prompt", "new title"));
    await waitFor("upsert of s-new", () => latest.get(key("s-new")));
    assert.equal(latest.get(key("s-new"))!.preview, "new prompt");

    await fs.appendFile(newFile, jl([{ type: "custom-title", customTitle: "renamed" }]));
    await waitFor("rename of s-new", () => latest.get(key("s-new"))?.name === "renamed");

    await fs.rm(newFile);
    await waitFor("remove of s-new", () => latest.get(key("s-new")) === null);
    assert.ok(events.some((e) => e.type === "remove" && e.key === key("s-new")));

    // A new project dir with a transcript in it.
    const otherDir = path.join(accDir, "projects", "-work-other");
    await fs.mkdir(otherDir);
    await fs.writeFile(path.join(otherDir, "s-other.jsonl"), transcript("/work/other", "other", "other"));
    await waitFor("upsert of s-other", () => latest.get(key("s-other")));

    // ---- registration add and delete ----
    const opener = sleeper();
    await writeReg(opener.pid!, "s-none", "busy", "w:@9.%11");
    await waitFor("s-none running", () => latest.get(key("s-none"))?.status === "running");
    assert.equal(latest.get(key("s-none"))!.tmuxPane, "%11");
    await writeReg(opener.pid!, "s-none", "idle", "w:@9.%11");
    await waitFor("s-none open-idle", () => latest.get(key("s-none"))?.status === "open-idle");
    await fs.rm(path.join(sessDir, `${opener.pid}.json`));
    await waitFor("s-none closed", () => latest.get(key("s-none"))?.status === "closed");

    // ---- the sweep: a process dies and leaves its registration behind ----
    busy.kill("SIGKILL");
    await once(busy, "exit");
    await waitFor("s-busy closed by the sweep", () => latest.get(key("s-busy"))?.status === "closed");
    assert.equal(latest.get(key("s-busy"))!.owner, "none");

    // ---- quiet period: no re-emit for unchanged sessions, subagent writes are ignored ----
    const before = events.length;
    const ignoredBefore = source.stats().watch.ignoredEvents;
    await fs.appendFile(path.join(projDir, "s-busy", "subagents", "agent-a.jsonl"), jl([{ type: "assistant" }]));
    await delay(800); // eight sweeps
    assert.equal(events.length, before, "nothing changed, so nothing is emitted");
    assert.ok(source.stats().watch.ignoredEvents > ignoredBefore, "the subagent write arrived and was ignored");
    assert.equal(upserts.get(key("s-dead")), 1, "an untouched session is sent once");
    assert.ok(source.stats().sweeps >= 5);
  } finally {
    await source.stop();
  }
});
