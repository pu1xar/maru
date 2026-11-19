// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts (commit ee3b2084), the
// helpers that turn a Claude tool_use and its result into TurnItem fields: the tool classification
// table (3435-3460), the item title (6793-6828), and commandInputFromClaudeTool,
// fileNameFromClaudeTool, claudeNativeToolOutputValue, claudeCommandOutputText,
// claudeFileChangeText, claudeSubagentResultText and the web search helpers (3520-3920). Also
// isWorkspaceImagePreviewPath from packages/shared/src/mediaPreview.ts and mcpToolResultOutput,
// toolOutputImages from packages/shared/src/toolOutput.ts.
//
// Differences from T3:
//   - Effect Schema decoders are plain type guards.
//   - The `diff` package is replaced by formatHunks, which writes the same text as jsdiff 9
//     formatPatch(patch, FILE_HEADERS_ONLY) for the hunks Claude records.
//   - A tool output is the transcript pair (tool_result.content, toolUseResult) instead of the SDK
//     message, so ToolOutput below holds both.
//   - A WebFetch result snippet keeps the whole fetched text (T3 cuts it at 8,000 characters), and
//     its row carries the fetch facts of toolUseResult (webFetchResultFromClaudeOutput).
import type { OrchestrationV2WebSearchResult } from "@maru/shared";
import { dynamicToolTitle, formatReadToolLabel, formatSearchToolLabel } from "./toolTitles.ts";

export type ClaudeToolItemType = "command_execution" | "file_change" | "dynamic_tool" | "web_search";

const CLAUDE_KNOWN_TOOL_CLASSIFICATIONS: Record<string, ClaudeToolItemType> = {
  agent: "dynamic_tool",
  bash: "command_execution",
  edit: "file_change",
  glob: "dynamic_tool",
  grep: "dynamic_tool",
  ls: "dynamic_tool",
  monitor: "dynamic_tool",
  multiedit: "file_change",
  notebookedit: "file_change",
  read: "dynamic_tool",
  sendmessage: "dynamic_tool",
  task: "dynamic_tool",
  taskstop: "dynamic_tool",
  todowrite: "dynamic_tool",
  toolsearch: "dynamic_tool",
  webfetch: "web_search",
  websearch: "web_search",
  write: "file_change",
};

export function normalizedClaudeToolName(toolName: string): string {
  return toolName.toLowerCase().replaceAll(/[\s_-]/g, "");
}

/**
 * T3's table, with the census names it does not list: `bash_placeholder` runs a command
 * (docs/event-model.md 5.5); every other unknown name is a dynamic_tool, as in T3.
 */
export function classifyClaudeTool(toolName: string): ClaudeToolItemType {
  const normalized = normalizedClaudeToolName(toolName);
  if (normalized === "bashplaceholder") return "command_execution";
  return CLAUDE_KNOWN_TOOL_CLASSIFICATIONS[normalized] ?? "dynamic_tool";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function firstStringInputField(input: unknown, keys: ReadonlyArray<string>): string | undefined {
  const record = asRecord(input);
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function jsonStringifyForTool(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value) ?? String(value);
}

/** T3 ClaudeAdapterV2 item title: Read path, then search label, then dynamicToolTitle. */
export function claudeToolTitle(toolName: string, input: unknown): string | null {
  const normalized = normalizedClaudeToolName(toolName);
  const readPath = normalized === "read" || normalized === "readfile" ? firstStringInputField(input, ["file_path", "path"]) : undefined;
  if (readPath !== undefined) return formatReadToolLabel(readPath);
  const searchTitle = ["grep", "glob", "ls"].includes(normalized) ? formatSearchToolLabel({ input: asRecord(input) }) : undefined;
  return searchTitle ?? dynamicToolTitle(toolName, input) ?? null;
}

export function commandInputFromClaudeTool(toolName: string, input: unknown): string {
  return firstStringInputField(input, ["command", "cmd", "script"]) ?? `${toolName}: ${jsonStringifyForTool(input)}`;
}

export function fileNameFromClaudeTool(toolName: string, input: unknown): string {
  return firstStringInputField(input, ["file_path", "notebook_path", "path", "filename", "fileName"]) ?? `${toolName} result`;
}

const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = [
  ".avif", ".bmp", ".gif", ".ico", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp",
] as const;

export function isWorkspaceImagePreviewPath(path: string): boolean {
  const literalPath = path.toLowerCase();
  return WORKSPACE_IMAGE_PREVIEW_EXTENSIONS.some((extension) => literalPath.endsWith(extension));
}

/** Read of an image file: T3 shows it inline through viewedImagePath. */
export function viewedImagePathFromClaudeTool(toolName: string, input: unknown): string | undefined {
  const normalized = normalizedClaudeToolName(toolName);
  if (normalized !== "read" && normalized !== "readfile") return undefined;
  const readPath = firstStringInputField(input, ["file_path", "path"]);
  return readPath !== undefined && readPath.length <= 4096 && !/[\r\n]/.test(readPath) && isWorkspaceImagePreviewPath(readPath)
    ? readPath
    : undefined;
}

// ---- outputs ----

/**
 * One tool result as the transcript records it: the API tool_result block content and the
 * CLI's structured `toolUseResult` (absent for some tools, a string for denials).
 */
export interface ToolOutput {
  content: unknown;
  /** `toolUseResult`; undefined when the line has none. */
  structured: unknown;
}

/**
 * T3 readToolOutputImage: an image block with a base64 source, or with its own mimeType (the
 * shape of an image whose data is not inline). T3 also requires a raster MIME type; any string
 * passes here.
 */
function isImageBlock(block: unknown): boolean {
  const record = asRecord(block);
  if (record === undefined || record.type !== "image") return false;
  const source = asRecord(record.source);
  if (record.source !== undefined) return source?.type === "base64" && typeof source.media_type === "string";
  return typeof record.mimeType === "string";
}

function outputBlocks(value: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (record !== undefined && Array.isArray(record.content)) return record.content;
  return [value];
}

function hasOutputImages(value: unknown): boolean {
  return outputBlocks(value).some(isImageBlock);
}

function mcpToolResultOutput(result: { content?: unknown; structuredContent?: unknown }): unknown {
  const sc = result.structuredContent;
  const structuredContent = (Array.isArray(sc) || asRecord(sc) !== undefined) && Object.keys(sc as object).length === 0 ? undefined : sc;
  if (structuredContent != null && hasOutputImages(result.content)) {
    return { content: result.content, structuredContent };
  }
  return structuredContent ?? result.content;
}

/** T3 claudeNativeToolOutputValue over the transcript pair. */
export function claudeToolOutputValue(output: ToolOutput): unknown {
  if (output.structured === undefined) return output.content;
  if (!hasOutputImages(output.structured)) {
    return mcpToolResultOutput({ content: output.content, structuredContent: output.structured });
  }
  return output.structured;
}

export function claudeToolOutputText(output: ToolOutput): string {
  const value = claudeToolOutputValue(output);
  return typeof value === "string" ? value : value === undefined ? "" : jsonStringifyForTool(value);
}

export function claudeCommandOutputText(output: ToolOutput): string {
  const value = claudeToolOutputValue(output);
  const record = asRecord(value);
  if (record !== undefined) {
    const stdout = record.stdout;
    const stderr = record.stderr;
    if (typeof stdout === "string" || typeof stderr === "string") {
      const out = typeof stdout === "string" && stdout.trim().length > 0 ? stdout : "";
      const err = typeof stderr === "string" && stderr.trim().length > 0 ? stderr : "";
      // Claude trims each stream's trailing newline, so stderr may need one to start its line.
      const text = out.length > 0 && err.length > 0 && !out.endsWith("\n") ? `${out}\n${err}` : out + err;
      if (text.length > 0) return text;
      return output.structured !== undefined && output.content !== undefined
        ? claudeSubagentResultText({ content: output.content, structured: undefined })
        : "";
    }
  }
  return claudeToolOutputText(output);
}

interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

function isPatchHunk(value: unknown): value is PatchHunk {
  const r = asRecord(value);
  return (
    r !== undefined &&
    typeof r.oldStart === "number" &&
    typeof r.oldLines === "number" &&
    typeof r.newStart === "number" &&
    typeof r.newLines === "number" &&
    Array.isArray(r.lines) &&
    r.lines.every((line) => typeof line === "string")
  );
}

interface FileEditResult {
  type?: string;
  filePath: string;
  content?: string;
  structuredPatch: PatchHunk[];
}

function asFileEditResult(value: unknown): FileEditResult | undefined {
  const r = asRecord(value);
  if (r === undefined || typeof r.filePath !== "string" || !Array.isArray(r.structuredPatch)) return undefined;
  if (!r.structuredPatch.every(isPatchHunk)) return undefined;
  if (r.type !== undefined && typeof r.type !== "string") return undefined;
  if (r.content !== undefined && typeof r.content !== "string") return undefined;
  return r as unknown as FileEditResult;
}

/** The hunks of a new file, as jsdiff structuredPatch("/dev/null", path, "", content) makes them. */
function createHunks(content: string): PatchHunk[] {
  if (content.length === 0) return [];
  const endsWithNewline = content.endsWith("\n");
  const body = endsWithNewline ? content.slice(0, -1) : content;
  const lines = body.split("\n").map((line) => `+${line}`);
  const count = lines.length;
  if (!endsWithNewline) lines.push("\\ No newline at end of file");
  return [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: count, lines }];
}

/** jsdiff 9 formatPatch(patch, FILE_HEADERS_ONLY): a zero-length side prints start - 1. */
export function formatHunks(oldFileName: string, newFileName: string, hunks: PatchHunk[]): string {
  let text = `--- ${oldFileName}\n+++ ${newFileName}\n`;
  for (const h of hunks) {
    const oldStart = h.oldLines === 0 ? h.oldStart - 1 : h.oldStart;
    const newStart = h.newLines === 0 ? h.newStart - 1 : h.newStart;
    text += `@@ -${oldStart},${h.oldLines} +${newStart},${h.newLines} @@\n`;
    for (const line of h.lines) text += `${line}\n`;
  }
  return text;
}

export interface FileChangeText {
  diffStr: string;
  additions?: number;
  deletions?: number;
}

export function claudeFileChangeText(output: ToolOutput): FileChangeText {
  const result = asFileEditResult(output.structured);
  if (result === undefined) return { diffStr: claudeToolOutputText(output) };
  const isCreate = result.structuredPatch.length === 0 && result.type === "create" && result.content !== undefined;
  const hunks = isCreate ? createHunks(result.content ?? "") : result.structuredPatch;
  if (hunks.length === 0) return { diffStr: "" };
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
  }
  const oldName = isCreate ? "/dev/null" : result.filePath;
  return { diffStr: formatHunks(oldName, result.filePath, hunks), additions, deletions };
}

// Claude Code prefixes foreground Agent results with a note for the parent model, not the report.
const CLAUDE_TOOLS_USED_NOTE = /^\s*<tools-used-before-summary>[^<]*<\/tools-used-before-summary>\s*/;

export function claudeSubagentResultText(output: ToolOutput): string {
  return claudeSubagentRawResultText(output).replace(CLAUDE_TOOLS_USED_NOTE, "");
}

function claudeSubagentRawResultText(output: ToolOutput): string {
  const value = claudeToolOutputValue(output);
  const record = asRecord(value);
  const content = Array.isArray(value) ? value : record !== undefined && "content" in record ? record.content : undefined;
  if (Array.isArray(content)) {
    const text = content
      .flatMap((part) => {
        const p = asRecord(part);
        return p !== undefined && p.type === "text" && typeof p.text === "string" ? [p.text] : [];
      })
      .join("\n");
    if (text.length > 0) {
      return text;
    }
  }
  return claudeToolOutputText(output);
}

export function isClaudeSubagentAsyncLaunchAck(output: ToolOutput): boolean {
  const record = asRecord(claudeToolOutputValue(output));
  if (record !== undefined) {
    if (record.isAsync === true) return true;
    if (record.status === "async_launched") return true;
  }
  return claudeSubagentResultText(output).startsWith("Async agent launched successfully.");
}

function isClaudeWebSearchOutput(output: unknown): output is { query: string; results: unknown[] } {
  const r = asRecord(output);
  return r !== undefined && typeof r.query === "string" && Array.isArray(r.results) && typeof r.durationSeconds === "number";
}

export function webSearchPatternsFromClaudeTool(input: unknown, output: ToolOutput | null): string[] {
  const value = output === null ? undefined : claudeToolOutputValue(output);
  const pattern = firstStringInputField(input, ["query", "url", "pattern"]) ?? (isClaudeWebSearchOutput(value) ? value.query : undefined);
  return pattern === undefined || pattern.trim().length === 0 ? [] : [pattern];
}

/**
 * A WebFetch result as one result row: the URL, the model's answer about the page as the snippet
 * (`toolUseResult.result`, else the tool_result text), and the fetch facts the CLI records in
 * `toolUseResult` (DESIGN.md 6i). null when there is nothing to show.
 */
export function webFetchResultFromClaudeOutput(input: unknown, output: ToolOutput): OrchestrationV2WebSearchResult | null {
  const s = asRecord(output.structured);
  const url = firstStringInputField(input, ["url"]) ?? (typeof s?.url === "string" ? s.url : undefined);
  const answer = typeof s?.result === "string" ? s.result : claudeToolOutputText(output);
  const out: OrchestrationV2WebSearchResult = {};
  if (answer.trim().length > 0) out.snippet = answer;
  for (const k of ["bytes", "code", "durationMs"] as const) {
    const v = s?.[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  if (typeof s?.codeText === "string") out.codeText = s.codeText;
  if (Object.keys(out).length === 0) return null;
  return url === undefined ? out : { url, ...out };
}

export function webSearchResultsFromClaudeOutput(output: ToolOutput): Array<{ title?: string; url?: string; snippet?: string }> {
  const value = claudeToolOutputValue(output);
  if (!isClaudeWebSearchOutput(value)) return [];
  return value.results.flatMap((result) => {
    const r = asRecord(result);
    if (r === undefined || !Array.isArray(r.content)) return [];
    return r.content.flatMap((content) => {
      const c = asRecord(content);
      if (c === undefined) return [];
      return [{ ...(typeof c.title === "string" ? { title: c.title } : {}), ...(typeof c.url === "string" ? { url: c.url } : {}) }];
    });
  });
}
