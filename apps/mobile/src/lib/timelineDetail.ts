// What an opened tool row shows: the web's rules for whether a row opens (WorkEntryLogRow's
// canExpandProjectedItem) and the sections its inspector draws per item type (V2ItemInspector),
// as plain blocks the app's row view draws. The text helpers are the web's own (itemDetail.ts,
// MessagesTimeline.logic.ts, TimelineWorkEntryRow.logic.ts); this module only arranges them.
import type { OrchestrationV2TurnItem } from "@maru/shared";
import { isJsonToolText, toolCallLines, turnItemHasDetail, turnItemOutputText } from "../../../web/src/client-runtime/work-log/itemDetail.ts";
import { toolGroupAction } from "../../../web/src/client-runtime/work-log/presentation.ts";
import { formatWorkspaceRelativePath } from "../../../web/src/filePathDisplay.ts";
import { claudeSkillInvocation } from "../../../web/src/t3-shared/toolActivity.ts";
import { workEntryReadOutput } from "../../../web/src/components/chat/MessagesTimeline.logic.ts";
import { buildToolCallExpandedBody, workEntryRawCommand } from "../../../web/src/components/chat/TimelineWorkEntryRow.logic.ts";
import type { TimelineWorkEntry } from "./timeline.ts";

/** Only web links open from a search result (web V2ItemInspector resolveExternalWebLinkHref). */
export function externalWebHref(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * One section of an opened row, in the kinds the web's inspector draws (V2ItemInspector):
 * command   a command or a search pattern, monospace at 85%
 * args      a tool's `key value` lines: the key muted, the value at 85% (a JSON value is flagged)
 * output    tool output and notice text, monospace muted (85% when it is a JSON document)
 * plain     a read's file text or a skill's arguments, monospace muted
 * failure   an exit code in the error color
 * path      a changed file's path with its +/- counts
 * changes   a file change's operations, one per line
 * diff      a unified diff, drawn line by line with +/- colors
 * markdown  reasoning
 * files     a file search's hits: `path:line:column` and the matching line
 * web       a web search's hits: title, the link when it is a web address, and the snippet
 */
export type DetailBlock =
  | { kind: "command" | "output" | "plain" | "failure" | "diff" | "markdown"; text: string; json?: boolean }
  | { kind: "args"; items: Array<{ key: string; value: string; json: boolean }> }
  | { kind: "path"; text: string; counts: { add: string; del: string } | null }
  | { kind: "changes"; items: string[] }
  | { kind: "files"; items: Array<{ label: string; preview?: string }> }
  | { kind: "web"; items: Array<{ title: string; href: string | null; snippet?: string }> };

/** JSON objects and arrays; a bare `14` or `true` from a command is just output (web V2ItemInspector isJsonDocumentText). */
export function isJsonDocumentText(text: string): boolean {
  return /^\s*[[{]/.test(text) && isJsonToolText(text);
}

const DIFF_COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** Read output and a skill's arguments replace the inspector, as on the web. */
function plainOutput(entry: TimelineWorkEntry, workspaceRoot: string | undefined): string | null | undefined {
  if (toolGroupAction(entry) === "read") return workEntryReadOutput(entry, workspaceRoot);
  const payload = entry.structuredPayload;
  const skill = payload?.type === "dynamic_tool" ? claudeSkillInvocation(payload.toolName, payload.input) : undefined;
  return skill ? (skill.args ?? null) : undefined;
}

/** Whether tapping the row opens it (web WorkEntryLogRow canExpandProjectedItem). */
export function workEntryCanOpen(entry: TimelineWorkEntry, workspaceRoot: string | undefined, previewText: string): boolean {
  const plain = plainOutput(entry, workspaceRoot);
  if (plain !== undefined) return Boolean(plain || entry.questionAnswer);
  const item = entry.projectedItem?.item;
  if (item === undefined) {
    return (
      previewText.trim().length > 0 ||
      (entry.itemType === "dynamic_tool" && entry.toolData !== undefined) ||
      Boolean(workEntryRawCommand(entry) || entry.command?.trim() || entry.detail?.trim() || entry.changedFiles?.length)
    );
  }
  if (entry.itemType === "reasoning") return Boolean(entry.detail?.trim());
  return Boolean(entry.questionAnswer || entry.projectedItem?.x?.body?.trim() || turnItemHasDetail(item));
}

/** The sections of an opened row, in the inspector's order. Empty when there is nothing to show. */
export function workEntryDetail(entry: TimelineWorkEntry, workspaceRoot: string | undefined, previewText: string): DetailBlock[] {
  if (entry.itemType === "reasoning") return entry.detail?.trim() ? [{ kind: "markdown", text: entry.detail }] : [];
  const plain = plainOutput(entry, workspaceRoot);
  if (plain !== undefined) return plain ? [{ kind: "plain", text: plain }] : [];
  const projected = entry.projectedItem;
  if (projected === undefined) {
    const body = buildToolCallExpandedBody(entry, workspaceRoot, previewText, null);
    return body ? [{ kind: "plain", text: body }] : [];
  }
  const blocks = itemBlocks(projected.item, workspaceRoot);
  const body = projected.x?.body?.trim();
  const item = projected.item;
  if (body && (item.type === "system_notice" || item.type === "notification")) {
    const shown = (item.type === "system_notice" ? item.message : item.detail)?.trim();
    if (body !== shown) blocks.push({ kind: "output", text: body });
  }
  return blocks;
}

function push(blocks: DetailBlock[], kind: "command" | "output" | "markdown", text: string | null | undefined): void {
  if (text && text.trim()) blocks.push(kind === "output" ? { kind, text, json: isJsonDocumentText(text) } : { kind, text });
}

/** Tool input as the inspector lists it: the command, `key value` lines, or the raw value. */
function callBlocks(blocks: DetailBlock[], input: { command?: string; args?: unknown }): void {
  const call = toolCallLines(input);
  if (call.command) blocks.push({ kind: "command", text: call.command });
  if (call.args) blocks.push({ kind: "args", items: call.args.map(([key, value]) => ({ key, value, json: isJsonDocumentText(value) })) });
  push(blocks, "output", call.argsText);
}

function itemBlocks(item: OrchestrationV2TurnItem, workspaceRoot: string | undefined): DetailBlock[] {
  const blocks: DetailBlock[] = [];
  switch (item.type) {
    case "reasoning":
      push(blocks, "markdown", item.text);
      break;
    case "command_execution":
      callBlocks(blocks, { command: item.input });
      push(blocks, "output", turnItemOutputText(item));
      if (item.exitCode !== undefined && item.exitCode !== 0) blocks.push({ kind: "failure", text: `exit ${item.exitCode}` });
      break;
    case "file_change": {
      const counted = item.additions !== undefined || item.deletions !== undefined;
      blocks.push({
        kind: "path",
        text: formatWorkspaceRelativePath(item.fileName, workspaceRoot),
        counts: counted ? { add: `+${DIFF_COUNT_FORMAT.format(item.additions ?? 0)}`, del: `-${DIFF_COUNT_FORMAT.format(item.deletions ?? 0)}` } : null,
      });
      if (item.diffStr?.trim()) blocks.push({ kind: "diff", text: item.diffStr });
      if (item.changes?.length) {
        blocks.push({
          kind: "changes",
          items: item.changes.map(
            (c) =>
              `${c.operation} ${c.oldPath ? `${c.oldPath} -> ` : ""}${formatWorkspaceRelativePath(c.path, workspaceRoot)}${
                c.fileType || c.mimeType ? ` (${[c.fileType, c.mimeType].filter(Boolean).join(", ")})` : ""
              }`,
          ),
        });
      }
      break;
    }
    case "file_search":
      push(blocks, "command", item.pattern);
      if (item.results?.length) {
        blocks.push({
          kind: "files",
          items: item.results.map((r) => ({
            label: `${formatWorkspaceRelativePath(r.fileName, workspaceRoot)}${r.line === undefined ? "" : `:${r.line}`}${r.column === undefined ? "" : `:${r.column}`}`,
            ...(r.preview?.trim() ? { preview: r.preview } : {}),
          })),
        });
      }
      break;
    case "web_search":
      push(blocks, "command", item.patterns?.join("\n"));
      if (item.results?.length) {
        blocks.push({
          kind: "web",
          items: item.results.map((r) => ({
            title: r.title ?? r.url ?? "Search result",
            href: externalWebHref(r.url),
            ...(r.snippet ? { snippet: r.snippet } : {}),
          })),
        });
      }
      break;
    case "dynamic_tool":
      callBlocks(blocks, { args: item.input });
      push(blocks, "output", turnItemOutputText(item));
      break;
    case "approval_request":
      push(blocks, "output", item.prompt);
      break;
    case "user_input_request":
      push(
        blocks,
        "output",
        item.questions.map((q) => [q.question, ...q.options.map((o) => `- ${o.label}`)].join("\n")).join("\n\n"),
      );
      break;
    case "notification":
      push(blocks, "output", item.detail);
      break;
    case "system_notice":
      push(blocks, "output", item.message);
      break;
    case "error":
      push(blocks, "output", item.failure.message);
      break;
    case "todo_list":
      push(
        blocks,
        "output",
        item.steps.map((s) => `${s.status === "completed" ? "✓" : s.status === "running" ? "◉" : "○"} ${s.text}`).join("\n"),
      );
      break;
    default:
      break;
  }
  return blocks;
}
