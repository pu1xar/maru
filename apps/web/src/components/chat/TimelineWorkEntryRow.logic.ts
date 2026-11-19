// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/TimelineWorkEntryRow.logic.ts
// Local changes: the compact reasoning preview flattens markdown with a plain text pass
// (`thoughtPreviewText`) instead of T3's remark plugin, because ChatMarkdown here takes no extra
// remark plugins. The expanded body heading reads "Tool 입력".
import {
  resolveWorkEntryToolPresentation,
  toolGroupAction,
} from "../../client-runtime/work-log/presentation.ts";
import { isJavaScriptReplTool } from "../../t3-shared/toolActivity.ts";
import { formatWorkspaceRelativePath } from "../../filePathDisplay.ts";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic.ts";

// The row types come from the pure timeline logic (not timelineRowContext.ts, which holds React
// contexts) so this file imports no React, DOM or alias module: the Android app shares it.
type TimelineRow = MessagesTimelineRow;
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];

/** The named tool icons; TimelineToolActivityIcon.tsx draws each with a lucide glyph. */
export type WorkEntryIconName =
  | "bot"
  | "brain"
  | "browser"
  | "check"
  | "list-todo"
  | "circle-alert"
  | "computer"
  | "code"
  | "device"
  | "eye"
  | "globe"
  | "hammer"
  | "message-circle"
  | "search"
  | "square-pen"
  | "terminal"
  | "pull-request"
  | "t3-code"
  | "wrench"
  | "x"
  | "zap";

export function toolGroupSummaryIconName(
  kind: Extract<TimelineRow, { kind: "work-toggle" }>["summaryKind"],
): WorkEntryIconName {
  switch (kind) {
    case "pull-request":
    case "link-pr":
    case "unlink-pr":
    case "list-prs":
    case "watch-pr":
    case "unwatch-pr":
      return "pull-request";
    case "read":
      return "eye";
    case "edit":
      return "square-pen";
    case "command":
      return "terminal";
    case "thread-create":
      return "t3-code";
    case "browser":
      return "browser";
    case "device":
      return "device";
    case "search":
      return "globe";
    case "code-search":
      return "search";
    case "other":
      return "wrench";
    case "dynamic-tool":
      return "hammer";
    case "reasoning":
      return "brain";
    case "agent-tool":
      return "bot";
    case "tone-tool":
      return "zap";
    case "update":
    case "mixed":
      return "hammer";
  }
}

export function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  iconName: WorkEntryIconName;
  className: string;
} {
  if (tone === "error") {
    return { iconName: "circle-alert", className: "text-foreground/92" };
  }
  if (tone === "thinking") {
    return { iconName: "brain", className: "text-icon-muted" };
  }
  if (tone === "info") {
    return { iconName: "check", className: "text-muted-foreground" };
  }
  return { iconName: "zap", className: "text-foreground/92" };
}

export function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

export function buildToolCallExpandedBody(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
  visibleLabel: string,
  viewedImagePath: string | null,
): string | null {
  const blocks: string[] = [];
  const seen = new Set<string>([visibleLabel.trim()]);
  const addBlock = (value: string | null | undefined) => {
    const text = value?.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    blocks.push(text);
  };
  if (workEntry.itemType === "dynamic_tool" && workEntry.toolData !== undefined) {
    const input =
      workEntry.structuredPayload?.type === "dynamic_tool"
        ? workEntry.structuredPayload.input
        : workEntry.toolData !== null &&
            typeof workEntry.toolData === "object" &&
            "input" in workEntry.toolData
          ? workEntry.toolData.input
          : undefined;
    if (input !== undefined) addBlock(`Tool input\n${JSON.stringify(input, null, 2)}`);
  }
  const command = workEntry.command?.trim();
  const raw = workEntryRawCommand(workEntry);
  if (command === visibleLabel.trim()) {
    seen.add(command);
  } else {
    addBlock(raw ?? command);
  }
  const detail = workEntry.detail?.trim();
  if (detail !== viewedImagePath?.trim()) {
    addBlock(detail);
  }
  const viewedImagePaths = new Set(
    viewedImagePath
      ? [viewedImagePath.trim(), formatWorkspaceRelativePath(viewedImagePath, workspaceRoot)]
      : [],
  );
  const changedFiles = (workEntry.changedFiles ?? []).flatMap((filePath) => {
    const formattedPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
    return viewedImagePaths.has(filePath) ||
      viewedImagePaths.has(formattedPath) ||
      filePath.trim() === detail ||
      formattedPath === detail
      ? []
      : [formattedPath];
  });
  if (changedFiles.length > 0) {
    addBlock([...new Set(changedFiles)].join("\n"));
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

export function workEntryIconName(workEntry: TimelineWorkEntry): WorkEntryIconName {
  if (workEntry.structuredPayload?.type === "notification") {
    if (workEntry.structuredPayload.outcome === "failed") return "circle-alert";
    const source = workEntry.structuredPayload.source;
    switch (source.kind) {
      case "subagent":
      case "delegated_task":
        return "bot";
      case "command":
        return "terminal";
      case "monitor":
        return "eye";
      case "background_task":
        return "zap";
      case "system":
        return "t3-code";
      default:
        source satisfies never;
        return "zap";
    }
  }
  if (workEntry.itemType === "system_notice") {
    return workEntry.structuredPayload?.type === "system_notice" &&
      workEntry.structuredPayload.level === "info"
      ? "zap"
      : "circle-alert";
  }
  if (workEntry.itemType === "user_input_request" || workEntry.itemType === "approval_request") {
    return "message-circle";
  }
  if (workEntry.itemType === "todo_list") return "list-todo";
  if (
    workEntry.structuredPayload?.type === "dynamic_tool" &&
    isJavaScriptReplTool(workEntry.structuredPayload.toolName)
  )
    return "code";
  const toolPresentation = resolveWorkEntryToolPresentation(workEntry);
  if (toolPresentation) return toolPresentation.icon as WorkEntryIconName;
  const action = toolGroupAction(workEntry);
  if (action !== "other") return toolGroupSummaryIconName(action);

  switch (workEntry.itemType) {
    case "dynamic_tool":
      return "wrench";
    case "subagent":
      return "bot";
  }

  return workToneIcon(workEntry.tone).iconName;
}

// Look past the visible label so long destinations and inline delimiters can close.
export const THOUGHT_PREVIEW_SOURCE_MAX_LENGTH = 8_192;
export const THOUGHT_PREVIEW_MAX_LENGTH = 2_048;

/**
 * Compact reasoning flattened into one line of label text, like T3's remarkThoughtPreview:
 * block structure becomes spaces and inline markers drop away. Falls back when nothing is left.
 */
export function thoughtPreviewText(markdown: string, fallback: string): string {
  const text = markdown
    .slice(0, THOUGHT_PREVIEW_SOURCE_MAX_LENGTH)
    // Fenced code keeps its body, loses the fence lines.
    .replace(/^\s*(```|~~~)[^\n]*$/gm, " ")
    // Images keep their alt text, links their label.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // Headings, quotes and list markers at line starts.
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    // Inline code keeps its content as it is (a `~~` or `**` span is the text itself); outside code,
    // strong markers go. Single `*` and `_` stay: identifiers use them. Tildes stay: the
    // conversation renders no strikethrough (markdownPipeline.ts remarkTildesAsText).
    .split(/(`+[^`]*?`+)/)
    .map((part) => (/^`+[^`]*?`+$/.test(part) ? part.replace(/^`+|`+$/g, "") : part.replace(/(\*\*|__)/g, "")))
    .join("")
    // Raw HTML tags.
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, THOUGHT_PREVIEW_MAX_LENGTH)
    // A cut must not leave half a surrogate pair.
    .replace(/[\uD800-\uDBFF]$/, "");
  return text || fallback;
}
