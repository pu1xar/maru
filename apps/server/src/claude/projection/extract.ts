// One Claude transcript line -> the facts the projector folds (docs/event-model.md 5.1-5.5).
//
// Everything here depends on the line alone, so a line extracted once gives the same facts
// whichever page it arrived in. What depends on other lines (tool results, run membership, lanes,
// "the first pr-link with this URL") is an op that projector.ts applies in file order.
//
// Each line gets one stats key: the census key of the line (census.py claude_keys, base part)
// followed by the content shape and the table row that classified it (7.11), for example
//   claude|top|type=user|content=str|row=13
//   claude|top|type=assistant|block=tool_use|tool=Bash
//   claude|top|type=attachment|attachment.type=queued_command|origin=human
import type {
  BlobRef,
  ChatAttachment,
  OrchestrationV2ProviderFailure,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemBase,
  OrchestrationV2TurnItemStatus,
  OrchestrationV2UserInputQuestion,
  ProjectionExtension,
  RawRef,
} from "@maru/shared";
import { queuedCommandSendId, userLineSendIds } from "@maru/shared";
import type { RawRecord } from "../../transcript/claudeTranscript.ts";
import { hasOneMillionBeta } from "./claudeModels.ts";
import { goalEventOf, type GoalEvent } from "./goalState.ts";
import {
  classifyClaudeTool,
  claudeToolTitle,
  commandInputFromClaudeTool,
  fileNameFromClaudeTool,
  viewedImagePathFromClaudeTool,
  webSearchPatternsFromClaudeTool,
} from "./claudeTools.ts";
import type { ToolOutput } from "./claudeTools.ts";

export interface ExtractCtx {
  threadId: string;
  kind: "top" | "sub";
  path: string;
  providerInstanceId: string;
  /** `sessionId`, or `sessionId:agent-<agentId>` for a subagent (2.2 providerThreadId). */
  providerThreadId: string;
}

export type Disposition = "displayed" | "hidden" | "unknown";

/** An item as one line describes it. The fold fills runId, providerTurnId, ordinal and x.raw. */
export interface ItemTemplate {
  item: OrchestrationV2TurnItem;
  /** Position inside the line (block index in content), part of the ordinal. */
  slot: number;
  x: Omit<ProjectionExtension, "raw" | "sourceKey">;
  synthetic?: true;
}

export type ToolKind = "subagent" | "workflow" | "ask" | "plan" | "task" | "advisor" | "generic";

export interface HookSummary {
  event: string;
  name?: string;
  exitCode?: number;
  durationMs?: number;
}

export interface StatePatch {
  customTitle?: string;
  agentName?: string;
  aiTitle?: string;
  lastPrompt?: { text: string; leafUuid?: string };
  model?: string;
  /** null: the response ran without an effort level, which clears the last one. */
  effort?: string | null;
  permissionMode?: string;
  mode?: string;
  outputStyle?: string;
  cwd?: string;
}

export interface NotificationTags {
  taskId: string | null;
  toolUseId: string | null;
  outputFile: string | null;
  status: string | null;
  summary: string | null;
  result: string | null;
  /** `<usage>` of a finished agent or workflow: `<subagent_tokens>`, `<tool_uses>`, `<duration_ms>`. */
  usage: NotificationUsage | null;
}

export interface NotificationUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export type Op =
  | { op: "item"; t: ItemTemplate }
  | { op: "tool"; t: ItemTemplate; toolUseId: string; name: string; input: unknown; kind: ToolKind }
  | {
      op: "toolResult";
      toolUseId: string;
      slot: number;
      output: ToolOutput;
      isError: boolean;
      denial: string | null;
      timestamp: string | null;
    }
  | { op: "advisorResult"; toolUseId: string; contentType: string | null }
  | { op: "state"; patch: StatePatch }
  | { op: "goal"; event: GoalEvent }
  | { op: "queue"; operation: string; content: string; t: ItemTemplate | null }
  | { op: "compactSummary"; text: string }
  | { op: "turnDuration"; durationMs: number | null }
  | { op: "stopHook" }
  | { op: "assistantLine" }
  | { op: "interrupt" }
  | { op: "hook"; toolUseId: string; hook: HookSummary }
  | { op: "truncNotice"; toolUseId: string; banner: string }
  | { op: "notify"; t: ItemTemplate; tags: NotificationTags }
  | { op: "taskStatus"; t: ItemTemplate; toolUseId: string | null; taskType: string | null; status: string | null }
  | { op: "retract"; uuids: string[] }
  | { op: "usage"; messageId: string; usage: StepUsage; model: string | null }
  | { op: "cost"; totalCostUsd: number | null; modelUsage: Record<string, unknown> | null }
  | { op: "prLink"; url: string; t: ItemTemplate }
  | { op: "metaImage"; images: unknown[] }
  | { op: "forkCopy"; toolUseId: string }
  | { op: "scheduled"; taskId: string | null; cron: string | null }
  | { op: "structuredOutput"; toolUseId: string; data: unknown }
  /** An `api-request` line: the model and whether the request asked for the 1M context. */
  | { op: "request"; model: string; oneMillion: boolean };

export interface StepUsage {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
  /** `usage.cache_creation` split by TTL (prompt cache clock, promptCache.ts); absent when the line has no split. */
  created?: { fiveMinute: number; oneHour: number };
}

export interface LineFacts {
  offset: number;
  length: number;
  /** Line number the reader knew (null for tail pages). */
  recLine: number | null;
  parseFailure: boolean;
  key: string;
  disposition: Disposition;
  uuid: string | null;
  parentUuid: string | null;
  opener: boolean;
  promptId: string | null;
  timestamp: string | null;
  /** `forkedFrom.sessionId` of a `--fork-session` copy. */
  forkedFrom: string | null;
  cwd: string | null;
  gitBranch: string | null;
  ops: Op[];
}

// ---- small readers ----

type Rec = Record<string, unknown>;

export function rec(value: unknown): Rec | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Text between <name ...> and </name>, or null. */
export function tagText(text: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(text);
  return m === null ? null : m[1]!;
}

export function parseNotification(text: string): NotificationTags {
  const t = (name: string) => {
    const v = tagText(text, name);
    return v === null ? null : v.trim();
  };
  return {
    taskId: t("task-id"),
    toolUseId: t("tool-use-id"),
    outputFile: t("output-file"),
    status: t("status"),
    summary: t("summary"),
    result: tagText(text, "result"),
    usage: notificationUsage(tagText(text, "usage")),
  };
}

function notificationUsage(inner: string | null): NotificationUsage | null {
  if (inner === null) return null;
  const n = (name: string) => {
    const v = tagText(inner, name);
    const parsed = v === null ? NaN : Number(v.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const usage: NotificationUsage = {};
  const totalTokens = n("subagent_tokens");
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  const toolUses = n("tool_uses");
  if (toolUses !== undefined) usage.toolUses = toolUses;
  const durationMs = n("duration_ms");
  if (durationMs !== undefined) usage.durationMs = durationMs;
  return Object.keys(usage).length === 0 ? null : usage;
}

// ---- census key ----

function censusBase(d: Rec): string {
  let base = `type=${String(d.type)}`;
  if ("subtype" in d) base += `|subtype=${String(d.subtype)}`;
  for (const [k, v] of Object.entries(d)) {
    if (k === "message") continue;
    const r = rec(v);
    if (r !== undefined && typeof r.type === "string") base += `|${k}.type=${r.type}`;
  }
  return base;
}

function contentShape(content: unknown): string {
  if (typeof content === "string") return "|content=str";
  if (!Array.isArray(content)) return "|content=none";
  const types: string[] = [];
  const tools: string[] = [];
  for (const b of content) {
    const r = rec(b);
    if (r === undefined) {
      types.push("<nondict>");
      continue;
    }
    types.push(String(r.type));
    if (r.type === "tool_use" || r.type === "server_tool_use") tools.push(String(r.name));
  }
  return `|block=${types.join("+")}${tools.length > 0 ? `|tool=${tools.join("+")}` : ""}`;
}

// ---- blobs ----

function base64Bytes(len: number, data: string): number {
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - pad);
}

type BlobMaker = (jsonPath: string, mediaType: string | undefined, data: string) => BlobRef;

/**
 * A copy of `value` with base64 image data replaced by a BlobRef to the line (5.4 row 1b,
 * 6.2 BlobRef). Image blocks become `{type: "image", mimeType, blob}`, the shape T3 uses for
 * an image whose data is not inline (omitToolOutputImageData).
 */
export function stripBlobs(value: unknown, jsonPath: string, mk: BlobMaker): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((e, i) => {
      const r = stripBlobs(e, `${jsonPath}[${i}]`, mk);
      if (r !== e) changed = true;
      return r;
    });
    return changed ? out : value;
  }
  const r = rec(value);
  if (r === undefined) return value;
  if (r.type === "image") {
    const s = rec(r.source);
    if (s !== undefined && s.type === "base64" && typeof s.data === "string") {
      const mediaType = str(s.media_type);
      return { type: "image", mimeType: mediaType ?? "application/octet-stream", blob: mk(`${jsonPath}.source.data`, mediaType, s.data) };
    }
  }
  let out: Rec | null = null;
  for (const [k, v] of Object.entries(r)) {
    let next: unknown;
    if (k === "base64" && typeof v === "string" && v.length > 0) {
      next = mk(`${jsonPath}.base64`, str(r.type), v);
    } else {
      next = stripBlobs(v, `${jsonPath}.${k}`, mk);
    }
    if (next !== v) {
      out ??= { ...r };
      out[k] = next;
    }
  }
  return out ?? r;
}

// ---- items ----

function baseFields(
  ctx: ExtractCtx,
  id: string,
  status: OrchestrationV2TurnItemStatus,
  ts: string | null,
  nativeId: string | null,
  slot: number,
  title: string | null = null,
): OrchestrationV2TurnItemBase {
  return {
    id,
    threadId: ctx.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: ctx.providerThreadId,
    providerTurnId: null,
    nativeItemRef: nativeId === null ? null : { driver: "claude", nativeId, strength: "strong", ordinal: slot },
    parentItemId: null,
    ordinal: 0,
    status,
    title,
    startedAt: ts,
    completedAt: status === "completed" || status === "failed" ? ts : null,
    updatedAt: ts ?? "",
  };
}

type NoticeLevel = "info" | "warning" | "error";

function notice(
  ctx: ExtractCtx,
  id: string,
  ts: string | null,
  nativeId: string | null,
  message: string,
  level: NoticeLevel,
  x: ItemTemplate["x"] = {},
  title: string | null = null,
  slot = 0,
): ItemTemplate {
  return {
    item: { ...baseFields(ctx, id, "completed", ts, nativeId, slot, title), type: "system_notice", message, level },
    slot,
    x,
  };
}

function unknownNotice(ctx: ExtractCtx, id: string, ts: string | null, nativeId: string | null, slot = 0): ItemTemplate {
  return notice(ctx, id, ts, nativeId, "Unknown record", "info", { unknown: true }, "Unknown record", slot);
}

// ---- tables (docs/event-model.md 5.1-5.3) ----

const HIDDEN_TOP_TYPES = new Set([
  "custom-title", "agent-name", "ai-title", "last-prompt", "mode", "permission-mode", "session-owner",
  "atis-latch", "cost-state", "tools-used", "queue-operation", "file-history-snapshot", "file-history-delta",
  "api-request", "api-request-blob", "api-request-shape", "bridge-session", "history-suppression",
  // workflow journal record types (5.1, sub only); they live in journal.jsonl, read as sidecars
  "launched", "started", "result", "failed",
]);

const HIDDEN_ATTACHMENTS = new Set([
  "advisor_tool", "agent_listing_delta", "auto_mode", "bash_output_audience_note", "batching_reminder_sent",
  "command_permissions", "credential_org", "date", "date_change", "deferred_tools_delta", "deferred_tools_record",
  "dynamic_skill", "environment", "hook_success", "instructions", "mcp_instructions_delta", "model", "output_style",
  "output_style_instructions", "plan_mode", "prompt_snapshot", "remote_session_change", "session_context",
  "session_cron_carry", "silent_turn_reminder", "skill_listing", "task_reminder", "thinking_drop",
  "thinking_stripped", "total_tokens_reminder", "workflow_size_guideline_change",
]);

// ---- run openers (5.4 bold rows, lane_test.py is_opener) ----

const OPEN_META_ORIGINS = new Set(["peer", "coordinator", "task-notification", "auto-continuation"]);
const NON_OPENER_TAGS = ["<local-command-stdout>", "<bash-stdout>", "<local-command-caveat>", "[Request interrupted"];

function joinedText(content: unknown, sep: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((b) => {
      const r = rec(b);
      return r !== undefined && r.type === "text" && typeof r.text === "string" ? [r.text] : [];
    })
    .join(sep);
}

/** lane_test.py is_opener, the definition the 7.3 measurements used. */
export function isOpener(d: Rec): boolean {
  if (d.type !== "user" || d.isCompactSummary === true) return false;
  const content = rec(d.message)?.content;
  if (Array.isArray(content)) {
    const hasResult = content.some((b) => rec(b)?.type === "tool_result");
    if (hasResult) return joinedText(content, " ").includes("<fork-boilerplate>");
  }
  const s = joinedText(content, " ").trimStart();
  if (NON_OPENER_TAGS.some((t) => s.startsWith(t))) return false;
  if (d.isMeta === true) return OPEN_META_ORIGINS.has(String(rec(d.origin)?.kind));
  return true;
}

// ---- main ----

export function extractLine(record: RawRecord, ctx: ExtractCtx): LineFacts {
  const facts: LineFacts = {
    offset: record.offset,
    length: record.length,
    recLine: record.line,
    parseFailure: false,
    key: "",
    disposition: "hidden",
    uuid: null,
    parentUuid: null,
    opener: false,
    promptId: null,
    timestamp: null,
    forkedFrom: null,
    cwd: null,
    gitBranch: null,
    ops: [],
  };
  const v = record.value;
  const d = rec(v);
  if (d === undefined || d.__parseError === true) {
    facts.parseFailure = true;
    facts.key = `claude|${ctx.kind}|<parse-error>`;
    return facts;
  }
  if (typeof d.type !== "string") {
    facts.key = `claude|${ctx.kind}|<no-type>`;
    facts.disposition = "unknown";
    return facts;
  }
  const uuid = str(d.uuid) ?? null;
  const isNode = uuid !== null && (d.type === "user" || d.type === "assistant" || d.type === "attachment" || d.type === "system");
  if (isNode) {
    facts.uuid = uuid;
    facts.parentUuid = str(d.parentUuid) ?? null;
    facts.opener = isOpener(d);
    facts.promptId = str(d.promptId) ?? null;
  }
  facts.timestamp = str(d.timestamp) ?? null;
  facts.forkedFrom = str(rec(d.forkedFrom)?.sessionId) ?? null;
  facts.cwd = str(d.cwd) ?? null;
  facts.gitBranch = str(d.gitBranch) ?? null;
  const prefix = `claude|${ctx.kind}|${censusBase(d)}`;
  const raw: RawRef = { source: "claude-transcript", key: prefix, path: ctx.path, byteOffset: record.offset };
  const mk: BlobMaker = (jsonPath, mediaType, data) => ({
    raw,
    jsonPath,
    ...(mediaType === undefined ? {} : { mediaType }),
    bytes: base64Bytes(data.length, data),
  });
  const lineId = `${ctx.threadId}:off:${record.offset}`;
  const uuidId = uuid === null ? lineId : `${ctx.threadId}:uuid:${uuid}`;
  const L: LineHelpers = { ctx, d, facts, ts: facts.timestamp, uuid, uuidId, lineId, mk, prefix };
  switch (d.type) {
    case "user":
      extractUser(L);
      break;
    case "assistant":
      extractAssistant(L);
      break;
    case "system":
      extractSystem(L);
      break;
    case "attachment":
      extractAttachment(L);
      break;
    default:
      extractOther(L);
  }
  return facts;
}

interface LineHelpers {
  ctx: ExtractCtx;
  d: Rec;
  facts: LineFacts;
  ts: string | null;
  uuid: string | null;
  uuidId: string;
  lineId: string;
  mk: BlobMaker;
  prefix: string;
}

function set(L: LineHelpers, suffix: string, disposition: Disposition): void {
  L.facts.key = L.prefix + suffix;
  L.facts.disposition = disposition;
}

/** A line the tables have no row for: a folded notice when it has a uuid, else a counter (7.11 3). */
function markUnknown(L: LineHelpers, suffix = ""): void {
  set(L, suffix, "unknown");
  if (L.uuid !== null) L.facts.ops.push({ op: "item", t: unknownNotice(L.ctx, L.uuidId, L.ts, L.uuid) });
}

// ---- user (5.4) ----

function extractUser(L: LineHelpers): void {
  const { d, ctx, ts, uuid, uuidId } = L;
  const message = rec(d.message);
  const content = message?.content;
  const shape = contentShape(content);
  const blocks = Array.isArray(content) ? content.map(rec) : [];
  const text = joinedText(content, "\n");
  const s = text.trimStart();
  const isMeta = d.isMeta === true;
  const originKind = str(rec(d.origin)?.kind);
  const row = (r: string, disposition: Disposition) => set(L, `${shape}|row=${r}`, disposition);

  // 1, 1a: tool results
  if (blocks.some((b) => b?.type === "tool_result")) {
    const structured = "toolUseResult" in d ? d.toolUseResult : undefined;
    const denial = str(d.toolDenialKind) ?? null;
    blocks.forEach((b, i) => {
      if (b?.type !== "tool_result") return;
      const toolUseId = str(b.tool_use_id);
      if (toolUseId === undefined) return;
      const jsonPath = `$.message.content[${i}].content`;
      const output: ToolOutput = {
        content: stripBlobs(b.content, jsonPath, L.mk),
        structured: structured === undefined ? undefined : stripBlobs(structured, "$.toolUseResult", L.mk),
      };
      L.facts.ops.push({ op: "toolResult", toolUseId, slot: i, output, isError: b.is_error === true, denial, timestamp: ts });
    });
    const textBlocks = blocks.filter((b) => b?.type === "text");
    if (textBlocks.length > 0) {
      row("1a", "displayed");
      L.facts.ops.push({ op: "item", t: userMessage(L, text, [], "turn_start", "agent", { kind: "system" }, blocks.length) });
    } else {
      row("1", "displayed");
    }
    return;
  }
  // 1b: an image the CLI attached under a tool result; the fold checks the parent line
  if (isMeta && blocks.length > 0 && blocks.every((b) => b?.type === "image")) {
    row("1b", "displayed");
    L.facts.ops.push({ op: "metaImage", images: blocks.map((b, i) => stripBlobs(b, `$.message.content[${i}]`, L.mk)) });
    return;
  }
  // 2: compaction summary
  if (d.isCompactSummary === true) {
    row("2", "displayed");
    L.facts.ops.push({ op: "compactSummary", text });
    return;
  }
  // 3: user interrupt
  const firstText = typeof content === "string" ? content : str(blocks.find((b) => b?.type === "text")?.text) ?? "";
  if (firstText.trimStart().startsWith("[Request interrupted")) {
    row("3", "displayed");
    L.facts.ops.push({
      op: "item",
      t: { item: { ...baseFields(ctx, uuidId, "completed", ts, uuid, 0), type: "run_interrupt_result", message: firstText.trim() }, slot: 0, x: {} },
    });
    L.facts.ops.push({ op: "interrupt" });
    return;
  }
  // 4: task notification (opens a run)
  if (s.startsWith("<task-notification>")) {
    row("4", "displayed");
    L.facts.ops.push({ op: "notify", t: notificationItem(L, uuidId, text), tags: parseNotification(text) });
    return;
  }
  // 5: slash command
  if (s.startsWith("<command-name>") || s.startsWith("<command-message>")) {
    row("5", "displayed");
    let name = (tagText(text, "command-name") ?? tagText(text, "command-message") ?? "").trim();
    if (!name.startsWith("/")) name = `/${name}`;
    const args = (tagText(text, "command-args") ?? "").trim();
    L.facts.ops.push({ op: "item", t: withSendIds(userMessage(L, args.length > 0 ? `${name} ${args}` : name, [], "turn_start", "user", { kind: "human" }), d) });
    return;
  }
  // 6, 8: command output
  if (s.startsWith("<local-command-stdout>") || s.startsWith("<bash-stdout>")) {
    row(s.startsWith("<bash-stdout>") ? "8" : "6", "displayed");
    const body = text.replace(/<\/?(?:local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>/g, "").trim();
    L.facts.ops.push({ op: "item", t: notice(ctx, uuidId, ts, uuid, body, "info", { noticeKind: "command_output" }) });
    return;
  }
  // 7: shell escape
  if (s.startsWith("<bash-input>")) {
    row("7", "displayed");
    const cmd = (tagText(text, "bash-input") ?? "").trim();
    L.facts.ops.push({ op: "item", t: withSendIds(userMessage(L, `!${cmd}`, [], "turn_start", "user", { kind: "human" }), d) });
    return;
  }
  if (isMeta) {
    // 9: message from another agent or session
    if (originKind === "peer" || originKind === "coordinator") {
      row("9", "displayed");
      // The CLI records the sender and the bare message on `origin` (2.1.326: kind, from, name, body);
      // the text is that body wrapped as "Another Claude session sent a message:\n<agent-message
      // from=...>...</agent-message>" for the model. The wrapper is the fallback for lines without them.
      const o = rec(d.origin);
      const m = /<(agent-message|cross-session-message)\b([^>]*)>([\s\S]*?)<\/\1>/.exec(text);
      const from = str(o?.from) ?? (m === null ? undefined : (/\bfrom(?:-name)?="([^"]*)"/.exec(m[2]!)?.[1] ?? undefined));
      const name = str(o?.name);
      const body = str(o?.body)?.trim() || (m === null ? text : m[3]!.trim());
      L.facts.ops.push({
        op: "item",
        t: userMessage(L, body, [], "turn_start", "agent", {
          kind: originKind,
          ...(from === undefined ? {} : { from }),
          ...(name === undefined ? {} : { name }),
        }),
      });
      return;
    }
    // 10: task notification delivered as a meta line (subagents)
    if (originKind === "task-notification") {
      row("10", "displayed");
      L.facts.ops.push({ op: "notify", t: notificationItem(L, uuidId, text), tags: parseNotification(text) });
      return;
    }
    // 11: auto-continuation
    if (originKind === "auto-continuation") {
      row("11", "displayed");
      L.facts.ops.push({
        op: "item",
        t: notice(ctx, uuidId, ts, uuid, text.trim(), "info", { origin: { kind: "auto_continuation" } }),
      });
      return;
    }
    // 12: system reminders, skill bodies, caveats
    row("12", "hidden");
    return;
  }
  // 13: a prompt
  row("13", "displayed");
  const attachments: ChatAttachment[] = [];
  const blobs: Record<string, BlobRef> = {};
  blocks.forEach((b, i) => {
    if (b === undefined || b.type === "text") return;
    const attId = `${uuidId}:att:${i}`;
    const source = rec(b.source);
    const data = str(source?.data);
    const mimeType = str(source?.media_type) ?? "application/octet-stream";
    attachments.push({
      type: String(b.type),
      id: attId,
      name: `${String(b.type)}-${i + 1}`,
      mimeType,
      sizeBytes: data === undefined ? 0 : base64Bytes(data.length, data),
    });
    if (data !== undefined) blobs[attId] = L.mk(`$.message.content[${i}].source.data`, mimeType, data);
  });
  const origin = originOf(d, ctx);
  const createdBy = ctx.kind === "sub" ? "agent" : "user";
  const t = userMessage(L, text, attachments, "turn_start", createdBy, origin);
  // The CLI writes a sent prompt under the uuid it was sent with (DESIGN.md 4.3, 4.4).
  // Messages the CLI folded into this one line (`mergedSendUuids`) were sent with their own uuids; the
  // row names them too, so each of those sends settles on this row.
  L.facts.ops.push({ op: "item", t: withSendIds(t, d, Object.keys(blobs).length > 0 ? { attachmentBlobs: blobs } : {}) });
}

/**
 * Names on the row the sends its transcript line delivered (`x.data.clientId`, `mergedClientIds`),
 * so the waiting message of that send leaves the list when the row arrives (DESIGN.md 4.4). Every
 * user line the CLI writes for a send carries it: a prompt, and also a slash command (`/goal`,
 * written as `<command-name>` text under the uuid it was sent with) and a `!` shell escape.
 */
function withSendIds(t: ItemTemplate, d: Rec, extra: Record<string, unknown> = {}): ItemTemplate {
  const sent = userLineSendIds(d);
  const data: Record<string, unknown> = {
    ...(sent.id !== null ? { clientId: sent.id } : {}),
    ...(sent.merged.length > 0 ? { mergedClientIds: sent.merged } : {}),
    ...extra,
  };
  return Object.keys(data).length > 0 ? { ...t, x: { ...t.x, data } } : t;
}

function originOf(d: Rec, ctx: ExtractCtx): NonNullable<ProjectionExtension["origin"]> {
  const kind = str(rec(d.origin)?.kind);
  if (kind === "human" || kind === undefined) {
    const entry = str(d.entrypoint) ?? "";
    if (ctx.kind === "sub") return { kind: "system" };
    return { kind: entry.startsWith("sdk") ? "sdk" : "human" };
  }
  switch (kind) {
    case "peer":
    case "coordinator":
      return { kind };
    case "task-notification":
      return { kind: "task_notification" };
    case "auto-continuation":
      return { kind: "auto_continuation" };
    default:
      return { kind: "system" };
  }
}

function userMessage(
  L: LineHelpers,
  text: string,
  attachments: ChatAttachment[],
  inputIntent: "turn_start" | "steer" | "queued_turn",
  createdBy: "user" | "agent" | "system",
  origin: NonNullable<ProjectionExtension["origin"]>,
  slot = 0,
  id = L.uuidId,
): ItemTemplate {
  return {
    item: {
      ...baseFields(L.ctx, id, inputIntent === "queued_turn" ? "pending" : "completed", L.ts, L.uuid, slot),
      type: "user_message",
      createdBy,
      creationSource: "provider",
      messageId: id,
      inputIntent,
      text,
      attachments,
    },
    slot,
    x: { origin },
  };
}

function notificationItem(L: LineHelpers, id: string, text: string): ItemTemplate {
  const tags = parseNotification(text);
  const summary = tags.summary ?? text.trim().split("\n")[0] ?? "";
  const item: OrchestrationV2TurnItem = {
    ...baseFields(L.ctx, id, "completed", L.ts, L.uuid, 0),
    type: "notification",
    source: { kind: "background_task" },
    outcome: notificationOutcome(tags.status),
    summary,
    ...(tags.result === null ? {} : { detail: tags.result }),
  };
  return { item, slot: 0, x: { origin: { kind: "task_notification", ...(tags.taskId === null ? {} : { taskId: tags.taskId }) } } };
}

export function notificationOutcome(status: string | null): "completed" | "failed" | "cancelled" | "updated" | "unknown" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "killed":
    case "stopped":
    case "cancelled":
      return "cancelled";
    case "running":
      return "updated";
    default:
      return "unknown";
  }
}

// ---- assistant (5.5) ----

function stepUsage(u: Rec | undefined): StepUsage | null {
  if (u === undefined) return null;
  const split = rec(u.cache_creation);
  return {
    input: num(u.input_tokens) ?? 0,
    cacheRead: num(u.cache_read_input_tokens) ?? 0,
    cacheCreation: num(u.cache_creation_input_tokens) ?? 0,
    output: num(u.output_tokens) ?? 0,
    ...(split === undefined ? {} : { created: { fiveMinute: num(split.ephemeral_5m_input_tokens) ?? 0, oneHour: num(split.ephemeral_1h_input_tokens) ?? 0 } }),
  };
}

function extractAssistant(L: LineHelpers): void {
  const { d, ctx, ts, uuid, uuidId } = L;
  const message = rec(d.message);
  const content = message?.content;
  const shape = contentShape(content);
  const model = str(message?.model) ?? null;
  const synthetic = model === "<synthetic>";
  const messageId = str(message?.id) ?? null;
  const apiBlockIndex = num(d.apiBlockIndex);
  const blocks = Array.isArray(content) ? content : [];
  L.facts.ops.push({ op: "assistantLine" });

  // Fork subagent: line 2 copies the parent's Agent call (7.7 fork 2); the child hides it.
  if (ctx.kind === "sub" && L.facts.parentUuid === null && blocks.length === 1) {
    const b = rec(blocks[0]);
    if (b?.type === "tool_use" && b.name === "Agent" && typeof b.id === "string") {
      set(L, `${shape}|forkCopy`, "hidden");
      L.facts.ops.push({ op: "forkCopy", toolUseId: b.id });
      return;
    }
  }

  let anyUnknown = false;
  blocks.forEach((raw, i) => {
    const b = rec(raw);
    const blockIndex = apiBlockIndex === undefined ? i : apiBlockIndex + i;
    const blkId =
      messageId !== null && apiBlockIndex !== undefined ? `${ctx.threadId}:blk:${messageId}:${blockIndex}` : i === 0 ? uuidId : `${uuidId}:${i}`;
    switch (b?.type) {
      case "text": {
        const text = str(b.text) ?? "";
        if (synthetic) {
          L.facts.ops.push({ op: "item", t: syntheticItem(L, blkId, text, i) });
        } else {
          L.facts.ops.push({
            op: "item",
            t: {
              item: {
                ...baseFields(ctx, blkId, "completed", ts, uuid, blockIndex),
                type: "assistant_message",
                messageId: blkId,
                text,
                streaming: false,
                ...(model === null ? {} : { model }),
              },
              slot: i,
              x: {},
            },
          });
        }
        break;
      }
      case "thinking": {
        const durationMs = num(d.thinkingDurationMs);
        L.facts.ops.push({
          op: "item",
          t: {
            item: { ...baseFields(ctx, blkId, "completed", ts, uuid, blockIndex), type: "reasoning", text: str(b.thinking) ?? "", streaming: false },
            slot: i,
            x: durationMs === undefined ? {} : { durationMs },
          },
        });
        break;
      }
      case "tool_use":
      case "server_tool_use": {
        const toolUseId = str(b.id);
        const name = str(b.name) ?? "";
        if (toolUseId === undefined) {
          anyUnknown = true;
          L.facts.ops.push({ op: "item", t: unknownNotice(ctx, blkId, ts, uuid, i) });
          break;
        }
        L.facts.ops.push(toolOp(L, toolUseId, name, b.input, i, blockIndex, b.type === "server_tool_use"));
        break;
      }
      case "advisor_tool_result": {
        const toolUseId = str(b.tool_use_id);
        if (toolUseId !== undefined) L.facts.ops.push({ op: "advisorResult", toolUseId, contentType: str(rec(b.content)?.type) ?? null });
        break;
      }
      case "fallback": {
        const from = str(rec(b.from)?.model) ?? "?";
        const to = str(rec(b.to)?.model) ?? "?";
        L.facts.ops.push({
          op: "item",
          t: notice(ctx, blkId, ts, uuid, `Model fallback: ${from} -> ${to}`, "warning", { data: { from, to, stopDetails: message?.stop_details ?? null } }, null, i),
        });
        break;
      }
      default:
        anyUnknown = true;
        L.facts.ops.push({ op: "item", t: unknownNotice(ctx, blkId, ts, uuid, i) });
    }
  });
  set(L, shape + (synthetic ? "|synthetic" : ""), anyUnknown ? "unknown" : "displayed");
  const usage = stepUsage(rec(message?.usage));
  if (!synthetic && messageId !== null && usage !== null) L.facts.ops.push({ op: "usage", messageId, usage, model });
  if (!synthetic && model !== null) {
    // `effort` sits on the line (CLI 2.1.3xx) when the model took the effort parameter; a response
    // without it clears the previous model's value.
    L.facts.ops.push({ op: "state", patch: { model, effort: str(d.effort) ?? null } });
  }
}

/** `message.model == '<synthetic>'` (5.5 synthetic table). */
function syntheticItem(L: LineHelpers, id: string, text: string, slot: number): ItemTemplate {
  const { d, ctx, ts, uuid } = L;
  if (d.isApiErrorMessage !== true) {
    return notice(ctx, id, ts, uuid, text, "info", {}, null, slot);
  }
  const error = str(d.error) ?? "unknown";
  let failure: OrchestrationV2ProviderFailure;
  switch (error) {
    case "rate_limit": {
      const resetsAt = num(rec(d.quotaLimits)?.resetsAt);
      failure = {
        class: "usage_limit",
        message: text,
        code: error,
        retryable: null,
        resetAt: resetsAt === undefined ? null : new Date(resetsAt * 1000).toISOString(),
      };
      break;
    }
    case "authentication_failed":
    case "oauth_org_not_allowed":
      failure = { class: "permission_error", message: text, code: error, retryable: null };
      break;
    case "server_error":
      failure = {
        class: /mid-response|stopped arriving/i.test(text) ? "transport_error" : "provider_error",
        message: text,
        code: error,
        retryable: null,
      };
      break;
    case "invalid_request":
      failure = /safeguards/i.test(text)
        ? { class: "provider_error", message: text, code: "refusal", retryable: false }
        : { class: "validation_error", message: text, code: error, retryable: null };
      break;
    default:
      failure = { class: "unknown", message: text, code: error, retryable: null };
  }
  return { item: { ...baseFields(ctx, id, "failed", ts, uuid, slot), type: "error", failure }, slot, x: {} };
}

function toolOp(L: LineHelpers, toolUseId: string, name: string, input: unknown, slot: number, blockIndex: number, server: boolean): Op {
  const { ctx, ts } = L;
  const id = `${ctx.threadId}:tool:${toolUseId}`;
  const base = baseFields(ctx, id, "running", ts, toolUseId, blockIndex, null);
  const inRec = rec(input);
  let item: OrchestrationV2TurnItem;
  let kind: ToolKind = "generic";
  const x: ItemTemplate["x"] = {};
  if (server) {
    kind = "advisor";
    item = { ...base, type: "dynamic_tool", toolName: name, input };
  } else if (name === "Agent" || name === "Workflow") {
    kind = name === "Agent" ? "subagent" : "workflow";
    const description = str(inRec?.description) ?? null;
    item = {
      ...base,
      status: "pending",
      title: description ?? (name === "Workflow" ? "Workflow" : null),
      type: "subagent",
      subagentId: id,
      origin: "provider_native",
      driver: "claude",
      providerInstanceId: ctx.providerInstanceId,
      childThreadId: null,
      prompt: str(inRec?.prompt) ?? "",
      result: null,
    };
    if (name === "Workflow") {
      const script = str(inRec?.script);
      if (script !== undefined) x.body = script;
    }
  } else if (name === "AskUserQuestion") {
    kind = "ask";
    const questions: OrchestrationV2UserInputQuestion[] = arr(inRec?.questions).map((q, i) => {
      const r = rec(q);
      const options = arr(r?.options).map((o) => {
        const or = rec(o);
        return { label: str(or?.label) ?? "", description: str(or?.description) ?? "" };
      });
      return {
        id: String(i),
        header: str(r?.header) ?? "",
        question: str(r?.question) ?? "",
        options,
        ...(typeof r?.multiSelect === "boolean" ? { multiSelect: r.multiSelect } : {}),
        allowCustomAnswer: true,
      };
    });
    item = { ...base, status: "waiting", type: "user_input_request", requestId: id, questions };
  } else if (name === "ExitPlanMode") {
    kind = "plan";
    item = { ...base, type: "proposed_plan", planId: id, markdown: str(inRec?.plan) ?? "", streaming: false };
  } else {
    if (name === "TaskCreate" || name === "TaskUpdate" || name === "TaskList") kind = "task";
    const type = classifyClaudeTool(name);
    const title = claudeToolTitle(name, input);
    if (type === "command_execution") {
      item = { ...base, title, type, input: commandInputFromClaudeTool(name, input) };
      const description = str(inRec?.description);
      const background = inRec?.run_in_background === true || inRec?.run_in_background === "true";
      if (description !== undefined || background) {
        x.data = { ...(description === undefined ? {} : { description }), ...(background ? { runInBackground: true } : {}) };
      }
    } else if (type === "file_change") {
      item = { ...base, title, type, fileName: fileNameFromClaudeTool(name, input) };
      // The result's create/update says what happened to the file, not which tool did it (a Write
      // over an existing file records "update").
      x.data = { toolName: name };
    } else if (type === "web_search") {
      const patterns = webSearchPatternsFromClaudeTool(input, null);
      item = { ...base, title, type, ...(patterns.length === 0 ? {} : { patterns }) };
    } else {
      const viewedImagePath = viewedImagePathFromClaudeTool(name, input);
      item = { ...base, title, type: "dynamic_tool", toolName: name, input, ...(viewedImagePath === undefined ? {} : { viewedImagePath }) };
    }
  }
  return { op: "tool", t: { item, slot, x }, toolUseId, name, input, kind };
}

// ---- system (5.2) ----

function extractSystem(L: LineHelpers): void {
  const { d, ctx, ts, uuid, uuidId } = L;
  const subtype = str(d.subtype);
  const content = str(d.content) ?? "";
  const push = (t: ItemTemplate) => L.facts.ops.push({ op: "item", t });
  switch (subtype) {
    case "compact_boundary": {
      set(L, "", "displayed");
      const meta = rec(d.compactMetadata);
      const preserved = rec(meta?.preservedMessages)?.allUuids;
      const compaction: NonNullable<ProjectionExtension["compaction"]> = {};
      const trigger = str(meta?.trigger);
      if (trigger !== undefined) compaction.trigger = trigger;
      const durationMs = num(meta?.durationMs);
      if (durationMs !== undefined) compaction.durationMs = durationMs;
      const logicalParentUuid = str(d.logicalParentUuid);
      if (logicalParentUuid !== undefined) compaction.logicalParentUuid = logicalParentUuid;
      if (Array.isArray(preserved)) compaction.preservedUuids = preserved.filter((u): u is string => typeof u === "string");
      const before = num(meta?.preTokens);
      const after = num(meta?.postTokens);
      push({
        item: {
          ...baseFields(ctx, uuidId, "completed", ts, uuid, 0),
          type: "compaction",
          driver: "claude",
          ...(before === undefined ? {} : { beforeTokenCount: before }),
          ...(after === undefined ? {} : { afterTokenCount: after }),
        },
        slot: 0,
        x: { compaction },
      });
      return;
    }
    case "informational":
      set(L, "", "displayed");
      push(notice(ctx, uuidId, ts, uuid, content, d.level === "notice" ? "warning" : "info"));
      return;
    case "model_refusal_fallback": {
      set(L, "", "displayed");
      push(
        notice(ctx, uuidId, ts, uuid, content, "warning", {
          noticeKind: "refusal",
          data: { originalModel: d.originalModel ?? null, fallbackModel: d.fallbackModel ?? null, apiRefusalCategory: d.apiRefusalCategory ?? null },
        }),
      );
      const retracted = Array.isArray(d.retractedMessageUuids) ? d.retractedMessageUuids.filter((u): u is string => typeof u === "string") : [];
      if (retracted.length > 0) L.facts.ops.push({ op: "retract", uuids: retracted });
      return;
    }
    case "model_refusal_no_fallback": {
      set(L, "", "displayed");
      const category = str(d.apiRefusalCategory) ?? "unknown";
      push({
        item: {
          ...baseFields(ctx, uuidId, "failed", ts, uuid, 0),
          type: "error",
          failure: { class: "provider_error", message: str(d.apiRefusalExplanation) ?? content, code: `refusal:${category}`, retryable: false },
        },
        slot: 0,
        x: { noticeKind: "refusal" },
      });
      return;
    }
    case "scheduled_task_fire": {
      set(L, "", "displayed");
      const taskId = str(d.taskId) ?? null;
      const cron = str(d.cron) ?? null;
      push(
        notice(ctx, uuidId, ts, uuid, content, "info", {
          origin: { kind: "scheduled", ...(taskId === null ? {} : { taskId }), ...(cron === null ? {} : { cron }) },
          data: { prompt: d.prompt ?? null },
        }),
      );
      L.facts.ops.push({ op: "scheduled", taskId, cron });
      return;
    }
    case "agents_killed":
      set(L, "", "displayed");
      push(notice(ctx, uuidId, ts, uuid, "All background agents stopped", "warning"));
      return;
    case "local_command":
      set(L, "", "displayed");
      push(
        notice(ctx, uuidId, ts, uuid, content.replace(/<\/?(?:local-command-stdout|local-command-stderr)>/g, "").trim(), "info", {
          noticeKind: "command_output",
          data: { commandRun: d.commandRun ?? null },
        }),
      );
      return;
    case "away_summary":
      set(L, "", "displayed");
      push(notice(ctx, uuidId, ts, uuid, content, "info"));
      return;
    case "bridge_status": {
      set(L, "", "displayed");
      const url = str(d.url);
      push(notice(ctx, uuidId, ts, uuid, content, "info", { noticeKind: "link", ...(url === undefined ? {} : { link: { url } }) }));
      return;
    }
    case "turn_duration":
      set(L, "", "hidden");
      L.facts.ops.push({ op: "turnDuration", durationMs: num(d.durationMs) ?? null });
      return;
    case "stop_hook_summary": {
      L.facts.ops.push({ op: "stopHook" });
      const errors = Array.isArray(d.hookErrors) ? d.hookErrors : [];
      if (errors.length > 0 || d.preventedContinuation === true) {
        set(L, "|hookErrors", "displayed");
        const reason = str(d.stopReason) ?? "";
        const message = [reason, ...errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e)))].filter((s) => s.length > 0).join("\n");
        push(notice(ctx, uuidId, ts, uuid, message.length > 0 ? message : "Stop hook", "warning", { noticeKind: "hook", data: { hookErrors: errors } }, "Stop hook"));
      } else {
        set(L, "", "hidden");
      }
      return;
    }
    default:
      markUnknown(L);
  }
}

// ---- attachment (5.3) ----

function extractAttachment(L: LineHelpers): void {
  const { d, ctx, ts, uuid, uuidId } = L;
  const a = rec(d.attachment) ?? {};
  const type = str(a.type) ?? "";
  const push = (t: ItemTemplate) => L.facts.ops.push({ op: "item", t });
  const info = (message: string, x: ItemTemplate["x"] = {}, title: string | null = null, level: NoticeLevel = "info") =>
    push(notice(ctx, uuidId, ts, uuid, message, level, x, title));
  if (HIDDEN_ATTACHMENTS.has(type)) {
    set(L, "", "hidden");
    switch (type) {
      case "environment": {
        const cwd = str(rec(a.snapshot)?.workingDirectory);
        if (cwd !== undefined) L.facts.ops.push({ op: "state", patch: { cwd } });
        break;
      }
      case "model": {
        const model = str(rec(a.identity)?.modelId);
        if (model !== undefined) L.facts.ops.push({ op: "state", patch: { model } });
        break;
      }
      case "output_style": {
        const outputStyle = str(a.style);
        if (outputStyle !== undefined) L.facts.ops.push({ op: "state", patch: { outputStyle } });
        break;
      }
      case "plan_mode":
        L.facts.ops.push({ op: "state", patch: { mode: "plan" } });
        break;
      case "hook_success": {
        const toolUseId = str(a.toolUseID);
        if (toolUseId !== undefined) {
          const hook: HookSummary = { event: str(a.hookEvent) ?? "" };
          const name = str(a.hookName);
          if (name !== undefined) hook.name = name;
          const exitCode = num(a.exitCode);
          if (exitCode !== undefined) hook.exitCode = exitCode;
          const durationMs = num(a.durationMs);
          if (durationMs !== undefined) hook.durationMs = durationMs;
          L.facts.ops.push({ op: "hook", toolUseId, hook });
        }
        break;
      }
    }
    return;
  }
  switch (type) {
    case "goal_status": {
      // A sentinel marks the goal for a later resume and the CLI draws nothing for it. The rest is
      // one row: achieved, could not be achieved (failed), or not met yet. The row's text is the
      // state and the condition; the evaluator's reason, often paragraphs, is the folded body
      // (2.1.325 bundle, goal_status in the attachment renderer).
      const goalEvent = goalEventOf(a, L.facts.timestamp, L.facts.offset);
      if (goalEvent !== null) L.facts.ops.push({ op: "goal", event: goalEvent });
      if (a.sentinel === true) {
        set(L, "|sentinel", "hidden");
        return;
      }
      set(L, "", "displayed");
      const met = a.met === true;
      const failed = !met && a.failed === true;
      const condition = str(a.condition) ?? "";
      const reason = str(a.reason) ?? "";
      info(`${met ? "Goal met" : failed ? "Goal cannot be met" : "Goal not met"}: ${condition}`, {
        noticeKind: "goal",
        ...(reason.length > 0 ? { body: reason } : {}),
        data: { condition, met, failed, reason, iterations: a.iterations ?? null, durationMs: a.durationMs ?? null, tokens: a.tokens ?? null },
      }, null, failed ? "error" : "info");
      return;
    }
    case "hook_blocking_error":
      set(L, "", "displayed");
      info(str(rec(a.blockingError)?.blockingError) ?? "", { noticeKind: "hook" }, str(a.hookName) ?? null, "error");
      return;
    case "hook_system_message":
      set(L, "", "displayed");
      info(str(a.content) ?? "", { noticeKind: "hook" }, str(a.hookName) ?? null);
      return;
    case "queued_command": {
      const origin = rec(a.origin);
      const originKind = str(origin?.kind) ?? (a.commandMode === "task-notification" ? "task-notification" : "none");
      set(L, `|origin=${originKind}`, "displayed");
      const prompt = a.prompt;
      const text = typeof prompt === "string" ? prompt : joinedText(prompt, "\n");
      if (originKind === "task-notification") {
        L.facts.ops.push({ op: "notify", t: notificationItem(L, uuidId, text), tags: parseNotification(text) });
      } else if (originKind === "auto-continuation") {
        info(text, { origin: { kind: "auto_continuation" } });
      } else {
        const createdBy = originKind === "human" ? "user" : originKind === "peer" || originKind === "coordinator" ? "agent" : "system";
        const x: NonNullable<ProjectionExtension["origin"]> =
          originKind === "human" ? { kind: "human" } : originKind === "peer" || originKind === "coordinator" ? { kind: originKind } : { kind: "system" };
        const t = userMessage(L, text, [], "steer", createdBy, x);
        // A message folded in between tool rounds names the uuid it was sent with (DESIGN.md 4.4).
        const sourceUuid = queuedCommandSendId(a);
        if (sourceUuid !== null) t.x = { ...t.x, data: { clientId: sourceUuid } };
        push(t);
      }
      return;
    }
    case "compact_file_reference":
    case "file":
      set(L, "", "displayed");
      info(str(a.displayPath) ?? str(a.filename) ?? "", { noticeKind: "context" });
      return;
    case "nested_memory":
      set(L, "", "displayed");
      info(str(a.displayPath) ?? str(a.path) ?? "", { noticeKind: "context" });
      return;
    case "diagnostics": {
      set(L, "", "displayed");
      const files = Array.isArray(a.files) ? a.files : [];
      let count = 0;
      let worst: NoticeLevel = "info";
      const parts: string[] = [];
      for (const f of files) {
        const fr = rec(f);
        const diags = arr(fr?.diagnostics);
        count += diags.length;
        for (const dg of diags) {
          const sev = str(rec(dg)?.severity);
          if (sev === "Error" || sev === "Warning") worst = "warning";
        }
        const uri = str(fr?.uri) ?? "";
        parts.push(`${uri.split("/").at(-1) ?? uri}: ${diags.length}`);
      }
      info(`Diagnostics: ${count} (${parts.join(", ")})`, { noticeKind: "context", data: { files } }, null, worst);
      return;
    }
    case "edited_text_file": {
      set(L, "", "displayed");
      const fileName = str(a.filename) ?? "";
      push({
        item: { ...baseFields(ctx, uuidId, "completed", ts, uuid, 0, "Changed outside the editor"), type: "file_change", fileName, diffStr: str(a.snippet) ?? "" },
        slot: 0,
        x: {},
      });
      return;
    }
    case "hook_additional_context": {
      set(L, "", "displayed");
      const c = a.content;
      const message = Array.isArray(c) ? c.filter((s): s is string => typeof s === "string").join("\n") : (str(c) ?? "");
      info(message, { noticeKind: "hook" }, str(a.hookName) ?? null);
      return;
    }
    case "hook_cancelled":
      set(L, "", "displayed");
      info(str(a.hookName) ?? "", { noticeKind: "hook" }, null, "warning");
      return;
    case "hook_non_blocking_error":
      set(L, "", "displayed");
      info(str(a.stderr) ?? "", { noticeKind: "hook", data: { exitCode: a.exitCode ?? null } }, str(a.hookName) ?? null, "warning");
      return;
    case "invoked_skills": {
      set(L, "", "displayed");
      const skills = Array.isArray(a.skills) ? a.skills : [];
      info(skills.map((s) => str(rec(s)?.name) ?? "").filter((s) => s.length > 0).join(", "), { noticeKind: "context" });
      return;
    }
    case "plan_file_reference": {
      set(L, "", "displayed");
      const body = str(a.planContent);
      info(str(a.planFilePath) ?? "", { noticeKind: "mode", ...(body === undefined ? {} : { body }) });
      return;
    }
    case "plan_mode_exit":
      set(L, "", "displayed");
      info(str(a.planFilePath) ?? "", { noticeKind: "mode" });
      return;
    case "read_truncation_notice": {
      set(L, "", "displayed");
      const toolUseId = str(a.toolUseID);
      if (toolUseId !== undefined) L.facts.ops.push({ op: "truncNotice", toolUseId, banner: str(a.banner) ?? "" });
      return;
    }
    case "structured_output": {
      set(L, "", "displayed");
      const toolUseId = str(a.toolUseID);
      if (toolUseId !== undefined) L.facts.ops.push({ op: "structuredOutput", toolUseId, data: a.data });
      return;
    }
    case "task_status": {
      set(L, "", "displayed");
      const taskType = str(a.taskType) ?? null;
      const status = str(a.status) ?? null;
      const toolUseId = str(rec(a.shell)?.toolUseId) ?? str(a.toolUseId) ?? null;
      const item: OrchestrationV2TurnItem = {
        ...baseFields(ctx, uuidId, "completed", ts, uuid, 0),
        type: "notification",
        source: taskType === "local_agent" ? { kind: "subagent" } : taskType === "local_bash" ? { kind: "command" } : { kind: "background_task" },
        outcome: status === "completed" ? "completed" : status === "failed" ? "failed" : status === "killed" ? "cancelled" : "updated",
        summary: str(a.description) ?? "",
      };
      const deltaSummary = str(a.deltaSummary);
      if (deltaSummary !== undefined) item.detail = deltaSummary;
      L.facts.ops.push({
        op: "taskStatus",
        t: { item, slot: 0, x: toolUseId === null ? {} : { relatedCallId: toolUseId } },
        toolUseId,
        taskType,
        status,
      });
      return;
    }
    default:
      markUnknown(L);
  }
}

// ---- uuid-less record types (5.1) ----

function extractOther(L: LineHelpers): void {
  const { d, ctx, ts, lineId } = L;
  const type = String(d.type);
  if (HIDDEN_TOP_TYPES.has(type)) {
    set(L, "", "hidden");
    switch (type) {
      case "custom-title": {
        const v = str(d.customTitle);
        if (v !== undefined) L.facts.ops.push({ op: "state", patch: { customTitle: v } });
        break;
      }
      case "agent-name": {
        const v = str(d.agentName);
        if (v !== undefined) L.facts.ops.push({ op: "state", patch: { agentName: v } });
        break;
      }
      case "ai-title": {
        const v = str(d.aiTitle);
        if (v !== undefined) L.facts.ops.push({ op: "state", patch: { aiTitle: v } });
        break;
      }
      case "last-prompt": {
        const text = str(d.lastPrompt);
        if (text !== undefined) {
          const leafUuid = str(d.leafUuid);
          L.facts.ops.push({ op: "state", patch: { lastPrompt: { text, ...(leafUuid === undefined ? {} : { leafUuid }) } } });
        }
        break;
      }
      case "mode": {
        const v = str(d.mode);
        if (v !== undefined) L.facts.ops.push({ op: "state", patch: { mode: v } });
        break;
      }
      case "permission-mode": {
        const v = str(d.permissionMode);
        if (v !== undefined) L.facts.ops.push({ op: "state", patch: { permissionMode: v } });
        break;
      }
      case "cost-state":
        L.facts.ops.push({ op: "cost", totalCostUsd: num(d.totalCostUSD) ?? null, modelUsage: rec(d.modelUsage) ?? null });
        break;
      case "api-request": {
        const params = rec(d.params);
        const model = str(params?.model);
        if (model !== undefined) L.facts.ops.push({ op: "request", model, oneMillion: hasOneMillionBeta(params?.betas) });
        break;
      }
      case "queue-operation": {
        const operation = str(d.operation) ?? "";
        const content = str(d.content) ?? "";
        const id = `${ctx.threadId}:syn:queue:${L.facts.offset}`;
        const t =
          operation === "enqueue"
            ? userMessage(
                L,
                content,
                [],
                "queued_turn",
                content.trimStart().startsWith("<task-notification>") ? "system" : "user",
                content.trimStart().startsWith("<task-notification>") ? { kind: "task_notification" } : { kind: "human" },
                0,
                id,
              )
            : null;
        if (t !== null) t.synthetic = true;
        L.facts.ops.push({ op: "queue", operation, content, t });
        break;
      }
    }
    return;
  }
  switch (type) {
    case "continued-in": {
      set(L, "", "displayed");
      const sid = str(d.continuedInSessionId);
      const threadId = sid === undefined ? undefined : siblingThreadId(ctx.threadId, sid);
      L.facts.ops.push({
        op: "item",
        t: notice(ctx, lineId, ts, null, "Continued from another session", "info", {
          noticeKind: "link",
          ...(threadId === undefined ? {} : { link: { threadId } }),
        }),
      });
      return;
    }
    case "pr-link": {
      set(L, "", "displayed");
      const url = str(d.prUrl) ?? "";
      const n = num(d.prNumber);
      const repo = str(d.prRepository) ?? "";
      L.facts.ops.push({
        op: "prLink",
        url,
        t: notice(ctx, `${ctx.threadId}:pr:${url}`, ts, null, `PR${n === undefined ? "" : ` #${n}`}${repo.length > 0 ? ` ${repo}` : ""}`, "info", {
          noticeKind: "link",
          link: { url },
          data: { prNumber: d.prNumber ?? null, prRepository: d.prRepository ?? null },
        }),
      });
      return;
    }
    case "frame-link": {
      set(L, "", "displayed");
      const url = str(d.frameUrl);
      L.facts.ops.push({
        op: "item",
        t: notice(ctx, lineId, ts, null, str(d.path) ?? url ?? "", "info", { noticeKind: "link", ...(url === undefined ? {} : { link: { url } }) }),
      });
      return;
    }
    case "fork-context-ref": {
      set(L, "", "displayed");
      const until = str(d.parentLastUuid);
      const t = notice(ctx, lineId, ts, null, "Inherited parent context", "info", {
        noticeKind: "context",
        ...(until === undefined ? {} : { inheritsContextUntil: until }),
        data: { parentSessionId: d.parentSessionId ?? null, contextLength: d.contextLength ?? null },
      });
      t.synthetic = true;
      L.facts.ops.push({ op: "item", t });
      return;
    }
    default:
      markUnknown(L);
  }
}

/** `claude:<account>:<sid>` of another session of the same account. */
export function siblingThreadId(threadId: string, sessionId: string): string {
  const parts = threadId.split(":");
  return `${parts[0]}:${parts[1]}:${sessionId}`;
}
