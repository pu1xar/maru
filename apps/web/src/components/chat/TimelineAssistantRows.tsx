// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/TimelineAssistantRows.tsx
// Local changes: read-only viewer. Citations, fork and reply buttons, the changed files card,
// html renders, sent messages and MCP apps are gone. The streamed text is the row's message text
// (T3 reads it from a per-row atom). The status badge shows Korean words. UI text is Korean.
// The copy button is always shown: T3 shows it on hover only for an answer that ends its turn
// and always for one followed by tool groups, so the latest answer hid it (user report). The
// answer's time sits in the timeline's left gutter (MessagesTimeline); when the frame is too
// narrow for the gutter, the meta row shows it after the copy button, where T3 puts it.
import type { OrchestrationV2TurnItemStatus } from "@maru/shared";
import { use } from "react";

import { cn } from "~/lib/utils";
import { shouldPreserveAssistantLineBreaks } from "../../t3-shared/markdownPipeline.ts";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import type { ChatMessage } from "../../types.ts";
import ChatMarkdown from "../ChatMarkdown";
import { MessageCopyButton } from "./MessageCopyButton";
import { resolveAssistantMessageCopyState } from "./MessagesTimeline.logic";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";
import { MESSAGE_HEADING_LEVEL, MessageAuthorHeading, UncopiedText } from "./TimelineRowParts";

const ASSISTANT_STATUS_LABEL: Record<OrchestrationV2TurnItemStatus, string> = {
  idle: "Idle",
  pending: "Pending",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const text = row.message.text;
  const messageText =
    text || (row.message.streaming || row.suppressEmptyResponse ? "" : "(empty response)");

  return (
    <div className="relative min-w-0 px-1 py-0.5">
      <MessageAuthorHeading>Assistant</MessageAuthorHeading>
      {/* The text a find in the thread looks into (DESIGN.md 6u). */}
      <div data-thread-find-text="">
        <ChatMarkdown
          text={messageText}
          renderInsights
          cwd={ctx.markdownCwd}
          isStreaming={Boolean(row.message.streaming)}
          lineBreaks={shouldPreserveAssistantLineBreaks(messageText)}
          headingLevelOffset={MESSAGE_HEADING_LEVEL}
        />
      </div>
      {!row.showAssistantMeta && row.projectedItem?.item.status === "interrupted" ? (
        <div className="mt-1.5 flex">
          <AssistantStatusBadge status="interrupted" />
        </div>
      ) : null}
      {row.showAssistantMeta ? (
        <AssistantMessageMeta
          className="mt-1.5"
          projectedItem={row.projectedItem}
          message={row.message}
          showCopyButton={row.showAssistantCopyButton}
          copyStreaming={row.assistantCopyStreaming}
        />
      ) : null}
    </div>
  );
}

export function AssistantMetaTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "assistant-meta" }>;
}) {
  return (
    <div className="px-1">
      <AssistantMessageMeta
        className="mt-0.5"
        projectedItem={row.projectedItem}
        message={row.message}
        showCopyButton={row.showAssistantCopyButton}
        copyStreaming={row.assistantCopyStreaming}
      />
    </div>
  );
}

function AssistantMessageMeta({
  className,
  projectedItem,
  message,
  showCopyButton,
  copyStreaming,
}: {
  className?: string;
  projectedItem?: Extract<TimelineRow, { kind: "message" }>["projectedItem"];
  message: ChatMessage;
  showCopyButton: boolean;
  copyStreaming: boolean;
}) {
  const { timestampFormat } = use(TimelineRowCtx);
  return (
    <div className={cn("flex items-center gap-2 text-xs tabular-nums", className)}>
      {projectedItem && projectedItem.item.status !== "completed" ? (
        <AssistantStatusBadge status={projectedItem.item.status} />
      ) : null}
      <AssistantCopyButton
        message={message}
        showCopyButton={showCopyButton}
        streaming={copyStreaming}
      />
      {message.streaming ? null : (
        <UncopiedText
          text={formatDayAwareTimestamp(message.createdAt, timestampFormat)}
          className="text-muted-foreground @min-[62rem]/frame:hidden"
          title={formatChatTimestampTooltip(message.createdAt, timestampFormat)}
          data-message-meta-time=""
        />
      )}
    </div>
  );
}

function AssistantStatusBadge({ status }: { status: OrchestrationV2TurnItemStatus }) {
  return (
    <UncopiedText
      text={ASSISTANT_STATUS_LABEL[status]}
      className="rounded-full border border-border/70 px-1.5 py-0.5 text-3xs text-muted-foreground"
    />
  );
}

function AssistantCopyButton({
  message,
  showCopyButton,
  streaming,
}: {
  message: ChatMessage;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: message.text ?? null,
    showCopyButton,
    streaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ""} variant="ghost" />;
}

export function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard planMarkdown={row.proposedPlan.planMarkdown} cwd={ctx.markdownCwd} />
    </div>
  );
}
