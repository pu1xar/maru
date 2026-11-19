// Live check of the Claude driver and the session host (run in this process) against the
// installed CLI. Re-run it after a CLI or SDK upgrade (DESIGN.md 11). It spends a few small model
// turns and writes one new session.
// Run from the project root:
//   node apps/server/src/claude/driver-check.ts --cwd <trusted dir> [--account ~/.claude] [--model haiku]
// Steps:
//   1. new session: a prompt that makes the model call AskUserQuestion, answered here
//   2. "Reply OK" in the same process
//   3. while it is open, a resume of the same session from another driver must be refused
//      (that driver's query is a stub, so a regression cannot fork the session)
//   4. close, then resume the session for one more "Reply OK" turn
// Then reads the transcript and reports the entrypoint of every line that has one.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createSessionHost } from "../host/core.ts";
import { DECISION_KEY, SessionOpenError, createClaudeDriver } from "./driver.ts";
import { localHostLink } from "./hostLink.ts";
import type { ClaudeDriverDeps, DriverEvents, PendingQuestion, RunHandle } from "./driver.ts";
import { isRegistrationLive, parseRegistration } from "./registry.ts";
import type { Registration } from "./registry.ts";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? fallback : process.argv[i + 1];
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}

const expandHome = (p: string) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
const accountDir = path.resolve(expandHome(arg("account", "~/.claude")));
const cwd = path.resolve(arg("cwd"));
const model = arg("model", "haiku");
const sessionsDir = path.join(accountDir, "sessions");

function registrations(): Registration[] {
  const out: Registration[] = [];
  for (const name of fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    try {
      const reg = parseRegistration(fs.readFileSync(path.join(sessionsDir, name), "utf8"), Number(m[1]));
      if (reg) out.push(reg);
    } catch {
      // removed between readdir and read
    }
  }
  return out;
}

const isSessionOpen = (id: string) => registrations().some((r) => r.sessionId === id && isRegistrationLive(r));

function ps(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "(gone)";
  }
}

interface Probe extends DriverEvents {
  counts: Record<string, number>;
  sessionIds: Set<string>;
  questions: PendingQuestion[];
  results: string[];
  exit: Promise<{ code: string; error?: string }>;
  nextResult(): Promise<string>;
  run: RunHandle | null;
}

/** Records messages and answers every question: the first option of each, or a reject. */
function probe(): Probe {
  let resolveExit!: (v: { code: string; error?: string }) => void;
  const waiters: ((s: string) => void)[] = [];
  const p: Probe = {
    counts: {},
    sessionIds: new Set(),
    questions: [],
    results: [],
    run: null,
    exit: new Promise((r) => (resolveExit = r)),
    onMessage(m: SDKMessage) {
      const k = m.type === "system" ? `system/${(m as { subtype?: string }).subtype}` : m.type;
      p.counts[k] = (p.counts[k] ?? 0) + 1;
      const sid = (m as { session_id?: unknown }).session_id;
      if (typeof sid === "string") p.sessionIds.add(sid);
      if (m.type === "result") {
        const r = m as { subtype: string; result?: string };
        const text = `${r.subtype}: ${r.result ?? ""}`;
        p.results.push(text);
        waiters.shift()?.(text);
      }
    },
    onQuestion(q: PendingQuestion) {
      p.questions.push(q);
      // Answered on a later tick: answer() settles the promise the SDK callback is building.
      queueMicrotask(() => {
        const answers: Record<string, string> = {};
        if (q.kind === "question") {
          const qs = (q.input.questions ?? []) as { question: string; options?: { label: string }[] }[];
          for (const item of qs) answers[item.question] = item.options?.[0]?.label ?? "yes";
        } else {
          answers[DECISION_KEY] = "reject";
        }
        console.log(`  question ${q.requestId} (${q.toolName}, ${q.kind}) -> ${JSON.stringify(answers)}`);
        p.run!.answer(q.requestId, answers);
      });
    },
    onExit(info) {
      resolveExit(info);
    },
    nextResult() {
      return new Promise((r) => waiters.push(r));
    },
  };
  return p;
}

function transcriptOf(sid: string): string | null {
  const projects = path.join(accountDir, "projects");
  for (const enc of fs.readdirSync(projects)) {
    const f = path.join(projects, enc, `${sid}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// The SDK runs in a session host inside this process, reached over the same frames as its socket.
const driver = createClaudeDriver({ isSessionOpen, link: localHostLink(createSessionHost({ log: (l) => console.log(`  host: ${l}`) })) });
await driver.ready();
const report: Record<string, unknown> = { accountDir, cwd, model };

// 1. new session with a question
const p1 = probe();
const t0 = Date.now();
const firstResult = p1.nextResult();
const run1 = await driver.start(
  {
    accountDir,
    cwd,
    model,
    prompt:
      "Call the AskUserQuestion tool exactly once with one question 'Pick a color' and the options Red and Blue. " +
      "After the answer, reply with only the chosen color.",
  },
  p1,
);
p1.run = run1;
let pidFoundMs: number | null = null;
let run1Ended = false;
void p1.exit.then(() => (run1Ended = true));
void (async () => {
  while (pidFoundMs === null && !run1Ended) {
    await new Promise((r) => setTimeout(r, 50));
    if (run1.pid() !== null) pidFoundMs = Date.now() - t0;
  }
})();
console.log(`  turn 1: ${await firstResult}`);
const sid = run1.sessionId()!;
console.log(`session ${sid}`);

const pid = run1.pid();
const reg = pid === null ? null : registrations().find((r) => r.pid === pid) ?? null;
report.session = sid;
report.pid = {
  handlePid: pid,
  foundAfterMs: pidFoundMs,
  ownPids: [...driver.ownPids()],
  registration: reg && { pid: reg.pid, sessionId: reg.sessionId, entrypoint: reg.entrypoint, status: reg.status },
  ps: pid === null ? null : ps(pid),
  serverPid: process.pid,
};

// 2. a second turn in the same process
const secondResult = p1.nextResult();
await run1.send("Reply OK");
console.log(`  turn 2: ${await secondResult}`);

// 3. resume while open, from a driver that only knows the registrations
let stubCalled = false;
const stub = (() => {
  stubCalled = true;
  throw new Error("the refused resume reached query()");
}) as unknown as NonNullable<ClaudeDriverDeps["query"]>;
const other = createClaudeDriver({ isSessionOpen, link: localHostLink(createSessionHost({ query: stub })) });
await other.ready();
try {
  await other.start({ accountDir, cwd, model, resume: sid, prompt: "Reply OK" }, probe());
  report.refusedWhileOpen = false;
} catch (err) {
  report.refusedWhileOpen = err instanceof SessionOpenError && !stubCalled;
}

await run1.close();
report.run1 = {
  exit: await p1.exit,
  counts: p1.counts,
  sessionIds: [...p1.sessionIds],
  results: p1.results,
  questions: p1.questions.map((q) => `${q.toolName}/${q.kind}`),
  pidAliveAfterClose: pid === null ? null : ps(pid),
};
report.ownPidsAfterClose = [...driver.ownPids()];

// 4. resume the closed session
const p2 = probe();
const resumeResult = p2.nextResult();
const run2 = await driver.start({ accountDir, cwd, model, resume: sid, prompt: "Reply OK" }, p2);
p2.run = run2;
console.log(`  resumed: ${await resumeResult}`);
report.resume = { sessionId: run2.sessionId(), sameSession: run2.sessionId() === sid, pid: run2.pid() };
await run2.close();
report.run2 = { exit: await p2.exit, counts: p2.counts, sessionIds: [...p2.sessionIds], results: p2.results };

// transcript
const file = transcriptOf(sid);
const entrypoints: Record<string, number> = {};
let lines = 0;
if (file) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    lines++;
    const o = JSON.parse(line) as { entrypoint?: unknown };
    const k = typeof o.entrypoint === "string" ? o.entrypoint : "(none)";
    entrypoints[k] = (entrypoints[k] ?? 0) + 1;
  }
}
report.transcript = { file, lines, entrypoints };
console.log(JSON.stringify(report, null, 2));
