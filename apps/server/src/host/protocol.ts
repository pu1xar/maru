// Wire contract between the maru web server and the Claude session host (DESIGN.md 2b).
// One JSON object per line over a unix domain socket.
//
// The host is a thin, generic wrapper around the Agent SDK's `query()`: it keeps the Query objects
// (and so the Claude CLI child processes) alive across web server restarts. Everything that
// decides what a run means (which tool asks need a person, idle closing, names, groups) stays in
// the web server, so the host rarely changes and rarely needs a restart.
//
// Client -> host: requests with a numeric `id`, answered by one Reply with the same id.
// Host -> client: replies, and events (`ev`). Events about runs and callbacks go only to clients
// that said `watch: true` in hello; `host.state` goes to every client.
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export const PROTOCOL_VERSION = 1;

/**
 * Query methods a client may call through `run.call`. Everything a UI may want from a running
 * session, so new features need no host change. Left out on purpose: the iterator methods and
 * close() (run.close covers it), streamInput (run.send covers it), and reinitialize (the host
 * holds the only SDK connection, so callbacks are never redelivered).
 *
 * cancelAsyncMessage takes a queued user message back by its uuid (the CLI's cancel_async_message
 * control request, DESIGN.md 4.4). SDK 0.3.321 has it on its Query class but not in sdk.d.ts.
 */
export const CONTROL_METHODS = [
  "interrupt",
  "cancelAsyncMessage",
  "stopTask",
  "backgroundTasks",
  "setModel",
  "setPermissionMode",
  "setMaxThinkingTokens",
  "applyFlagSettings",
  "updateSettings",
  "supportedCommands",
  "supportedModels",
  "supportedAgents",
  "mcpServerStatus",
  "getContextUsage",
  "accountInfo",
  "initializationResult",
  "reloadPlugins",
  "reloadSkills",
  "reloadOutputStyles",
  "rewindFiles",
  "seedReadState",
  "readFile",
  "reconnectMcpServer",
  "toggleMcpServer",
  "setMcpServers",
  "setMcpPermissionModeOverride",
  "readMcpResource",
] as const;
export type ControlMethod = (typeof CONTROL_METHODS)[number];

/**
 * SDK options whose function the host supplies: it forwards each call to the watching clients and
 * resolves it with the first reply. Their arguments must survive JSON (an AbortSignal among them
 * becomes `callback.settled` with reason "aborted").
 */
export const CALLBACK_OPTIONS = ["canUseTool", "onElicitation", "onUserDialog"] as const;
export type CallbackOption = (typeof CALLBACK_OPTIONS)[number];

/** query() options as JSON: the callbacks are named in `run.start.callbacks` instead. */
export type WireOptions = Omit<Options, CallbackOption | "abortController" | "stderr" | "spawnClaudeCodeProcess" | "hooks">;

export interface TaskInfo {
  taskId: string;
  /** task_type from the SDK (local_agent, local_bash, local_workflow, ...), when it said. */
  type: string | null;
  description: string;
  /** Running in the background (a turn may have ended while it runs). */
  background: boolean;
  /** The SDK marks housekeeping tasks (watchers) as not activity. Drain does not wait for them. */
  ambient: boolean;
}

export interface RunInfo {
  runId: string;
  /** Opaque data the client attached at run.start, returned as is. */
  meta: unknown;
  cwd: string | null;
  startedAt: number;
  /** The session the CLI writes to, from its messages; the resume target before the first one. */
  sessionId: string | null;
  /** A turn runs: from a user message (or a system/init) until its result or an idle state. */
  busy: boolean;
  /** run.close was called, or the host closes it while shutting down. */
  closing: boolean;
  /** Tasks the CLI reported as started and not yet ended. */
  tasks: TaskInfo[];
}

export interface CallbackInfo {
  callbackId: string;
  runId: string;
  name: CallbackOption;
  /** The callback's arguments as JSON (functions and AbortSignals dropped). */
  args: unknown[];
  createdAt: number;
}

/** One run a draining host still waits for. */
export interface DrainWait {
  runId: string;
  sessionId: string | null;
  cwd: string | null;
  meta: unknown;
  turn: boolean;
  /** One entry per pending callback: the tool name for canUseTool, else the callback name. */
  callbacks: string[];
  /** One entry per live task that is not ambient: `<type>: <description>`. */
  tasks: string[];
}

export interface DrainInfo {
  force: boolean;
  since: number;
  /** Nothing left to wait for: the host closes its runs and exits. */
  closing: boolean;
  waiting: DrainWait[];
}

export interface HostInfo {
  pid: number;
  protocol: number;
  startedAt: number;
  /** realpath of the entry file the host runs (apps/server/src/host/main.ts in some release). */
  entry: string | null;
  /** The release root the entry belongs to. */
  root: string | null;
  /**
   * The host code fingerprint (scripts/host-fingerprint.ts) of `root`, taken as the host started,
   * so it stays right if the folder changes later. Null until computed; "error: ..." when it failed.
   */
  fingerprint: string | null;
  /** Null while the host takes new runs. */
  drain: DrainInfo | null;
}

export interface Snapshot {
  host: HostInfo;
  runs: RunInfo[];
  /** Every callback that waits for a reply, of every run. */
  callbacks: CallbackInfo[];
}

export type Request =
  /** Greets the host; `watch` subscribes to run and callback events. Answered with a Snapshot. */
  | { id: number; op: "hello"; client: string; watch: boolean }
  /** Starts a run; `messages` are the first user messages. Answered with `{ runId }`. */
  | { id: number; op: "run.start"; runId: string; options: WireOptions; callbacks: CallbackOption[]; messages: SDKUserMessage[]; meta: unknown }
  | { id: number; op: "run.send"; runId: string; message: SDKUserMessage }
  /** Calls a Query method from CONTROL_METHODS. Answered with its result. */
  | { id: number; op: "run.call"; runId: string; method: string; args: unknown[] }
  /** Ends the run (interrupting a running turn first). run.exit follows once the SDK stream ended. */
  | { id: number; op: "run.close"; runId: string }
  /** Settles a callback: `result` resolves it, `error` rejects it. The first reply wins. */
  | { id: number; op: "callback.reply"; callbackId: string; result?: unknown; error?: string }
  /** Stops taking new runs and exits once nothing runs. `force` closes every run at once. */
  | { id: number; op: "host.drain"; force: boolean }
  | { id: number; op: "host.drainCancel" }
  | { id: number; op: "host.status" };

export type ErrorCode = "bad-request" | "draining" | "unknown-run" | "not-allowed" | "failed";

export type Reply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; code: ErrorCode };

export type HostEvent =
  | { ev: "run.message"; runId: string; message: SDKMessage }
  /** busy, sessionId, closing or tasks changed. */
  | { ev: "run.state"; run: RunInfo }
  /**
   * The run's SDK stream ended. done: on its own or closed between turns; interrupted: closed
   * during a turn; error: the CLI or SDK failed.
   */
  | { ev: "run.exit"; runId: string; code: "done" | "interrupted" | "error"; error?: string }
  | { ev: "callback"; callback: CallbackInfo }
  | { ev: "callback.settled"; callbackId: string; reason: "replied" | "aborted" | "run-ended" }
  | { ev: "host.state"; host: HostInfo };

export type HostFrame = Reply | HostEvent;

/** One line for a run a draining host waits for (host log, drain command). */
export function describeWait(w: DrainWait): string {
  const parts: string[] = [];
  if (w.turn) parts.push("turn running");
  if (w.callbacks.length) parts.push(`waiting callbacks: ${w.callbacks.join(", ")}`);
  if (w.tasks.length) parts.push(`tasks: ${w.tasks.join("; ")}`);
  return `session ${w.sessionId ?? "?"} (${w.cwd ?? "?"}): ${parts.join(", ")}`;
}

/** One frame per line. JSON never contains a raw newline. */
export function encodeFrame(frame: object): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Splits a byte stream into frames. A line that is not JSON goes to `onBad` and the stream
 * continues; the decoder keeps a UTF-8 character that spans two chunks whole.
 */
export function frameDecoder(onFrame: (frame: unknown) => void, onBad?: (line: string, err: unknown) => void) {
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  return (chunk: Uint8Array | string): void => {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch (err) {
        onBad?.(line, err);
        continue;
      }
      onFrame(frame);
    }
  };
}
