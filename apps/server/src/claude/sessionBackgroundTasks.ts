// The background shell commands and Monitors of a Claude session, for the right panel's "작업" tab
// (DESIGN.md 6i). They are read from the session transcript, as the subagents and workflows are
// read from their sidecar files, so a task started long ago, one of a session a terminal holds and
// one of a session this server did not run all show.
//
// What the transcript says (measured on CLI 2.1.325, 2026-11-16):
// - a Bash call that went to the background, by `run_in_background` or by Ctrl+B, has a
//   tool_result whose `toolUseResult.backgroundTaskId` names the task (Ctrl+B adds
//   `backgroundedByUser`); its tool_use line, earlier, has the command, the description and the
//   real start time. The tool_result text names the output file.
// - a Monitor call's tool_result has `toolUseResult.taskId`.
// - the end of a task is a `queue-operation` "enqueue" line holding a `<task-notification>` with
//   `<status>` (completed, failed, killed for a task that was stopped), `<summary>` (the exit code of a command is in it) and
//   `<output-file>`. A Monitor's per-event notices have no `<status>`, so they are not an end.
// - the output is the file `<tmp>/claude-<uid>/<cwd name>/<session id>/tasks/<task id>.output`;
//   a command's file ends with "[exited with code N]".
// Tasks a subagent started are in that subagent's own transcript and are not listed here.
import fs from "node:fs";
import path from "node:path";
import type { SessionAgentView } from "@maru/shared";

export type BackgroundTaskKind = "shell" | "monitor";

export interface BackgroundTaskEnd {
  /** The notice's own word: completed, failed, killed (a stop; "stopped" in the SDK's type). */
  status: string;
  summary: string;
  /** The command's exit code, when the summary names one. */
  exitCode: number | null;
  /** ms */
  at: number | null;
}

export interface BackgroundTaskRecord {
  taskId: string;
  kind: BackgroundTaskKind;
  toolUseId: string | null;
  command: string;
  description: string;
  /** ms: the tool_use's time, else the tool_result's. */
  startedAt: number | null;
  /** The path the transcript names, not yet checked. */
  outputFile: string | null;
  end: BackgroundTaskEnd | null;
}

/** The fields of a `<task-notification>` that end a task, or null for a notice that does not end one. */
export function parseTaskNotification(content: string): { taskId: string; status: string; summary: string; exitCode: number | null; outputFile: string | null } | null {
  if (!content.includes("<task-notification>")) return null;
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(content)?.[1]?.trim() ?? null;
  const taskId = tag("task-id");
  const status = tag("status");
  // A Monitor that reached its timeout ends with a notice that has no <status>, only an event
  // "[Monitor expired after 50s with 1 event delivered. ...]" (measured 2026-11-16; its output file
  // ends "[killed]"). That is its end.
  const event = tag("event");
  if (taskId && status === null && event !== null && /^\[Monitor expired after /.test(event)) {
    return { taskId, status: "completed", summary: event.replace(/^\[|\]$/g, ""), exitCode: null, outputFile: tag("output-file") };
  }
  if (!taskId || !status) return null;
  const summary = tag("summary") ?? "";
  const code = /exit code (-?\d+)/.exec(summary)?.[1];
  return { taskId, status, summary, exitCode: code === undefined ? null : Number(code), outputFile: tag("output-file") };
}

interface Call {
  kind: BackgroundTaskKind;
  command: string;
  description: string;
  at: number | null;
}

interface Scan {
  offset: number;
  calls: Map<string, Call>;
  tasks: Map<string, BackgroundTaskRecord>;
}

const scans = new Map<string, Scan>();
const CHUNK = 1 << 20;

// Marks that a line can matter; only those lines are parsed.
const MARKS = [Buffer.from('"name":"Bash"'), Buffer.from('"name":"Monitor"'), Buffer.from('"backgroundTaskId"'), Buffer.from('"taskId"'), Buffer.from("<task-notification>")];

function ms(v: unknown): number | null {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** One transcript line into the scan. A line that is not ours changes nothing. */
export function applyLine(scan: Pick<Scan, "calls" | "tasks">, line: unknown): void {
  if (!line || typeof line !== "object") return;
  const o = line as Record<string, any>;
  if (o.type === "assistant" && Array.isArray(o.message?.content)) {
    for (const c of o.message.content) {
      if (c?.type !== "tool_use" || typeof c.id !== "string") continue;
      if (c.name !== "Bash" && c.name !== "Monitor") continue;
      scan.calls.set(c.id, {
        kind: c.name === "Bash" ? "shell" : "monitor",
        command: str(c.input?.command),
        description: str(c.input?.description),
        at: ms(o.timestamp),
      });
    }
    return;
  }
  if (o.type === "user" && Array.isArray(o.message?.content)) {
    const result = o.toolUseResult;
    const taskId = typeof result?.backgroundTaskId === "string" ? result.backgroundTaskId : typeof result?.taskId === "string" ? result.taskId : null;
    if (!taskId) return;
    for (const c of o.message.content) {
      if (c?.type !== "tool_result" || typeof c.tool_use_id !== "string") continue;
      const call = scan.calls.get(c.tool_use_id);
      const text = typeof c.content === "string" ? c.content : "";
      const file = /Output is being written to: (\S+?)\.(?:\s|$)/.exec(text)?.[1];
      const kind: BackgroundTaskKind = call?.kind ?? (typeof result?.backgroundTaskId === "string" ? "shell" : "monitor");
      const prev = scan.tasks.get(taskId);
      scan.tasks.set(taskId, {
        taskId,
        kind,
        toolUseId: c.tool_use_id,
        command: call?.command ?? prev?.command ?? "",
        description: call?.description ?? prev?.description ?? "",
        startedAt: call?.at ?? ms(o.timestamp) ?? prev?.startedAt ?? null,
        outputFile: file ?? prev?.outputFile ?? null,
        end: prev?.end ?? null,
      });
    }
    return;
  }
  if (o.type === "queue-operation" && o.operation === "enqueue" && typeof o.content === "string") {
    const n = parseTaskNotification(o.content);
    if (!n) return;
    const prev = scan.tasks.get(n.taskId);
    const end: BackgroundTaskEnd = { status: n.status, summary: n.summary, exitCode: n.exitCode, at: ms(o.timestamp) };
    // A notification can precede the record only if the tool_result line is missing: keep what it says.
    scan.tasks.set(n.taskId, {
      taskId: n.taskId,
      kind: prev?.kind ?? "shell",
      toolUseId: prev?.toolUseId ?? null,
      command: prev?.command ?? "",
      description: prev?.description ?? "",
      startedAt: prev?.startedAt ?? null,
      outputFile: n.outputFile ?? prev?.outputFile ?? null,
      end,
    });
  }
}

function readNew(file: string, scan: Scan, size: number): void {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return;
  }
  try {
    let pending = Buffer.alloc(0);
    let pos = scan.offset;
    const buf = Buffer.alloc(CHUNK);
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const data = pending.length ? Buffer.concat([pending, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        const line = data.subarray(start, nl);
        start = nl + 1;
        if (!MARKS.some((m) => line.indexOf(m) !== -1)) continue;
        try {
          applyLine(scan, JSON.parse(line.toString("utf8")));
        } catch {
          // Not a record of ours.
        }
      }
      pending = Buffer.from(data.subarray(start));
      // Only whole lines count as read: a line being written is read again next time.
      scan.offset = pos - pending.length;
    }
  } catch {
    // An unreadable transcript lists nothing more.
  } finally {
    fs.closeSync(fd);
  }
}

/** The session's background tasks from its transcript, oldest first. The transcript is read once, then only what was appended. */
export function readBackgroundTasks(transcript: string): BackgroundTaskRecord[] {
  let size: number;
  try {
    size = fs.statSync(transcript).size;
  } catch {
    return [];
  }
  let scan = scans.get(transcript);
  if (!scan || size < scan.offset) {
    scan = { offset: 0, calls: new Map(), tasks: new Map() };
    scans.set(transcript, scan);
  }
  if (size > scan.offset) readNew(transcript, scan, size);
  return [...scan.tasks.values()];
}

export interface TaskRowContext {
  /** A live process holds the session (the index says it is not closed, or this server runs it). */
  sessionOpen: boolean;
  /** When the session's current process started, ms; null when unknown (then no age check). */
  processStartMs: number | null;
  /** The task ids this server's process reports as running; null when this server runs no process for the session. */
  liveTaskIds: ReadonlySet<string> | null;
}

/**
 * A task is running when its end is not in the transcript and its process still has it: the
 * process this server runs reports its tasks (liveTaskIds); for a session another process holds, it
 * is running while the session is open and the task started with that process. Otherwise the
 * process went away with it unfinished: interrupted.
 */
/** The exit code the CLI writes for a shell ended by SIGTERM. */
export const SIGTERM_EXIT = 144;

export function backgroundTaskRows(records: readonly BackgroundTaskRecord[], ctx: TaskRowContext): SessionAgentView[] {
  return records.map((r) => {
    let status: SessionAgentView["status"];
    // Exit code 144 is the CLI's own word for a shell ended by SIGTERM (2.1.321: `n==="SIGTERM"?144:1`):
    // a stop, a session or host going away, a kill from outside. Not a failure of the command.
    if (r.end) status = r.end.status === "completed" ? "completed" : r.end.status === "failed" && r.end.exitCode !== SIGTERM_EXIT ? "failed" : "cancelled";
    else if (ctx.liveTaskIds) status = ctx.liveTaskIds.has(r.taskId) ? "running" : "interrupted";
    else status = ctx.sessionOpen && (ctx.processStartMs === null || r.startedAt === null || r.startedAt >= ctx.processStartMs - 1000) ? "running" : "interrupted";
    const firstLine = r.command.split("\n", 1)[0] ?? "";
    return {
      id: r.taskId,
      kind: r.kind,
      title: r.description || firstLine || (r.kind === "shell" ? "Command" : "Monitor"),
      status,
      agentType: null,
      model: null,
      parentAgentId: null,
      childThreadId: null,
      startedAt: r.startedAt === null ? null : new Date(r.startedAt).toISOString(),
      updatedAt: new Date(r.end?.at ?? r.startedAt ?? 0).toISOString(),
      completedAt: r.end?.at ? new Date(r.end.at).toISOString() : null,
      ...(r.command ? { command: r.command } : {}),
      ...(r.end ? { exitCode: r.end.exitCode, endSummary: r.end.summary } : {}),
    };
  });
}

// ---- output ----

/**
 * How much of the end of an output file one read returns. The CLI's own /tasks detail reads the
 * last 8 KiB; a read here shows more, and says when it holds only the end (`truncated`).
 */
export const OUTPUT_TAIL_BYTES = 64 * 1024;

export interface TaskOutput {
  /** The end of the output as plain text. Empty before the command wrote anything. */
  output: string;
  /** The size of the whole output file, bytes. */
  totalBytes: number;
  /** `output` holds only the end of a longer output. */
  truncated: boolean;
}

// CSI sequences (colors, cursor moves) and OSC sequences (titles, links) a command printed.
const ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** The output as text a pane can show: escape sequences dropped, CRLF as LF. */
export function plainOutput(text: string): string {
  return text.replace(ESCAPES, "").replace(/\r\n/g, "\n");
}

/** The file's last `tailBytes`, cut at a character boundary, or null when it cannot be read. */
export function readOutputTail(file: string, tailBytes: number = OUTPUT_TAIL_BYTES): TaskOutput | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const total = fs.fstatSync(fd).size;
    const from = Math.max(0, total - tailBytes);
    const buf = Buffer.alloc(total - from);
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    let data = buf.subarray(0, n);
    if (from > 0) {
      // The cut may fall inside a multibyte character: skip its continuation bytes.
      let skip = 0;
      while (skip < data.length && skip < 4 && (data[skip]! & 0xc0) === 0x80) skip++;
      data = data.subarray(skip);
    }
    return { output: plainOutput(data.toString("utf8")), totalBytes: total, truncated: from > 0 };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

const TASK_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * The output file of a task. It must be `.../<session id>/tasks/<task id>.output`: the path the
 * transcript names when it names one, else the same folder name under the session's other tasks
 * (a Monitor's result names none), else under `<tmp>/claude-<uid>/*`.
 */
export function outputFileOf(record: Pick<BackgroundTaskRecord, "taskId" | "outputFile">, sessionId: string, siblings: readonly Pick<BackgroundTaskRecord, "outputFile">[], tmpRoots: readonly string[]): string | null {
  if (!TASK_ID_RE.test(record.taskId)) return null;
  const tail = path.join(sessionId, "tasks", `${record.taskId}.output`);
  const fits = (p: string) => path.isAbsolute(p) && p.endsWith(path.sep + tail);
  if (record.outputFile && fits(record.outputFile)) return record.outputFile;
  for (const s of siblings) {
    if (!s.outputFile || !path.isAbsolute(s.outputFile)) continue;
    const dir = path.dirname(s.outputFile);
    if (path.basename(dir) !== "tasks" || path.basename(path.dirname(dir)) !== sessionId) continue;
    return path.join(dir, `${record.taskId}.output`);
  }
  for (const root of tmpRoots) {
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = path.join(root, n, tail);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
