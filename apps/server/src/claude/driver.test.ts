import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { duplexPair, type Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { CanUseTool, Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createSessionHost, type SessionHost } from "../host/core.ts";
import { serveStream } from "../host/socket.ts";
import {
  DECISION_KEY, ENTRYPOINT, FEEDBACK_KEY, HostDrainingError, SessionOpenError, buildEnv, createClaudeDriver,
} from "./driver.ts";
import type { AdoptedRun, ClaudeDriverDeps, DriverEvents, PendingQuestion, RunHandle, RunState } from "./driver.ts";
import { HostDownError, createHostLink, localHostLink, type HostLink } from "./hostLink.ts";
import { isPidAlive } from "./registry.ts";

// Every driver here reaches its SDK query() through a session host in this process (host/core.ts),
// over the same frames as the unix socket. The CLI pid is then a child of this process.

let root: string;
let accountDir: string;
let workDir: string;
let binFile: string;
let binLink: string;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-driver-"));
  accountDir = path.join(root, "account");
  workDir = path.join(root, "work");
  await fs.mkdir(path.join(accountDir, "sessions"), { recursive: true });
  await fs.mkdir(workDir);
  binFile = path.join(root, "claude-2.1.325");
  binLink = path.join(root, "claude");
  await fs.writeFile(binFile, "");
  await fs.symlink(binFile, binLink);
});

const links: HostLink[] = [];

after(async () => {
  for (const l of links) l.close();
  await fs.rm(root, { recursive: true, force: true });
});

// ---- fake SDK ----

interface FakeCall {
  options: Options;
  prompts: string[];
  /** The client uuid of each user message, in the order they came. */
  uuids: Array<string | undefined>;
  /** The priority field of each user message, in the order they came (undefined: none). */
  priorities: Array<string | undefined>;
  interrupts: number;
  closed: boolean;
  /** Task ids stopTask() received. */
  stopped: string[];
}

/** Messages the fake yields for one user message. */
type TurnScript = (text: string, call: FakeCall, sid: string) => AsyncGenerator<SDKMessage>;

const msg = (o: Record<string, unknown>) => o as unknown as SDKMessage;

async function* replyTurn(text: string, _call: FakeCall, sid: string): AsyncGenerator<SDKMessage> {
  yield msg({ type: "assistant", session_id: sid, message: { content: [{ type: "text", text: `re: ${text}` }] } });
  yield msg({ type: "result", subtype: "success", session_id: sid, result: `re: ${text}` });
}

async function* hangTurn(): AsyncGenerator<SDKMessage> {
  await new Promise(() => {});
}

function textOf(m: SDKUserMessage): string {
  const c = m.message.content;
  return typeof c === "string" ? c : JSON.stringify(c);
}

/**
 * A stand-in for SDK query(): yields system/init, then runs `turn` for every user message the
 * prompt stream delivers, until the stream ends or close() is called.
 */
function fakeSdk(opts: {
  turn?: TurnScript;
  beforeInit?: (call: FakeCall) => Promise<void>;
  /** Runs when close() is called, as the SDK's delayed SIGTERM would. */
  onClose?: () => void;
} = {}) {
  const turn = opts.turn ?? replyTurn;
  const calls: FakeCall[] = [];
  const query = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const call: FakeCall = { options: params.options, prompts: [], uuids: [], priorities: [], interrupts: 0, closed: false, stopped: [] };
    calls.push(call);
    let markClosed!: () => void;
    const closed = new Promise<null>((resolve) => {
      markClosed = () => resolve(null);
    });
    const sid = params.options.resume ?? "sid-new";
    async function* run(): AsyncGenerator<SDKMessage, void> {
      if (opts.beforeInit) await opts.beforeInit(call);
      const it = params.prompt[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([it.next(), closed]);
        if (next === null || next.done) return;
        const text = textOf(next.value);
        call.prompts.push(text);
        call.uuids.push(next.value.uuid);
        call.priorities.push(next.value.priority);
        yield msg({ type: "system", subtype: "init", session_id: sid });
        const turnIt = turn(text, call, sid)[Symbol.asyncIterator]();
        while (true) {
          const step = await Promise.race([turnIt.next(), closed]);
          if (step === null) return;
          if (step.done) break;
          yield step.value;
        }
      }
    }
    return Object.assign(run(), {
      interrupt: async () => {
        call.interrupts++;
        return undefined;
      },
      supportedCommands: async () => [{ name: "compact", description: "Clear history", argumentHint: "<instructions>", builtin: true }],
      initializationResult: async () => ({
        commands: [{ name: "compact", description: "Clear history", argumentHint: "<instructions>", builtin: true }],
        models: [{ value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5" }],
        available_output_styles: ["default", "Concise"],
      }),
      stopTask: async (taskId: string) => {
        call.stopped.push(taskId);
      },
      close: () => {
        call.closed = true;
        markClosed();
        opts.onClose?.();
      },
    }) as unknown as Query;
  }) as unknown as NonNullable<ClaudeDriverDeps["query"]>;
  return { query, calls };
}

interface Recorder extends DriverEvents {
  messages: SDKMessage[];
  questions: PendingQuestion[];
  withdrawn: string[];
  exits: { code: string; error?: string }[];
  states: RunState[];
  /** Resolves once a message matching `pred` has arrived (also one that already did). */
  until(pred: (m: SDKMessage, all: SDKMessage[]) => boolean): Promise<void>;
  results(n: number): Promise<void>;
  exited: Promise<void>;
}

function recorder(): Recorder {
  const waiters: { pred: (m: SDKMessage, all: SDKMessage[]) => boolean; resolve: () => void }[] = [];
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const r: Recorder = {
    messages: [],
    questions: [],
    withdrawn: [],
    exits: [],
    states: [],
    onState(s) {
      r.states.push(s);
    },
    onMessage(m) {
      r.messages.push(m);
      for (const w of [...waiters]) {
        if (w.pred(m, r.messages)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve();
        }
      }
    },
    onQuestion(q) {
      r.questions.push(q);
    },
    onQuestionWithdrawn(id) {
      r.withdrawn.push(id);
    },
    onExit(info) {
      r.exits.push(info);
      markExited();
    },
    until(pred) {
      if (r.messages.some((m, i) => pred(m, r.messages.slice(0, i + 1)))) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ pred, resolve }));
    },
    results(n) {
      return r.until((_m, all) => all.filter((x) => x.type === "result").length >= n);
    },
    exited,
  };
  return r;
}

const closedEverywhere = () => false;

function ctx(extra: Record<string, unknown> = {}, signal = new AbortController().signal) {
  return { signal, toolUseID: "tu-1", requestId: "req-1", ...extra } as unknown as Parameters<CanUseTool>[2];
}

/** Whether a promise has settled, checked after pending callbacks ran. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  await sleep(10);
  return done;
}

function newHost(sdk: ReturnType<typeof fakeSdk>): SessionHost {
  return createSessionHost({ query: sdk.query, childPids: async () => [] });
}

/** A driver connected to `host` (a new one by default), as the web server is. */
async function connect(host: SessionHost, sdk: ReturnType<typeof fakeSdk>, isSessionOpen: (id: string) => boolean = closedEverywhere) {
  const link = localHostLink(host);
  links.push(link);
  const driver = createClaudeDriver({ link, query: sdk.query, isSessionOpen, executable: binLink });
  await driver.ready();
  return { driver, link };
}

async function newDriver(sdk: ReturnType<typeof fakeSdk>, isSessionOpen: (id: string) => boolean = closedEverywhere) {
  return (await connect(newHost(sdk), sdk, isSessionOpen)).driver;
}

/** Waits until `cond` holds, checking every 5 ms (the host answers through streams). */
async function until(cond: () => boolean): Promise<void> {
  while (!cond()) await sleep(5);
}

// ---- tests ----

test("start passes only the account env and the fixed options", async () => {
  process.env.MARU_TEST_LEAK = "must-not-pass";
  try {
    const sdk = fakeSdk();
    const ev = recorder();
    const run = await (await newDriver(sdk)).start({ accountDir, cwd: workDir, model: "haiku", prompt: "hi" }, ev);
    await until(() => sdk.calls.length === 1);
    const o = sdk.calls[0]!.options;
    const required = ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CONFIG_DIR", "HOME", "LANG", "LOGNAME", "PATH", "SHELL", "USER"];
    const optional = ["SSH_AUTH_SOCK", "TMPDIR"];
    const keys = Object.keys(o.env!);
    for (const k of required) assert.ok(keys.includes(k), `env has ${k}`);
    for (const k of keys) assert.ok(required.includes(k) || optional.includes(k), `env leaks ${k}`);
    assert.equal(o.env!.CLAUDE_CONFIG_DIR, accountDir);
    assert.equal(o.env!.CLAUDE_CODE_ENTRYPOINT, ENTRYPOINT);
    assert.equal(ENTRYPOINT, "maru");
    assert.ok(o.env!.USER && o.env!.LOGNAME && o.env!.HOME && o.env!.PATH);
    assert.equal(o.permissionMode, "bypassPermissions");
    assert.equal(o.allowDangerouslySkipPermissions, true);
    assert.equal(o.includePartialMessages, true);
    assert.equal(o.perTaskStopAffordance, true, "an interrupt spares background tasks");
    assert.equal("settingSources" in o, false);
    assert.equal("resume" in o, false);
    assert.equal(o.pathToClaudeCodeExecutable, realpathSync(binFile));
    assert.equal(o.cwd, workDir);
    assert.equal(o.model, "haiku");
    assert.equal(typeof o.canUseTool, "function");
    await ev.results(1);
    assert.equal(run.sessionId(), "sid-new", "the id the CLI reported");
    assert.deepEqual((await run.commands()).map((c) => c.name), ["compact"], "the run's own command list");
    await run.close();
    assert.deepEqual(ev.exits, [{ code: "done" }]);
  } finally {
    delete process.env.MARU_TEST_LEAK;
  }
});

test("a rewind's start (DESIGN.md 6o): no message, resume up to a line, file checkpoints; the next server learns the checkpoints from the meta", async () => {
  const sdk = fakeSdk();
  const host = newHost(sdk);
  const first = await connect(host, sdk);
  const ev = recorder();
  const run = await first.driver.start({ accountDir, cwd: workDir, resume: "s-rw", resumeSessionAt: "line-7", fileCheckpointing: true }, ev);
  await until(() => sdk.calls.length === 1);
  const o = sdk.calls[0]!.options;
  assert.equal(o.resume, "s-rw");
  assert.equal(o.resumeSessionAt, "line-7");
  assert.equal(o.enableFileCheckpointing, true);
  assert.equal(run.state().busy, false, "a start without a message runs no turn");
  assert.equal(run.fileCheckpointing(), true);
  await sleep(20);
  assert.deepEqual(sdk.calls[0]!.prompts, [], "no message reached the CLI");
  // A restart of this server: the run is adopted and still keeps checkpoints.
  first.link.close();
  const adopted: RunHandle[] = [];
  const second = await connect(host, sdk);
  second.driver.onAdopt((handle) => {
    adopted.push(handle);
    return recorder();
  });
  await until(() => adopted.length === 1);
  assert.equal(adopted[0]!.fileCheckpointing(), true);
  await adopted[0]!.close();
  // Without the options none of them is passed.
  const plain = await (await newDriver(sdk)).start({ accountDir, cwd: workDir, resumeSessionAt: "ignored-without-resume", prompt: "hi" }, recorder());
  await until(() => sdk.calls.length === 2);
  assert.equal("resumeSessionAt" in sdk.calls[1]!.options, false);
  assert.equal("enableFileCheckpointing" in sdk.calls[1]!.options, false);
  assert.equal(plain.fileCheckpointing(), false);
  await plain.close();
});

test("a Workflow result maps its run id to the task id, and stopTask reaches the CLI", async () => {
  const sdk = fakeSdk({
    async *turn(_text, _call, sid) {
      for (const taskId of ["w-first", "w-resumed"]) {
        yield msg({
          type: "user", session_id: sid, parent_tool_use_id: null,
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu-${taskId}`, content: "launched" }] },
          tool_use_result: { status: "async_launched", taskId, taskType: "local_workflow", runId: "wf_abc-123", scriptPath: "/s.js" },
        });
      }
      yield msg({
        type: "user", session_id: sid, parent_tool_use_id: null,
        message: { role: "user", content: [] },
        tool_use_result: { status: "async_launched", agentId: "a1", taskId: "not-a-workflow", runId: "wf_other-1" },
      });
      yield msg({ type: "result", subtype: "success", session_id: sid, result: "ok" });
    },
  });
  const ev = recorder();
  const run = await (await newDriver(sdk)).start({ accountDir, cwd: workDir, prompt: "go" }, ev);
  await ev.results(1);
  assert.equal(run.workflowTaskId("wf_abc-123"), "w-resumed", "the newest launch of the run");
  assert.equal(run.workflowTaskId("wf_other-1"), null, "only local_workflow results count");
  await run.stopTask("a1");
  assert.deepEqual(sdk.calls[0]!.stopped, ["a1"]);
  await run.close();
  await assert.rejects(run.stopTask("a1"), /ended/);
});

test("every user message carries a client uuid; the host's busy and tasks reach onState and state()", async () => {
  const sdk = fakeSdk({
    async *turn(text, _call, sid) {
      if (text === "launch") {
        yield msg({ type: "system", subtype: "task_started", session_id: sid, task_id: "a1", task_type: "local_agent", description: "bg", is_backgrounded: true });
      }
      yield msg({ type: "result", subtype: "success", session_id: sid, result: "ok" });
    },
  });
  const ev = recorder();
  const run = await (await newDriver(sdk)).start({ accountDir, cwd: workDir, prompt: "launch" }, ev);
  await ev.results(1);
  await until(() => !run.state().busy);
  assert.deepEqual(run.state().tasks.map((t) => [t.taskId, t.background]), [["a1", true]], "the task outlives the turn");
  assert.deepEqual(ev.states.at(-1), { busy: false, tasks: run.state().tasks });
  assert.ok(ev.states.some((s) => s.tasks.length === 1 && s.busy), "the task started while the turn ran");

  const before = ev.states.length;
  const sending = run.send("again");
  assert.equal(run.state().busy, true, "busy from the send on");
  assert.equal(ev.states[before]?.busy, true, "and the run's events hear it at once");
  await sending;
  await ev.results(2);
  await until(() => !run.state().busy);
  assert.equal(ev.states.at(-1)?.busy, false);
  const uuids = sdk.calls[0]!.uuids;
  assert.equal(uuids.length, 2);
  for (const u of uuids) assert.match(u ?? "", /^[0-9a-f-]{36}$/);
  assert.notEqual(uuids[0], uuids[1]);
  await run.close();
});

test("probe reads commands, models and output styles from a CLI that is sent nothing, with hooks and the transcript off, then closes it", async () => {
  const sdk = fakeSdk();
  const driver = await newDriver(sdk);
  const info = await driver.probe({ accountDir, cwd: workDir });
  assert.deepEqual(info.commands.map((c) => c.name), ["compact"]);
  assert.deepEqual(info.models.map((m) => m.value), ["default"]);
  assert.deepEqual(info.outputStyles, ["default", "Concise"]);
  const call = sdk.calls[0]!;
  assert.equal(call.options.persistSession, false);
  assert.deepEqual(call.options.settings, { disableAllHooks: true });
  assert.equal(call.options.cwd, workDir);
  assert.equal(call.options.env!.CLAUDE_CONFIG_DIR, accountDir);
  assert.equal(call.options.pathToClaudeCodeExecutable, realpathSync(binFile));
  assert.equal("canUseTool" in call.options, false);
  assert.deepEqual(call.prompts, [], "no message reached the CLI");
  assert.equal(call.closed, true);
  assert.equal(driver.ownPids().size, 0);
  await assert.rejects(driver.probe({ accountDir, cwd: path.join(root, "missing") }));
});

test("buildEnv fills the login variables when the server env lacks them", () => {
  const env = buildEnv("/acct", { PATH: "/x" });
  const user = os.userInfo().username;
  assert.deepEqual(env, {
    HOME: os.homedir(),
    USER: user,
    LOGNAME: user,
    PATH: "/x",
    LANG: "C.UTF-8",
    SHELL: os.userInfo().shell || "/bin/zsh",
    CLAUDE_CONFIG_DIR: "/acct",
    CLAUDE_CODE_ENTRYPOINT: "maru",
  });
  const passed = buildEnv("/a", { PATH: "/x", SHELL: "/bin/bash", TMPDIR: "/t/", SSH_AUTH_SOCK: "/s.sock" });
  assert.deepEqual([passed.SHELL, passed.TMPDIR, passed.SSH_AUTH_SOCK], ["/bin/bash", "/t/", "/s.sock"]);
  assert.equal(buildEnv("/a", { USER: "u1", LANG: "ko_KR.UTF-8" }).LOGNAME, "u1");
  assert.equal(buildEnv("/a", { USER: "u1", LANG: "ko_KR.UTF-8" }).LANG, "ko_KR.UTF-8");
});

test("canUseTool: an ordinary tool is allowed at once and raises no question", async () => {
  const sdk = fakeSdk();
  const ev = recorder();
  const run = await (await newDriver(sdk)).start({ accountDir, cwd: workDir, prompt: "hi" }, ev);
  const canUseTool = sdk.calls[0]!.options.canUseTool!;
  const input = { command: "rm -rf build" };
  assert.deepEqual(await canUseTool("Bash", input, ctx()), { behavior: "allow", updatedInput: input });
  // requiresUserInteraction false is still an ordinary ask
  assert.deepEqual(await canUseTool("Write", input, ctx({ requiresUserInteraction: false })), {
    behavior: "allow",
    updatedInput: input,
  });
  assert.equal(ev.questions.length, 0);
  await run.close();
});

test("AskUserQuestion waits as a question until answer() supplies the answers", async () => {
  const sdk = fakeSdk();
  const ev = recorder();
  const run = await (await newDriver(sdk)).start({ accountDir, cwd: workDir, prompt: "hi" }, ev);
  const input = { questions: [{ question: "Which color?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }] }] };
  const decided = sdk.calls[0]!.options.canUseTool!("AskUserQuestion", input, ctx({ requiresUserInteraction: true }));
  assert.equal(await settled(decided), false, "waits for the user");
  assert.equal(ev.questions.length, 1);
  const q = ev.questions[0]!;
  assert.equal(q.requestId, "req-1");
  assert.equal(q.toolUseId, "tu-1");
  assert.equal(q.kind, "question");
  assert.deepEqual(q.input, input);
  run.answer("req-1", { "Which color?": "Blue" });
  assert.deepEqual(await decided, {
    behavior: "allow",
    updatedInput: { ...input, answers: { "Which color?": "Blue" } },
  });
  assert.throws(() => run.answer("req-1", { "Which color?": "Red" }), /no pending question/);
  assert.deepEqual(ev.withdrawn, [], "an answered question is not withdrawn");
  await run.close();
});

test("ExitPlanMode and asks that need a person map the decision to allow or deny", async () => {
  const sdk = fakeSdk();
  const ev = recorder();
  const run = await (await newDriver(sdk)).start({ accountDir, cwd: workDir, prompt: "hi" }, ev);
  const canUseTool = sdk.calls[0]!.options.canUseTool!;

  const plan = { plan: "1. do it" };
  const approved = canUseTool("ExitPlanMode", plan, ctx({ requestId: "p1" }));
  await settled(approved);
  assert.equal(ev.questions.at(-1)!.kind, "plan");
  // A malformed decision is refused and the question stays open.
  assert.throws(() => run.answer("p1", { [DECISION_KEY]: "yes" }), /approve" or "reject/);
  run.answer("p1", { [DECISION_KEY]: "approve" });
  assert.deepEqual(await approved, { behavior: "allow", updatedInput: plan });

  const rejected = canUseTool("ExitPlanMode", plan, ctx({ requestId: "p2" }));
  await settled(rejected);
  run.answer("p2", { [DECISION_KEY]: "reject", [FEEDBACK_KEY]: "add tests" });
  const r = (await rejected) as Extract<PermissionResult, { behavior: "deny" }>;
  assert.equal(r.behavior, "deny");
  assert.match(r.message, /did not approve the plan.*add tests/);

  const toolInput = { url: "https://example.com" };
  const asked = canUseTool("mcp__srv__open", toolInput, ctx({ requestId: "m1", requiresUserInteraction: true, title: "Open a page" }));
  await settled(asked);
  const q = ev.questions.at(-1)!;
  assert.equal(q.kind, "approval");
  assert.equal(q.title, "Open a page");
  run.answer("m1", { [DECISION_KEY]: "reject" });
  assert.equal(((await asked) as { behavior: string }).behavior, "deny");
  await run.close();
});

test("a withdrawn request is denied, reported, and leaves nothing to answer", async () => {
  const sdk = fakeSdk();
  const ev = recorder();
  const run = await (await newDriver(sdk)).start({ accountDir, cwd: workDir, prompt: "hi" }, ev);
  const ac = new AbortController();
  const decided = sdk.calls[0]!.options.canUseTool!("AskUserQuestion", { questions: [] }, ctx({}, ac.signal));
  await settled(decided);
  assert.equal(ev.questions.length, 1);
  ac.abort();
  // The SDK has given up on the request; the host rejects it and the UI drops the question.
  await assert.rejects(decided);
  await until(() => ev.withdrawn.length > 0);
  assert.deepEqual(ev.withdrawn, ["req-1"]);
  assert.throws(() => run.answer("req-1", {}), /no pending question/);
  await run.close();
});

test("close() withdraws a waiting question, and asks during close never reach the UI", async () => {
  const sdk = fakeSdk({ turn: hangTurn });
  const ev = recorder();
  const run = await (await newDriver(sdk)).start({ accountDir, cwd: workDir, prompt: "hi" }, ev);
  const canUseTool = sdk.calls[0]!.options.canUseTool!;
  const decided = canUseTool("AskUserQuestion", { questions: [] }, ctx());
  await settled(decided);
  const closing = run.close();
  // Interrupting while the run closes is a no-op, not an error.
  await run.interrupt();
  // A late ask is refused: by the host when it already closes the run, else by the driver.
  const late = await canUseTool("AskUserQuestion", { questions: [] }, ctx({ requestId: "req-2" })).then(
    (r) => r?.behavior ?? "none",
    () => "rejected",
  );
  await closing;
  await assert.rejects(decided, /run ended/);
  assert.ok(late === "deny" || late === "rejected", late);
  assert.equal(ev.questions.length, 1, "the late ask was not shown");
  assert.deepEqual(ev.withdrawn, ["req-1"]);
});

test("resume is refused while the session is open, here or in another process", async () => {
  const sdk = fakeSdk();
  const open = new Set(["s-terminal"]);
  const driver = await newDriver(sdk, (id) => open.has(id));

  await assert.rejects(
    driver.start({ accountDir, cwd: workDir, resume: "s-terminal", prompt: "hi" }, recorder()),
    (err: unknown) => err instanceof SessionOpenError && err.sessionId === "s-terminal",
  );
  assert.equal(sdk.calls.length, 0, "nothing was spawned");

  // The first resume holds s1 from start(), before the index could see its process.
  const run = await driver.start({ accountDir, cwd: workDir, resume: "s1", prompt: "hi" }, recorder());
  assert.equal(run.sessionId(), "s1");
  await assert.rejects(driver.start({ accountDir, cwd: workDir, resume: "s1", prompt: "again" }, recorder()), SessionOpenError);
  assert.equal(sdk.calls.length, 1);
  assert.equal(sdk.calls[0]!.options.resume, "s1");
  await run.close();

  // Released when the run ends.
  const next = await driver.start({ accountDir, cwd: workDir, resume: "s1", prompt: "hi" }, recorder());
  await next.close();
});

test("a session id the CLI moves to is held, and the old one is released", async () => {
  async function* clearTurn(text: string, call: FakeCall, sid: string): AsyncGenerator<SDKMessage> {
    if (text !== "/clear") return yield* replyTurn(text, call, sid);
    yield msg({ type: "conversation_reset", session_id: "sid-moved", new_conversation_id: "c2" });
    yield msg({ type: "result", subtype: "success", session_id: "sid-moved", result: "" });
  }
  const sdk = fakeSdk({ turn: clearTurn });
  const driver = await newDriver(sdk);
  const ev = recorder();
  const run = await driver.start({ accountDir, cwd: workDir, resume: "s-old", prompt: "hi" }, ev);
  await ev.results(1);
  await run.send("/clear");
  await ev.results(2);
  assert.equal(run.sessionId(), "sid-moved");
  await assert.rejects(driver.start({ accountDir, cwd: workDir, resume: "sid-moved", prompt: "x" }, recorder()), SessionOpenError);
  const old = await driver.start({ accountDir, cwd: workDir, resume: "s-old", prompt: "x" }, recorder());
  await old.close();
  await run.close();
});

test("send() carries the priority and the id on the message through the host, and none unless asked", async () => {
  const sdk = fakeSdk();
  const ev = recorder();
  const run = await (await newDriver(sdk)).start({ accountDir, cwd: workDir, prompt: "first" }, ev);
  await ev.results(1);
  await run.send("plain", "11111111-1111-4111-8111-111111111111");
  await ev.results(2);
  await run.send("urgent", "22222222-2222-4222-8222-222222222222", "now");
  await ev.results(3);
  assert.deepEqual(sdk.calls[0]!.priorities, [undefined, undefined, "now"], "a message sent without a priority has no priority field");
  assert.deepEqual(sdk.calls[0]!.uuids.slice(1), ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
  await run.close();
});

test("send() delivers later turns to the same process", async () => {
  const sdk = fakeSdk();
  const ev = recorder();
  const run = await (await newDriver(sdk)).start({ accountDir, cwd: workDir, prompt: "first" }, ev);
  await ev.results(1);
  await run.send("second");
  await ev.results(2);
  await run.send("third");
  await ev.results(3);
  assert.equal(sdk.calls.length, 1, "one process for every turn");
  assert.deepEqual(sdk.calls[0]!.prompts, ["first", "second", "third"]);
  const results = ev.messages.filter((m) => m.type === "result").map((m) => (m as { result: string }).result);
  assert.deepEqual(results, ["re: first", "re: second", "re: third"]);
  await run.interrupt();
  assert.equal(sdk.calls[0]!.interrupts, 1);
  await run.close();
  assert.equal(sdk.calls[0]!.closed, true);
  assert.equal(sdk.calls[0]!.interrupts, 1, "close between turns does not interrupt");
  assert.deepEqual(ev.exits, [{ code: "done" }]);
  await assert.rejects(run.send("late"), /ended/);
});

test("close() during a turn interrupts it and reports interrupted", async () => {
  const sdk = fakeSdk({ turn: hangTurn });
  const ev = recorder();
  const run = await (await newDriver(sdk)).start({ accountDir, cwd: workDir, prompt: "work" }, ev);
  await ev.until((m) => m.type === "system");
  await run.close();
  assert.equal(sdk.calls[0]!.interrupts, 1);
  assert.deepEqual(ev.exits, [{ code: "interrupted" }]);
});

test("a turn the CLI starts on its own after a result counts as running", async () => {
  // A background task reporting back opens a new turn with system/init and no send().
  async function* bgTurn(text: string, call: FakeCall, sid: string): AsyncGenerator<SDKMessage> {
    yield* replyTurn(text, call, sid);
    yield msg({ type: "system", subtype: "init", session_id: sid });
    await new Promise(() => {});
  }
  const sdk = fakeSdk({ turn: bgTurn });
  const ev = recorder();
  const run = await (await newDriver(sdk)).start({ accountDir, cwd: workDir, prompt: "go" }, ev);
  await ev.until((_m, all) => all.filter((x) => x.type === "system").length >= 2);
  await run.close();
  assert.deepEqual(ev.exits, [{ code: "interrupted" }]);
});

test("a process that fails before init reports the error and releases its resume target", async () => {
  const sdk = fakeSdk({
    beforeInit: async () => {
      throw new Error("Claude Code process exited with code 1. stderr: Not logged in");
    },
  });
  const driver = await newDriver(sdk);
  const ev = recorder();
  const run = await driver.start({ accountDir, cwd: workDir, resume: "s-bad", prompt: "hi" }, ev);
  await ev.exited;
  assert.equal(ev.exits.length, 1);
  assert.equal(ev.exits[0]!.code, "error");
  assert.match(ev.exits[0]!.error!, /Not logged in/);
  await assert.rejects(run.send("x"), /ended/);
  const again = await (await newDriver(fakeSdk())).start({ accountDir, cwd: workDir, resume: "s-bad", prompt: "hi" }, recorder());
  await again.close();
  // The driver that ran it no longer holds it either (a held target would throw here).
  const ev2 = recorder();
  await driver.start({ accountDir, cwd: workDir, resume: "s-bad", prompt: "hi" }, ev2);
  await ev2.exited;
});

test("bad input fails start() before anything is spawned or held", async () => {
  const sdk = fakeSdk();
  const missingLink = localHostLink(newHost(sdk));
  links.push(missingLink);
  const missingBin = createClaudeDriver({ link: missingLink, query: sdk.query, isSessionOpen: closedEverywhere, executable: path.join(root, "nope") });
  await missingBin.ready();
  await assert.rejects(missingBin.start({ accountDir, cwd: workDir, resume: "s-x", prompt: "hi" }, recorder()), /ENOENT/);
  const driver = await newDriver(sdk);
  await assert.rejects(driver.start({ accountDir, cwd: path.join(root, "no-dir"), resume: "s-x", prompt: "hi" }, recorder()), /ENOENT/);
  await assert.rejects(driver.start({ accountDir, cwd: binFile, resume: "s-x", prompt: "hi" }, recorder()), /not a directory/);
  await assert.rejects(driver.start({ accountDir, cwd: workDir, resume: "", prompt: "hi" }, recorder()), /resume must be/);
  assert.equal(sdk.calls.length, 0);
  // None of them kept s-x held.
  await (await driver.start({ accountDir, cwd: workDir, resume: "s-x", prompt: "hi" }, recorder())).close();
});

test("ownPids holds the CLI child until it has exited", { timeout: 15_000 }, async () => {
  // A child of this test process stands in for the CLI; its registration names the session.
  const child: ChildProcess = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const sessionsDir = path.join(accountDir, "sessions");
  const childPid = child.pid!;
  try {
    // A decoy that holds the same session but is not our child (this process's parent is the runner).
    await fs.writeFile(path.join(sessionsDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "sid-own" }));
    const sdk = fakeSdk({
      beforeInit: async () => {
        await fs.writeFile(path.join(sessionsDir, `${childPid}.json`), JSON.stringify({ pid: childPid, sessionId: "sid-own", status: "busy" }));
      },
      // The SDK's close() ends the stream at once and leaves SIGTERM to a timer.
      onClose: () => setTimeout(() => child.kill(), 300),
    });
    const driver = await newDriver(sdk);
    const ev = recorder();
    let aliveAtExit: boolean | null = null;
    const run = await driver.start({ accountDir, cwd: workDir, resume: "sid-own", prompt: "hi" }, {
      ...ev,
      onExit(info) {
        aliveAtExit = isPidAlive(childPid);
        ev.onExit(info);
      },
    });
    while (run.pid() === null) await sleep(20);
    assert.equal(run.pid(), childPid);
    assert.deepEqual(driver.ownPids(), new Set([childPid]));

    const closing = run.close();
    await sleep(100);
    // The stream has ended but the process lives: still ours, still held.
    assert.deepEqual(driver.ownPids(), new Set([childPid]));
    assert.equal(driver.holds("sid-own"), true);
    await assert.rejects(driver.start({ accountDir, cwd: workDir, resume: "sid-own", prompt: "x" }, recorder()), SessionOpenError);
    await closing;
    assert.equal(aliveAtExit, false, "onExit came after the process exited");
    assert.deepEqual(driver.ownPids(), new Set());
    assert.equal(driver.holds("sid-own"), false);
  } finally {
    child.kill();
    await fs.rm(path.join(sessionsDir, `${childPid}.json`), { force: true });
    await fs.rm(path.join(sessionsDir, `${process.pid}.json`), { force: true });
  }
});

// ---- the session host across restarts ----

const QUESTION = { questions: [{ question: "Which color?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }] }] };

/** A turn that asks with AskUserQuestion and replies with the answer it got. */
async function* askTurn(_text: string, call: FakeCall, sid: string): AsyncGenerator<SDKMessage> {
  const r = await call.options.canUseTool!("AskUserQuestion", QUESTION, ctx({ requiresUserInteraction: true }));
  yield msg({ type: "result", subtype: "success", session_id: sid, result: JSON.stringify(r) });
}

function adoptions(driver: ReturnType<typeof createClaudeDriver>) {
  const got: Array<{ handle: RunHandle; info: AdoptedRun; ev: Recorder }> = [];
  driver.onAdopt((handle, info) => {
    const ev = recorder();
    got.push({ handle, info, ev });
    return ev;
  });
  return got;
}

test("a web server restart: the host keeps the run, the next server adopts it with its question and answers it", async () => {
  const sdk = fakeSdk({ turn: askTurn });
  const host = newHost(sdk);
  const first = await connect(host, sdk);
  const ev1 = recorder();
  await first.driver.start({ accountDir, cwd: workDir, resume: "s-restart", prompt: "ask me" }, ev1);
  await until(() => ev1.questions.length === 1);
  first.link.close();

  const second = await connect(host, sdk);
  const got = adoptions(second.driver);
  assert.equal(got.length, 1, "one run adopted");
  const { handle, info, ev } = got[0]!;
  assert.deepEqual(info, { accountDir, cwd: workDir });
  assert.equal(handle.sessionId(), "s-restart");
  assert.equal(second.driver.holds("s-restart"), true, "the adopted session is held");
  await assert.rejects(second.driver.start({ accountDir, cwd: workDir, resume: "s-restart", prompt: "x" }, recorder()), SessionOpenError);
  assert.deepEqual(ev.questions.map((q) => [q.requestId, q.kind]), [["req-1", "question"]], "the question waits again");
  handle.answer("req-1", { "Which color?": "Blue" });
  await ev.results(1);
  const result = JSON.parse((ev.messages.find((m) => m.type === "result") as { result: string }).result) as { updatedInput: { answers: unknown } };
  assert.deepEqual(result.updatedInput.answers, { "Which color?": "Blue" }, "the CLI got the answer");
  assert.equal(sdk.calls.length, 1, "no second process");
  await handle.close();
  assert.deepEqual(ev.exits, [{ code: "done" }]);
  assert.equal(second.driver.holds("s-restart"), false);
});

test("a permission ask made while no web server is connected waits in the host and is settled by the next one", async () => {
  const sdk = fakeSdk({ turn: hangTurn });
  const host = newHost(sdk);
  const first = await connect(host, sdk);
  await first.driver.start({ accountDir, cwd: workDir, resume: "s-away", prompt: "work" }, recorder());
  await until(() => sdk.calls.length === 1);
  first.link.close();
  const input = { command: "ls" };
  const decided = sdk.calls[0]!.options.canUseTool!("Bash", input, ctx({ requestId: "b1" }));
  assert.equal(await settled(decided), false, "nobody to ask: it waits");
  const second = await connect(host, sdk);
  const got = adoptions(second.driver);
  assert.deepEqual(await decided, { behavior: "allow", updatedInput: input }, "the next server allows it from the snapshot");
  assert.equal(got[0]!.ev.questions.length, 0, "an ordinary ask is no question");
  await got[0]!.handle.close();
  assert.deepEqual(got[0]!.ev.exits, [{ code: "interrupted" }]);
});

test("runs gone from the host after a reconnect (the host restarted) end: done when idle, error mid-turn", async () => {
  // One link whose connections go to `target`; dropping the connection makes it reconnect.
  let target = newHost(fakeSdk());
  const idleSdk = fakeSdk();
  const busySdk = fakeSdk({ turn: hangTurn });
  let clientEnd: Duplex | null = null;
  let opened = 0;
  const link = createHostLink({
    open: async () => {
      const [server, client] = duplexPair();
      serveStream(target, server);
      clientEnd = client;
      opened++;
      return client;
    },
    client: "test",
    retryMs: 5,
  });
  links.push(link);
  const driver = createClaudeDriver({ link, query: idleSdk.query, isSessionOpen: closedEverywhere, executable: binLink });
  await driver.ready();
  const reconnect = async (next: SessionHost) => {
    target = next;
    const before = opened;
    (clientEnd as Duplex | null)?.destroy();
    await until(() => opened > before && link.connected());
  };
  // Two SDKs behind one host: s-busy hangs in its turn, the rest answer.
  await reconnect(createSessionHost({
    query: ((p: Parameters<typeof idleSdk.query>[0]) =>
      (p.options?.resume === "s-busy" ? busySdk.query : idleSdk.query)(p)) as typeof idleSdk.query,
    childPids: async () => [],
  }));
  const idle = recorder();
  await driver.start({ accountDir, cwd: workDir, resume: "s-idle", prompt: "hi" }, idle);
  await idle.results(1);
  const busy = recorder();
  await driver.start({ accountDir, cwd: workDir, resume: "s-busy", prompt: "work" }, busy);
  await busy.until((m) => m.type === "system");
  assert.equal(driver.holds("s-idle") && driver.holds("s-busy"), true);

  // The host restarts: the link finds a new one without those runs.
  await reconnect(newHost(fakeSdk()));
  await idle.exited;
  await busy.exited;
  assert.deepEqual(idle.exits, [{ code: "done" }]);
  assert.equal(busy.exits[0]!.code, "error");
  assert.match(busy.exits[0]!.error!, /connection to the session host was down/);
  assert.equal(driver.holds("s-idle") || driver.holds("s-busy"), false, "released");
});

test("without a host: start fails with HostDownError and the status says down", async () => {
  const link = createHostLink({ open: () => Promise.reject(new Error("connect ENOENT /x.sock")), client: "test", retryMs: 60_000 });
  links.push(link);
  const driver = createClaudeDriver({ link, query: fakeSdk().query, isSessionOpen: closedEverywhere, executable: binLink });
  await driver.ready();
  assert.deepEqual(driver.hostStatus(), { state: "down", error: "connect ENOENT /x.sock", waitingFor: [] });
  await assert.rejects(driver.start({ accountDir, cwd: workDir, prompt: "hi" }, recorder()), HostDownError);
  assert.equal(driver.holds("anything"), false);
});

test("a draining host refuses new runs; the status lists what it waits for", async () => {
  const sdk = fakeSdk({ turn: hangTurn });
  const host = newHost(sdk);
  const { driver } = await connect(host, sdk);
  const statuses: string[] = [];
  driver.onHostStatus((s) => statuses.push(`${s.state}:${s.waitingFor.join("|")}`));
  const ev = recorder();
  const run = await driver.start({ accountDir, cwd: workDir, resume: "s-drain", prompt: "work" }, ev);
  await ev.until((m) => m.type === "system");
  const admin = await connect(host, sdk);
  await admin.link.request({ op: "host.drain", force: false });
  await until(() => driver.hostStatus().state === "draining");
  assert.deepEqual(driver.hostStatus().waitingFor, [`session s-drain (${path.basename(workDir)}): turn running`]);
  await assert.rejects(driver.start({ accountDir, cwd: workDir, prompt: "new" }, recorder()), HostDrainingError);
  await admin.link.request({ op: "host.drainCancel" });
  await until(() => driver.hostStatus().state === "up");
  assert.deepEqual(statuses, [`draining:session s-drain (${path.basename(workDir)}): turn running`, "up:"]);
  await run.close();
});

test("a new session's name goes to the CLI as the SDK title; a resume does not carry it", async () => {
  const sdk = fakeSdk();
  const driver = await newDriver(sdk);
  const named = await driver.start({ accountDir, cwd: workDir, prompt: "hi", title: "My name" }, recorder());
  await until(() => sdk.calls.length === 1);
  assert.equal(sdk.calls[0]!.options.title, "My name");
  await named.close();
  const resumed = await driver.start({ accountDir, cwd: workDir, prompt: "hi", resume: "s-1", title: "Ignored" }, recorder());
  await until(() => sdk.calls.length === 2);
  assert.equal("title" in sdk.calls[1]!.options, false);
  await resumed.close();
});
