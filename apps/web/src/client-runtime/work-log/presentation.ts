// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: packages/client-runtime/src/work-log/presentation.ts.
// Local changes: T3's own MCP tool presentation (t3McpToolPresentation, t3ToolSummary) is left out,
// because maru threads never call T3's MCP tools, so `resolveWorkEntryToolPresentation`
// always returns null. `resolveViewedImageAsset` returns null: maru has no media route yet.
// User-visible labels are Korean.
import {
  viewedImageBlobFromOutput,
  type OrchestrationV2TurnItem,
  type UserInputAttachmentAnswerPayload,
  type ViewedImage,
} from "@maru/shared";
import {
  isOrchestrationV2WorkActive,
  isToolLifecycleItemType,
  type RuntimeItemStatus,
  type ToolActivityIcon,
  type ToolActivitySource,
  type ToolActivitySurface,
  type ToolCallVisibility,
} from "../../t3-shared/contracts.ts";
import { plural } from "../../lib/plural.ts";
import { isWorkspaceImagePreviewPath } from "../../t3-shared/mediaPreview.ts";
import { classifyToolActivity } from "../../t3-shared/toolActivity.ts";
import { toolOutputIndicatesFailure } from "../../t3-shared/toolOutput.ts";
import { formatTokens } from "../../t3-shared/usageFormat.ts";

export type WorkLogToolLifecycleStatus = RuntimeItemStatus | "stopped" | "idle";

export function toolItemForDisplay(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "command_execution":
    case "dynamic_tool": {
      const { output: _output, ...displayItem } = item;
      return displayItem;
    }
    case "file_change": {
      const { diffStr, oldStr: _oldStr, newStr: _newStr, ...displayItem } = item;
      // A failed edit's diffStr holds the provider's error, not a diff.
      return item.status === "failed" && diffStr?.trim()
        ? { ...displayItem, diffStr }
        : displayItem;
    }
    default:
      return item;
  }
}

type CompactionLabelItem = Pick<
  Extract<OrchestrationV2TurnItem, { type: "compaction" }>,
  "status" | "beforeTokenCount" | "afterTokenCount"
>;

export function contextCompactionTokenCounts(
  item: CompactionLabelItem,
): { readonly before: string; readonly after: string } | null {
  if (
    item.status === "running" ||
    item.beforeTokenCount === undefined ||
    item.afterTokenCount === undefined
  ) {
    return null;
  }
  return { before: formatTokens(item.beforeTokenCount), after: formatTokens(item.afterTokenCount) };
}

export function contextCompactionLabel(item: CompactionLabelItem): string {
  if (item.status === "failed") return "Context compaction failed";
  if (item.status === "cancelled" || item.status === "interrupted") return "Context compaction stopped";
  if (isOrchestrationV2WorkActive(item.status)) return "Compacting context";
  const tokens = contextCompactionTokenCounts(item);
  return tokens ? `Context compaction ${tokens.before} → ${tokens.after} tokens` : "Context compaction";
}

export interface WorkLogPresentationEntry {
  readonly questionAnswer?: UserInputAttachmentAnswerPayload;
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly command?: string;
  readonly rawCommand?: string;
  readonly detail?: string;
  readonly viewedImagePath?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly toolTitle?: string;
  readonly toolData?: unknown;
  readonly requestKind?: string;
  readonly itemType?: OrchestrationV2TurnItem["type"];
  readonly toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  readonly structuredPayload?: OrchestrationV2TurnItem;
  readonly toolSource?: ToolActivitySource;
  readonly toolSurface?: ToolActivitySurface;
  readonly toolIcon?: ToolActivityIcon;
}

export type ToolGroupAction =
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "read"
  | "edit"
  | "command"
  | "thread-create"
  | "browser"
  | "device"
  | "code-search"
  | "search"
  | "other"
  | "update";

export type ToolGroupSummaryKind =
  | "pull-request"
  | ToolGroupAction
  | "dynamic-tool"
  | "reasoning"
  | "agent-tool"
  | "tone-tool"
  | "mixed";

/** A T3 MCP tool's presentation; maru threads never produce one (see the header). */
export interface WorkEntryToolPresentation {
  readonly displayName: string;
  readonly icon: string;
  readonly action?: ToolGroupAction;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function liveActivityToolStatus(status: string | undefined, presentTense: boolean) {
  if (status === "failed" || status === "declined" || status === "stopped" || status === "idle") {
    return status;
  }
  if (presentTense || status === "inProgress") return "inProgress";
  return "completed";
}

export function resolveWorkEntryToolPresentation(
  _entry: Pick<
    WorkLogPresentationEntry,
    "label" | "toolTitle" | "toolData" | "toolLifecycleStatus" | "structuredPayload"
  >,
  _fallbackStatus?: "inProgress" | "completed",
): WorkEntryToolPresentation | null {
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function workLogEntryIsToolLike(entry: WorkLogPresentationEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") return true;
  if (entry.command !== undefined && entry.command.trim().length > 0) return true;
  if (entry.requestKind !== undefined) return true;
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

function workEntryIndicatesToolFailureFromOutput(
  entry: WorkLogPresentationEntry,
  includeCommand: boolean,
): boolean {
  if (
    entry.tone === "error" ||
    entry.toolLifecycleStatus === "failed" ||
    entry.toolLifecycleStatus === "declined"
  ) {
    return true;
  }
  // Reasoning detail is the model's own prose (often tens of KB), not tool
  // output: scanning it is slow on long threads and misreads phrases like
  // "that exit code 2 is expected" as a failed tool.
  if (!workLogEntryIsToolLike(entry) || entry.itemType === "reasoning") return false;
  const item = entry.structuredPayload;
  if (item?.type === "command_execution") {
    // The exit code outranks text in the output or the command itself.
    if (item.exitCode !== undefined) return item.exitCode !== 0;
    if (item.outputIndicatesFailure) return true;
    if (item.output && toolOutputIndicatesFailure(item.output.slice(0, 32_768))) {
      return true;
    }
  }
  const output = includeCommand
    ? [entry.detail, entry.command].filter(Boolean).join("\n")
    : (entry.detail ?? "");
  return output.length > 0 && toolOutputIndicatesFailure(output);
}

// Rows are re-derived on every timeline update but entries are reused while
// their item is unchanged, so these per-entry checks are computed once.
const entryChecks = new WeakMap<
  WorkLogPresentationEntry,
  { failure?: boolean; displayFailure?: boolean; action?: ToolGroupAction }
>();

function checksFor(entry: WorkLogPresentationEntry) {
  let checks = entryChecks.get(entry);
  if (!checks) {
    checks = {};
    entryChecks.set(entry, checks);
  }
  return checks;
}

export function workEntryIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return (checksFor(entry).failure ??= workEntryIndicatesToolFailureFromOutput(entry, true));
}

export function workEntryDisplayIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return (checksFor(entry).displayFailure ??= workEntryIndicatesToolFailureFromOutput(
    entry,
    false,
  ));
}

const HIDEABLE_TOOL_CALL_ITEM_TYPES: ReadonlySet<WorkLogPresentationEntry["itemType"]> = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
]);

export function workEntryHiddenByToolCallVisibility(
  entry: WorkLogPresentationEntry,
  visibility: ToolCallVisibility,
): boolean {
  if (visibility === "showAll" || !HIDEABLE_TOOL_CALL_ITEM_TYPES.has(entry.itemType)) return false;
  if (visibility !== "hideSuccessful") return true;
  return entry.toolLifecycleStatus === "completed" && !workEntryDisplayIndicatesToolFailure(entry);
}

function workLogEntryIsLocalCodeSearch(entry: WorkLogPresentationEntry): boolean {
  return (
    entry.itemType === "file_search" ||
    (entry.itemType === "web_search" &&
      /\bgrep\b/i.test(normalizeCompactToolLabel(entry.toolTitle ?? entry.label)))
  );
}

export function toolGroupAction(entry: WorkLogPresentationEntry): ToolGroupAction {
  return (checksFor(entry).action ??= computeToolGroupAction(entry));
}

function computeToolGroupAction(entry: WorkLogPresentationEntry): ToolGroupAction {
  if (entry.itemType === "thread_created") return "thread-create";
  const presentation = resolveWorkEntryToolPresentation(entry);
  if (presentation?.action !== undefined) return presentation.action;
  if (presentation?.icon === "browser") return "browser";
  if (presentation?.icon === "device") return "device";
  if (entry.requestKind === "file-read" || entry.viewedImagePath !== undefined) return "read";
  if (entry.itemType === "approval_request" || entry.itemType === "user_input_request") {
    return workLogEntryIsToolLike(entry) ? "other" : "update";
  }
  const data = asRecord(entry.toolData) ?? {};
  const toolName =
    entry.structuredPayload?.type === "dynamic_tool"
      ? entry.structuredPayload.toolName
      : typeof data.toolName === "string"
        ? data.toolName
        : entry.toolTitle;
  const classified = classifyToolActivity({
    itemType:
      entry.itemType === "command_execution" ||
      entry.itemType === "file_change" ||
      entry.itemType === "web_search"
        ? entry.itemType
        : entry.itemType === "dynamic_tool"
          ? "dynamic_tool_call"
          : undefined,
    title: entry.toolTitle ?? entry.label,
    data: {
      ...data,
      ...(toolName ? { toolName } : {}),
    },
  });
  if (classified === "read") return "read";
  if (classified === "file_change" || entry.itemType === "file_change") return "edit";
  if (classified === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  if (classified === "search") {
    return entry.itemType === "web_search" && !workLogEntryIsLocalCodeSearch(entry)
      ? "search"
      : "code-search";
  }
  if (workLogEntryIsLocalCodeSearch(entry)) return "code-search";
  if (entry.itemType === "web_search") return "search";
  if ((entry.changedFiles?.length ?? 0) > 0) return "edit";
  return workLogEntryIsToolLike(entry) ? "other" : "update";
}

export function workEntryViewedImagePath(entry: WorkLogPresentationEntry): string | null {
  const viewedImagePath = entry.viewedImagePath?.trim();
  if (
    viewedImagePath !== undefined &&
    !/[\r\n]/.test(viewedImagePath) &&
    isWorkspaceImagePreviewPath(viewedImagePath)
  ) {
    return viewedImagePath;
  }
  const detail = entry.detail?.trim();
  return toolGroupAction(entry) === "read" &&
    detail !== undefined &&
    !/[\r\n]/.test(detail) &&
    isWorkspaceImagePreviewPath(detail)
    ? detail
    : null;
}

/** Distinct images the agent opened across a tool group, in viewing order. */
export function workEntriesViewedImagePaths(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): string[] {
  return [...new Set(entries.flatMap((entry) => workEntryViewedImagePath(entry) ?? []))];
}

/**
 * The pictures the tool group opened with where each one can be drawn from (packages/shared
 * viewedImages.ts): the path, plus the tool result's own copy when the transcript carries one.
 * One entry per path; an entry with a copy wins over one without.
 */
export function workEntriesViewedImages(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): ViewedImage[] {
  const byPath = new Map<string, ViewedImage>();
  for (const entry of entries) {
    const path = workEntryViewedImagePath(entry);
    if (path === null) continue;
    const output = (entry.toolData as { output?: unknown } | null | undefined)?.output;
    const blob = output === undefined ? null : viewedImageBlobFromOutput(output);
    const existing = byPath.get(path);
    if (existing === undefined || (existing.blob === null && blob !== null)) byPath.set(path, { path, blob });
  }
  return [...byPath.values()];
}

/** T3 resolves a workspace image to an environment media asset; maru has no media route. */
export interface ViewedImageAsset {
  readonly resource: { readonly _tag: "media-file"; readonly path: string };
  readonly alt: string;
  readonly srcFragment: string;
}

export function resolveViewedImageAsset(
  _source: string,
  _input: {
    readonly threadId: string;
    readonly workspaceRoot?: string | null | undefined;
  },
): ViewedImageAsset | null {
  return null;
}

function toolGroupActionCount(
  action: ToolGroupAction,
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): number {
  if (action !== "edit") return entries.length;
  const changedFiles = new Set<string>();
  let editsWithoutFileDetails = 0;
  for (const entry of entries) {
    if (!entry.changedFiles || entry.changedFiles.length === 0) {
      editsWithoutFileDetails += 1;
    } else {
      for (const file of entry.changedFiles) changedFiles.add(file);
    }
  }
  return changedFiles.size + editsWithoutFileDetails;
}

function toolGroupActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "link-pr":
      return `Linked ${plural(count, "pull request")}`;
    case "unlink-pr":
      return `Unlinked ${plural(count, "pull request")}`;
    case "watch-pr":
      return `Watching ${plural(count, "pull request")}`;
    case "unwatch-pr":
      return `Stopped watching ${plural(count, "pull request")}`;
    case "list-prs":
      return count === 1 ? "Checked linked pull request" : `Checked linked pull requests ${count} times`;
    case "read":
      return `Read ${plural(count, "file")}`;
    case "edit":
      return `Changed ${plural(count, "file")}`;
    case "command":
      return `Ran ${plural(count, "command")}`;
    case "thread-create":
      return `Created ${plural(count, "thread")}`;
    case "device":
      return `Used device control ${plural(count, "time")}`;
    case "browser":
      return `Used the browser ${plural(count, "time")}`;
    case "search":
      return `Searched the web ${plural(count, "time")}`;
    case "code-search":
      return `Searched code ${plural(count, "time")}`;
    case "other":
      return `Used ${plural(count, "tool")}`;
    case "update":
      return `Received ${plural(count, "update")}`;
  }
}

function summaryActionPriority(action: ToolGroupAction): number {
  switch (action) {
    case "command":
    case "edit":
    case "thread-create":
      return 0;
    case "other":
    case "update":
      return 2;
    default:
      return 1;
  }
}

/** Joins summary parts; T3 joins English clauses with "and", Korean lists them with commas. */
function joinSummaryLabels(labels: ReadonlyArray<string>): string {
  return labels.join(", ");
}

export function summarizeToolGroup(entries: ReadonlyArray<WorkLogPresentationEntry>): {
  summary: string;
  hasFailure: boolean;
} {
  const toolEntries = entries.filter((entry) => entry.itemType !== "reasoning");
  if (entries.length > 0 && toolEntries.length === 0) {
    return {
      summary: entries.length === 1 ? "Thought" : `Thought (×${entries.length})`,
      hasFailure: false,
    };
  }
  entries = toolEntries;
  const groups = new Map<ToolGroupAction, { action: ToolGroupAction; entries: WorkLogPresentationEntry[] }>();
  const sources = new Map<string, ToolActivitySource>();
  for (const entry of entries) {
    if (entry.toolSource) {
      sources.set(entry.toolSource.key, entry.toolSource);
      continue;
    }
    const action = toolGroupAction(entry);
    const group = groups.get(action);
    if (group) group.entries.push(entry);
    else groups.set(action, { action, entries: [entry] });
  }
  const summaries = [...groups].map(([action, group], index) => ({
    index,
    count: group.entries.length,
    priority: summaryActionPriority(action),
    label: toolGroupActionLabel(group.action, toolGroupActionCount(group.action, group.entries)),
    failedCount: group.entries.filter(workEntryDisplayIndicatesToolFailure).length,
  }));
  const selected = [...summaries]
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);
  const labels = selected.map(({ label }) => label);
  if (sources.size > 0) {
    const sourceValues = [...sources.values()];
    const sourceNames = [...new Set(sourceValues.map((source) => source.name))];
    const allIntegrations = sourceValues.every((source) => source.kind === "integration");
    labels.unshift(`${sourceNames.join(", ")}${allIntegrations ? " integration" : ""} used`);
  }
  const sourcedCount = entries.filter((entry) => entry.toolSource !== undefined).length;
  const remainingCount =
    entries.length - sourcedCount - selected.reduce((count, group) => count + group.count, 0);
  if (remainingCount > 0) {
    labels.push(`${plural(remainingCount, "other action")}`);
  }
  return {
    summary: joinSummaryLabels(labels),
    hasFailure: summaries.some((group) => group.failedCount > 0),
  };
}

export function toolGroupSummaryKind(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): ToolGroupSummaryKind {
  const toolEntries = entries.filter((entry) => entry.itemType !== "reasoning");
  if (entries.length > 0 && toolEntries.length === 0) return "reasoning";
  entries = toolEntries;
  if (
    entries.length > 0 &&
    entries.every((entry) => resolveWorkEntryToolPresentation(entry)?.icon === "pull-request")
  )
    return "pull-request";
  const actions = new Set(entries.map(toolGroupAction));
  if (actions.size !== 1) return "mixed";
  const action = actions.values().next().value!;
  if (action !== "other") return action;
  const fallbackKinds = new Set(
    entries.map((entry): ToolGroupSummaryKind => {
      if (entry.itemType === "dynamic_tool") return "dynamic-tool";
      if (entry.itemType === "subagent") return "agent-tool";
      if (entry.tone === "thinking") return "agent-tool";
      if (entry.tone === "tool") return "tone-tool";
      return "other";
    }),
  );
  return fallbackKinds.size === 1 ? fallbackKinds.values().next().value! : "mixed";
}

export function liveThoughtLine(markdown: string): string {
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(markdown)?.[1];
  const text = (heading ?? markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (heading !== undefined) return text;
  const end = /[.?!]["'”’)]?(?=\s)/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
}
