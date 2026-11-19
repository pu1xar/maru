// Terminal mode (DESIGN.md 6i): the timeline entries (session-logic.ts) turned into the blocks the
// Claude Code CLI (2.1.325) draws. Every rule here was measured against the CLI's own screen
// (tmux capture of `claude --resume`) or read from its bundle; the comments name the source.
// Pure functions only, so the rules have tests (terminalModel.test.ts).
import type {
  OrchestrationV2PlanStep,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  OrchestrationV2UserInputQuestion,
  ThreadSnapshot,
} from "@maru/shared";

import { commandDisplayText, commandProgramName } from "../../client-runtime/work-log/commandLabel.ts";
import { contextWindowOf, footerModel } from "../../lib/modelLabel.ts";
import { shortPath } from "../../model.ts";
import { sentMessageAttachments, type SentAttachment } from "../../lib/composerAttachments.logic.ts";
import type { TimelineEntry, WorkLogEntry } from "../../session-logic.ts";

// ---- text width ----

/** Terminal cells of one code point: 2 for East Asian wide and fullwidth, 0 for combining marks. */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function stringWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0) ?? 0);
  return width;
}

/** Splits one line into pieces of at most `width` cells (the CLI's Bun.sliceAnsi loop). */
export function hardWrap(line: string, width: number): string[] {
  if (stringWidth(line) <= width) return [line];
  const pieces: string[] = [];
  let piece = "";
  let used = 0;
  for (const ch of line) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (used + w > width && piece !== "") {
      pieces.push(piece);
      piece = "";
      used = 0;
    }
    piece += ch;
    used += w;
  }
  if (piece !== "") pieces.push(piece);
  return pieces;
}

// ---- output fold ----

/** Lines shown above the fold (CLI bundle: `var c=3`). */
export const FOLD_LINES = 3;
/** Columns the CLI takes off the terminal width before wrapping tool output (`var h=10`). */
export const FOLD_WIDTH_MARGIN = 10;

export interface FoldResult {
  /** The lines shown, already wrapped at the fold width. */
  lines: string[];
  /** Lines left out ("… +N lines"). */
  hidden: number;
}

/**
 * The CLI's tool output fold ($Ps in the 2.1.325 bundle): wrap every line at
 * max(columns - 10, 10) cells, keep 3 lines (all 4 when exactly one would hide), and count the
 * rest. Text longer than 3 x width x 4 characters is cut first and its hidden count comes from
 * its newlines and length, as the CLI does.
 */
export function foldOutput(text: string, columns: number): FoldResult {
  const trimmed = text.trimEnd();
  if (!trimmed) return { lines: [], hidden: 0 };
  const width = Math.max(columns - FOLD_WIDTH_MARGIN, 10);
  const cap = FOLD_LINES * width * 4;
  const cut = trimmed.length > cap;
  const source = cut ? trimmed.slice(0, cap) : trimmed;
  const wrapped: string[] = [];
  for (const line of source.split("\n")) {
    for (const piece of hardWrap(line, width)) wrapped.push(piece.trimEnd());
  }
  const over = wrapped.length - FOLD_LINES;
  let shown: string[];
  let hidden: number;
  if (over === 1) {
    shown = wrapped.slice(0, FOLD_LINES + 1);
    hidden = 0;
  } else {
    shown = wrapped.slice(0, FOLD_LINES);
    hidden = Math.max(0, over);
  }
  if (cut) {
    let newlines = 0;
    for (let i = trimmed.indexOf("\n"); i !== -1; i = trimmed.indexOf("\n", i + 1)) newlines++;
    const lines = Math.max(newlines + 1, Math.ceil(trimmed.length / width));
    hidden = Math.max(hidden, lines - FOLD_LINES);
  }
  const joined = shown.join("\n").trimEnd();
  return { lines: joined ? joined.split("\n") : [], hidden };
}

/** "… +20 lines" (CLI, measured on a 30-line Write). */
export function moreLinesLabel(hidden: number): string {
  return `… +${hidden} ${hidden === 1 ? "line" : "lines"}`;
}

/** Lines of a written file shown before "… +N lines" (measured: a 30-line Write shows 10). */
export const WRITE_PREVIEW_LINES = 10;

// ---- paths ----

/** A path under the session folder as the CLI shows it outside the transcript view: relative. */
export function displayPath(path: string, cwd: string | undefined, verbose: boolean): string {
  if (verbose || !cwd) return path;
  const root = cwd.replace(/\/+$/, "");
  if (path === root) return ".";
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function absolutePath(path: string, cwd: string | undefined): string {
  if (path.startsWith("/") || path.startsWith("~") || !cwd) return path;
  return `${cwd.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`;
}

// ---- blocks ----

/** One styled run of text. `path` makes it a link that opens the file in the right panel. */
export interface Seg {
  t: string;
  bold?: boolean;
  dim?: boolean;
  path?: string;
}

/** One row under a tool's `⎿`. */
export type TermRow =
  | { k: "text"; segs: Seg[]; tone?: "error" | "dim"; indent?: boolean }
  | { k: "code"; n: number; w: number; text: string }
  | { k: "diff"; n: number; w: number; sign: " " | "-" | "+"; text: string }
  | { k: "gap" }
  | { k: "more"; hidden: number; hint: boolean }
  | { k: "md"; text: string }
  /** Starts a new `⎿` group (the CLI's transcript view gives an Agent call's prompt its own). */
  | { k: "section" };

export type ToolTone = "ok" | "error" | "running" | "dim";

export interface GroupPart {
  key: "search" | "read" | "list" | "mcp" | "agent" | "other" | "bash" | "unrecorded";
  verb: string;
  count: number | null;
  /** Text after the count (or the whole object when count is null). */
  noun: string;
}

export type TermBlock =
  /** `attachments`: what the message carried, its notes taken off `text` (DESIGN.md 6n). */
  | { kind: "user"; id: string; text: string; attachments?: SentAttachment[] }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "command-output"; id: string; text: string }
  | { kind: "stamp"; id: string; time: string; model: string | null }
  | {
      kind: "tool";
      id: string;
      tone: ToolTone;
      name: string;
      /** The name is a description in regular weight (a running Bash call), not a bold tool name. */
      plainName?: boolean;
      args: Seg[];
      suffix?: string;
      rows: TermRow[];
      childThreadId?: string;
      /**
       * A Bash or Agent call that runs in the foreground: the CLI offers "run in background" under
       * it after 2 s (DESIGN.md 4.5). `itemId` carries the tool_use id; the view draws the hint.
       */
      background?: { itemId: string; kind: "command" | "agent" };
    }
  /** Collapsed calls; `rows` follow under `⎿` when the group ended on a call stopped with esc. */
  | { kind: "group"; id: string; parts: GroupPart[]; active: boolean; rows?: TermRow[] }
  | { kind: "thinking"; id: string; text: string; streaming: boolean }
  | { kind: "compaction"; id: string; state: "done" | "running" | "failed"; summary: string | null; failure?: string }
  | { kind: "notice"; id: string; level: "info" | "warning" | "error"; text: string }
  /** "Interrupted  What should <agent> do instead?" under the block it stopped. */
  | { kind: "interrupted"; id: string; agent: string }
  | { kind: "error"; id: string; text: string }
  | { kind: "notification"; id: string; tone: ToolTone; text: string; suffix?: string; childThreadId?: string }
  | { kind: "todo"; id: string; steps: OrchestrationV2PlanStep[] }
  /** An answered ExitPlanMode: approved (with the plan), rejected (the plan in a box), or exited without one. */
  | { kind: "plan"; id: string; state: "approved" | "rejected" | "exited"; markdown: string; path: string | null }
  /** EnterPlanMode's result: entered, or declined by the user. */
  | { kind: "plan-mode"; id: string; entered: boolean; agent: string }
  | { kind: "answers"; id: string; pairs: Array<{ question: string; answer: string }> };

export interface TerminalContext {
  cwd: string | undefined;
  /** Terminal width in cells (the fold width comes from it). */
  columns: number;
  /** ctrl+o: the CLI's transcript view, every call on its own and in full. */
  verbose: boolean;
  /** Group ids the user opened by clicking their summary line. */
  openGroups?: ReadonlySet<string>;
  /** Subagent records of the thread, by item id (Agent and Workflow calls). */
  subagents?: ReadonlyArray<OrchestrationV2Subagent>;
  /** Model shown on the transcript view's time stamps. */
  model?: string | null;
  /** Draw the entries before the last compaction too (the CLI starts at the compaction). */
  beforeCompaction?: boolean;
  /** Tool use ids of Agent calls that ran in the background (filled by terminalBlocks). */
  backgroundCalls?: ReadonlySet<string>;
  /** Who the interrupt line asks ("What should Claude do instead?"); Claude when unset. */
  agentName?: string;
  /** The thread's items by id, for what a timeline entry leaves out (a plan's status). */
  items?: ReadonlyMap<string, OrchestrationV2TurnItem>;
  /** Plan file paths by plan entry id (filled by terminalBlocks from the plan_mode_exit notices). */
  planPaths?: ReadonlyMap<string, string>;
}

// ---- tool classification ----

const HIDDEN_TOOLS = new Set([
  // Measured: 2.1.325 draws nothing for these calls in either view; tasks show as the todo list item.
  "ToolSearch",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TodoWrite",
  "TodoRead",
]);

const LIST_PROGRAMS = new Set(["ls", "tree", "eza", "exa", "lsd"]);
const SEARCH_PROGRAMS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd", "locate"]);
const READ_PROGRAMS = new Set(["cat", "head", "tail", "less", "more", "bat", "nl", "wc"]);

/**
 * Which summary a shell command counts toward. Measured: `ls` counted as "listed 1 directory",
 * `find` and `grep` as patterns, other commands as shell commands. The CLI's own parser reads the
 * whole command; this looks at the first program only.
 */
export function bashGroupKind(command: string): GroupPart["key"] {
  const program = commandProgramName(command)?.toLowerCase() ?? "";
  if (LIST_PROGRAMS.has(program)) return "list";
  if (SEARCH_PROGRAMS.has(program)) return "search";
  if (READ_PROGRAMS.has(program)) return "read";
  return "bash";
}

export function mcpParts(toolName: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return m ? { server: m[1]!, tool: m[2]! } : null;
}

function itemOf(entry: WorkLogEntry): OrchestrationV2TurnItem | undefined {
  return entry.structuredPayload;
}

function isActive(entry: WorkLogEntry): boolean {
  return entry.toolLifecycleStatus === "inProgress";
}

function isFailed(entry: WorkLogEntry): boolean {
  const item = itemOf(entry);
  if (entry.toolLifecycleStatus === "failed" || entry.toolLifecycleStatus === "stopped") return true;
  if (item?.type === "command_execution") {
    return item.outputIndicatesFailure === true || (item.exitCode !== undefined && item.exitCode !== 0);
  }
  return false;
}

/** How the projection marks a call the user stopped (esc during the call). */
const STOPPED_KINDS = new Set(["user-rejected", "interrupted", "cancelled"]);

/**
 * A call the user stopped with esc while it ran: Claude records it as a rejected tool use
 * (toolDenialKind "user-rejected"), Codex as an interrupted item.
 */
export function isInterruptedCall(entry: WorkLogEntry): boolean {
  const item = itemOf(entry);
  if (!item) return false;
  if (entry.toolLifecycleStatus === "stopped") return true;
  return item.toolNonExecutionKind !== undefined && STOPPED_KINDS.has(item.toolNonExecutionKind);
}

/**
 * The summary group a work entry joins outside the transcript view, or null to draw it alone.
 * Failed and stopped calls stay in their group (measured: a failing `ls` counts as "Listed 1
 * directory", a Read stopped with esc as "Read 1 file"); the group then shows the interrupt.
 */
export function groupKindOf(entry: WorkLogEntry): GroupPart["key"] | null {
  const item = itemOf(entry);
  if (!item) return null;
  if (item.type === "command_execution") {
    // A running shell command shows its own line until it ends (measured: live capture).
    if (isActive(entry)) return null;
    return bashGroupKind(item.input);
  }
  if (item.type === "dynamic_tool") {
    const name = item.toolName ?? "";
    if (name === "Read" || name === "ReadFile" || name === "NotebookRead") return "read";
    if (name === "Grep" || name === "Glob") return "search";
    if (name === "LS") return "list";
    if (mcpParts(name)) return "mcp";
  }
  return null;
}

/** Calls drawn nowhere (measured: ToolSearch and the task tools). */
export function isHiddenEntry(entry: WorkLogEntry): boolean {
  const item = itemOf(entry);
  return item?.type === "dynamic_tool" && HIDDEN_TOOLS.has(item.toolName ?? "");
}

// ---- group summary ----

/**
 * The CLI's collapsed group line, in its order: searched, read, listed, called (MCP), ran agents,
 * called tools, ran shell commands. Counts are bold; an active group uses -ing verbs and ends in
 * "…". The first verb is capitalized.
 */
export function groupParts(entries: ReadonlyArray<WorkLogEntry>, active: boolean): GroupPart[] {
  let search = 0;
  let read = 0;
  let list = 0;
  let bash = 0;
  let mcp = 0;
  let unrecorded = 0;
  const servers: string[] = [];
  for (const entry of entries) {
    const kind = groupKindOf(entry) ?? (itemOf(entry)?.type === "command_execution" ? "bash" : null);
    // Measured: a shell command stopped with esc counts as "no result recorded for 1 other call".
    if (kind === "bash" && isInterruptedCall(entry)) unrecorded++;
    else if (kind === "search") search++;
    else if (kind === "read") read++;
    else if (kind === "list") list++;
    else if (kind === "bash") bash++;
    else if (kind === "mcp") {
      mcp++;
      const item = itemOf(entry);
      const server = item?.type === "dynamic_tool" ? mcpParts(item.toolName ?? "")?.server : undefined;
      if (server && !servers.includes(server)) servers.push(server);
    }
  }
  const parts: GroupPart[] = [];
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  if (search > 0) parts.push({ key: "search", verb: active ? "searching for" : "searched for", count: search, noun: plural(search, "pattern", "patterns") });
  if (read > 0) parts.push({ key: "read", verb: active ? "reading" : "read", count: read, noun: plural(read, "file", "files") });
  if (list > 0) parts.push({ key: "list", verb: active ? "listing" : "listed", count: list, noun: plural(list, "directory", "directories") });
  if (mcp > 0) parts.push({ key: "mcp", verb: active ? "calling" : "called", count: null, noun: `${servers.join(", ") || "MCP"}${mcp > 1 ? ` ${mcp} times` : ""}` });
  if (bash > 0) parts.push({ key: "bash", verb: active ? "running" : "ran", count: bash, noun: plural(bash, "shell command", "shell commands") });
  // Bundle: "other " only when other parts come first.
  if (unrecorded > 0) parts.push({ key: "unrecorded", verb: "no result recorded for", count: unrecorded, noun: `${parts.length > 0 ? "other " : ""}${plural(unrecorded, "call", "calls")}` });
  if (parts[0]) parts[0] = { ...parts[0], verb: parts[0].verb.charAt(0).toUpperCase() + parts[0].verb.slice(1) };
  return parts;
}

/**
 * What a group shows under its line when its last call was stopped with esc (measured): the
 * stopped command as "$ command" when it was a shell command, then the interrupt line.
 */
export function groupStopRows(entries: ReadonlyArray<WorkLogEntry>, agent: string | undefined): TermRow[] | undefined {
  const last = entries.at(-1);
  if (!last || !isInterruptedCall(last)) return undefined;
  const item = itemOf(last);
  const rows: TermRow[] = [];
  if (item?.type === "command_execution") rows.push({ k: "text", segs: [{ t: `$ ${commandDisplayText(item.input)}` }], tone: "dim" }, { k: "section" });
  rows.push({ k: "text", segs: [{ t: interruptedText(agent) }], tone: "dim" });
  return rows;
}

/** The group line as plain text, e.g. "Listed 1 directory, ran 2 shell commands". */
export function groupText(parts: ReadonlyArray<GroupPart>, active: boolean): string {
  const text = parts.map((p) => (p.count === null ? `${p.verb} ${p.noun}` : `${p.verb} ${p.count} ${p.noun}`)).join(", ");
  return active ? `${text}…` : text;
}

// ---- unified diff ----

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  hunks: Array<{ oldStart: number; newStart: number; lines: string[] }>;
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffFile["hunks"][number] | null = null;
  const stripPrefix = (p: string) => {
    const path = p.trim().split("\t")[0] ?? "";
    if (path === "/dev/null") return null;
    return path.replace(/^[ab]\//, "");
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      file = { oldPath: stripPrefix(line.slice(4)), newPath: null, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (line.startsWith("+++ ") && file && file.newPath === null && hunk === null) {
      file.newPath = stripPrefix(line.slice(4));
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      if (!file) {
        file = { oldPath: null, newPath: null, hunks: [] };
        files.push(file);
      }
      hunk = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk && (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+"))) hunk.lines.push(line);
  }
  return files.filter((f) => f.hunks.length > 0);
}

/**
 * The CLI's numbered diff rows (measured on Update): context and added lines carry the new line
 * number, removed lines the old one; the number column is as wide as the hunk's largest number,
 * and hunks are separated by a "..." row.
 */
export function diffRows(file: DiffFile): TermRow[] {
  const rows: TermRow[] = [];
  file.hunks.forEach((h, index) => {
    // A creation hunk records a zero-length old side as start 0 (jsdiff formatPatch).
    let oldN = Math.max(h.oldStart, 1);
    let newN = Math.max(h.newStart, 1);
    const numbered: Array<{ n: number; sign: " " | "-" | "+"; text: string }> = [];
    for (const line of h.lines) {
      const sign = line[0] as " " | "-" | "+";
      const text = line.slice(1);
      if (sign === "-") numbered.push({ n: oldN++, sign, text });
      else if (sign === "+") numbered.push({ n: newN++, sign, text });
      else {
        numbered.push({ n: newN, sign, text });
        oldN++;
        newN++;
      }
    }
    const w = String(Math.max(0, ...numbered.map((r) => r.n))).length;
    if (index > 0) rows.push({ k: "gap" });
    for (const r of numbered) rows.push({ k: "diff", n: r.n, w, sign: r.sign, text: r.text });
  });
  return rows;
}

function countLines(text: string, n: number, one: string, many: string): Seg[] {
  return [{ t: `${text}` }, { t: String(n), bold: true }, { t: ` ${n === 1 ? one : many}` }];
}

/** "Added 1 line, removed 2 lines" with bold counts (measured). */
export function changeSummary(additions: number, deletions: number): Seg[] {
  const segs: Seg[] = [];
  if (additions > 0 || deletions === 0) segs.push(...countLines("Added ", additions, "line", "lines"));
  if (deletions > 0) segs.push(...countLines(segs.length > 0 ? ", removed " : "Removed ", deletions, "line", "lines"));
  return segs;
}

// ---- tool presentation ----

function outputText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .flatMap((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? [String((part as { text?: unknown }).text ?? "")] : []))
      .join("\n");
    if (text) return text;
  }
  const record = value as Record<string, unknown>;
  if (record && typeof record === "object" && Array.isArray(record.content)) return outputText(record.content);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function textRows(text: string, ctx: TerminalContext, tone?: "error" | "dim", hint = true): TermRow[] {
  if (ctx.verbose) {
    const trimmed = text.trimEnd();
    return trimmed ? trimmed.split("\n").map((line) => ({ k: "text" as const, segs: [{ t: line }], ...(tone ? { tone } : {}) })) : [];
  }
  const fold = foldOutput(text, ctx.columns);
  const rows: TermRow[] = fold.lines.map((line) => ({ k: "text" as const, segs: [{ t: line }], ...(tone ? { tone } : {}) }));
  if (fold.hidden > 0) rows.push({ k: "more", hidden: fold.hidden, hint });
  return rows;
}

function quoteArg(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
}

/** `key: "value", key2: 3` as the CLI writes a generic tool's input. */
export function inputSummary(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object") return String(input);
  return Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${quoteArg(v)}`)
    .join(", ");
}

function pathSeg(path: string, ctx: TerminalContext): Seg {
  return { t: displayPath(path, ctx.cwd, ctx.verbose), path: absolutePath(path, ctx.cwd) };
}

function toneOf(entry: WorkLogEntry): ToolTone {
  if (isActive(entry)) return "running";
  if (isFailed(entry)) return "error";
  return "ok";
}

function durationSeconds(item: OrchestrationV2TurnItem): number | null {
  if (!item.startedAt || !item.completedAt) return null;
  const ms = Date.parse(item.completedAt) - Date.parse(item.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}

/**
 * Claude model aliases and ids as the CLI names them ("Haiku 4.5"); any other model (Codex's
 * gpt-6-luna) keeps its own id.
 */
export function modelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(model);
  // The CLI writes a `[1m]` model as "Opus 4.6 (1M context)" (its model catalog's display rule).
  if (m) return `${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ""}${/\[1m\]$/i.test(model) ? " (1M context)" : ""}`;
  if (/^(opus|sonnet|haiku|fable)$/.test(model)) return model.charAt(0).toUpperCase() + model.slice(1);
  return model;
}

/** Token counts as the CLI's Agent "Done" line writes them (bundle `Ta`): 999, 4.0k, 12.3k, 1.2m. */
export function compactCount(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1, minimumFractionDigits: n >= 1000 ? 1 : 0 })
    .format(n)
    .toLowerCase();
}

/** Durations as the CLI's Agent "Done" line writes them (bundle `bn`): 3s, 1m 5s, 1h 2m 3s. */
export function cliDuration(ms: number): string {
  if (ms < 60_000) {
    if (ms === 0) return "0s";
    if (ms < 1) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 1000)}s`;
  }
  let d = Math.floor(ms / 86_400_000);
  let h = Math.floor((ms % 86_400_000) / 3_600_000);
  let m = Math.floor((ms % 3_600_000) / 60_000);
  let s = Math.round((ms % 60_000) / 1000);
  if (s === 60) (s = 0), m++;
  if (m === 60) (m = 0), h++;
  if (h === 24) (h = 0), d++;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

/**
 * The finished Agent call's line: "Done (1 tool use, 4.0k tokens, 3s)" when the server sends the
 * counts (subagent record `toolUses`, `totalTokens`, `durationMs`, DESIGN.md 6i), else "Done (3s)"
 * from the item's times. The CLI separates the parts with middle dots; this app uses commas.
 */
export function agentDoneLine(stats: { toolUses?: unknown; totalTokens?: unknown; durationMs?: unknown }, fallbackSeconds: number | null): string {
  const parts: string[] = [];
  if (typeof stats.toolUses === "number") parts.push(stats.toolUses === 1 ? "1 tool use" : `${stats.toolUses} tool uses`);
  if (typeof stats.totalTokens === "number") parts.push(`${compactCount(stats.totalTokens)} tokens`);
  if (typeof stats.durationMs === "number") parts.push(cliDuration(stats.durationMs));
  else if (fallbackSeconds !== null) parts.push(`${fallbackSeconds}s`);
  return parts.length > 0 ? `Done (${parts.join(", ")})` : "Done";
}

/** The CLI's interrupt words (InterruptedByUser) with two spaces for its middle dot. */
export function interruptedText(agent: string | undefined): string {
  return `Interrupted  What should ${agent ?? "Claude"} do instead?`;
}

function interruptedRows(ctx: TerminalContext): TermRow[] {
  return [{ k: "text", segs: [{ t: interruptedText(ctx.agentName) }], tone: "dim" }];
}

/** A string field of the item's projection data (DESIGN.md 6i server contract), when the server sends it. */
function dataString(entry: WorkLogEntry, key: string): string | undefined {
  const value = entry.projectedItem?.x?.data?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function bashBlock(entry: WorkLogEntry, item: Extract<OrchestrationV2TurnItem, { type: "command_execution" }>, ctx: TerminalContext): TermBlock {
  const tone = toneOf(entry);
  const command = commandDisplayText(item.input);
  const description = dataString(entry, "description");
  if (tone === "running" && description && !ctx.verbose) {
    // Measured (live capture): a running call with a description shows it, then "$ command" under it.
    return { kind: "tool", id: entry.id, tone, name: description, plainName: true, args: [], rows: [{ k: "text", segs: [{ t: `$ ${command}` }], tone: "dim" }], ...bashBackground(entry, item) };
  }
  let rows: TermRow[];
  if (isInterruptedCall(entry)) {
    rows = interruptedRows(ctx);
  } else if (tone === "running") {
    rows = [{ k: "text", segs: [{ t: "Running…" }], tone: "dim" }];
  } else {
    const output = (item.output ?? "").replace(/\s+$/, "");
    if (!output) rows = [{ k: "text", segs: [{ t: item.outputOmitted ? "(output not loaded)" : "(No output)" }], tone: "dim" }];
    else rows = textRows(output, ctx, tone === "error" ? "error" : undefined);
  }
  return { kind: "tool", id: entry.id, tone, name: "Bash", args: [{ t: command }], rows, ...bashBackground(entry, item) };
}

/** The background offer of a running Bash call; the view shows it while the server says the CLI holds the call in the foreground. */
function bashBackground(entry: WorkLogEntry, item: Extract<OrchestrationV2TurnItem, { type: "command_execution" }>): { background?: { itemId: string; kind: "command" } } {
  if (!isActive(entry) || item.status !== "running") return {};
  return { background: { itemId: item.id, kind: "command" } };
}

/** The hint under a call that can go to the background, as the CLI words it ("(ctrl+b to run in background)"). */
export function backgroundHintText(keyLabel: string): string {
  return `(${keyLabel} to run in background)`;
}

/** A plan file (Claude Code keeps plans in `<config dir>/plans/`). */
export function isPlanFile(path: string): boolean {
  return /\/\.claude[^/]*\/plans\/[^/]+$/.test(path);
}

/**
 * The CLI's name for a file change: Write for the Write tool (a new file or an overwrite), Update
 * for Edit and MultiEdit. The original tool name comes from the server (`x.data.toolName`, DESIGN.md
 * 6i); without it a created file counts as Write.
 */
export function fileChangeToolName(toolName: string | undefined, created: boolean): "Write" | "Update" {
  if (toolName === "Write") return "Write";
  if (toolName !== undefined && toolName !== "") return "Update";
  return created ? "Write" : "Update";
}

function fileChangeBlocks(entry: WorkLogEntry, item: Extract<OrchestrationV2TurnItem, { type: "file_change" }>, ctx: TerminalContext): TermBlock[] {
  const tone = toneOf(entry);
  const toolName = dataString(entry, "toolName") ?? (item.title === "Write" || item.title === "Edit" || item.title === "MultiEdit" ? item.title : undefined);
  const files = item.diffStr ? parseUnifiedDiff(item.diffStr) : [];
  if (files.length === 0 || isInterruptedCall(entry)) {
    const name = fileChangeToolName(toolName, item.changes?.some((c) => c.operation === "add") ?? false);
    const rows: TermRow[] = isInterruptedCall(entry)
      ? interruptedRows(ctx)
      : tone === "running"
        ? []
        : item.diffStr
          ? textRows(item.diffStr, ctx, tone === "error" ? "error" : undefined)
          : [];
    return [{ kind: "tool", id: entry.id, tone, name, args: [pathSeg(item.fileName, ctx)], rows }];
  }
  return files.map((file, index) => {
    const path = file.newPath ?? file.oldPath ?? item.fileName;
    const id = index === 0 ? entry.id : `${entry.id}:${index}`;
    const name = fileChangeToolName(toolName, file.oldPath === null);
    if (file.oldPath === null) {
      const lines = file.hunks.flatMap((h) => h.lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1)));
      if (!ctx.verbose && isPlanFile(path)) {
        // Measured in the bundle (FileWrite result): a plan file shows only "/plan to preview".
        return { kind: "tool" as const, id, tone, name, args: [pathSeg(path, ctx)], rows: [{ k: "text" as const, segs: [{ t: "/plan to preview" }], tone: "dim" as const }] };
      }
      // A created file: "Wrote N lines to path" and its numbered lines, 10 before "… +N lines".
      const shown = ctx.verbose ? lines : lines.slice(0, WRITE_PREVIEW_LINES);
      const w = String(shown.length).length;
      const rows: TermRow[] = [
        { k: "text", segs: [{ t: "Wrote " }, { t: String(lines.length), bold: true }, { t: ` ${lines.length === 1 ? "line" : "lines"} to ` }, { ...pathSeg(path, ctx), bold: true }] },
        ...shown.map((text, i) => ({ k: "code" as const, n: i + 1, w, text })),
      ];
      if (shown.length < lines.length) rows.push({ k: "more", hidden: lines.length - shown.length, hint: false });
      return { kind: "tool" as const, id, tone, name, args: [pathSeg(path, ctx)], rows };
    }
    let additions = 0;
    let deletions = 0;
    for (const h of file.hunks) for (const l of h.lines) {
      if (l.startsWith("+")) additions++;
      else if (l.startsWith("-")) deletions++;
    }
    // An overwriting Write draws the same diff as Update under its own name (bundle: FileWrite "update").
    const rows: TermRow[] = [{ k: "text", segs: changeSummary(additions, deletions) }, ...diffRows(file)];
    return { kind: "tool" as const, id, tone, name, args: [pathSeg(path, ctx)], rows };
  });
}

function readCount(output: unknown): number | null {
  const file = output && typeof output === "object" ? (output as { file?: { numLines?: unknown } }).file : undefined;
  return typeof file?.numLines === "number" ? file.numLines : null;
}

function dynamicToolBlock(entry: WorkLogEntry, item: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>, ctx: TerminalContext): TermBlock {
  const tone = toneOf(entry);
  const name = item.toolName ?? "Tool";
  const input = (item.input ?? {}) as Record<string, unknown>;
  const errorRows = () => textRows(outputText(item.output), ctx, "error");
  if (name === "Read" || name === "ReadFile") {
    const path = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : "";
    const n = readCount(item.output);
    const rows: TermRow[] =
      tone === "error" ? errorRows() : tone === "running" ? [] : n === null ? [{ k: "text", segs: [{ t: "Read file" }] }] : [{ k: "text", segs: countLines("Read ", n, "line", "lines") }];
    return { kind: "tool", id: entry.id, tone, name: "Read", args: path ? [pathSeg(path, ctx)] : [], rows };
  }
  if (name === "Grep" || name === "Glob") {
    const args: string[] = [];
    if (typeof input.pattern === "string") args.push(`pattern: ${JSON.stringify(input.pattern)}`);
    if (typeof input.path === "string") args.push(`path: ${JSON.stringify(displayPath(input.path, ctx.cwd, ctx.verbose))}`);
    if (typeof input.glob === "string") args.push(`glob: ${JSON.stringify(input.glob)}`);
    const out = (item.output ?? {}) as { numLines?: unknown; numFiles?: unknown; mode?: unknown };
    let rows: TermRow[] = [];
    if (tone === "error") rows = errorRows();
    else if (tone !== "running") {
      const lines = out.mode === "content" && typeof out.numLines === "number" ? out.numLines : null;
      const files = typeof out.numFiles === "number" ? out.numFiles : null;
      rows = lines !== null ? [{ k: "text", segs: countLines("Found ", lines, "line", "lines") }] : files !== null ? [{ k: "text", segs: countLines("Found ", files, "file", "files") }] : textRows(outputText(item.output), ctx);
    }
    return { kind: "tool", id: entry.id, tone, name: "Search", args: [{ t: args.join(", ") }], rows };
  }
  const mcp = mcpParts(name);
  const rows = tone === "running" ? [] : textRows(outputText(item.output), ctx, tone === "error" ? "error" : undefined);
  if (mcp) {
    // Measured: "ref - echo (MCP)(text: "hello from maru")".
    return { kind: "tool", id: entry.id, tone, name: `${mcp.server} - ${mcp.tool} (MCP)`, args: [{ t: inputSummary(input) }], rows };
  }
  if (name === "Skill" && typeof input.skill === "string") {
    return { kind: "tool", id: entry.id, tone, name: "Skill", args: [{ t: input.skill }], rows };
  }
  return { kind: "tool", id: entry.id, tone, name, args: [{ t: inputSummary(input) }], rows };
}

function webBlock(entry: WorkLogEntry, item: Extract<OrchestrationV2TurnItem, { type: "web_search" }>, ctx: TerminalContext): TermBlock {
  const tone = toneOf(entry);
  const pattern = item.patterns?.[0] ?? "";
  const seconds = durationSeconds(item);
  if (/^https?:\/\//.test(pattern)) {
    // WebFetch: "Received <size> (<code> <text>)" (bundle, WebFetch result). The server sends the
    // fetched page's size and status in results[0] (DESIGN.md 6i); without them, the size of the
    // model's answer the transcript keeps.
    const text = item.results?.[0]?.snippet ?? "";
    const fetched = (item.results?.[0] ?? {}) as { bytes?: unknown; code?: unknown; codeText?: unknown };
    const bytes = typeof fetched.bytes === "number" ? fetched.bytes : new TextEncoder().encode(text).length;
    const status = typeof fetched.code === "number" ? ` (${fetched.code}${typeof fetched.codeText === "string" && fetched.codeText ? ` ${fetched.codeText}` : ""})` : "";
    const rows: TermRow[] = tone === "running" ? [] : [{ k: "text", segs: [{ t: "Received " }, { t: byteLabel(bytes), bold: true }, ...(status ? [{ t: status }] : [])] }];
    if (ctx.verbose && text) rows.push(...textRows(text, ctx));
    return { kind: "tool", id: entry.id, tone, name: "Fetch", args: [{ t: pattern }], rows };
  }
  const rows: TermRow[] =
    tone === "running" ? [] : [{ k: "text", segs: [{ t: `Did 1 search${seconds !== null ? ` in ${seconds}s` : ""}` }] }];
  return { kind: "tool", id: entry.id, tone, name: "Web Search", args: [{ t: JSON.stringify(pattern) }], rows };
}

/** A fetched size: "103 bytes" (measured), larger ones in KB and MB. */
export function byteLabel(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, "")}KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")}MB`;
}

const WORKFLOW_GLYPH: Record<string, string> ={ completed: "✔", running: "◼", queued: "◻", failed: "✘" };

/** The tool use id inside an item id (`<thread>:tool:<toolUseId>`). */
function toolUseIdOf(itemId: string): string | null {
  const at = itemId.lastIndexOf(":tool:");
  return at === -1 ? null : itemId.slice(at + ":tool:".length);
}

function subagentBlock(entry: TimelineEntry & { kind: "event" }, ctx: TerminalContext): TermBlock {
  const item = entry.projectedItem.item as Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
  const record = ctx.subagents?.find((s) => s.id === item.id || s.id === item.subagentId);
  const status = record?.status ?? item.status;
  const tone: ToolTone =
    status === "failed" || status === "cancelled" || status === "interrupted" ? "error" : status === "completed" ? "ok" : "running";
  const childThreadId = record?.childThreadId ?? item.childThreadId ?? undefined;
  const title = record?.title ?? item.title ?? "";
  const workflow = record?.workflow;
  const callId = toolUseIdOf(item.id);
  // Fields the server adds to the record (DESIGN.md 6i); absent ones fall back to what the items say.
  const extra = (record ?? {}) as { background?: unknown; modelResolved?: unknown; toolUses?: unknown; totalTokens?: unknown; durationMs?: unknown };
  // Measured: a background Agent keeps "Backgrounded agent"; its end shows as a notification. The
  // record says so when the server sends it; without it, a completion notice naming the call does.
  const background =
    typeof extra.background === "boolean" ? extra.background : callId !== null && (ctx.backgroundCalls?.has(callId) ?? false);
  const rows: TermRow[] = [];
  const prompt = record?.prompt || item.prompt;
  const result = record?.result ?? item.result;
  if (workflow) {
    const done = workflow.agents.filter((a) => a.state === "completed").length;
    rows.push({ k: "text", segs: [{ t: `${done}/${workflow.agents.length} agents done` }], tone: "dim" });
    let phase: string | undefined;
    for (const agent of workflow.agents) {
      if (agent.phaseTitle && agent.phaseTitle !== phase) {
        phase = agent.phaseTitle;
        rows.push({ k: "text", segs: [{ t: phase, bold: true }] });
      }
      rows.push({ k: "text", segs: [{ t: `${WORKFLOW_GLYPH[agent.state] ?? "\u25fb"} ${agent.label}` }], ...(agent.state === "failed" ? { tone: "error" as const } : agent.state === "queued" ? { tone: "dim" as const } : {}) });
    }
  } else if (tone === "error") {
    rows.push(...textRows(result ?? "Error", ctx, "error"));
  } else if (background || (tone === "running" && !(record?.progress ?? item.progress))) {
    // Measured: "Backgrounded agent (↓ to manage, ctrl+o to expand)" with a middle dot for the comma; two spaces here.
    rows.push({ k: "text", segs: [{ t: "Backgrounded agent" }, ...(ctx.verbose ? [] : [{ t: " (↓ to manage  ctrl+o to expand)", dim: true }])] });
    if (ctx.verbose && prompt) rows.push({ k: "section" }, { k: "text", segs: [{ t: "Prompt:" }] }, ...quotedRows(prompt));
  } else if (tone === "running") {
    rows.push({ k: "text", segs: [{ t: (record?.progress ?? item.progress ?? "").trim() }] });
  } else {
    // Measured (foreground agent, transcript view): Prompt, Response and Done, each under its own `⎿`.
    const seconds = durationSeconds(item);
    if (ctx.verbose && prompt) rows.push({ k: "text", segs: [{ t: "Prompt:" }] }, ...quotedRows(prompt), { k: "section" });
    if (ctx.verbose && result) rows.push({ k: "text", segs: [{ t: "Response:" }] }, ...quotedRows(result), { k: "section" });
    rows.push({ k: "text", segs: [{ t: agentDoneLine(extra, seconds) }] });
  }
  const suffix = modelLabel(typeof extra.modelResolved === "string" ? extra.modelResolved : record?.model);
  return {
    kind: "tool",
    id: entry.id,
    tone,
    name: workflow ? "Workflow" : "Agent",
    args: [{ t: workflow?.name ?? title }],
    ...(suffix ? { suffix } : {}),
    rows,
    ...(childThreadId ? { childThreadId } : {}),
    // A running Agent call that is not background; a workflow, a background agent and a finished one have none.
    ...(tone === "running" && status === "running" && !background && !workflow
      ? { background: { itemId: item.id, kind: "agent" as const } }
      : {}),
  };
}

/** A prompt or a result under "Prompt:"/"Response:": its own lines, two cells further in (measured). */
function quotedRows(text: string): TermRow[] {
  return text.replace(/\s+$/, "").split("\n").map((line) => ({ k: "text" as const, segs: [{ t: line }], indent: true }));
}

function questionAnswers(item: Extract<OrchestrationV2TurnItem, { type: "user_input_request" }>): Array<{ question: string; answer: string }> {
  const answer = item.questionAnswer;
  if (!answer) return [];
  const byId = new Map<string, OrchestrationV2UserInputQuestion>(item.questions.map((q) => [q.id, q]));
  return Object.entries(answer.answers).map(([id, value]) => ({
    question: answer.questionTextById?.[id] ?? byId.get(id)?.question ?? id,
    answer: Array.isArray(value) ? value.join(", ") : typeof value === "object" && value !== null && Array.isArray((value as { answers?: unknown }).answers) ? ((value as { answers: unknown[] }).answers.join(", ")) : String(value),
  }));
}

const QUIET_NOTICE_KINDS = new Set(["context", "hook"]);

/** One work entry's blocks, drawn on its own (no group). */
export function workBlocks(entry: WorkLogEntry, ctx: TerminalContext): TermBlock[] {
  const item = itemOf(entry);
  if (!item) return [{ kind: "notice", id: entry.id, level: "info", text: entry.label }];
  // A stopped call keeps its header and shows the interrupt in place of a result.
  const stopped = (block: TermBlock): TermBlock =>
    block.kind === "tool" && isInterruptedCall(entry) ? { ...block, tone: "error", rows: interruptedRows(ctx) } : block;
  switch (item.type) {
    case "command_execution":
      return [bashBlock(entry, item, ctx)];
    case "file_change":
      return fileChangeBlocks(entry, item, ctx);
    case "dynamic_tool": {
      if (isHiddenEntry(entry)) return [];
      if (item.toolName === "EnterPlanMode") {
        // Bundle (EnterPlanMode result): "Entered plan mode" with a dim line, or "User declined
        // to enter plan mode"; nothing while it waits.
        if (isActive(entry)) return [];
        if (!isFailed(entry)) return [{ kind: "plan-mode", id: entry.id, entered: true, agent: ctx.agentName ?? "Claude" }];
        if (item.toolNonExecutionKind === "user-rejected") return [{ kind: "plan-mode", id: entry.id, entered: false, agent: ctx.agentName ?? "Claude" }];
      }
      return [stopped(dynamicToolBlock(entry, item, ctx))];
    }
    case "web_search":
      return [stopped(webBlock(entry, item, ctx))];
    case "reasoning": {
      // Measured: 2.1.325 hides thinking outside the live "✻ Thinking…" line; the transcript
      // view here shows its text (DESIGN.md 6i).
      const streaming = item.streaming || entry.toolLifecycleStatus === "inProgress";
      if (!ctx.verbose && !streaming) return [];
      if (!item.text.trim() && !streaming) return [];
      return [{ kind: "thinking", id: entry.id, text: ctx.verbose ? item.text : "", streaming }];
    }
    case "compaction": {
      const state = entry.toolLifecycleStatus === "inProgress" ? "running" : entry.toolLifecycleStatus === "failed" ? "failed" : "done";
      return [{ kind: "compaction", id: entry.id, state, summary: ctx.verbose ? (item.summary ?? null) : null, ...(state === "failed" && entry.detail ? { failure: entry.detail } : {}) }];
    }
    case "todo_list":
      return [{ kind: "todo", id: entry.id, steps: item.steps }];
    case "notification": {
      const tone: ToolTone = item.outcome === "failed" ? "error" : item.outcome === "completed" ? "ok" : "dim";
      const child = item.source.kind === "subagent" || item.source.kind === "delegated_task" ? item.source.childThreadId : undefined;
      // Measured: 'Agent "Count files" finished' and, after a middle dot, the agent's run time.
      const callId = entry.projectedItem?.x?.relatedCallId;
      const record = callId ? ctx.subagents?.find((s) => toolUseIdOf(s.id) === callId) : undefined;
      const ms = record?.startedAt && record.completedAt ? Date.parse(record.completedAt) - Date.parse(record.startedAt) : NaN;
      const suffix = Number.isFinite(ms) && ms >= 0 ? cliDuration(ms) : undefined;
      return [{ kind: "notification", id: entry.id, tone, text: item.summary, ...(suffix ? { suffix } : {}), ...(child ? { childThreadId: child } : {}) }];
    }
    case "system_notice": {
      const level = item.level ?? "info";
      const x = entry.projectedItem?.x;
      const noticeKind = x?.noticeKind;
      // The CLI draws nothing for records it keeps for the model (its hidden attachment list:
      // plan_mode, plan_mode_exit, unknown_command_fallback and the like). The projection marks
      // the plan ones as "mode" and the ones it has no row for as unknown.
      if (noticeKind === "mode" || x?.unknown) return [];
      if (!ctx.verbose && level === "info" && noticeKind && QUIET_NOTICE_KINDS.has(noticeKind)) return [];
      // The folded body (a goal's reason) shows in the transcript view, and always for an error,
      // as the CLI shows a goal's reason in verbose mode and for a goal it could not achieve.
      const body = x?.body?.trim();
      const text = body && (ctx.verbose || level === "error") ? `${item.message}\n${body}` : item.message;
      return [{ kind: "notice", id: entry.id, level, text }];
    }
    case "error":
      // The CLI prints the provider's own message ("API Error: 529 …").
      return [{ kind: "error", id: entry.id, text: item.failure.message || entry.label }];
    case "user_input_request": {
      const pairs = questionAnswers(item);
      return pairs.length > 0 ? [{ kind: "answers", id: entry.id, pairs }] : [];
    }
    case "approval_request":
      return [{ kind: "notice", id: entry.id, level: "warning", text: `${entry.label}${item.prompt ? `: ${item.prompt}` : ""}` }];
    default:
      return [{ kind: "notice", id: entry.id, level: "info", text: entry.label }];
  }
}

function eventBlocks(entry: TimelineEntry & { kind: "event" }, ctx: TerminalContext): TermBlock[] {
  const item = entry.projectedItem.item;
  switch (item.type) {
    case "subagent":
      return [subagentBlock(entry, ctx)];
    case "run_interrupt_result":
      // An interrupt during a tool call shows on the call (workBlocks), so only the plain one
      // gets its own line.
      return /for tool use/.test(item.message) ? [] : [{ kind: "interrupted", id: entry.id, agent: ctx.agentName ?? "Claude" }];
    case "run_interrupt_request":
      return [];
    case "fork":
      return [{ kind: "notice", id: entry.id, level: "info", text: "Forked conversation" }];
    default:
      return [{ kind: "notice", id: entry.id, level: "info", text: item.title ?? item.type.replaceAll("_", " ") }];
  }
}

/**
 * Where the CLI's screen starts: the last finished compaction (measured: after /compact the
 * resumed screen begins at "✻ Conversation compacted" in both views). 0 when there is none.
 */
export function lastCompactionIndex(entries: ReadonlyArray<TimelineEntry>): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === "work" && e.entry.itemType === "compaction" && e.entry.toolLifecycleStatus === "completed") return i;
  }
  return 0;
}

function nativeIdOf(entry: TimelineEntry): string | undefined {
  const item = entry.kind === "work" ? entry.entry.structuredPayload : entry.kind === "proposed-plan" ? undefined : entry.projectedItem?.item;
  return item?.nativeItemRef?.nativeId ?? undefined;
}

/**
 * The entries the CLI's screen holds after a compaction: the compaction, then the messages it kept
 * word for word (its preserved transcript lines), then everything after it.
 */
export function fromLastCompaction(entries: ReadonlyArray<TimelineEntry>): ReadonlyArray<TimelineEntry> {
  const cut = lastCompactionIndex(entries);
  if (cut === 0) return entries;
  const compaction = entries[cut]!;
  const preserved = new Set(compaction.kind === "work" ? (compaction.entry.projectedItem?.x?.compaction?.preservedUuids ?? []) : []);
  const kept = preserved.size === 0 ? [] : entries.slice(0, cut).filter((e) => preserved.has(nativeIdOf(e) ?? ""));
  return [compaction, ...kept, ...entries.slice(cut + 1)];
}

/** "01:45 AM" as the transcript view's stamp writes it. */
export function stampTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const h = d.getHours();
  const hh = String(h % 12 === 0 ? 12 : h % 12).padStart(2, "0");
  return `${hh}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * All blocks of a thread. Outside the transcript view, consecutive collapsible calls (reads,
 * searches, listings, MCP and shell commands) fold into one summary line unless the user opened
 * that group; hidden calls do not end a group (measured: ToolSearch between calls).
 */
export function terminalBlocks(allEntries: ReadonlyArray<TimelineEntry>, context: TerminalContext): TermBlock[] {
  const backgroundCalls = new Set<string>();
  for (const e of allEntries) {
    const callId = e.kind === "work" && e.entry.itemType === "notification" ? e.entry.projectedItem?.x?.relatedCallId : undefined;
    if (callId) backgroundCalls.add(callId);
  }
  const ctx: TerminalContext = { ...context, backgroundCalls, planPaths: planFilePaths(allEntries) };
  const entries = context.beforeCompaction ? allEntries : fromLastCompaction(allEntries);
  const blocks: TermBlock[] = [];
  let group: WorkLogEntry[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const id = `group:${group[0]!.id}`;
    if (ctx.openGroups?.has(id)) {
      for (const entry of group) blocks.push(...workBlocks(entry, ctx));
    } else {
      const active = group.some(isActive);
      const rows = groupStopRows(group, ctx.agentName);
      blocks.push({ kind: "group", id, parts: groupParts(group, active), active, ...(rows ? { rows } : {}) });
    }
    group = [];
  };
  for (const entry of entries) {
    if (entry.kind === "work") {
      if (isHiddenEntry(entry.entry)) continue;
      if (!ctx.verbose && groupKindOf(entry.entry) !== null) {
        group.push(entry.entry);
        continue;
      }
      const drawn = workBlocks(entry.entry, ctx);
      if (drawn.length === 0) continue;
      flush();
      blocks.push(...drawn);
      continue;
    }
    if (entry.kind === "proposed-plan") {
      const block = planBlock(entry, ctx);
      if (!block) continue;
      flush();
      blocks.push(block);
      continue;
    }
    flush();
    if (entry.kind === "message") {
      const { message } = entry;
      if (message.role === "user") {
        const sent = sentMessageAttachments(message.text, message.attachments ?? [], entry.projectedItem?.x?.data);
        blocks.push({ kind: "user", id: entry.id, text: sent.text, ...(sent.attachments.length > 0 ? { attachments: sent.attachments } : {}) });
      } else if (entry.projectedItem?.x?.noticeKind === "command_output") {
        blocks.push({ kind: "command-output", id: entry.id, text: message.text });
      } else {
        if (!message.text.trim() && !message.streaming) continue;
        if (ctx.verbose) blocks.push({ kind: "stamp", id: `stamp:${entry.id}`, time: stampTime(message.createdAt), model: messageModel(entry) ?? ctx.model ?? null });
        blocks.push({ kind: "assistant", id: entry.id, text: message.text, streaming: message.streaming });
      }
    } else {
      for (const block of eventBlocks(entry, ctx)) {
        // A call or a group that already shows the interrupt does not get a second line for it.
        const prev = blocks.at(-1);
        if (block.kind === "interrupted" && (prev?.kind === "tool" || prev?.kind === "group") && showsInterrupt(prev.rows ?? [])) continue;
        blocks.push(block);
      }
    }
  }
  flush();
  return blocks;
}

function showsInterrupt(rows: ReadonlyArray<TermRow>): boolean {
  return rows.some((row) => row.k === "text" && /^Interrupted {2}What should /.test(row.segs[0]?.t ?? ""));
}

/** The model an answer came from, when the server sends it per message (DESIGN.md 6i). */
function messageModel(entry: TimelineEntry & { kind: "message" }): string | null {
  const model = (entry.projectedItem?.item as { model?: unknown } | undefined)?.model;
  return typeof model === "string" && model ? model : null;
}

/** Plan file paths by plan entry: the first plan_mode_exit notice after a plan names its file. */
export function planFilePaths(entries: ReadonlyArray<TimelineEntry>): Map<string, string> {
  const paths = new Map<string, string>();
  let plan: string | null = null;
  for (const e of entries) {
    if (e.kind === "proposed-plan") plan = e.id;
    else if (plan && e.kind === "work" && e.entry.itemType === "system_notice" && /plan_mode_exit/.test(e.entry.projectedItem?.x?.sourceKey ?? "")) {
      const item = e.entry.structuredPayload;
      if (item?.type === "system_notice" && item.message) paths.set(plan, item.message);
      plan = null;
    }
  }
  return paths;
}

/**
 * An ExitPlanMode call once it is answered, as the bundle's ExitPlanMode result draws it: "User
 * approved Claude's plan" with the plan, "User rejected Claude's plan:" with the plan in a box, or
 * "Exited plan mode" when no plan text came. Nothing while it waits (the picker shows the plan)
 * and nothing for a call that failed on its own (no plan, no message to show).
 */
function planBlock(entry: TimelineEntry & { kind: "proposed-plan" }, ctx: TerminalContext): TermBlock | null {
  const item = ctx.items?.get(entry.id);
  const markdown = entry.proposedPlan.planMarkdown;
  const path = ctx.planPaths?.get(entry.id) ?? null;
  const status = item?.status ?? "completed";
  if (status === "completed") return { kind: "plan", id: entry.id, state: markdown.trim() ? "approved" : "exited", markdown, path };
  if (item?.toolNonExecutionKind === "user-rejected" && markdown.trim()) return { kind: "plan", id: entry.id, state: "rejected", markdown, path };
  return null;
}

// ---- tables (assistant markdown) ----

/**
 * A markdown table as the CLI draws it (measured on two tables): box lines, one space of padding,
 * columns at least 3 cells wide, headers centered (extra space on the right), body cells left
 * aligned.
 */
export function boxTable(rows: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const laid = layoutTable(rows, Infinity);
  return laid.kind === "box" ? laid.lines : [];
}

/** Bundle constants of the table layout: side margin, narrowest column, most lines in a cell, rows drawn. */
const TABLE_MARGIN = 4;
const TABLE_MIN_COL = 3;
const TABLE_MAX_CELL_LINES = 4;
const TABLE_MAX_ROWS = 200;

/** Word wrap at `width` cells; `hard` also breaks words longer than the width. */
export function wrapWords(text: string, width: number, hard: boolean): string[] {
  const out: string[] = [];
  let line = "";
  const push = () => {
    if (line.trim()) out.push(line.trimEnd());
    line = "";
  };
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const pieces = hard && stringWidth(word) > width ? hardWrap(word, width) : [word];
    for (const piece of pieces) {
      if (line === "") line = piece;
      else if (stringWidth(line) + 1 + stringWidth(piece) <= width) line += ` ${piece}`;
      else {
        push();
        line = piece;
      }
    }
  }
  push();
  return out.length > 0 ? out : [""];
}

function padCell(text: string, width: number, align: "left" | "center" | "right"): string {
  const space = Math.max(0, width - stringWidth(text));
  if (align === "left") return text + " ".repeat(space);
  if (align === "right") return " ".repeat(space) + text;
  const left = Math.floor(space / 2);
  return " ".repeat(left) + text + " ".repeat(space - left);
}

export type TableLayout =
  | { kind: "box"; lines: string[] }
  /** One record per row, each cell as "Header: value" (header bold) with a rule between records. */
  | { kind: "vertical"; records: Array<Array<{ label: string; lines: string[] }>>; rule: string; more: string | null };

function moreRowsLine(n: number): string {
  return `… ${n.toLocaleString("en-US")} more ${n === 1 ? "row" : "rows"} not shown`;
}

/**
 * A markdown table as the CLI (2.1.325 bundle, markdown table renderer) lays it out in `width`
 * cells: columns at their natural width when they fit; otherwise each column keeps its longest
 * word and the rest of the room goes out in proportion to what the column wanted; if even the
 * words do not fit, columns shrink in proportion and words break. Cells wrap within their column
 * and center vertically in their row. When a cell would need more than 4 lines, or the box is
 * still wider than the width less 4, the table becomes a list of records instead.
 */
export function layoutTable(
  allRows: ReadonlyArray<ReadonlyArray<string>>,
  width: number,
  align: ReadonlyArray<"left" | "center" | "right" | null> = [],
): TableLayout {
  if (allRows.length === 0) return { kind: "box", lines: [] };
  const header = allRows[0]!;
  const cols = Math.max(...allRows.map((r) => r.length));
  const truncated = Math.max(0, allRows.length - 1 - TABLE_MAX_ROWS);
  const rows = allRows.slice(1, 1 + TABLE_MAX_ROWS);
  const all = [header, ...rows];
  const cell = (r: ReadonlyArray<string>, c: number) => r[c] ?? "";
  const longestWord = (text: string) => Math.max(TABLE_MIN_COL, ...text.split(/\s+/).filter(Boolean).map(stringWidth));
  const minWidths = Array.from({ length: cols }, (_, c) => Math.max(...all.map((r) => longestWord(cell(r, c)))));
  const idealWidths = Array.from({ length: cols }, (_, c) => Math.max(TABLE_MIN_COL, ...all.map((r) => stringWidth(cell(r, c)))));
  const room = Math.max(width - (1 + cols * 3) - TABLE_MARGIN, cols * TABLE_MIN_COL);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  let widths: number[];
  let hard = false;
  if (sum(idealWidths) <= room) widths = idealWidths;
  else if (sum(minWidths) <= room) {
    const extra = room - sum(minWidths);
    const wants = idealWidths.map((w, c) => w - minWidths[c]!);
    const total = sum(wants);
    widths = minWidths.map((w, c) => (total === 0 ? w : w + Math.floor((wants[c]! / total) * extra)));
  } else {
    hard = true;
    const scale = room / sum(minWidths);
    widths = minWidths.map((w) => Math.max(Math.floor(w * scale), TABLE_MIN_COL));
  }
  const wrapped = (r: ReadonlyArray<string>) => widths.map((w, c) => wrapWords(cell(r, c), w, hard));
  const tallest = Math.max(...all.map((r) => Math.max(...wrapped(r).map((lines) => lines.length))));
  const vertical = (): TableLayout => {
    const labels = header.map((h) => h.replace(/\s+/g, " ").trim());
    const body = rows.length > 0 ? rows : [header.map(() => "")];
    const records = body.map((r) =>
      Array.from({ length: cols }, (_, c) => {
        const label = rows.length > 0 ? (labels[c] ?? "") : "";
        const text = (rows.length > 0 ? cell(r, c) : cell(header, c)).replace(/\s+/g, " ").trim();
        if (!label && !text) return null;
        const first = wrapWords(text, Math.max(label ? width - stringWidth(label) - 3 : width - 1, 10), false);
        const rest = first.length > 1 ? wrapWords(first.slice(1).join(" "), width - 3, false) : [];
        return { label, lines: [first[0] ?? "", ...rest.filter((l) => l.trim()).map((l) => `  ${l}`)] };
      }).filter((x): x is { label: string; lines: string[] } => x !== null),
    ).filter((record) => record.length > 0);
    return { kind: "vertical", records, rule: "─".repeat(Math.min(width - 1, 40)), more: truncated > 0 ? moreRowsLine(truncated) : null };
  };
  if (tallest > TABLE_MAX_CELL_LINES) return vertical();
  const rule = (l: string, m: string, r: string) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const boxRow = (r: ReadonlyArray<string>, isHeader: boolean) => {
    const cells = wrapped(r);
    const height = Math.max(...cells.map((lines) => lines.length), 1);
    const out: string[] = [];
    for (let i = 0; i < height; i++) {
      let line = "│";
      cells.forEach((lines, c) => {
        const at = i - Math.floor((height - lines.length) / 2);
        const text = at >= 0 && at < lines.length ? lines[at]! : "";
        line += ` ${padCell(text, widths[c]!, isHeader ? "center" : (align[c] ?? "left"))} │`;
      });
      out.push(line);
    }
    return out;
  };
  const lines = [rule("┌", "┬", "┐"), ...boxRow(header, true)];
  for (const r of rows) lines.push(rule("├", "┼", "┤"), ...boxRow(r, false));
  lines.push(rule("└", "┴", "┘"));
  if (Math.max(...lines.map(stringWidth)) > width - TABLE_MARGIN) return vertical();
  if (truncated > 0) lines.push(moreRowsLine(truncated));
  return { kind: "box", lines };
}

// ---- progress line ----

/** Spinner frames (the CLI's set without its middle-dot frame, which this app does not draw). */
export const SPINNER_FRAMES = ["✢", "✳", "✶", "✻", "✽"] as const;

/** Present-tense words for the progress line; one per run, picked from its id. */
export const PROGRESS_VERBS = ["Working", "Thinking", "Cogitating", "Pondering", "Brewing", "Crafting", "Computing", "Mulling", "Tinkering", "Noodling", "Percolating", "Musing"] as const;
/** Past-tense words for the line a finished run leaves ("✻ Worked for 11s"). */
export const DONE_VERBS = ["Worked", "Cogitated", "Brewed", "Cooked", "Crunched", "Churned"] as const;

export function hashPick<T>(list: ReadonlyArray<T>, key: string): T {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return list[h % list.length]!;
}

/** "12s", "1m 5s", "1h 2m" as the progress line counts. */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "184", "1.2k", "3.4M" tokens. */
export function tokenLabel(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * The progress line's parenthesis: "(12s  ↓ 1.2k tokens)". The CLI separates the parts with a
 * middle dot; this app uses two spaces (DESIGN.md 6i).
 */
export function progressDetail(elapsedMs: number, outputTokens: number | null): string {
  const parts = [elapsedLabel(elapsedMs)];
  if (outputTokens !== null && outputTokens > 0) parts.push(`↓ ${tokenLabel(outputTokens)} tokens`);
  return `(${parts.join("  ")})`;
}

// ---- permission mode ----

/** The modes shift+tab moves through (the `/ws` thread.setPermissionMode contract). */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/**
 * The mode shift+tab moves to, in the CLI's order (2.1.325 bundle, `MIn`): default, accept edits,
 * plan, bypass (sessions here always run with bypass available), back to default. Any other mode
 * (dontAsk, auto) goes to default, as there.
 */
export function nextPermissionMode(mode: string | undefined): PermissionMode {
  switch (mode) {
    case "default":
      return "acceptEdits";
    case "acceptEdits":
      return "plan";
    case "plan":
      return "bypassPermissions";
    default:
      return "default";
  }
}

/** Where the thread's items leave plan mode: on after EnterPlanMode, off after an approved plan. */
export interface PlanSignal {
  on: boolean;
  /** When that item ended (ISO), to order it against a mode change seen live. */
  at: string;
}

/** The last plan mode change the thread's own items show, or null when they show none. */
export function planSignal(items: ReadonlyArray<{ item: OrchestrationV2TurnItem; x?: { sourceKey?: string } }>): PlanSignal | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const { item, x } = items[i]!;
    const at = item.completedAt ?? item.updatedAt;
    if (item.type === "dynamic_tool" && item.toolName === "EnterPlanMode" && item.status === "completed") return { on: true, at };
    if (item.type === "proposed_plan" && item.status === "completed") return { on: false, at };
    if (item.type === "system_notice" && /plan_mode_exit/.test(x?.sourceKey ?? "")) return { on: false, at };
  }
  return null;
}

/**
 * The mode the footer shows. The server's value (state.permissionMode) is the default; plan mode
 * entered by the model (EnterPlanMode) shows from the items when it is newer than the last change
 * of the server's value this page saw (`stateChangedAt`, epoch ms, null before any).
 */
export function effectivePermissionMode(stateMode: string | undefined, signal: PlanSignal | null, stateChangedAt: number | null): string | undefined {
  if (!signal?.on) return stateMode;
  if (stateChangedAt !== null && Date.parse(signal.at) <= stateChangedAt) return stateMode;
  return "plan";
}

// ---- input footer ----

/** The status line under the mode line: model, context use, folder, branch (what the thread knows). */
export function statusParts(snapshot: ThreadSnapshot | null, cwd: string | null): string[] {
  const parts: string[] = [];
  const model = modelLabel(footerModel(snapshot?.state));
  if (model) parts.push(model);
  const usage = snapshot?.tokenUsage;
  if (usage && usage.usedTokens > 0) {
    const max = contextWindowOf(snapshot?.state, usage);
    parts.push(
      max
        ? `${tokenLabel(usage.usedTokens)}/${tokenLabel(max)} context (${Math.round((usage.usedTokens / max) * 100)}%)`
        : `${tokenLabel(usage.usedTokens)} context`,
    );
  }
  const folder = snapshot?.state.cwd ?? cwd;
  if (folder) parts.push(shortPath(folder));
  // The CLI records "HEAD" outside a git repository (and on a detached head): no branch to show.
  const branch = snapshot?.state.gitBranch;
  if (branch && branch !== "HEAD") parts.push(branch);
  return parts;
}

/** A command's description on one row of the `/` menu: line breaks and runs of spaces become one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The first visible row of a window of `rows` rows that keeps `active` in view. */
export function menuWindowStart(active: number, count: number, rows: number): number {
  return Math.max(0, Math.min(active - rows + 1, count - rows));
}

/** Footer text and color token per permission mode (measured on shift+tab). */
export function permissionModeLabel(mode: string | undefined): { label: string; tone: "bypass" | "accept" | "plan" | "manual" } {
  switch (mode) {
    case "acceptEdits":
      return { label: "⏵⏵ accept edits on", tone: "accept" };
    case "plan":
      return { label: "⏸ plan mode on", tone: "plan" };
    case "default":
      return { label: "⏸ manual mode on", tone: "manual" };
    default:
      return { label: "⏵⏵ bypass permissions on", tone: "bypass" };
  }
}
