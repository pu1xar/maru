// The Claude session host's state (DESIGN.md 2b): every live SDK Query, the callbacks waiting for
// a client, and the drain. Transport-agnostic: socket.ts feeds it frames from unix socket clients,
// and tests and driver-check.ts feed it through an in-process stream pair.
//
// Rules:
// - A run is one query() in streaming input mode, with the options the client sent as JSON. The
//   host adds only the callbacks the client named; each call is forwarded to the watching clients
//   and the first reply settles it. With no client connected the call waits, and a client that
//   connects later finds it in the hello snapshot.
// - busy and tasks follow the SDK's own messages (result, system/init, session_state_changed,
//   task_*, background_tasks_changed). They tell the drain what still runs.
// - Drain: no new runs; once no run has a turn, a pending callback or a live task that is not
//   ambient, every run is closed and the host exits (pm2 starts the new code). There is no time
//   limit; `force` closes every run at once instead.
import { execFile } from "node:child_process";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CALLBACK_OPTIONS, CONTROL_METHODS, PROTOCOL_VERSION, describeWait,
  type CallbackInfo, type CallbackOption, type DrainWait, type ErrorCode, type HostFrame, type HostInfo, type Request,
  type RunInfo, type Snapshot, type TaskInfo,
} from "./protocol.ts";

export interface HostConnection {
  /** Writes one frame to this client. */
  send(frame: HostFrame): void;
}

export interface ClientSession {
  /** A frame the client sent. */
  receive(frame: unknown): void;
  /** The client went away. Its pending callbacks stay for the next client. */
  close(): void;
}

export interface SessionHostDeps {
  query?: typeof sdkQuery;
  log?: (line: string) => void;
  /** A drain finished: every run ended and the CLI processes exited. The process should exit now. */
  onDrained?: () => void;
  /** pids of this process's live children (the CLIs). Default: `pgrep -P <pid>`. */
  childPids?: () => Promise<number[]>;
  /** Wait between child checks while a drain finishes, ms. A poll interval, not a limit. */
  childPollMs?: number;
  now?: () => number;
  /** What the host runs, for host.status (main.ts fills it). */
  identity?: () => { entry: string | null; root: string | null; fingerprint: string | null };
}

export interface SessionHost {
  connect(conn: HostConnection): ClientSession;
  /** Ends every run now (the signal path). Resolves once their SDK streams ended. */
  stopAll(reason: string): Promise<void>;
  info(): HostInfo;
}

class HostError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Async queue used as the streaming prompt. Ending it closes the CLI's stdin. */
function createInbox() {
  const items: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    push(m: SDKUserMessage): void {
      items.push(m);
      notify();
    },
    end(): void {
      ended = true;
      notify();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void> {
      while (true) {
        const next = items.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

interface Run {
  id: string;
  meta: unknown;
  cwd: string | null;
  startedAt: number;
  sessionId: string | null;
  busy: boolean;
  closing: boolean;
  busyAtClose: boolean;
  ended: boolean;
  tasks: Map<string, TaskInfo>;
  inbox: ReturnType<typeof createInbox>;
  q: Query;
  done: Promise<void>;
}

interface Callback {
  info: CallbackInfo;
  run: Run;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
}

interface Client {
  conn: HostConnection;
  watch: boolean;
  name: string;
}

const TASK_ENDED = new Set(["completed", "failed", "killed"]);

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** The callback's arguments as JSON: functions and AbortSignals are dropped. */
function toJson(args: unknown[]): unknown[] {
  const text = JSON.stringify(args, (_k, v: unknown) => (typeof v === "function" || v instanceof AbortSignal ? undefined : v));
  return JSON.parse(text) as unknown[];
}

/** AbortSignals among the arguments and their direct fields (canUseTool passes one in its options). */
function signalsIn(args: unknown[]): AbortSignal[] {
  const out: AbortSignal[] = [];
  for (const a of args) {
    if (a instanceof AbortSignal) out.push(a);
    else if (a && typeof a === "object") for (const v of Object.values(a)) if (v instanceof AbortSignal) out.push(v);
  }
  return out;
}

function defaultChildPids(): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("pgrep", ["-P", String(process.pid)], (err, stdout) => {
      // pgrep exits 1 when nothing matches.
      if (err && (err as { code?: unknown }).code !== 1) {
        resolve([]);
        return;
      }
      resolve(String(stdout).split("\n").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0));
    });
  });
}

export function createSessionHost(deps: SessionHostDeps = {}): SessionHost {
  const runQuery = deps.query ?? sdkQuery;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const runs = new Map<string, Run>();
  const callbacks = new Map<string, Callback>();
  const clients = new Set<Client>();
  let drain: { force: boolean; since: number; closing: boolean; sig: string } | null = null;
  let nextCallback = 0;

  // ---- views ----

  function runInfo(run: Run): RunInfo {
    return {
      runId: run.id, meta: run.meta, cwd: run.cwd, startedAt: run.startedAt, sessionId: run.sessionId,
      busy: run.busy, closing: run.closing, tasks: [...run.tasks.values()],
    };
  }

  function waitList(): DrainWait[] {
    const out: DrainWait[] = [];
    for (const run of runs.values()) {
      const cbs = [...callbacks.values()]
        .filter((c) => c.run === run)
        .map((c) => (c.info.name === "canUseTool" && typeof c.info.args[0] === "string" ? `canUseTool(${c.info.args[0]})` : c.info.name));
      const tasks = [...run.tasks.values()].filter((t) => !t.ambient).map((t) => `${t.type ?? "task"}: ${t.description}`);
      if (run.busy || cbs.length || tasks.length) {
        out.push({ runId: run.id, sessionId: run.sessionId, cwd: run.cwd, meta: run.meta, turn: run.busy, callbacks: cbs, tasks });
      }
    }
    return out;
  }

  function info(): HostInfo {
    const id = deps.identity?.() ?? { entry: null, root: null, fingerprint: null };
    return {
      pid: process.pid,
      protocol: PROTOCOL_VERSION,
      startedAt,
      entry: id.entry,
      root: id.root,
      fingerprint: id.fingerprint,
      drain: drain && { force: drain.force, since: drain.since, closing: drain.closing, waiting: waitList() },
    };
  }

  function snapshot(): Snapshot {
    return { host: info(), runs: [...runs.values()].map(runInfo), callbacks: [...callbacks.values()].map((c) => c.info) };
  }

  // ---- fan-out ----

  function toWatchers(frame: HostFrame): void {
    for (const c of clients) if (c.watch) c.conn.send(frame);
  }

  function toAll(frame: HostFrame): void {
    for (const c of clients) c.conn.send(frame);
  }

  function stateChanged(run: Run): void {
    toWatchers({ ev: "run.state", run: runInfo(run) });
    drainCheck();
  }

  // ---- runs ----

  /** Follows the SDK's messages; true when busy, the session id or the tasks changed. */
  function observe(run: Run, m: SDKMessage): boolean {
    const o = m as unknown as Record<string, unknown>;
    let changed = false;
    const sid = str(o.session_id);
    if (sid !== null && sid !== run.sessionId) {
      run.sessionId = sid;
      changed = true;
    }
    const setBusy = (b: boolean) => {
      if (run.busy !== b) {
        run.busy = b;
        changed = true;
      }
    };
    if (o.type === "result") setBusy(false);
    if (o.type !== "system") return changed;
    const taskId = str(o.task_id);
    switch (o.subtype) {
      // system/init opens every turn, also one the CLI starts itself (a background task reporting back).
      case "init":
        setBusy(true);
        break;
      case "session_state_changed":
        setBusy(o.state !== "idle");
        break;
      case "task_started":
        if (taskId !== null) {
          run.tasks.set(taskId, {
            taskId, type: str(o.task_type), description: typeof o.description === "string" ? o.description : "",
            background: o.is_backgrounded === true, ambient: o.ambient === true || o.skip_transcript === true,
          });
          changed = true;
        }
        break;
      case "task_updated": {
        const t = taskId !== null ? run.tasks.get(taskId) : undefined;
        const patch = (o.patch ?? {}) as Record<string, unknown>;
        if (!t) break;
        if (typeof patch.status === "string" && TASK_ENDED.has(patch.status)) run.tasks.delete(t.taskId);
        else if (typeof patch.is_backgrounded === "boolean") t.background = patch.is_backgrounded;
        else break;
        changed = true;
        break;
      }
      case "task_notification":
        if (taskId !== null && run.tasks.delete(taskId)) changed = true;
        break;
      case "background_tasks_changed": {
        // REPLACE semantics (SDK docs): the full list of live background tasks.
        const list = Array.isArray(o.tasks) ? (o.tasks as Record<string, unknown>[]) : [];
        run.tasks = new Map(
          list.flatMap((t) => {
            const id = str(t.task_id);
            if (id === null) return [];
            const desc = typeof t.description === "string" ? t.description : "";
            return [[id, { taskId: id, type: str(t.task_type), description: desc, background: true, ambient: t.ambient === true }]];
          }),
        );
        changed = true;
        break;
      }
    }
    return changed;
  }

  function startRun(req: Extract<Request, { op: "run.start" }>): void {
    if (drain) throw new HostError("draining", "the session host is draining for a restart and takes no new runs");
    if (typeof req.runId !== "string" || !req.runId) throw new HostError("bad-request", "runId is required");
    if (runs.has(req.runId)) throw new HostError("bad-request", `run ${req.runId} exists`);
    if (!req.options || typeof req.options !== "object") throw new HostError("bad-request", "options must be an object");
    const names = Array.isArray(req.callbacks) ? req.callbacks : [];
    for (const n of names) {
      if (!(CALLBACK_OPTIONS as readonly string[]).includes(n)) throw new HostError("not-allowed", `callback ${String(n)} is not supported`);
    }
    const inbox = createInbox();
    const messages = Array.isArray(req.messages) ? req.messages : [];
    const run: Run = {
      id: req.runId,
      meta: req.meta ?? null,
      cwd: typeof req.options.cwd === "string" ? req.options.cwd : null,
      startedAt: now(),
      sessionId: str(req.options.resume),
      busy: messages.length > 0,
      closing: false,
      busyAtClose: false,
      ended: false,
      tasks: new Map(),
      inbox,
      q: undefined as unknown as Query,
      done: Promise.resolve(),
    };
    const options: Record<string, unknown> = { ...req.options };
    for (const n of names) options[n] = forwarder(run, n);
    for (const m of messages) inbox.push(m);
    let q: Query;
    try {
      q = runQuery({ prompt: inbox, options });
    } catch (err) {
      throw new HostError("failed", errorText(err));
    }
    run.q = q;
    runs.set(run.id, run);
    log(`run ${run.id} start cwd=${run.cwd ?? "-"} resume=${run.sessionId ?? "-"} meta=${JSON.stringify(run.meta)}`);
    run.done = (async () => {
      let error: unknown = null;
      try {
        for await (const m of q) {
          const changed = observe(run, m);
          toWatchers({ ev: "run.message", runId: run.id, message: m });
          if (changed) stateChanged(run);
        }
      } catch (err) {
        error = err;
      }
      endRun(run, error);
    })();
  }

  function endRun(run: Run, error: unknown): void {
    run.ended = true;
    run.inbox.end();
    runs.delete(run.id);
    for (const cb of [...callbacks.values()]) if (cb.run === run) settle(cb, "run-ended", { error: "the run ended" });
    let code: "done" | "interrupted" | "error";
    if (run.closing) code = run.busyAtClose ? "interrupted" : "done";
    else code = error === null ? "done" : "error";
    log(`run ${run.id} exit ${code}${error !== null ? `: ${errorText(error)}` : ""} session=${run.sessionId ?? "-"}`);
    toWatchers(code === "error" ? { ev: "run.exit", runId: run.id, code, error: errorText(error) } : { ev: "run.exit", runId: run.id, code });
    drainCheck();
  }

  function closeRun(run: Run): void {
    if (run.ended || run.closing) return;
    run.closing = true;
    run.busyAtClose = run.busy;
    // Closing stdin alone lets a running turn go on until the SDK's SIGTERM; stop it first.
    // close() rejects the interrupt's pending response, which is expected here.
    if (run.busy) run.q.interrupt().catch(() => {});
    run.inbox.end();
    run.q.close();
    stateChanged(run);
  }

  function getRun(runId: unknown): Run {
    const run = typeof runId === "string" ? runs.get(runId) : undefined;
    if (!run) throw new HostError("unknown-run", `no run ${String(runId)}`);
    return run;
  }

  // ---- callbacks ----

  function forwarder(run: Run, name: CallbackOption) {
    return (...args: unknown[]) =>
      new Promise<unknown>((resolve, reject) => {
        if (run.ended || run.closing) {
          reject(new Error("the run is closing"));
          return;
        }
        const callbackId = `${run.id}/${++nextCallback}`;
        const signals = signalsIn(args);
        const onAbort = () => settle(cb, "aborted", { error: "the request was withdrawn" });
        const cb: Callback = {
          info: { callbackId, runId: run.id, name, args: toJson(args), createdAt: now() },
          run, resolve, reject,
          cleanup: () => {
            for (const s of signals) s.removeEventListener("abort", onAbort);
          },
        };
        callbacks.set(callbackId, cb);
        if (signals.some((s) => s.aborted)) {
          settle(cb, "aborted", { error: "the request was withdrawn" });
          return;
        }
        for (const s of signals) s.addEventListener("abort", onAbort, { once: true });
        toWatchers({ ev: "callback", callback: cb.info });
        drainCheck();
      });
  }

  function settle(cb: Callback, reason: "replied" | "aborted" | "run-ended", outcome: { result?: unknown; error?: string }): boolean {
    if (callbacks.get(cb.info.callbackId) !== cb) return false;
    callbacks.delete(cb.info.callbackId);
    cb.cleanup();
    if (outcome.error !== undefined) cb.reject(new Error(outcome.error));
    else cb.resolve(outcome.result);
    toWatchers({ ev: "callback.settled", callbackId: cb.info.callbackId, reason });
    drainCheck();
    return true;
  }

  // ---- drain ----

  function drainCheck(): void {
    if (!drain) return;
    const waiting = waitList();
    const sig = JSON.stringify(waiting);
    if (sig !== drain.sig) {
      drain.sig = sig;
      if (!drain.closing) {
        log(waiting.length ? `drain: waiting for ${waiting.length} run(s): ${waiting.map(describeWait).join(" | ")}` : "drain: nothing runs");
      }
      toAll({ ev: "host.state", host: info() });
    }
    if (!drain.closing && waiting.length === 0) void finishDrain();
  }

  async function finishDrain(): Promise<void> {
    if (!drain || drain.closing) return;
    drain.closing = true;
    log(`drain: closing ${runs.size} run(s)${drain.force ? " (forced)" : ""}`);
    toAll({ ev: "host.state", host: info() });
    const all = [...runs.values()];
    for (const run of all) closeRun(run);
    await Promise.all(all.map((r) => r.done));
    // The SDK ends its stream before the CLI exits; let the processes finish writing first.
    const childPids = deps.childPids ?? defaultChildPids;
    for (let pids = await childPids(); pids.length; pids = await childPids()) {
      await new Promise((r) => setTimeout(r, deps.childPollMs ?? 100));
    }
    log("drain: done");
    deps.onDrained?.();
  }

  function startDrain(force: boolean): void {
    if (drain?.closing) return;
    if (!drain) drain = { force, since: now(), closing: false, sig: "" };
    else drain.force ||= force;
    log(`drain: started${force ? " (force)" : ""}, ${runs.size} run(s)`);
    if (force) {
      void finishDrain();
      return;
    }
    drainCheck();
    toAll({ ev: "host.state", host: info() });
  }

  function cancelDrain(): void {
    if (!drain) return;
    if (drain.closing) throw new HostError("failed", "the drain already closes the runs");
    drain = null;
    log("drain: cancelled");
    toAll({ ev: "host.state", host: info() });
  }

  // ---- requests ----

  function handle(client: Client, req: Request): unknown {
    switch (req.op) {
      case "hello":
        client.watch = req.watch === true;
        client.name = typeof req.client === "string" ? req.client : "?";
        log(`client ${client.name} hello watch=${client.watch} runs=${runs.size} callbacks=${callbacks.size}`);
        return snapshot();
      case "host.status":
        return snapshot();
      case "run.start":
        startRun(req);
        return { runId: req.runId };
      case "run.send": {
        const run = getRun(req.runId);
        if (run.closing) throw new HostError("unknown-run", `run ${run.id} is closing`);
        if (drain?.closing) throw new HostError("draining", "the session host is closing its runs for a restart");
        run.inbox.push(req.message);
        if (!run.busy) {
          run.busy = true;
          stateChanged(run);
        }
        return null;
      }
      case "run.call": {
        const run = getRun(req.runId);
        if (!(CONTROL_METHODS as readonly string[]).includes(req.method)) {
          throw new HostError("not-allowed", `Query.${String(req.method)} is not callable through the host`);
        }
        const fn = (run.q as unknown as Record<string, unknown>)[req.method];
        if (typeof fn !== "function") throw new HostError("failed", `this SDK has no Query.${req.method}`);
        return (fn as (...a: unknown[]) => unknown).apply(run.q, Array.isArray(req.args) ? req.args : []);
      }
      case "run.close":
        closeRun(getRun(req.runId));
        return null;
      case "callback.reply": {
        const cb = callbacks.get(req.callbackId);
        if (!cb) return { settled: false };
        settle(cb, "replied", typeof req.error === "string" ? { error: req.error } : { result: req.result });
        return { settled: true };
      }
      case "host.drain":
        startDrain(req.force === true);
        return info();
      case "host.drainCancel":
        cancelDrain();
        return info();
      default:
        throw new HostError("bad-request", `unknown op ${String((req as { op?: unknown }).op)}`);
    }
  }

  function connect(conn: HostConnection): ClientSession {
    const client: Client = { conn, watch: false, name: "?" };
    clients.add(client);
    const reply = (id: number, result: Promise<unknown>) => {
      result.then(
        (r) => conn.send({ id, ok: true, result: r === undefined ? null : r }),
        (err: unknown) => conn.send({ id, ok: false, error: errorText(err), code: err instanceof HostError ? err.code : "failed" }),
      );
    };
    return {
      receive(frame: unknown): void {
        const req = frame as Request;
        if (!req || typeof req !== "object" || typeof req.id !== "number") return;
        let result: Promise<unknown>;
        try {
          result = Promise.resolve(handle(client, req));
        } catch (err) {
          result = Promise.reject(err);
        }
        reply(req.id, result);
      },
      close(): void {
        if (clients.delete(client)) log(`client ${client.name} gone, ${callbacks.size} callback(s) wait`);
      },
    };
  }

  async function stopAll(reason: string): Promise<void> {
    // Refuse new runs and sends while stopping, as a drain that is closing does.
    drain = { force: true, since: now(), closing: true, sig: "" };
    const all = [...runs.values()];
    log(`stop (${reason}): closing ${all.length} run(s)${all.length ? `: ${waitList().map(describeWait).join(" | ")}` : ""}`);
    for (const run of all) closeRun(run);
    await Promise.all(all.map((r) => r.done));
  }

  return { connect, stopAll, info };
}
