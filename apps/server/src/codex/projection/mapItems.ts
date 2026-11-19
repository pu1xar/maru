// Codex ThreadItem (app-server v2) → T3 turn items (docs/event-model.md 5.8, 3, 7.4).
//
// One ThreadItem becomes zero, one or two rows. Every item gets a statistics key and a
// disposition: displayed (shown or collapsed), hidden (no row; it may update subagent state) or
// unknown (a type this table does not know, shown as a collapsed system_notice with x.unknown).
//
// Render hints from the official Codex client (docs/ref-codex-official.md 2.1) take precedence
// over the "schema only" rows of event-model 5.8:
// - reasoning shows the summary; the raw content goes to x.body
// - sleep, enteredReviewMode and exitedReviewMode are hidden
// - commandExecution keeps its parsed commandActions (x.data) and titles exploration commands

import type {
  ChatAttachment,
  IsoDateTime,
  OrchestrationV2FileChangeDetail,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemBase,
  OrchestrationV2TurnItemStatus,
  OrchestrationV2UserInputQuestion,
  ProjectionExtension,
  RawRef,
} from "@maru/shared";
import type { ThreadItem } from "../protocol/v2/ThreadItem.ts";
import type { CommandAction } from "../protocol/v2/CommandAction.ts";
import type { CollabAgentStatus } from "../protocol/v2/CollabAgentStatus.ts";
import type { FileUpdateChange } from "../protocol/v2/FileUpdateChange.ts";
import type { TurnStatus } from "../protocol/v2/TurnStatus.ts";
import type { UserInput } from "../protocol/v2/UserInput.ts";
import type { WebSearchAction } from "../protocol/v2/WebSearchAction.ts";
import type { JsonValue } from "../protocol/serde_json/JsonValue.ts";
import { CODEX_DRIVER, codexRunId, codexThreadKey, isoFromMs } from "./summaries.ts";

export type ItemDisposition = "displayed" | "hidden" | "unknown";

/** Where the item came from: a history page or a live item notification. */
export type ItemLifecycle = "history" | "started" | "completed";

export interface CodexMapContext {
  /** `codex:<account>:<threadId>` */
  threadKey: string;
  account: string;
  /** The raw Codex thread id. */
  providerThreadId: string;
  providerInstanceId: string;
  turnId: string | null;
  turnStatus: TurnStatus | null;
  lifecycle: ItemLifecycle;
  /** userMessage items before this one in the same turn (0 for the first: turn_start). */
  userMessageIndex: number;
  /** Used when the item records no time (ISO). */
  fallbackAt: IsoDateTime;
  /** The source record, kept in x.raw. */
  raw: RawRef;
}

export interface MappedRow {
  item: OrchestrationV2TurnItem;
  x: ProjectionExtension;
}

/** A status change for a child thread, from collab tool calls and subAgentActivity. */
export interface SubagentSignal {
  childProviderThreadId: string;
  status: OrchestrationV2Subagent["status"];
}

export interface MappedItem {
  /** Statistics key, e.g. `codex|item|type=commandExecution`. */
  key: string;
  disposition: ItemDisposition;
  rows: MappedRow[];
  /** spawnAgent: the subagent record for the parent's side table. */
  subagent?: OrchestrationV2Subagent;
  subagentSignals: SubagentSignal[];
}

export const UNKNOWN_TITLE = "Unknown record";

export function codexItemRowId(threadKey: string, itemId: string): string {
  return `${threadKey}:item:${itemId}`;
}

/** The census-style key of an item, with the sub-discriminators that change its row. */
export function codexItemKey(item: ThreadItem): string {
  const type = itemType(item);
  const base = `codex|item|type=${type}`;
  switch (item.type) {
    case "collabAgentToolCall":
      return `${base}|tool=${item.tool}`;
    case "subAgentActivity":
      return `${base}|kind=${item.kind}`;
    case "agentMessage":
      return item.delivery === "async" && item.questions?.length ? `${base}|questions` : base;
    default:
      return base;
  }
}

function itemType(item: ThreadItem): string {
  const t = (item as { type?: unknown }).type;
  return typeof t === "string" ? t : "(missing)";
}

export function mapThreadItem(item: ThreadItem, ctx: CodexMapContext): MappedItem {
  const key = codexItemKey(item);
  const rowId = codexItemRowId(ctx.threadKey, item.id);
  const startedAt = isoFromMs(item.startedAtMs);
  const completedAt = isoFromMs(item.completedAtMs);
  const x = (extra: Partial<ProjectionExtension> = {}): ProjectionExtension => ({ raw: [ctx.raw], sourceKey: key, ...extra });
  const base = (status: OrchestrationV2TurnItemStatus, title: string | null = null): OrchestrationV2TurnItemBase =>
    baseFields(ctx, rowId, item.id, status, title, startedAt, completedAt);
  const lifeStatus = settle(lifecycleStatus(ctx, item.completedAtMs), ctx);
  const shown = (row: MappedRow): MappedItem => ({ key, disposition: "displayed", rows: [row], subagentSignals: [] });
  const hidden = (subagentSignals: SubagentSignal[] = []): MappedItem => ({ key, disposition: "hidden", rows: [], subagentSignals });

  switch (item.type) {
    case "userMessage": {
      const { text, attachments, data } = userInput(item.content, item.id);
      if (item.clientId) data.clientId = item.clientId;
      return shown({
        item: {
          ...base("completed"),
          type: "user_message",
          createdBy: "user",
          creationSource: "provider",
          messageId: rowId,
          inputIntent: ctx.userMessageIndex === 0 ? "turn_start" : "steer",
          text,
          attachments,
        },
        x: x(Object.keys(data).length ? { data } : {}),
      });
    }

    case "hookPrompt":
      return shown({
        item: {
          ...base(lifeStatus),
          type: "system_notice",
          message: item.fragments.map((f) => f.text).join("\n"),
          level: "info",
        },
        x: x({ noticeKind: "hook", data: { hookRunIds: item.fragments.map((f) => f.hookRunId) } }),
      });

    case "agentMessage": {
      const data: Record<string, unknown> = {};
      if (item.moderation) data.moderation = item.moderation;
      if (item.memoryCitation) data.memoryCitation = item.memoryCitation;
      const message: MappedRow = {
        item: {
          ...base(lifeStatus),
          type: "assistant_message",
          ...(item.phase ? { phase: item.phase } : {}),
          messageId: rowId,
          text: item.text,
          streaming: lifeStatus === "running",
        },
        x: x(Object.keys(data).length ? { data } : {}),
      };
      if (item.delivery !== "async" || !item.questions?.length) return shown(message);
      const questionsId = `${rowId}:questions`;
      const questions: OrchestrationV2UserInputQuestion[] = item.questions.map((q, i) => ({
        id: String(i),
        header: "Question",
        question: q.title,
        options: (q.options ?? []).map((label) => ({ label, description: "" })),
        allowCustomAnswer: true,
      }));
      const request: MappedRow = {
        item: {
          // Answered by a later message; the view settles questions once a later turn exists.
          ...baseFields(ctx, questionsId, item.id, "waiting", null, startedAt, completedAt),
          type: "user_input_request",
          requestId: questionsId,
          questions,
        },
        x: x(),
      };
      return { key, disposition: "displayed", rows: [message, request], subagentSignals: [] };
    }

    case "functionCallOutput":
      return shown({
        item: {
          ...base(lifeStatus),
          type: "dynamic_tool",
          toolName: item.namespace ? `${item.namespace}.${item.name}` : item.name,
          input: null,
          output: item.output,
        },
        x: x(),
      });

    case "plan":
      return shown({
        item: { ...base(lifeStatus), type: "proposed_plan", planId: rowId, markdown: item.text, streaming: lifeStatus === "running" },
        x: x(),
      });

    case "reasoning": {
      const body = item.content.join("\n\n");
      return shown({
        item: { ...base(lifeStatus), type: "reasoning", text: item.summary.join("\n\n"), streaming: lifeStatus === "running" },
        x: x(body ? { body } : {}),
      });
    }

    case "commandExecution": {
      const declined = item.status === "declined";
      return shown({
        item: {
          ...base(settle(toolStatus(item.status), ctx), commandActionsTitle(item.commandActions)),
          ...(declined ? { toolNonExecutionKind: "declined" } : {}),
          type: "command_execution",
          input: item.command,
          ...(item.aggregatedOutput === null ? {} : { output: item.aggregatedOutput }),
          ...(item.exitCode === null ? {} : { exitCode: item.exitCode }),
        },
        x: x({
          data: {
            cwd: item.cwd,
            source: item.source,
            commandActions: item.commandActions,
            ...(item.durationMs === null ? {} : { durationMs: item.durationMs }),
            ...(item.processId === null ? {} : { processId: item.processId }),
          },
        }),
      });
    }

    case "fileChange": {
      const patch = fileChangeFields(item.changes);
      return shown({
        item: { ...base(settle(toolStatus(item.status), ctx)), ...(item.status === "declined" ? { toolNonExecutionKind: "declined" } : {}), type: "file_change", ...patch },
        x: x(),
      });
    }

    case "mcpToolCall": {
      const output =
        item.error === null ? (item.result ?? undefined) : item.result === null ? { error: item.error.message } : { error: item.error.message, result: item.result };
      const data: Record<string, unknown> = {};
      if (item.durationMs !== null) data.durationMs = item.durationMs;
      if (item.mcpAppUi) data.mcpAppUi = item.mcpAppUi;
      return shown({
        item: {
          ...base(settle(toolStatus(item.status), ctx)),
          type: "dynamic_tool",
          toolName: `${item.server}.${item.tool}`,
          input: item.arguments,
          ...(output === undefined ? {} : { output }),
        },
        x: x(Object.keys(data).length ? { data } : {}),
      });
    }

    case "dynamicToolCall": {
      const output = item.contentItems ?? (item.success === false ? { success: false } : undefined);
      return shown({
        item: {
          ...base(settle(toolStatus(item.status), ctx)),
          type: "dynamic_tool",
          toolName: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
          input: item.arguments,
          ...(output === undefined ? {} : { output }),
        },
        x: x(item.durationMs === null ? {} : { data: { durationMs: item.durationMs } }),
      });
    }

    case "collabAgentToolCall": {
      const signals: SubagentSignal[] = [];
      for (const child of item.receiverThreadIds) {
        const state = item.agentsStates[child];
        if (state) signals.push({ childProviderThreadId: child, status: collabAgentStatus(state.status) });
      }
      if (item.tool !== "spawnAgent") return hidden(signals);
      const child = item.receiverThreadIds[0] ?? null;
      const childKey = child === null ? null : codexThreadKey(ctx.account, child);
      const childState = child === null ? undefined : item.agentsStates[child];
      const status = childState ? collabAgentStatus(childState.status) : spawnStatus(item.status);
      const turnItem: OrchestrationV2TurnItem = {
        ...base(status),
        type: "subagent",
        subagentId: item.id,
        origin: "provider_native",
        driver: CODEX_DRIVER,
        providerInstanceId: ctx.providerInstanceId,
        childThreadId: childKey,
        prompt: item.prompt ?? "",
        ...(childState?.message ? { progress: childState.message } : {}),
        result: null,
      };
      const subagent: OrchestrationV2Subagent = {
        id: item.id,
        threadId: ctx.threadKey,
        runId: turnItem.runId,
        parentNodeId: rowId,
        origin: "provider_native",
        createdBy: "agent",
        driver: CODEX_DRIVER,
        providerInstanceId: ctx.providerInstanceId,
        providerThreadId: child,
        childThreadId: childKey,
        nativeTaskRef: { driver: CODEX_DRIVER, nativeId: item.id, strength: "strong" },
        prompt: item.prompt ?? "",
        title: null,
        model: item.model,
        status,
        ...(childState?.message ? { progress: childState.message } : {}),
        result: null,
        startedAt,
        completedAt,
        updatedAt: turnItem.updatedAt,
      };
      return {
        key,
        disposition: "displayed",
        rows: [{ item: turnItem, x: x(childKey ? { link: { threadId: childKey, evidence: "parentThreadId" } } : {}) }],
        subagent,
        subagentSignals: signals,
      };
    }

    case "subAgentActivity": {
      const signal: SubagentSignal = { childProviderThreadId: item.agentThreadId, status: activityStatus(item.kind) };
      if (item.kind !== "completed") return hidden([signal]);
      const childKey = codexThreadKey(ctx.account, item.agentThreadId);
      return {
        key,
        disposition: "displayed",
        rows: [
          {
            item: {
              ...base("completed"),
              type: "notification",
              source: { kind: "subagent", childThreadId: childKey },
              outcome: "completed",
              summary: `Subagent completed: ${item.agentPath || item.agentThreadId}`,
            },
            x: x({ link: { threadId: childKey, evidence: "parentThreadId" }, data: { model: item.model, agentPath: item.agentPath } }),
          },
        ],
        subagentSignals: [signal],
      };
    }

    case "webSearch": {
      const patterns = webSearchPatterns(item.query, item.action);
      const { results, unmapped } = webSearchResults(item.results);
      return shown({
        item: {
          ...base(lifeStatus),
          type: "web_search",
          ...(patterns.length ? { patterns } : {}),
          ...(results.length ? { results } : {}),
        },
        x: x(unmapped.length ? { data: { unmappedResults: unmapped } } : {}),
      });
    }

    case "imageView":
      return shown({
        item: {
          ...base(lifeStatus),
          type: "dynamic_tool",
          toolName: "view_image",
          viewedImagePath: item.path,
          input: { path: item.path },
        },
        x: x(),
      });

    case "imageGeneration": {
      // The generated image bytes (`result`, base64) stay out of the row; savedPath points at the
      // file and x.data records how long the omitted value was.
      const g = item as typeof item & { result?: string; fileId?: string };
      const status = imageGenerationStatus(g.status, g.failure !== null);
      const output: Record<string, unknown> = {};
      if (g.savedPath) output.savedPath = g.savedPath;
      if (g.fileId) output.fileId = g.fileId;
      if (g.failure) output.failure = g.failure;
      if (g.generationId) output.generationId = g.generationId;
      return shown({
        item: {
          ...base(settle(status, ctx)),
          type: "dynamic_tool",
          toolName: "imagegen",
          ...(g.savedPath ? { viewedImagePath: g.savedPath } : {}),
          input: { revisedPrompt: g.revisedPrompt, ...(g.inputImages ? { inputImages: g.inputImages } : {}) },
          output,
        },
        x: x(typeof g.result === "string" ? { data: { resultChars: g.result.length } } : {}),
      });
    }

    case "contextCompaction":
      return shown({ item: { ...base(lifeStatus), type: "compaction", driver: CODEX_DRIVER }, x: x() });

    // The official client draws none of these (ref-codex-official 2.1).
    case "sleep":
    case "enteredReviewMode":
    case "exitedReviewMode":
      return hidden();

    default: {
      const raw = item as unknown as { type?: unknown; id?: unknown };
      const type = itemType(item);
      return {
        key,
        disposition: "unknown",
        rows: [
          {
            item: {
              ...baseFields(ctx, rowId, typeof raw.id === "string" ? raw.id : rowId, "completed", UNKNOWN_TITLE, startedAt, completedAt),
              type: "system_notice",
              message: `Codex item type ${type}`,
              level: "info",
            },
            x: x({ unknown: true, data: { item: raw } }),
          },
        ],
        subagentSignals: [],
      };
    }
  }
}

export function baseFields(
  ctx: Pick<CodexMapContext, "threadKey" | "providerThreadId" | "turnId" | "fallbackAt">,
  rowId: string,
  nativeId: string,
  status: OrchestrationV2TurnItemStatus,
  title: string | null,
  startedAt: IsoDateTime | null,
  completedAt: IsoDateTime | null,
): OrchestrationV2TurnItemBase {
  return {
    id: rowId,
    threadId: ctx.threadKey,
    runId: ctx.turnId === null ? null : codexRunId(ctx.threadKey, ctx.turnId),
    nodeId: null,
    providerThreadId: ctx.providerThreadId,
    providerTurnId: ctx.turnId,
    nativeItemRef: { driver: CODEX_DRIVER, nativeId, strength: "strong" },
    parentItemId: null,
    // The view sets the ordinal from the row's place in the thread.
    ordinal: 0,
    status,
    title,
    startedAt,
    completedAt,
    updatedAt: completedAt ?? startedAt ?? ctx.fallbackAt,
  };
}

/** Items without a status field: running while started, otherwise settled. */
function lifecycleStatus(ctx: CodexMapContext, completedAtMs: number | null | undefined): OrchestrationV2TurnItemStatus {
  switch (ctx.lifecycle) {
    case "started":
      return "running";
    case "completed":
      return "completed";
    case "history":
      return ctx.turnStatus === "inProgress" && (completedAtMs === null || completedAtMs === undefined) ? "running" : "completed";
  }
}

/** A running item of an interrupted or failed turn ends with its turn (the official client does the same). */
export function settle(status: OrchestrationV2TurnItemStatus, ctx: Pick<CodexMapContext, "turnStatus">): OrchestrationV2TurnItemStatus {
  if (status !== "running") return status;
  if (ctx.turnStatus === "interrupted") return "interrupted";
  if (ctx.turnStatus === "failed") return "failed";
  return status;
}

function toolStatus(status: string): OrchestrationV2TurnItemStatus {
  switch (status) {
    case "inProgress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "declined":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "running";
  }
}

function spawnStatus(status: string): OrchestrationV2Subagent["status"] {
  switch (status) {
    case "inProgress":
      return "pending";
    // The spawn call finished; the child runs on until a state or activity says otherwise.
    case "completed":
      return "running";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "running";
  }
}

export function collabAgentStatus(status: CollabAgentStatus): OrchestrationV2Subagent["status"] {
  switch (status) {
    case "pendingInit":
      return "pending";
    case "running":
      return "running";
    case "interrupted":
      return "interrupted";
    case "completed":
    case "shutdown":
      return "completed";
    case "errored":
    case "notFound":
      return "failed";
    default:
      return "running";
  }
}

function activityStatus(kind: string): OrchestrationV2Subagent["status"] {
  switch (kind) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    default:
      return "running";
  }
}

function imageGenerationStatus(status: string, failed: boolean): OrchestrationV2TurnItemStatus {
  if (failed || status === "failed") return "failed";
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "running";
}

/** "Read a.ts, Search foo in src" for commands that only explore; null when any action is a plain command. */
export function commandActionsTitle(actions: CommandAction[]): string | null {
  if (actions.length === 0) return null;
  const parts: string[] = [];
  for (const a of actions) {
    switch (a.type) {
      case "read":
        parts.push(`Read ${a.name || a.path}`);
        break;
      case "listFiles":
        parts.push(`List ${a.path ?? "files"}`);
        break;
      case "search":
        parts.push(`Search ${a.query ?? ""}${a.path ? ` in ${a.path}` : ""}`.trimEnd());
        break;
      default:
        return null;
    }
  }
  return parts.join(", ");
}

export function fileChangeFields(changes: FileUpdateChange[]): {
  fileName: string;
  diffStr: string;
  additions: number;
  deletions: number;
  changes: OrchestrationV2FileChangeDetail[];
} {
  let additions = 0;
  let deletions = 0;
  const parts: string[] = [];
  for (const c of changes) {
    const d = unifiedDiff(c);
    parts.push(d.text);
    additions += d.additions;
    deletions += d.deletions;
  }
  return {
    fileName: changes[0]?.path ?? "",
    diffStr: parts.join(""),
    additions,
    deletions,
    changes: changes.map((c) => {
      // move_path is the destination (T3's Codex adapter reads it the same way).
      const movePath = c.kind.type === "update" ? c.kind.move_path : null;
      return movePath ? { operation: "move", path: movePath, oldPath: c.path } : { operation: c.kind.type, path: c.path };
    }),
  };
}

/**
 * One file change as a unified diff with file headers. The daemon sends an update as bare hunks
 * and an add or a delete as the whole file text (measured on ~/.codex: 1,830 of 1,831 update
 * diffs start with "@@", the other is empty; all 198 adds and the 1 delete are plain file text),
 * so the headers and the +/- lines are put together here. Line counts come from the source, not
 * from the result, where a deleted line "-- x" would read as a header.
 */
export function unifiedDiff(c: FileUpdateChange): { text: string; additions: number; deletions: number } {
  if (c.kind.type === "add" || c.kind.type === "delete") {
    const add = c.kind.type === "add";
    const lines = c.diff.split("\n");
    if (lines.at(-1) === "") lines.pop();
    let text = add ? `--- /dev/null\n+++ b/${c.path}\n` : `--- a/${c.path}\n+++ /dev/null\n`;
    if (lines.length > 0) {
      const sign = add ? "+" : "-";
      text += add ? `@@ -0,0 +1,${lines.length} @@\n` : `@@ -1,${lines.length} +0,0 @@\n`;
      text += lines.map((l) => sign + l).join("\n") + "\n";
      if (!c.diff.endsWith("\n")) text += "\\ No newline at end of file\n";
    }
    return { text, additions: add ? lines.length : 0, deletions: add ? 0 : lines.length };
  }
  const to = c.kind.move_path ?? c.path;
  const body = c.diff === "" || c.diff.endsWith("\n") ? c.diff : `${c.diff}\n`;
  let additions = 0;
  let deletions = 0;
  for (const line of c.diff.split("\n")) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { text: `--- a/${c.path}\n+++ b/${to}\n${body}`, additions, deletions };
}

/** +/- line counts of a diff that has file headers (turn/diff/updated). */
export function diffLineCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

function webSearchPatterns(query: string, action: WebSearchAction | null): string[] {
  const vals: Array<string | null | undefined> = [];
  if (action === null) vals.push(query);
  else if (action.type === "search") vals.push(...(action.queries ?? []), action.query, query);
  else if (action.type === "openPage") vals.push(action.url, query);
  else if (action.type === "findInPage") vals.push(action.pattern, action.url, query);
  else vals.push(query);
  const out: string[] = [];
  for (const v of vals) {
    const t = v?.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function webSearchResults(results: JsonValue[] | null): {
  results: Array<{ title?: string; url?: string; snippet?: string }>;
  unmapped: JsonValue[];
} {
  const out: Array<{ title?: string; url?: string; snippet?: string }> = [];
  const unmapped: JsonValue[] = [];
  for (const r of results ?? []) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      unmapped.push(r);
      continue;
    }
    const o = r as Record<string, unknown>;
    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) if (typeof o[k] === "string") return o[k] as string;
      return undefined;
    };
    const title = pick("title", "name");
    const url = pick("url", "link");
    const snippet = pick("snippet", "description", "text");
    if (title === undefined && url === undefined && snippet === undefined) {
      unmapped.push(r);
      continue;
    }
    out.push({ ...(title === undefined ? {} : { title }), ...(url === undefined ? {} : { url }), ...(snippet === undefined ? {} : { snippet }) });
  }
  return { results: out, unmapped };
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
};

function mimeOf(nameOrUrl: string, fallback: string): string {
  const data = /^data:([^;,]+)[;,]/.exec(nameOrUrl);
  if (data?.[1]) return data[1];
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(nameOrUrl)?.[1]?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || fallback;
}

function baseName(p: string): string {
  if (p.startsWith("data:")) return "pasted";
  const clean = p.split(/[?#]/)[0] ?? p;
  return clean.split("/").filter(Boolean).at(-1) ?? clean;
}

/**
 * Text parts become the message text; images and audio become attachments. Where an attachment
 * lives (local path, URL, file id) goes to x.data.attachmentSources, except data URLs, whose
 * length is recorded instead.
 */
function userInput(
  content: UserInput[],
  itemId: string,
): { text: string; attachments: ChatAttachment[]; data: Record<string, unknown> } {
  const texts: string[] = [];
  const attachments: ChatAttachment[] = [];
  const sources: Record<string, unknown> = {};
  const mentions: Array<{ type: string; name: string; path: string }> = [];
  content.forEach((part, i) => {
    const id = `${itemId}:${i}`;
    switch (part.type) {
      case "text":
        texts.push(part.text);
        return;
      case "image":
      case "audio": {
        const p = part as { url?: string; fileId?: string };
        const loc = p.url ?? p.fileId ?? "";
        const kind = part.type;
        attachments.push({ type: kind, id, name: p.url ? baseName(p.url) : (p.fileId ?? kind), mimeType: mimeOf(loc, `${kind}/*`), sizeBytes: 0 });
        sources[id] = p.url?.startsWith("data:") ? { dataUrlChars: p.url.length } : p.url ? { url: p.url } : { fileId: p.fileId };
        return;
      }
      case "localImage":
      case "localAudio": {
        const kind = part.type === "localImage" ? "image" : "audio";
        attachments.push({ type: kind, id, name: baseName(part.path), mimeType: mimeOf(part.path, `${kind}/*`), sizeBytes: 0 });
        sources[id] = { path: part.path };
        return;
      }
      case "skill":
      case "mention":
        mentions.push({ type: part.type, name: part.name, path: part.path });
        return;
      default:
        sources[id] = { unknown: part };
    }
  });
  const data: Record<string, unknown> = {};
  if (Object.keys(sources).length) data.attachmentSources = sources;
  if (mentions.length) data.mentions = mentions;
  return { text: texts.join("\n"), attachments, data };
}
