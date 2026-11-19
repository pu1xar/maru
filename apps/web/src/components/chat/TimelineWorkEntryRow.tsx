// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/TimelineWorkEntryRow.tsx
// Local changes: read-only viewer. Pending approvals, T3 thread-read links, created-thread links,
// workspace preparation retry, image previews and fetched tool output are gone (viewed images
// show as paths); the expanded body
// reads the item on the wire. The collapsed reasoning preview is plain text from
// `thoughtPreviewText` (ChatMarkdown here takes no extra remark plugins). A task notification
// that names a known subagent opens its child thread through the row context. A row inside an
// expanded tool group takes the group's smaller icon and text (WorkLog.tsx). UI text is Korean.
import {
  viewedImageUrls,
  type OrchestrationV2NotificationSource,
  type UserInputAttachmentAnswerPayload,
  type ViewedImage,
} from "@maru/shared";
import { ChevronRightIcon, CircleAlertIcon, ImageIcon, XIcon } from "lucide-react";
import { memo, use, useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { turnItemHasDetail } from "../../client-runtime/work-log/itemDetail.ts";
import { toolGroupAction } from "../../client-runtime/work-log/presentation.ts";
import {
  getQuestionAnswerPreview,
  getQuestionAnswerText,
  getQuestionTextPreview,
  hasQuestionAnswer,
} from "../../client-runtime/work-log/userInput.ts";
import {
  workEntryDisplayIndicatesToolFailure,
  workEntrySignalsSevereFailure,
  workLogEntryIsToolLike,
} from "../../session-logic.ts";
import { formatWorkspaceRelativePath } from "../../filePathDisplay.ts";
import { claudeSkillInvocation } from "../../t3-shared/toolActivity.ts";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { InlineButton } from "../ui/button";
import { BackgroundButton } from "./BackgroundButton";
import { ImagePreviewDialog } from "./ImagePreviewDialog";
import { workEntryDisplayLabel, workEntryReadOutput } from "./MessagesTimeline.logic";
import {
  TimelineRowActivityCtx,
  TimelineRowCtx,
  WorkGroupViewCtx,
  type TimelineRow,
  type TimelineWorkEntry,
} from "./timelineRowContext";
import { MESSAGE_HEADING_LEVEL, TimelineRowTimestamp } from "./TimelineRowParts";
import {
  failedToolIconClassName,
  toolIconAcceptsTint,
  ToolActivityIconView,
} from "./TimelineToolActivityIcon";
import {
  buildToolCallExpandedBody,
  thoughtPreviewText,
  workEntryIconName,
  workEntryRawCommand,
  workToneIcon,
} from "./TimelineWorkEntryRow.logic";
import { V2ItemInspector } from "./V2ItemInspector";
import { SubagentNotificationLink } from "./V2LifecycleRow";
import { useWorkLogIconSize, WorkLogDetails, WorkLogRow } from "./WorkLog";

const toolCallExpandedBodyClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-(length:--font-size-code,calc(var(--text-2xs)*var(--chat-code-ratio,1))) leading-relaxed select-text";

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

/** Source: packages/client-runtime/src/state/threadExecution.ts notificationChildThreadId. */
function notificationChildThreadId(source: OrchestrationV2NotificationSource): string | undefined {
  switch (source.kind) {
    case "subagent":
    case "delegated_task":
      return source.childThreadId;
    default:
      return undefined;
  }
}

export function ReasoningTraceContent({ entries }: { entries: ReadonlyArray<TimelineWorkEntry> }) {
  const ctx = use(TimelineRowCtx);
  const { isWorking, latestRunId } = use(TimelineRowActivityCtx);
  const isStreaming = (entry: TimelineWorkEntry) =>
    isWorking && entry.runId === latestRunId && entry.toolLifecycleStatus === "inProgress";
  return (
    <WorkLogDetails followLive={entries.some(isStreaming)}>
      {entries.map((entry) => (
        <ChatMarkdown
          key={entry.id}
          className="text-foreground"
          text={entry.detail ?? ""}
          cwd={ctx.markdownCwd}
          isStreaming={isStreaming(entry)}
          headingLevelOffset={MESSAGE_HEADING_LEVEL}
          lineBreaks
        />
      ))}
    </WorkLogDetails>
  );
}

type WorkEntryRowProps = {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  displayLabel?: string | undefined;
  onToggleEntry?: ((collapsed: boolean) => void) | undefined;
  onContentReady?: (() => void) | undefined;
};

export const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: WorkEntryRowProps) {
  const ctx = use(TimelineRowCtx);
  const item = props.workEntry.projectedItem?.item;
  const childThreadId =
    item?.type === "notification" ? notificationChildThreadId(item.source) : undefined;
  if (item?.type !== "notification" || childThreadId === undefined) {
    return <WorkEntryLogRow {...props} />;
  }
  return (
    <SubagentNotificationLink
      childThreadId={childThreadId}
      taskIds={item.source.kind === "delegated_task" ? item.source.taskIds : undefined}
      outcome={item.outcome}
      createdAt={props.workEntry.createdAt}
      timestampFormat={ctx.timestampFormat}
      onOpenThread={ctx.onOpenThread}
      fallback={<WorkEntryLogRow {...props} />}
    />
  );
});

/**
 * Images the agent opened in the tool group above (DESIGN.md 6e, "작업 행의 그림"). Each shows its
 * workspace path and, under it, the picture: the tool result's own copy from the transcript when it
 * carries one, else the file (viewedImageUrls). A click opens it large. A picture that cannot be
 * loaded leaves the path alone.
 */
export function ViewedImagesTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "viewed-images" }>;
}) {
  const { workspaceRoot } = use(TimelineRowCtx);
  return (
    <div className="flex flex-wrap items-start gap-2 px-0.5" data-image-gallery>
      {row.images.map((image) => {
        const name = formatWorkspaceRelativePath(image.path, workspaceRoot);
        return (
          <div key={image.path} className="flex min-w-0 max-w-full flex-col items-start gap-1.5">
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground">
              <ImageIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="min-w-0 wrap-anywhere">{name}</span>
            </span>
            <ViewedImagePreview image={image} name={name} />
          </div>
        );
      })}
    </div>
  );
}

function ViewedImagePreview(props: { image: ViewedImage; name: string }) {
  const urls = viewedImageUrls(props.image);
  // The next source is tried when one fails to load; the last failure hides the preview.
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const src = urls[attempt];
  if (src === undefined) return null;
  return (
    <>
      <button
        type="button"
        data-viewed-image=""
        aria-label={`Enlarge ${props.name}`}
        className="block max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-border/60 bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => setOpen(true)}
      >
        <img
          src={src}
          alt={props.name}
          decoding="async"
          loading="lazy"
          draggable={false}
          onError={() => setAttempt((n) => n + 1)}
          className="block h-auto max-h-64 w-auto max-w-[min(100%,28rem)] object-contain"
        />
      </button>
      {open ? (
        <ImagePreviewDialog images={[{ src, name: props.name }]} index={0} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function WorkEntryLogRow(props: WorkEntryRowProps) {
  const { workEntry, workspaceRoot, displayLabel } = props;
  const ctx = use(TimelineRowCtx);
  const { timestampFormat } = ctx;
  const notifiedSubagentThreadId =
    workEntry.projectedItem?.item.type === "notification"
      ? notificationChildThreadId(workEntry.projectedItem.item.source)
      : undefined;
  const groupView = use(WorkGroupViewCtx);
  const iconSize = useWorkLogIconSize();
  const [expanded, setExpanded] = useState(
    () => groupView?.state.expandedEntries.has(workEntry.id) ?? false,
  );
  const onInitialOutputReady = () => {
    if (groupView) groupView.onContentReady?.(workEntry.id);
    else props.onContentReady?.();
  };
  const toggleExpanded = () => {
    const next = !expanded;
    if (groupView) {
      groupView.onToggleEntry(!next, workEntry.id);
      if (next) groupView.state.expandedEntries.add(workEntry.id);
      else groupView.state.expandedEntries.delete(workEntry.id);
    } else {
      props.onToggleEntry?.(!next);
    }
    setExpanded(next);
  };
  const failureItem = workEntry.projectedItem?.item;
  if (failureItem?.type === "error" && failureItem.status === "failed") {
    const warning = failureItem.failure.class === "usage_limit";
    const resetAt = failureItem.failure.resetAt;
    // The reset time is the viewer's local time; naming the zone keeps it unambiguous.
    const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const resetTime = resetAt
      ? `${formatUpcomingTimestamp(resetAt, timestampFormat, undefined, timeZone)} (${timeZone})`
      : null;
    const label = warning
      ? `Usage limit reached${resetTime ? `. You can try again after ${resetTime}` : ""}`
      : workEntry.label;
    return (
      <WorkLogRow
        data-v2-item-type="error"
        data-v2-item-visibility={workEntry.projectedItem?.visibility}
        wrapLabel
        icon={
          <CircleAlertIcon
            className={cn("size-4", warning ? "text-warning" : "text-destructive")}
          />
        }
        label={
          <span
            className={cn("text-sm font-medium", warning ? "text-warning-foreground" : "text-destructive-foreground")}
          >
            {label}
          </span>
        }
        trailing={
          <TimelineRowTimestamp
            createdAt={workEntry.createdAt}
            timestampFormat={timestampFormat}
            alwaysVisible
          />
        }
      >
        {!warning ? (
          <p className="ms-7 whitespace-pre-wrap break-words py-1 text-sm leading-relaxed text-foreground/80">
            {failureItem.failure.message}
          </p>
        ) : null}
      </WorkLogRow>
    );
  }
  const iconConfig = workToneIcon(workEntry.tone);
  const showWarningIndicator = workEntry.sourceActivityKind === "runtime.warning";
  const showFailedIndicator =
    !showWarningIndicator && workEntryDisplayIndicatesToolFailure(workEntry);
  const showDestructiveRowStyle =
    !showWarningIndicator &&
    showFailedIndicator &&
    (workEntrySignalsSevereFailure(workEntry) || !workLogEntryIsToolLike(workEntry));
  const entryIconName =
    showWarningIndicator || showDestructiveRowStyle ? "circle-alert" : workEntryIconName(workEntry);
  const isReasoning = workEntry.itemType === "reasoning";
  // The question and answer previews are one plain line each: markdown marks would only clutter.
  const questionHeading = workEntry.questionAnswer
    ? thoughtPreviewText(getQuestionTextPreview(workEntry.questionAnswer), "")
    : "";
  const previewText =
    isReasoning && expanded
      ? workEntry.toolLifecycleStatus === "inProgress"
        ? "Thinking"
        : "Thought"
      : questionHeading || (displayLabel ?? workEntryDisplayLabel(workEntry, workspaceRoot));
  const answerPreview =
    workEntry.questionAnswer && hasQuestionAnswer(workEntry.questionAnswer)
      ? thoughtPreviewText(getQuestionAnswerPreview(workEntry.questionAnswer), "") || null
      : null;
  const payload = workEntry.structuredPayload;
  const skill =
    payload?.type === "dynamic_tool"
      ? claudeSkillInvocation(payload.toolName, payload.input)
      : undefined;
  const plainOutput =
    toolGroupAction(workEntry) === "read"
      ? workEntryReadOutput(workEntry, workspaceRoot)
      : skill
        ? (skill.args ?? null)
        : undefined;
  const canExpand =
    previewText.trim().length > 0 ||
    (workEntry.itemType === "dynamic_tool" && workEntry.toolData !== undefined) ||
    Boolean(
      workEntryRawCommand(workEntry) ||
      workEntry.command?.trim() ||
      workEntry.detail?.trim() ||
      workEntry.changedFiles?.length,
    );
  const expandedBody =
    expanded && !isReasoning
      ? plainOutput !== undefined
        ? plainOutput
        : buildToolCallExpandedBody(workEntry, workspaceRoot, previewText, null)
      : null;
  const noticeBody = workEntry.projectedItem?.x?.body?.trim();
  const canExpandProjectedItem =
    plainOutput !== undefined
      ? Boolean(plainOutput || workEntry.questionAnswer)
      : workEntry.projectedItem === undefined
        ? canExpand
        : isReasoning
          ? Boolean(workEntry.detail?.trim())
          : Boolean(
              workEntry.questionAnswer ||
              noticeBody ||
              turnItemHasDetail(workEntry.projectedItem.item),
            );
  const iconWrapperClass = cn(
    "flex items-center justify-center",
    iconSize,
    showWarningIndicator
      ? "text-warning"
      : showDestructiveRowStyle
        ? "text-destructive"
        : showFailedIndicator
          ? failedToolIconClassName
          : workEntry.tone === "tool"
            ? "text-icon-muted"
            : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning-foreground"
    : showDestructiveRowStyle
      ? "font-medium text-destructive-foreground"
      : workLogEntryIsToolLike(workEntry)
        ? "text-secondary-label"
        : "text-foreground/80";
  const accessiblePreview = [previewText, answerPreview].filter(Boolean).join(": ");
  const accessibleDisplayText = showFailedIndicator
    ? `${accessiblePreview}, tool call failed`
    : accessiblePreview;
  const rowToggleProps = canExpandProjectedItem
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": accessibleDisplayText,
        "aria-expanded": expanded,
        onClick: toggleExpanded,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            toggleExpanded();
          }
        },
      }
    : {};

  return (
    <WorkLogRow
      data-work-entry-id={workEntry.id}
      data-v2-item-type={workEntry.projectedItem?.item.type}
      data-v2-item-visibility={workEntry.projectedItem?.visibility}
      {...rowToggleProps}
      icon={
        <span
          className={iconWrapperClass}
          role={showFailedIndicator ? "img" : undefined}
          aria-label={showFailedIndicator ? "Tool call failed" : undefined}
        >
          <ToolActivityIconView
            fallbackName={entryIconName}
            className={cn("block shrink-0 stroke-2", iconSize)}
            muted
          />
        </span>
      }
      label={
        <div className="min-w-0 flex-1 overflow-hidden">
          {/* Size and line height come from the row's line (one step smaller inside a group). */}
          <p className="flex min-w-0 w-full items-baseline gap-1.5">
            {/* The answer keeps its own width up to half the row; the question takes the rest. */}
            <span className={cn("min-w-0 flex-1 truncate", answerPreview && "basis-0", headingClass)}>
              {isReasoning && !expanded
                ? thoughtPreviewText(
                    workEntry.detail ?? previewText,
                    workEntry.toolLifecycleStatus === "inProgress" ? "Thinking" : "Thought",
                  )
                : previewText}
            </span>
            {answerPreview ? (
              <span
                className={cn(
                  "max-w-1/2 shrink-0 truncate",
                  !expanded &&
                    workEntry.questionAnswer &&
                    hasQuestionAnswer(workEntry.questionAnswer)
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {answerPreview}
              </span>
            ) : null}
          </p>
        </div>
      }
      trailing={
        <>
          {payload?.type === "command_execution" && payload.status === "running" ? (
            <BackgroundButton itemId={payload.id} kind="command" />
          ) : null}
          {notifiedSubagentThreadId ? (
            <InlineButton
              aria-label="Open subagent"
              onClick={(event) => {
                event.stopPropagation();
                ctx.onOpenThread(notifiedSubagentThreadId);
              }}
              onKeyDown={stopRowToggle}
            >
              Open subagent
            </InlineButton>
          ) : null}
          {showFailedIndicator && !showDestructiveRowStyle && !toolIconAcceptsTint(undefined) ? (
            <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
          ) : null}
          {canExpandProjectedItem ? (
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
              <ChevronRightIcon
                className={cn(
                  "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                  expanded && "rotate-90",
                )}
              />
            </span>
          ) : null}
          <TimelineRowTimestamp createdAt={workEntry.createdAt} timestampFormat={timestampFormat} />
        </>
      }
    >
      {expanded && workEntry.questionAnswer ? (
        <QuestionAnswerHistory answer={workEntry.questionAnswer} />
      ) : null}
      {expanded && isReasoning ? <ReasoningTraceContent entries={[workEntry]} /> : null}
      {expanded &&
      !isReasoning &&
      !workEntry.questionAnswer &&
      canExpandProjectedItem &&
      (expandedBody || (workEntry.projectedItem && plainOutput === undefined)) ? (
        <WorkLogDetails kind="panel">
          {workEntry.projectedItem && plainOutput === undefined ? (
            <V2ItemInspector
              onInitialOutputReady={onInitialOutputReady}
              projectedItem={workEntry.projectedItem}
              cwd={ctx.markdownCwd}
              workspaceRoot={workspaceRoot}
            />
          ) : expandedBody ? (
            <pre className={toolCallExpandedBodyClassName}>{expandedBody}</pre>
          ) : null}
        </WorkLogDetails>
      ) : null}
    </WorkLogRow>
  );
}

function QuestionAnswerHistory({ answer }: { answer: UserInputAttachmentAnswerPayload }) {
  return (
    <div className="ms-7 mt-2 space-y-2" onClick={stopRowToggle}>
      {[
        ...new Set([
          ...Object.keys(answer.questionTextById ?? {}),
          ...Object.keys(answer.answers),
          ...Object.keys(answer.attachmentsByQuestionId),
        ]),
      ].map((questionId) => (
        <div key={questionId} className="space-y-1">
          {answer.questionTextById?.[questionId] ? (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {answer.questionTextById[questionId]}
            </p>
          ) : null}
          {getQuestionAnswerText(answer.answers[questionId]) ? (
            <p className="ms-3 whitespace-pre-wrap text-sm text-muted-foreground">
              {getQuestionAnswerText(answer.answers[questionId])}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {(answer.attachmentsByQuestionId[questionId] ?? []).map((attachment) => (
              <span key={attachment.id} className="text-sm text-muted-foreground">
                {attachment.name}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
