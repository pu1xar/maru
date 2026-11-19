// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/V2LifecycleRow.tsx, SubagentTooltipContent.tsx and
// ThreadHoverCard.tsx (the hover card shell).
// Local changes: live subagent records come from the snapshot through the row context instead of
// environment atoms, and opening a subagent calls `onOpenThread(childThreadId)` in place of router
// navigation. The avatar draws the Claude or Codex mark by driver (no provider instance
// registry, badges or accent colors). Handoff, model switch, created thread and remote task rows
// are gone (we never produce those items). The tooltip keeps the prompt T3 drops, as plain text.
// The interrupt divider shows only what its label does not already say. Cards are select-none,
// so a drag across messages does not copy them. UI text is Korean.
import type { OrchestrationV2Notification, OrchestrationV2TurnItem } from "@maru/shared";
import { BotIcon, ChevronRightIcon, CircleStopIcon, GitForkIcon } from "lucide-react";
import { use, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { formatSubagentDisplayTitle } from "../../client-runtime/state/subagentDisplay.ts";
import { formatShortTimestamp, type TimestampFormat } from "../../timestampFormat";
import { ClaudeAI, OpenAI } from "../Icons";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed, type AgentTiming } from "./AgentElapsed";
import { BackgroundButton } from "./BackgroundButton";
import { TimelineRowCtx } from "./timelineRowContext";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
import { thoughtPreviewText } from "./TimelineWorkEntryRow.logic";
import {
  interruptDividerDetail,
  SUBAGENT_STATUS_LABEL,
  subagentDetailLine,
  subagentResumedSince,
} from "./V2LifecycleRow.logic";

export function V2LifecycleRow(props: {
  readonly item: OrchestrationV2TurnItem;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { item } = props;
  if (item.type === "run_interrupt_result") {
    return (
      <TimelineSystemDivider
        label="Interrupted"
        detail={interruptDividerDetail(item.message)}
        icon={CircleStopIcon}
        wrapDetail
      />
    );
  }
  if (item.type === "fork") {
    const relatedThreadId = item.source.type === "run" ? item.source.threadId : item.targetThreadId;
    const fromConversation = item.source.type === "run" || item.source.type === "provider_thread";
    return (
      <TimelineSystemDivider
        label={fromConversation ? "Forked from another conversation" : "Conversation fork"}
        icon={GitForkIcon}
        {...(item.source.type === "run"
          ? {
              actionLabel: "Open original conversation",
              onAction: () => props.onOpenThread(relatedThreadId),
            }
          : {})}
      />
    );
  }
  if (item.type === "subagent") {
    return <SubagentTimelineLink item={item} onOpenThread={props.onOpenThread} />;
  }
  return null;
}

/**
 * The subagent card: one subagent's row and the header of a group of them (TimelineV2EventRow
 * V2SubagentGroup) both draw it, so a change here reaches every subagent card. A border and a
 * slightly lighter surface part it from the prose around it (user request 2026-11-16, the group
 * header joined 2026-11-19); foreground-based tints keep it in step with either theme, and the
 * margins part it from the text above and below, the next card included.
 */
export const SUBAGENT_CARD =
  "mt-2 mb-2 flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-foreground/15 bg-foreground/[0.08] px-2.5 py-2 text-left select-none";
/** A subagent card that is a button: the hover and focus look. */
export const SUBAGENT_CARD_PRESSABLE =
  "cursor-pointer transition-colors hover:border-foreground/24 hover:bg-foreground/[0.11] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

const STATUS_DOT_CLASS: Record<OrchestrationV2TurnItem["status"], string> = {
  pending: "bg-info",
  running: "bg-info",
  waiting: "bg-info",
  idle: "bg-muted-foreground/50",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/60",
  interrupted: "bg-muted-foreground/60",
};

export function SubagentAvatar({
  driver,
  status,
  className,
}: {
  driver?: string | undefined;
  status?: OrchestrationV2TurnItem["status"] | undefined;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        // The mark alone: no ring, border or muted disc behind it (user request; on the card's
        // lighter surface they read as a black outline and a white plate).
        "relative inline-flex size-6 shrink-0 items-center justify-center",
        className,
      )}
    >
      {driver === "claude" ? (
        <ClaudeAI className="size-3.5" />
      ) : driver === "codex" ? (
        <OpenAI className="size-3.5 text-black dark:text-white" />
      ) : (
        <BotIcon className="size-3.5 text-muted-foreground" />
      )}
      {status ? (
        <span
          className={cn(
            "absolute -right-px -bottom-px size-2 rounded-full",
            STATUS_DOT_CLASS[status],
          )}
        />
      ) : null}
    </span>
  );
}

export function SubagentElapsed({ agent }: { agent: AgentTiming }) {
  return <AgentElapsed agent={agent} />;
}

const NOTIFICATION_OUTCOME_STATUS: Record<
  OrchestrationV2Notification["outcome"],
  OrchestrationV2TurnItem["status"] | null
> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  updated: null,
  unknown: null,
};

const NOTIFICATION_OUTCOME_LABEL: Record<OrchestrationV2Notification["outcome"], string> = {
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  updated: "Updated",
  unknown: "Done",
};

/** A task notification that names a subagent we know: drawn as that subagent's card. */
export function SubagentNotificationLink(props: {
  readonly childThreadId: string;
  readonly taskIds?: ReadonlyArray<string> | undefined;
  readonly outcome: OrchestrationV2Notification["outcome"];
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: string) => void;
  readonly fallback: ReactNode;
}) {
  const ctx = use(TimelineRowCtx);
  const agent =
    [...ctx.subagentsById.values()].find((candidate) =>
      props.taskIds === undefined
        ? candidate.childThreadId === props.childThreadId
        : props.taskIds.includes(candidate.id),
    ) ?? null;
  if (agent === null) return props.fallback;
  const resumed =
    NOTIFICATION_OUTCOME_STATUS[props.outcome] !== null &&
    subagentResumedSince(agent, props.createdAt);
  return (
    <SubagentCard
      subagentId={agent.id}
      driver={agent.driver}
      title={formatSubagentDisplayTitle(agent.title ?? "Subagent")}
      prompt={agent.prompt}
      model={agent.model}
      status={agent.status}
      result={agent.result}
      progress={agent.progress}
      startedAt={agent.startedAt}
      completedAt={agent.completedAt}
      threadId={props.childThreadId}
      onOpenThread={props.onOpenThread}
      {...(resumed
        ? {}
        : {
            event: {
              status: NOTIFICATION_OUTCOME_STATUS[props.outcome],
              label: NOTIFICATION_OUTCOME_LABEL[props.outcome],
              timestamp: formatShortTimestamp(props.createdAt, props.timestampFormat),
            },
          })}
    />
  );
}

function SubagentTimelineLink(props: {
  readonly item: Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { item } = props;
  const ctx = use(TimelineRowCtx);
  const live = ctx.subagentsById.get(item.subagentId);
  // A card of a foreground Agent call that runs offers "백그라운드로" beside it (the card is a
  // button itself, so the new one cannot sit inside). Workflows and background agents do not.
  const foreground = (live?.status ?? item.status) === "running" && live?.background !== true && !live?.workflow;
  const card = (
    <SubagentCard
      subagentId={item.subagentId}
      driver={item.driver}
      title={formatSubagentDisplayTitle(item.title ?? "Subagent")}
      prompt={item.prompt}
      model={null}
      status={item.status}
      result={item.result}
      progress={item.progress}
      startedAt={item.startedAt}
      completedAt={item.completedAt}
      threadId={item.childThreadId}
      onOpenThread={props.onOpenThread}
    />
  );
  if (!foreground) return card;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">{card}</div>
      <BackgroundButton itemId={item.id} kind="agent" />
    </div>
  );
}

function SubagentCard(props: {
  readonly subagentId: string;
  readonly driver: string;
  readonly title: string;
  readonly prompt: string;
  readonly model: string | null;
  readonly result: string | null;
  readonly progress: string | undefined;
  readonly status: OrchestrationV2TurnItem["status"];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly threadId: string | null;
  readonly onOpenThread: (threadId: string) => void;
  readonly event?: {
    readonly status: OrchestrationV2TurnItem["status"] | null;
    readonly label: string;
    readonly timestamp: string;
  };
}) {
  const ctx = use(TimelineRowCtx);
  const agent = ctx.subagentsById.get(props.subagentId) ?? null;
  const threadId = agent?.childThreadId ?? props.threadId;
  const open = threadId !== null ? () => props.onOpenThread(threadId) : null;
  const liveStatus = agent?.status ?? props.status;
  const status = props.event ? props.event.status : liveStatus;
  const statusLabel = props.event?.label ?? SUBAGENT_STATUS_LABEL[liveStatus];
  const result = agent?.result ?? props.result;
  const progress = agent?.progress ?? props.progress;
  const detail = subagentDetailLine({ status: status ?? liveStatus, result, progress });
  const failed = status === "failed";
  const timing: AgentTiming = {
    status: liveStatus,
    startedAt: agent?.startedAt ?? props.startedAt,
    completedAt: agent?.completedAt ?? props.completedAt,
  };
  const content = (
    <>
      <SubagentAvatar driver={props.driver} status={status ?? undefined} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {props.title}
          </span>
        </span>
        <span
          className={cn(
            "block text-2xs leading-relaxed",
            failed ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {detail === null ? (
            statusLabel
          ) : detail.includes("/") && !detail.includes(" ") ? (
            <MiddleTruncate value={detail} showTitle={false} className="flex" />
          ) : (
            <span className="block truncate">{detail}</span>
          )}
        </span>
      </span>
      {detail !== null && (props.event !== undefined || status !== "completed") ? (
        <span
          className={cn("shrink-0 text-xs", failed ? "text-destructive-foreground" : "text-muted-foreground")}
        >
          {statusLabel}
        </span>
      ) : null}
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {props.event ? props.event.timestamp : <SubagentElapsed agent={timing} />}
      </span>
      {open !== null ? (
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover/subagent:text-foreground"
        />
      ) : null}
    </>
  );
  const className = cn("group/subagent", SUBAGENT_CARD);
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          open === null ? (
            <div data-v2-item-type="subagent" aria-description={statusLabel} className={className}>
              {content}
            </div>
          ) : (
            <button
              type="button"
              data-v2-item-type="subagent"
              aria-label={`Open subagent: ${props.title}`}
              aria-description={statusLabel}
              onClick={open}
              className={cn(className, SUBAGENT_CARD_PRESSABLE)}
            >
              {content}
            </button>
          )
        }
      />
      <TooltipPopup variant="glass" className="max-w-80 text-left whitespace-normal">
        <SubagentTooltipContent
          title={props.title}
          driver={props.driver}
          model={agent?.model ?? props.model}
          status={liveStatus}
          elapsed={<SubagentElapsed agent={timing} />}
          prompt={agent?.prompt ?? props.prompt}
          canOpen={open !== null}
        />
      </TooltipPopup>
    </Tooltip>
  );
}

const DRIVER_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

/**
 * T3's ThreadHoverCard with the subagent facts this client knows: the provider mark with the
 * model (the provider's name until the model is known), the status, and the prompt as plain text.
 */
function SubagentTooltipContent(props: {
  readonly title: string;
  readonly driver: string;
  readonly model: string | null;
  readonly status: OrchestrationV2TurnItem["status"];
  readonly elapsed: ReactNode;
  readonly prompt: string;
  readonly canOpen: boolean;
}) {
  const working =
    props.status === "pending" || props.status === "running" || props.status === "waiting";
  const prompt = thoughtPreviewText(props.prompt, "");
  return (
    <div className="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
      <div className="min-w-0 truncate text-xs leading-tight font-medium text-foreground">
        {props.title}
      </div>
      <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          {props.driver === "claude" ? (
            <ClaudeAI aria-hidden className="size-3 shrink-0" />
          ) : props.driver === "codex" ? (
            <OpenAI aria-hidden className="size-3 shrink-0 text-foreground/75" />
          ) : (
            <BotIcon aria-hidden className="size-3 shrink-0" />
          )}
          <span className="min-w-0 truncate text-foreground/75">
            {props.model ?? DRIVER_NAMES[props.driver] ?? props.driver}
          </span>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-4">
          <span
            className={cn(
              "font-medium",
              working
                ? "text-info-foreground"
                : props.status === "failed"
                  ? "text-error-foreground"
                  : props.status === "completed"
                    ? "text-success-foreground"
                    : "text-muted-foreground",
            )}
          >
            {SUBAGENT_STATUS_LABEL[props.status]}
          </span>
          {props.elapsed}
        </div>
        {prompt ? <p className="line-clamp-3 wrap-anywhere">{prompt}</p> : null}
        {props.canOpen ? null : <p>No transcript</p>}
      </div>
    </div>
  );
}
