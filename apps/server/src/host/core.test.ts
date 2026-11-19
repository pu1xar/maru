import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createSessionHost, type SessionHostDeps } from "./core.ts";
import type { HostEvent, HostFrame, HostInfo, Request, Snapshot } from "./protocol.ts";

const msg = (o: Record<string, unknown>) => o as unknown as SDKMessage;

/** A query() stand-in the test drives: emit() yields a message, end() ends the stream. */
interface Call {
  options: Options;
  prompts: unknown[];
  interrupts: number;
  closed: boolean;
  emit(m: Record<string, unknown>): void;
  end(err?: Error): void;
}

function fakeQuery() {
  const calls: Call[] = [];
  const query = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const queue: Array<{ m?: SDKMessage; err?: Error; done?: boolean }> = [];
    let wake: (() => void) | null = null;
    const push = (x: { m?: SDKMessage; err?: Error; done?: boolean }) => {
      queue.push(x);
      wake?.();
      wake = null;
    };
    const call: Call = {
      options: params.options, prompts: [], interrupts: 0, closed: false,
      emit: (m) => push({ m: msg(m) }),
      end: (err) => push(err ? { err } : { done: true }),
    };
    calls.push(call);
    void (async () => {
      for await (const p of params.prompt) call.prompts.push(p);
    })();
    async function* run(): AsyncGenerator<SDKMessage, void> {
      while (true) {
        const x = queue.shift();
        if (!x) {
          await new Promise<void>((r) => (wake = r));
          continue;
        }
        if (x.err) throw x.err;
        if (x.done) return;
        yield x.m!;
      }
    }
    return Object.assign(run(), {
      interrupt: async () => {
        call.interrupts++;
      },
      supportedCommands: async () => [{ name: "compact", description: "", argumentHint: "" }],
      close: () => {
        call.closed = true;
        push({ done: true });
      },
    }) as unknown as Query;
  }) as unknown as NonNullable<SessionHostDeps["query"]>;
  return { query, calls };
}

/** A client of the host: requests by op, and the frames it received. */
function client(host: ReturnType<typeof createSessionHost>) {
  const frames: HostFrame[] = [];
  let id = 0;
  const waiting = new Map<number, (f: HostFrame) => void>();
  const session = host.connect({
    send(frame) {
      // Through JSON, as the socket does.
      const f = JSON.parse(JSON.stringify(frame)) as HostFrame;
      frames.push(f);
      if ("id" in f) waiting.get(f.id)?.(f);
    },
  });
  return {
    frames,
    events: () => frames.filter((f): f is HostEvent => "ev" in f),
    async req<T = unknown>(body: Record<string, unknown>): Promise<T> {
      const n = ++id;
      const reply = new Promise<HostFrame>((r) => waiting.set(n, r));
      session.receive({ ...body, id: n } as Request);
      const f = (await reply) as { ok: boolean; result?: unknown; error?: string; code?: string };
      if (!f.ok) throw Object.assign(new Error(f.error), { code: f.code });
      return f.result as T;
    },
    close: () => session.close(),
  };
}

const user = (text: string) => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });

async function startRun(c: ReturnType<typeof client>, runId: string, resume = "s1") {
  await c.req({ op: "run.start", runId, options: { cwd: "/w", resume }, callbacks: ["canUseTool"], messages: [user("go")], meta: { accountDir: "/a" } });
}

const tick = () => sleep(5);

test("a callback waits in the host while no client watches, and the next client finds it in the snapshot", async () => {
  const fq = fakeQuery();
  const host = createSessionHost({ query: fq.query, childPids: async () => [] });
  const a = client(host);
  await a.req({ op: "hello", client: "a", watch: true });
  await startRun(a, "r1");
  a.close();
  const ac = new AbortController();
  const decided = fq.calls[0]!.options.canUseTool!("AskUserQuestion", { questions: [] }, { signal: ac.signal, toolUseID: "t", requestId: "q1" } as never);
  const b = client(host);
  const snap = await b.req<Snapshot>({ op: "hello", client: "b", watch: true });
  assert.equal(snap.runs.length, 1);
  assert.equal(snap.runs[0]!.sessionId, "s1");
  assert.equal(snap.runs[0]!.busy, true, "the first message opened a turn");
  assert.deepEqual(snap.runs[0]!.meta, { accountDir: "/a" });
  assert.equal(snap.callbacks.length, 1);
  const cb = snap.callbacks[0]!;
  assert.equal(cb.name, "canUseTool");
  assert.deepEqual(cb.args, ["AskUserQuestion", { questions: [] }, { toolUseID: "t", requestId: "q1" }], "the AbortSignal is not sent");
  // A second client watches too; the first reply wins and both hear it settled.
  const c2 = client(host);
  await c2.req({ op: "hello", client: "c", watch: true });
  assert.deepEqual(await b.req({ op: "callback.reply", callbackId: cb.callbackId, result: { behavior: "allow", updatedInput: {} } }), { settled: true });
  assert.deepEqual(await c2.req({ op: "callback.reply", callbackId: cb.callbackId, result: { behavior: "deny", message: "x" } }), { settled: false });
  assert.deepEqual(await decided, { behavior: "allow", updatedInput: {} });
  assert.ok(c2.events().some((e) => e.ev === "callback.settled" && e.reason === "replied"));

  // An aborted request is settled as aborted and rejects in the SDK.
  const ac2 = new AbortController();
  const withdrawn = fq.calls[0]!.options.canUseTool!("Bash", {}, { signal: ac2.signal, toolUseID: "t2", requestId: "q2" } as never);
  await tick();
  ac2.abort();
  await assert.rejects(withdrawn, /withdrawn/);
  assert.ok(b.events().some((e) => e.ev === "callback.settled" && e.reason === "aborted"));
  void ac;
});

test("busy and tasks follow the SDK's messages; run.call takes only the allowlisted methods", async () => {
  const fq = fakeQuery();
  const host = createSessionHost({ query: fq.query, childPids: async () => [] });
  const c = client(host);
  await c.req({ op: "hello", client: "web", watch: true });
  await startRun(c, "r1");
  const call = fq.calls[0]!;
  call.emit({ type: "system", subtype: "init", session_id: "s1" });
  call.emit({ type: "system", subtype: "task_started", task_id: "t1", task_type: "local_agent", description: "explore", is_backgrounded: true, session_id: "s1" });
  call.emit({ type: "system", subtype: "task_started", task_id: "t2", task_type: "local_bash", description: "watch", ambient: true, session_id: "s1" });
  call.emit({ type: "result", subtype: "success", session_id: "s1" });
  await tick();
  let snap = await c.req<Snapshot>({ op: "host.status" });
  assert.equal(snap.runs[0]!.busy, false);
  assert.deepEqual(snap.runs[0]!.tasks.map((t) => [t.taskId, t.background, t.ambient]), [["t1", true, false], ["t2", false, true]]);
  call.emit({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed", session_id: "s1" });
  call.emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t3", task_type: "local_workflow", description: "wf" }], session_id: "s1" });
  await tick();
  snap = await c.req<Snapshot>({ op: "host.status" });
  assert.deepEqual(snap.runs[0]!.tasks.map((t) => t.taskId), ["t3"], "background_tasks_changed replaces the list");
  assert.ok(c.events().filter((e) => e.ev === "run.message").length >= 6, "every message is relayed");

  assert.deepEqual(await c.req({ op: "run.call", runId: "r1", method: "supportedCommands", args: [] }), [{ name: "compact", description: "", argumentHint: "" }]);
  await c.req({ op: "run.call", runId: "r1", method: "interrupt", args: [] });
  assert.equal(call.interrupts, 1);
  await assert.rejects(c.req({ op: "run.call", runId: "r1", method: "close", args: [] }), (e: { code?: string }) => e.code === "not-allowed");
  await assert.rejects(c.req({ op: "run.call", runId: "r1", method: "stopTask", args: ["t3"] }), /no Query.stopTask/);
  await assert.rejects(c.req({ op: "run.send", runId: "nope", message: user("x") }), (e: { code?: string }) => e.code === "unknown-run");
  await c.req({ op: "run.close", runId: "r1" });
  await tick();
  assert.ok(c.events().some((e) => e.ev === "run.exit" && e.runId === "r1" && e.code === "done"));
});

test("drain: refuses new runs, waits for the turn, the question and the background task, then closes and calls onDrained", async () => {
  const fq = fakeQuery();
  let drained = 0;
  const logs: string[] = [];
  const host = createSessionHost({ query: fq.query, childPids: async () => [], onDrained: () => drained++, log: (l) => logs.push(l) });
  const web = client(host);
  await web.req({ op: "hello", client: "web", watch: true });
  await startRun(web, "busy", "s-busy");
  await startRun(web, "idle", "s-idle");
  fq.calls[1]!.emit({ type: "result", subtype: "success", session_id: "s-idle" });
  const ask = fq.calls[0]!.options.canUseTool!("AskUserQuestion", { questions: [] }, { signal: new AbortController().signal, toolUseID: "t", requestId: "q" } as never);
  fq.calls[0]!.emit({ type: "system", subtype: "task_started", task_id: "bg", task_type: "local_bash", description: "sleep 20", is_backgrounded: true, session_id: "s-busy" });
  await tick();

  const admin = client(host);
  await admin.req({ op: "hello", client: "drain", watch: false });
  const info = await admin.req<HostInfo>({ op: "host.drain", force: false });
  assert.deepEqual(info.drain!.waiting.map((w) => [w.sessionId, w.turn, w.callbacks, w.tasks]), [
    ["s-busy", true, ["canUseTool(AskUserQuestion)"], ["local_bash: sleep 20"]],
  ], "only the run with work; the idle one is not waited for");
  await assert.rejects(startRun(web, "late", "s-late"), (e: { code?: string }) => e.code === "draining");
  // A send to a running session still goes through while the drain waits.
  await web.req({ op: "run.send", runId: "idle", message: user("more") });
  fq.calls[1]!.emit({ type: "result", subtype: "success", session_id: "s-idle" });

  const cb = (await web.req<Snapshot>({ op: "host.status" })).callbacks[0]!;
  await web.req({ op: "callback.reply", callbackId: cb.callbackId, result: { behavior: "allow", updatedInput: {} } });
  await ask;
  fq.calls[0]!.emit({ type: "result", subtype: "success", session_id: "s-busy" });
  await tick();
  assert.equal(drained, 0, "the background task still runs");
  const states = admin.events().filter((e) => e.ev === "host.state");
  assert.ok(states.length >= 2, "the drain client hears every change of what is waited for");
  fq.calls[0]!.emit({ type: "system", subtype: "task_notification", task_id: "bg", status: "completed", session_id: "s-busy" });
  await tick();
  assert.equal(drained, 1);
  assert.ok(fq.calls.every((c) => c.closed), "every run was closed");
  assert.deepEqual(fq.calls.map((c) => c.interrupts), [0, 0], "nothing ran when they closed");
  assert.ok(web.events().filter((e) => e.ev === "run.exit").every((e) => e.ev === "run.exit" && e.code === "done"));
  assert.ok(logs.some((l) => l.startsWith("drain: waiting for 1 run(s)")));
});

test("drain --force closes running turns at once; a drain can be cancelled before it closes", async () => {
  const fq = fakeQuery();
  let drained = 0;
  const host = createSessionHost({ query: fq.query, childPids: async () => [], onDrained: () => drained++ });
  const web = client(host);
  await web.req({ op: "hello", client: "web", watch: true });
  await startRun(web, "r1");
  await web.req({ op: "host.drain", force: false });
  assert.equal((await web.req<HostInfo>({ op: "host.drainCancel" })).drain, null);
  await startRun(web, "r2", "s2");
  await web.req({ op: "host.drain", force: true });
  await tick();
  assert.equal(drained, 1);
  assert.deepEqual(fq.calls.map((c) => c.interrupts), [1, 1], "running turns were interrupted");
  assert.deepEqual(web.events().filter((e) => e.ev === "run.exit").map((e) => e.ev === "run.exit" && e.code), ["interrupted", "interrupted"]);
});

test("a drain waits for the CLI processes to exit after the streams ended", async () => {
  const fq = fakeQuery();
  let children = [123];
  let drained = 0;
  const host = createSessionHost({ query: fq.query, childPids: async () => children, childPollMs: 5, onDrained: () => drained++ });
  const web = client(host);
  await web.req({ op: "hello", client: "web", watch: true });
  await startRun(web, "r1");
  fq.calls[0]!.emit({ type: "result", subtype: "success", session_id: "s1" });
  await tick();
  await web.req({ op: "host.drain", force: false });
  await sleep(30);
  assert.equal(drained, 0, "a child still runs");
  children = [];
  await sleep(30);
  assert.equal(drained, 1);
});
