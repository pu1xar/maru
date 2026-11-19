// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/TimelineUserMessageRow.tsx
// Local changes: pictures come from the server's transcript blobs and stored uploads and open the
// preview dialog; the attachment notes at the end of the text become file rows that open in the
// right panel (MessageAttachments.tsx, DESIGN.md 6n). No video or audio. Context chips, the prompt link,
// guest attribution, workflow openings, model switch and fresh session dividers are gone. T3's
// "Edit from here" is maru's 여기서 되돌리기: it opens the session's rewind screen at the message
// (lib/rewind.ts, DESIGN.md 6o), where the composer that can take it is on the page; 여기서 fork
// beside it makes a new session up to the message (lib/forkHere.ts, DESIGN.md 6q). Messages an
// agent or the system sent fold to one line, as in T3.
// The time is in the action row only when the timeline frame is too narrow for the gutter
// beside the bubble (MessagesTimeline), and never on touch screens. UI text is Korean. Code fences
// typed inside a sentence are moved onto their own lines before the parse (userMessageFences.ts).
import { ChevronDownIcon, GitForkIcon, MessagesSquareIcon, Redo2Icon, Undo2Icon, type LucideIcon } from "lucide-react";
import { memo, use, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { sentMessageAttachments } from "~/lib/composerAttachments.logic";
import { forkFromMessage, useForking } from "~/lib/forkHere";
import { openRewind, useCanRewind } from "~/lib/rewind";
import { rewindTargetOf } from "~/lib/rewind.logic";
import { cn } from "~/lib/utils";
import { foldedMessageLabel, resolveUserMessagePresentation } from "../../client-runtime/userMessage.ts";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import {
  remarkEnableOrderedListNumbers,
} from "../../t3-shared/markdownPipeline.ts";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MessageAttachments } from "./MessageAttachments";
import { FindRevealContext } from "./findReveal";
import { MessageCopyButton } from "./MessageCopyButton";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";
import { MESSAGE_HEADING_LEVEL, MessageAuthorHeading, UncopiedText } from "./TimelineRowParts";
import { useTallEnoughToFold } from "./useTallEnoughToFold";
import { userMessageFenceText } from "./userMessageFences";

export function UserMessageRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  return <UserTimelineRow row={row} />;
}

export function FoldedMessageHeader(props: {
  icon: LucideIcon;
  label: string;
  summary: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      aria-expanded={props.expanded}
      data-scroll-anchor-ignore
      onClick={props.onToggle}
      className="flex w-full min-w-0 items-center gap-1.5 rounded-2xl px-3 py-2 text-left text-sm select-none focus-visible:outline-2 focus-visible:outline-ring"
    >
      <Icon className="size-4 shrink-0 stroke-2 text-muted-foreground" />
      <span className="max-w-1/2 shrink-0 truncate text-muted-foreground">{props.label}</span>
      <span className="min-w-0 flex-1 truncate">{props.summary}</span>
      <ChevronDownIcon
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          props.expanded && "rotate-180",
        )}
      />
    </button>
  );
}

const USER_MESSAGE_STATUS_LABEL: Record<string, string> = {
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  running: "Processing",
  idle: "Idle",
};

function UserMessageProjectedStatus({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const status = row.projectedItem?.item.status;
  if (
    status === undefined ||
    status === "completed" ||
    status === "pending" ||
    status === "waiting"
  )
    return null;
  return (
    <div className="me-1 flex items-center gap-1.5">
      <UncopiedText
        text={USER_MESSAGE_STATUS_LABEL[status] ?? status}
        className="rounded-full border border-destructive/25 bg-destructive/8 px-1.5 py-0.5 text-3xs font-medium text-destructive-foreground"
      />
    </div>
  );
}

/**
 * A folded message's card (agent, automation, system): neutral, apart from the user's bubble color.
 * Its text and code take the page's colors, so the blue bubble setting (white text, index.css) stays
 * with the user's own bubbles; the card also leaves out `data-user-message-bubble` for that reason.
 */
const FOLDED_MESSAGE_CARD =
  "border border-border bg-foreground/[0.04] text-foreground [--contrast-message-foreground:var(--foreground)] [--chat-code-message-background:var(--chat-code-background)]";

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const coarsePointer = useMediaQuery({ pointer: "coarse" });
  const userMessage = resolveUserMessagePresentation(row.message);
  // Messages from agents, automations and the system fold to one line so the user's own
  // messages stay easy to find.
  const folded = userMessage.attribution !== null;
  const foldLabel =
    userMessage.attribution === null ? "" : foldedMessageLabel(userMessage.attribution, row.projectedItem?.x?.origin);
  const [expandedByReader, setExpanded] = useState(false);
  // A find showing this message opens its fold (DESIGN.md 6u).
  const revealed = use(FindRevealContext) === row.message.id;
  const expanded = expandedByReader || revealed;
  // The attachment notes at the end of the text become the pictures and file rows (DESIGN.md 6n).
  const sent = sentMessageAttachments(userMessage.text, row.message.attachments ?? [], row.projectedItem?.x?.data);
  const attachments = sent.attachments;
  const text = sent.text;
  const foldSummary =
    text
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";

  // Touch shows actions all the time, and narrow lanes have no room beside the
  // bubble, so both keep the actions on their own line.
  const floatActions = row.groupedWithNext === true && !coarsePointer;
  const messageActions = (
    <div
      className={cn(
        "flex items-center justify-end gap-x-2 gap-y-0.5",
        floatActions ? "flex-wrap" : "shrink-0",
      )}
    >
      {/* The time sits right of the bubble when the frame has room (MessagesTimeline); touch
          screens never show it (user decision). */}
      <UncopiedText
        text={formatDayAwareTimestamp(row.message.createdAt, ctx.timestampFormat)}
        className="text-muted-foreground text-xs tabular-nums @min-[62rem]/frame:hidden pointer-coarse:hidden"
        title={formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}
        data-message-action-time=""
      />
      <div className={cn("flex items-center gap-0.5", floatActions && "flex-wrap justify-end")}>
        {/* Copies the message as sent, its attachment notes too (DESIGN.md 7: copy keeps the original). */}
        {userMessage.text ? <MessageCopyButton text={userMessage.text} variant="ghost" /> : null}
        {!folded ? <RewindHereButton threadKey={ctx.routeThreadKey} row={row} /> : null}
        {!folded ? <ForkHereButton threadKey={ctx.routeThreadKey} row={row} /> : null}
      </div>
    </div>
  );
  return (
    <div
      className="group @container flex flex-col items-end gap-1"
      data-user-message-attribution={folded ? (userMessage.attribution ?? undefined) : undefined}
    >
      {(row.message.inputIntent === "steer" ||
        row.message.inputIntent === "promoted_queued_to_steer") &&
      !row.continuesSteer ? (
        <UserMessageIntentMarker
          intent={row.message.inputIntent}
          unread={row.projectedItem?.item.status === "pending"}
        />
      ) : null}
      <div
        className={cn(
          // A folded message is not the user's: a neutral card in place of the user's bubble color
          // (user request 2026-11-19, an agent's message read as one the user sent).
          "relative min-w-0 max-w-[80%] rounded-2xl",
          folded ? FOLDED_MESSAGE_CARD : "bg-message text-message-foreground",
          row.groupedWithPrevious && "rounded-tr-md",
          row.groupedWithNext && "rounded-br-md",
          !folded && "p-3",
          folded && expanded && "w-full",
        )}
        data-user-message-bubble={folded ? undefined : ""}
      >
        {/* Outside the fold so a collapsed message still has a heading to navigate to. */}
        <MessageAuthorHeading>{folded ? foldLabel : "You"}</MessageAuthorHeading>
        {folded ? (
          <FoldedMessageHeader
            icon={MessagesSquareIcon}
            label={foldLabel}
            summary={foldSummary}
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
          />
        ) : null}
        {!folded || expanded ? (
          <div className={cn(folded && "max-h-96 overflow-auto px-3 pb-3")}>
            <MessageAttachments attachments={attachments} standalone={text.trim() === ""} />
            <CollapsibleUserMessageBody
              text={text}
              markdownCwd={ctx.markdownCwd}
              collapsible={!folded}
              forceOpen={revealed}
            />
          </div>
        ) : null}
        {floatActions ? (
          <div
            className={cn(
              "absolute end-full top-1/2 me-2 hidden w-max max-w-[calc(20cqw-0.5rem)] -translate-y-1/2 @min-[37rem]:flex",
              ACTIONS_REVEAL_CLASS_NAME,
            )}
          >
            {messageActions}
          </div>
        ) : null}
      </div>
      <UserMessageProjectedStatus row={row} />
      {!folded || expanded ? (
        <div
          className={cn(
            "flex w-full max-w-[80%] justify-end pe-1",
            floatActions && "@min-[37rem]:hidden",
            ACTIONS_REVEAL_CLASS_NAME,
          )}
        >
          {messageActions}
        </div>
      ) : null}
    </div>
  );
}

/** The message's rewind target (lib/rewind.logic.ts rewindTargetOf, DESIGN.md 6o). */
function rewindTargetFor(threadKey: string, row: Extract<TimelineRow, { kind: "message" }>): string | null {
  return rewindTargetOf(threadKey, row.projectedItem?.item);
}

/** T3's "Edit from here" place: opens the rewind screen at this message (DESIGN.md 6o). */
function RewindHereButton({ threadKey, row }: { threadKey: string; row: Extract<TimelineRow, { kind: "message" }> }) {
  const canRewind = useCanRewind(threadKey);
  const target = rewindTargetFor(threadKey, row);
  if (!canRewind || target === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label="Rewind to here"
            data-rewind-here=""
            onClick={() => openRewind(threadKey, target)}
          />
        }
      >
        <Undo2Icon aria-hidden className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Rewind to here</TooltipPopup>
    </Tooltip>
  );
}

/**
 * 여기서 fork, next to 여기서 되돌리기 (DESIGN.md 6q): a new session from the conversation up to this
 * message and its answer, opened in place of this one. Shown where the rewind button is (the
 * session's composer is on the page, no subagent view) and disabled while a fork of the session runs.
 */
function ForkHereButton({ threadKey, row }: { threadKey: string; row: Extract<TimelineRow, { kind: "message" }> }) {
  const canFork = useCanRewind(threadKey);
  const forking = useForking(threadKey);
  const target = rewindTargetFor(threadKey, row);
  if (!canFork || target === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label="Fork from here"
            data-fork-here=""
            disabled={forking}
            onClick={() => void forkFromMessage(threadKey, target)}
          />
        }
      >
        <GitForkIcon aria-hidden className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{forking ? "Forking" : "Fork from here"}</TooltipPopup>
    </Tooltip>
  );
}

const ACTIONS_REVEAL_CLASS_NAME =
  "items-center text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100";

function UserMessageIntentMarker({
  intent,
  unread,
}: {
  readonly intent: "steer" | "promoted_queued_to_steer";
  readonly unread: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="me-1 flex items-center justify-end gap-1 text-xs leading-none text-muted-foreground"
            data-user-message-intent={intent}
          />
        }
      >
        <Redo2Icon aria-hidden="true" className="size-3" />
        <UncopiedText text={unread ? "steer, waiting to be read" : "steer"} />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {unread
          ? "The agent has not read it yet, it reads between steps after the running command finishes"
          : intent === "promoted_queued_to_steer"
            ? "It was queued, then became a steer of the turn in progress"
            : "A message sent into the turn in progress"}
      </TooltipPopup>
    </Tooltip>
  );
}

const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;

const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  markdownCwd: string | undefined;
  collapsible?: boolean;
  /** A find shows this message: it stays open (DESIGN.md 6u). */
  forceOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasVisibleBody = props.text.trim().length > 0;
  const { ref: contentRef, tallEnough: canCollapse } = useTallEnoughToFold(
    props.collapsible !== false && hasVisibleBody,
  );
  const isCollapsed = canCollapse && !expanded && props.forceOpen !== true;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <div ref={contentRef} data-thread-find-text="">
            <UserMessageBody text={props.text} markdownCwd={props.markdownCwd} />
          </div>
        </div>
      ) : null}
      {canCollapse ? (
        <div className="mt-1.5 flex items-center justify-end gap-2" data-user-message-footer="true">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-expanded={expanded}
            data-scroll-anchor-ignore
            onClick={() => setExpanded((value) => !value)}
            className="-ml-1"
          >
            {expanded ? "Show less" : "Show all"}
          </Button>
        </div>
      ) : null}
    </div>
  );
});

// Keyed by identity in ChatMarkdown's parse cache, so it is one module constant.
const USER_MESSAGE_REMARK_PLUGINS = [remarkEnableOrderedListNumbers];

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  markdownCwd: string | undefined;
}) {
  if (props.text.length === 0) {
    return null;
  }
  return (
    <ChatMarkdown
      // Fences typed inside sentences become blocks; the copy button keeps the text as sent.
      text={userMessageFenceText(props.text)}
      cwd={props.markdownCwd}
      className="text-message-foreground user-message-markdown"
      lineBreaks
      parseRawHtml={false}
      diagrams={false}
      extraRemarkPlugins={USER_MESSAGE_REMARK_PLUGINS}
      headingLevelOffset={MESSAGE_HEADING_LEVEL}
    />
  );
});
