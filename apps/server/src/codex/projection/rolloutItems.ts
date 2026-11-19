// Rollout item → app-server ThreadItem, for history the daemon does not serve (rolloutFallback.ts).
//
// A paginated rollout records each finished item as an `event_msg` of type `item_completed`:
//   {"type":"item_completed","thread_id","turn_id","started_at_ms","completed_at_ms","item":{...}}
// The item is the core TurnItem in its Rust serde form: PascalCase type names, snake_case fields
// for most types, camelCase for McpToolCall and Extension, and Extension items told apart by
// `kind`. mapRolloutItem turns one into the camelCase ThreadItem that thread/turns/list returns.
//
// The rules were measured against 0.169.0 daemons on 2026-11-15, comparing whole turns field by
// field: a scratch CODEX_HOME daemon serving copies of the ~/.codex rollouts after thread/resume
// (10 paginated threads, 390 turns, 41,142 items) and the ~/.codex daemon for every thread it
// serves with turns (18 threads, 379 turns, 36,498 items); all equal. rolloutItems.test.ts holds synthetic
// cases of each rule. Types this table does not know return null; the caller counts them and
// shows them as unknown rows.

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThreadItem } from "../protocol/v2/ThreadItem.ts";
import type { UserInput } from "../protocol/v2/UserInput.ts";
import type { CommandAction } from "../protocol/v2/CommandAction.ts";
import type { FileUpdateChange } from "../protocol/v2/FileUpdateChange.ts";
import type { CollabAgentState } from "../protocol/v2/CollabAgentState.ts";
import type { CodexErrorInfo } from "../protocol/v2/CodexErrorInfo.ts";
import type { TurnError } from "../protocol/v2/TurnError.ts";
import type { JsonValue } from "../protocol/serde_json/JsonValue.ts";

type Obj = Record<string, unknown>;

/** Lifecycle times from the item_completed envelope. */
export interface RolloutItemTimes {
  startedAtMs: number | null;
  completedAtMs: number | null;
}

/** The statistics key of a rollout item: its type, and `Extension/<kind>` for extension items. */
export function rolloutItemKey(item: unknown): string {
  const o = isObj(item) ? item : {};
  const type = typeof o.type === "string" ? o.type : "(missing)";
  return type === "Extension" ? `Extension/${typeof o.kind === "string" ? o.kind : "(missing)"}` : type;
}

/** The ThreadItem the daemon serves for a rollout item, or null for a type this table does not know. */
export function mapRolloutItem(item: unknown, times: RolloutItemTimes): ThreadItem | null {
  if (!isObj(item) || typeof item.id !== "string") return null;
  const id = item.id;
  const both = { startedAtMs: times.startedAtMs, completedAtMs: times.completedAtMs };
  switch (rolloutItemKey(item)) {
    case "UserMessage":
      return { type: "userMessage", id, clientId: strOrNull(item.client_id), content: arr(item.content).map(userInput), ...both };
    case "AgentMessage":
      return {
        type: "agentMessage",
        id,
        text: arr(item.content)
          .map((c) => (isObj(c) && typeof c.text === "string" ? c.text : ""))
          .join(""),
        phase: (strOrNull(item.phase) as "commentary" | "final_answer" | null) ?? null,
        moderation: (item.moderation ?? null) as never,
        memoryCitation: (item.memory_citation ?? null) as never,
        delivery: (strOrNull(item.delivery) as "async" | null) ?? null,
        questions: Array.isArray(item.questions) ? (item.questions as never) : null,
        ...both,
      } as ThreadItem;
    case "Reasoning":
      return { type: "reasoning", id, summary: texts(item.summary_text), content: texts(item.raw_content), ...both };
    case "CommandExecution": {
      const cwd = localPath(item.cwd);
      return {
        type: "commandExecution",
        id,
        pluginId: null,
        scriptPath: null,
        command: redactSecrets(Array.isArray(item.command) ? shellJoin(item.command.map(String)) : String(item.command ?? "")),
        cwd,
        processId: strOrNull(item.process_id),
        source: camel(String(item.source ?? "agent")) as never,
        status: camel(String(item.status ?? "completed")) as never,
        commandActions: arr(item.parsed_cmd).map((a) => commandAction(a, cwd)),
        // An empty output is served as null.
        aggregatedOutput: strOrNull(item.aggregated_output) || null,
        exitCode: numOrNull(item.exit_code),
        durationMs: durationMs(item.duration),
        ...both,
      };
    }
    case "FileChange":
      return { type: "fileChange", id, changes: fileChanges(item.changes), status: camel(String(item.status ?? "completed")) as never, ...both };
    case "McpToolCall":
      return {
        type: "mcpToolCall",
        id,
        server: String(item.server ?? ""),
        tool: String(item.tool ?? ""),
        status: camel(String(item.status ?? "completed")) as never,
        arguments: (item.arguments ?? null) as JsonValue,
        appContext:
          typeof item.connectorId === "string"
            ? {
                connectorId: item.connectorId,
                linkId: strOrNull(item.linkId),
                resourceUri: strOrNull(item.resourceUri),
                appName: strOrNull(item.appName),
                actionName: strOrNull(item.actionName),
              }
            : null,
        mcpAppUi: null,
        pluginId: null,
        readOnlyHint: typeof item.readOnlyHint === "boolean" ? item.readOnlyHint : null,
        ...mcpOutcome(item.result),
        durationMs: durationMs(item.duration),
        ...both,
      };
    case "ContextCompaction":
      return { type: "contextCompaction", id, ...both };
    case "ImageView":
      return { type: "imageView", id, path: localPath(item.path), ...both };
    case "SubAgentActivity":
      return {
        type: "subAgentActivity",
        id,
        kind: String(item.kind) as never,
        agentThreadId: String(item.agent_thread_id ?? ""),
        agentPath: String(item.agent_path ?? ""),
        model: strOrNull(item.model),
        reasoningEffort: strOrNull(item.reasoning_effort) as never,
        ...both,
      };
    case "CollabAgentToolCall":
      return {
        type: "collabAgentToolCall",
        id,
        tool: camel(String(item.tool ?? "")) as never,
        status: camel(String(item.status ?? "completed")) as never,
        senderThreadId: String(item.sender_thread_id ?? ""),
        receiverThreadIds: arr(item.receiver_thread_ids).map(String),
        prompt: strOrNull(item.prompt),
        model: strOrNull(item.model),
        reasoningEffort: strOrNull(item.reasoning_effort) as never,
        agentsStates: agentsStates(item.agents_states),
        ...both,
      };
    case "Extension/web.search":
      return {
        type: "webSearch",
        id,
        query: typeof item.query === "string" ? item.query : "",
        action: (item.action ?? null) as never,
        results: Array.isArray(item.results) ? (item.results as JsonValue[]) : null,
        ...both,
      };
    case "Extension/clock.sleep":
      return { type: "sleep", id, durationMs: numOrNull(item.durationMs) ?? 0, ...both };
    case "Extension/image_gen.generation": {
      // Already in ThreadItem form apart from the kind.
      const { kind: _kind, type: _type, ...rest } = item;
      return { ...(rest as Obj), type: "imageGeneration", ...both } as unknown as ThreadItem;
    }
    default:
      return null;
  }
}

/**
 * The command line the daemon shows for an argv: each word quoted like the Rust `shlex` crate's
 * `try_quote` (the longest run that one of unquoted, single quoted or double quoted can hold,
 * runs glued together), words joined by spaces.
 */
export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

const UNQUOTED = 1;
const SINGLE = 2;
const DOUBLE = 4;

export function shellQuote(word: string): string {
  if (word === "") return "''";
  let out = "";
  let rest = word;
  while (rest.length > 0) {
    let ok = UNQUOTED | SINGLE | DOUBLE;
    let i = 0;
    // `^` only right after an opening single quote (a Bash quirk the crate works around).
    if (rest[0] === "^") {
      ok = SINGLE;
      i = 1;
    }
    for (; i < rest.length; i++) {
      const cur = ok & allowed(rest.charCodeAt(i));
      if (cur === 0) break;
      ok = cur;
    }
    const chunk = rest.slice(0, i);
    rest = rest.slice(i);
    if (ok & UNQUOTED) out += chunk;
    else if (ok & SINGLE) out += `'${chunk}'`;
    else out += `"${chunk.replace(/[$`"\\]/g, (c) => `\\${c}`)}"`;
  }
  return out;
}

/** Which quoting styles can hold this UTF-16 code unit. Non-ASCII only rules out unquoted. */
function allowed(c: number): number {
  if (c >= 0x80) return SINGLE | DOUBLE;
  let ok = UNQUOTED | SINGLE | DOUBLE;
  if (!unquotedOk(c)) ok &= ~UNQUOTED;
  // No single quote, `^` or backslash inside single quotes.
  if (c === 0x27 || c === 0x5e || c === 0x5c) ok &= ~SINGLE;
  // No `$`, backquote, `!` or `^` inside double quotes.
  if (c === 0x24 || c === 0x60 || c === 0x21 || c === 0x5e) ok &= ~DOUBLE;
  return ok;
}

function unquotedOk(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === 0x2b || // +
    c === 0x2d || // -
    c === 0x2e || // .
    c === 0x2f || // /
    c === 0x3a || // :
    c === 0x40 || // @
    c === 0x5d || // ]
    c === 0x5f // _
  );
}

/** A Unicode word character, as the Rust regex crate's `\w` (its `\b` is Unicode-aware). */
const WORD = String.raw`[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}]`;

/**
 * The daemon's secret patterns (codex `secrets` crate, read from the 0.169.0 binary), in its order.
 * It applies them to a command's text and to each parsed command, and leaves output, diffs and
 * messages as written (measured: 27 commands redacted, 233 outputs and 21 diffs that match kept).
 */
const SECRET_RULES: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9]{20,}/gu, "[REDACTED_SECRET]"],
  [new RegExp(String.raw`(?<!${WORD})Bearer[ \t]+[A-Za-z0-9._~+/-]{16,}=*`, "giu"), "Bearer [REDACTED_SECRET]"],
  [new RegExp(String.raw`(?<!${WORD})AKIA[0-9A-Z]{16}(?!${WORD})`, "gu"), "[REDACTED_SECRET]"],
  [new RegExp(String.raw`(?<!${WORD})(api[_-]?key|token|secret|password)(?!${WORD})(\s*[:=]\s*)(["']?)[^\s"']{8,}`, "giu"), "$1$2$3[REDACTED_SECRET]"],
];

export function redactSecrets(s: string): string {
  let out = s;
  for (const [re, by] of SECRET_RULES) out = out.replace(re, by);
  return out;
}

/** A `file://` URL as a local path; anything else unchanged. */
export function localPath(v: unknown): string {
  const s = typeof v === "string" ? v : "";
  if (!s.startsWith("file://")) return s;
  try {
    return fileURLToPath(s);
  } catch {
    return s;
  }
}

/** snake_case → camelCase (`unified_exec_startup` → `unifiedExecStartup`). */
export function camel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** A Rust Duration `{secs, nanos}` in whole milliseconds. */
function durationMs(v: unknown): number | null {
  if (!isObj(v)) return numOrNull(v);
  const secs = numOrNull(v.secs) ?? 0;
  const nanos = numOrNull(v.nanos) ?? 0;
  return secs * 1000 + Math.floor(nanos / 1_000_000);
}

function userInput(part: unknown): UserInput {
  if (!isObj(part)) return part as UserInput;
  switch (part.type) {
    case "text":
      return { type: "text", text: String(part.text ?? ""), text_elements: arr(part.text_elements) as never };
    case "image":
      return { type: "image", url: String(part.image_url ?? part.url ?? "") };
    case "local_image":
      return { type: "localImage", path: localPath(part.path) };
    default:
      // A form this table does not know reaches mapItems as is; it records the part as unknown.
      return part as unknown as UserInput;
  }
}

/** A parsed command. A read's path is resolved against the command's cwd (the other paths stay as written). */
function commandAction(a: unknown, cwd: string): CommandAction {
  const o = isObj(a) ? a : {};
  const command = redactSecrets(String(o.cmd ?? ""));
  switch (o.type) {
    case "read": {
      const p = localPath(o.path);
      return { type: "read", command, name: String(o.name ?? ""), path: cwd && p && !path.isAbsolute(p) ? path.resolve(cwd, p) : p };
    }
    case "list_files":
      return { type: "listFiles", command, path: o.path === null || o.path === undefined ? null : localPath(o.path) };
    case "search":
      return { type: "search", command, query: strOrNull(o.query), path: o.path === null || o.path === undefined ? null : localPath(o.path) };
    default:
      return { type: "unknown", command };
  }
}

/**
 * `{path: {type, unified_diff | content, move_path}}` → FileUpdateChange[] sorted by path, as the
 * daemon serves them. Measured: byte order of the path string (292 multi-file changes; component
 * order gives the same result on all of them). A move ends its diff with "\n\nMoved to: <dest>".
 */
function fileChanges(v: unknown): FileUpdateChange[] {
  if (!isObj(v)) return [];
  return Object.keys(v)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((file) => {
      const raw = v[file];
      const c = isObj(raw) ? raw : {};
      if (c.type === "add" || c.type === "delete") return { path: file, kind: { type: c.type }, diff: String(c.content ?? "") };
      const movePath = strOrNull(c.move_path);
      const diff = String(c.unified_diff ?? "");
      return { path: file, kind: { type: "update", move_path: movePath }, diff: movePath ? `${diff}\n\nMoved to: ${movePath}` : diff };
    });
}

/** A rollout turn error `{message, codex_error_info, additional_details?}` → TurnError. */
export function turnError(v: unknown): TurnError | null {
  if (!isObj(v)) return null;
  return {
    message: typeof v.message === "string" ? v.message : JSON.stringify(v),
    codexErrorInfo: errorInfo(v.codex_error_info),
    additionalDetails: strOrNull(v.additional_details),
    misalignment: (v.misalignment ?? null) as never,
  };
}

/** `usage_limit_exceeded` → `usageLimitExceeded`; `{http_connection_failed: {http_status_code}}` → `{httpConnectionFailed: {httpStatusCode}}`. */
function errorInfo(v: unknown): CodexErrorInfo | null {
  if (typeof v === "string") return camel(v);
  if (!isObj(v)) return null;
  const out: Obj = {};
  for (const [k, inner] of Object.entries(v)) {
    if (!isObj(inner)) {
      out[camel(k)] = inner;
      continue;
    }
    const fields: Obj = {};
    for (const [fk, fv] of Object.entries(inner)) fields[camel(fk)] = fv;
    out[camel(k)] = fields;
  }
  return out as CodexErrorInfo;
}

/** The MCP call result: `{content, structuredContent?, _meta?, isError}`; a string is an error message. */
function mcpOutcome(v: unknown): Pick<Extract<ThreadItem, { type: "mcpToolCall" }>, "result" | "error"> {
  if (typeof v === "string") return { result: null, error: { message: v } };
  if (!isObj(v)) return { result: null, error: null };
  if (isObj(v.Err) || typeof v.Err === "string") return { result: null, error: { message: typeof v.Err === "string" ? v.Err : JSON.stringify(v.Err) } };
  const r = isObj(v.Ok) ? v.Ok : v;
  return {
    result: {
      content: arr(r.content) as JsonValue[],
      structuredContent: (r.structuredContent ?? null) as JsonValue,
      _meta: (r._meta ?? null) as JsonValue,
    },
    error: null,
  };
}

function agentsStates(v: unknown): { [key in string]?: CollabAgentState } {
  const out: { [key in string]?: CollabAgentState } = {};
  if (!isObj(v)) return out;
  for (const [k, s] of Object.entries(v)) {
    const o = isObj(s) ? s : {};
    out[k] = { status: (typeof o.status === "string" ? camel(o.status) : o.status) as never, message: strOrNull(o.message) };
  }
  return out;
}

/** Strings, or `{text}` parts, as strings. */
function texts(v: unknown): string[] {
  return arr(v).map((x) => (typeof x === "string" ? x : isObj(x) && typeof x.text === "string" ? x.text : JSON.stringify(x)));
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
