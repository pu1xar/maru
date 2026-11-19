// The conversation drawing's decisions that are plain data: which space follows a row, how a
// subagent card reads (time, status word, provider), what a user's bubble holds, when it folds, when
// the jump-to-end button shows, how a diff is laid out. React Native-free so node tests run them;
// components/timeline/ only draws what these return.
import type { OrchestrationV2TurnItemStatus } from "@maru/shared";
import type { ChatMessage } from "../../../web/src/types.ts";
import { withAlpha } from "../components/markdownModel.ts";
import { formatElapsedSeconds } from "../../../web/src/components/chat/agentElapsed.logic.ts";
import { parseUnifiedDiff, type DiffLineType } from "../../../web/src/components/chat/diffView.logic.ts";
import { subagentGroupTiming } from "../../../web/src/components/chat/TimelineV2EventRow.logic.ts";
import { userMessageFenceText } from "../../../web/src/components/chat/userMessageFences.ts";
import { formatWorkspaceRelativePath } from "../../../web/src/filePathDisplay.ts";
import { sentMessageAttachments, type SentAttachment } from "../../../web/src/lib/composerAttachments.logic.ts";
import { deriveSubagentElapsedMs } from "../../../web/src/t3-shared/orchestrationTiming.ts";
import { DEFAULT_TIMESTAMP_FORMAT, formatDayAwareTimestamp } from "../../../web/src/timestampFormat.ts";

export { withAlpha, subagentGroupTiming };

/** Space under a work log part (web WorkLogBlock: a standalone line 8, an open group's content 4). */
export function workLogGap(row: { continuesWorkLog?: boolean | undefined; layout: "standalone" | "group-header" | "group-content" }): number {
  if (row.continuesWorkLog || row.layout === "group-header") return 0;
  return row.layout === "group-content" ? 4 : 8;
}

/** The opacity of a nested work row's line until it is opened (index.css --work-group-entry-opacity). */
export function groupEntryOpacity(scheme: "light" | "dark" | null | undefined): number {
  return scheme === "light" ? 0.85 : 0.75;
}

/** A nested row's indent in an open tool group (web ps-7, 1.75rem). */
export const GROUP_INDENT = 28;

// ---- subagent cards

const ACTIVE = new Set<string>(["pending", "running", "waiting"]);

export function isSubagentActive(status: string): boolean {
  return ACTIVE.has(status);
}

/** `45s`, `3m 05s`, `1h 24m` of a subagent's run, or null while it has no start (or no end yet when settled). */
export function subagentElapsedText(
  agent: { status: OrchestrationV2TurnItemStatus; startedAt: string | null; completedAt: string | null },
  nowMs: number,
): string | null {
  const ms = deriveSubagentElapsedMs(agent, nowMs);
  return ms === null ? null : formatElapsedSeconds(ms / 1000);
}

/** The provider word before a card's title (web DRIVER_NAMES); null for a driver the app cannot name. */
export function subagentProviderLabel(driver: string | undefined): string | null {
  return driver === "claude" ? "Claude" : driver === "codex" ? "Codex" : null;
}

/**
 * The two texts of a card: the line under the title, and the status word at the right (web
 * SubagentCard). A card with nothing else to say shows the status under the title; one with a detail
 * names an unfinished status beside the time.
 */
export function subagentCardTexts(input: { statusLabel: string; detail: string | null; status: string }): { sub: string; word: string | null } {
  if (input.detail === null) return { sub: input.statusLabel, word: null };
  return { sub: input.detail, word: input.status === "completed" ? null : input.statusLabel };
}

export type SubagentDotRole = "info" | "ok" | "danger" | "muted";

/** The status dot's color role (web STATUS_DOT_CLASS: running is info, done is success). */
export function subagentDotRole(status: string): SubagentDotRole {
  if (isSubagentActive(status)) return "info";
  if (status === "completed") return "ok";
  if (status === "failed") return "danger";
  return "muted";
}

// ---- messages

/** The assistant's status pill words (web ASSISTANT_STATUS_LABEL). */
export const ASSISTANT_STATUS_LABEL: Record<OrchestrationV2TurnItemStatus, string> = {
  idle: "Idle",
  pending: "Pending",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

const USER_MESSAGE_STATUS_LABEL: Record<string, string> = {
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  running: "Processing",
  idle: "Idle",
};

/** The pill under an answer: any status but a finished one (web AssistantMessageMeta). */
export function assistantStatusPill(status: OrchestrationV2TurnItemStatus | undefined): string | null {
  return status === undefined || status === "completed" ? null : ASSISTANT_STATUS_LABEL[status];
}

/** The pill under the user's bubble: a message that failed or stopped (web UserMessageProjectedStatus). */
export function userStatusPill(status: string | undefined): string | null {
  if (status === undefined || status === "completed" || status === "pending" || status === "waiting") return null;
  return USER_MESSAGE_STATUS_LABEL[status] ?? status;
}

/** The time under an answer: the clock today, "Yesterday 14:03" yesterday, the date before (web formatDayAwareTimestamp). */
export function messageTimeLabel(iso: string, nowMs: number = Date.now()): string {
  return formatDayAwareTimestamp(iso, DEFAULT_TIMESTAMP_FORMAT, nowMs);
}

/** A bubble folds to this height (web max-h-44, 11rem). */
export const USER_MESSAGE_FOLDED_HEIGHT = 176;

/** A message folds only when opening it at least doubles what shows (web useTallEnoughToFold). */
export function userMessageFolds(contentHeight: number): boolean {
  return contentHeight >= USER_MESSAGE_FOLDED_HEIGHT * 2;
}

/**
 * The markdown a user's bubble draws: code fences typed inside a sentence moved onto their own
 * lines (web userMessageFenceText), and a single line break kept as a break (web lineBreaks). Lines
 * inside a fence keep their ends.
 */
export function userMessageMarkdown(text: string): string {
  const lines = userMessageFenceText(text).split("\n");
  let fence: string | null = null;
  return lines
    .map((line, i) => {
      const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence === null) {
        if (opener) {
          fence = opener;
          return line;
        }
      } else {
        const closes = opener !== undefined && opener[0] === fence[0] && opener.length >= fence.length && line.trim() === opener;
        if (closes) fence = null;
        return line;
      }
      const next = lines[i + 1];
      const joins = line.trim() !== "" && next !== undefined && next.trim() !== "";
      return joins && !line.endsWith("  ") ? `${line}  ` : line;
    })
    .join("\n");
}

/** A sent message split into its text and its attachments, the notes at the end of the text removed. */
export function userMessageParts(
  message: Pick<ChatMessage, "text" | "attachments">,
  shownText: string,
  data: Parameters<typeof sentMessageAttachments>[2],
): { text: string; attachments: SentAttachment[] } {
  return sentMessageAttachments(shownText, message.attachments ?? [], data);
}

// ---- the list

/** Past this many dp above the newest row, the jump-to-end button shows. */
export const JUMP_TO_END_OFFSET = 320;

export function showJumpToEnd(offsetY: number): boolean {
  return offsetY > JUMP_TO_END_OFFSET;
}

/** Whether the send counter moved since the list last saw it, which sends the list to its end. */
export function sendMovedList(seen: number | undefined, now: number | undefined): boolean {
  return seen !== undefined && now !== undefined && now !== seen;
}

// ---- detail blocks

export type DiffDisplayRow =
  | { kind: "line"; type: DiffLineType; oldNumber: number | null; newNumber: number | null; text: string }
  | { kind: "note"; text: string };

/** A unified diff as the rows the app draws: numbered +/- lines and plain notes (web DiffView). */
export function diffDisplayRows(diff: string): { rows: DiffDisplayRow[]; numberDigits: number } {
  const parsed = parseUnifiedDiff(diff);
  const rows: DiffDisplayRow[] = [];
  for (const row of parsed.rows) {
    if (row.kind === "line") rows.push({ kind: "line", type: row.type, oldNumber: row.oldNumber, newNumber: row.newNumber, text: row.text });
    else if (row.kind === "file") {
      if (parsed.fileCount > 1) rows.push({ kind: "note", text: formatWorkspaceRelativePath(row.path, undefined) });
    } else rows.push({ kind: "note", text: row.text });
  }
  return { rows, numberDigits: Math.max(2, String(parsed.maxLineNumber).length) };
}

/** The wash behind a diff line: added in the success color, removed in the error color, 10%. */
export function diffLineTint(type: DiffLineType, colors: { ok: string; danger: string }): string | undefined {
  if (type === "add") return withAlpha(colors.ok, 0.1);
  if (type === "del") return withAlpha(colors.danger, 0.1);
  return undefined;
}

/** A failed tool's icon: the error color at 40% (web tool-error-icon). */
export function failedToolIconColor(danger: string): string {
  return withAlpha(danger, 0.4);
}
