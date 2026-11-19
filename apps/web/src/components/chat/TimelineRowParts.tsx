// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/TimelineRowParts.tsx
// Local changes: TimestampFormat comes from the local timestampFormat module. Times and badges
// draw as `UncopiedText` (user request: a drag across messages copies no times).
import { type ComponentProps, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  formatChatTimestampTooltip,
  formatDayAwareTimestamp,
  type TimestampFormat,
} from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const MESSAGE_HEADING_LEVEL = 3;

export function MessageAuthorHeading({ children }: { children: string }) {
  return <h3 className="sr-only select-none">{children}</h3>;
}

/** Puts `text` in CSS generated content: `UncopiedText`'s span, or a trigger rendered as one. */
export function uncopiedTextProps(text: string, className?: string) {
  return { "data-label": text, className: cn("before:content-[attr(data-label)]", className) };
}

/**
 * Text the timeline shows beside a message rather than in it (a time, a status badge). It is CSS
 * generated content (`::before { content: attr(data-label) }`), which has no text node: a drag
 * across messages copies only the messages, in every browser and copy path, while screen
 * readers still read it.
 */
export function UncopiedText({
  text,
  className,
  ...props
}: ComponentProps<"span"> & { text: string }) {
  return <span {...props} {...uncopiedTextProps(text, className)} />;
}

export function TimelineRowTimestamp({
  createdAt,
  timestampFormat,
  className,
  alwaysVisible = false,
}: {
  createdAt: string;
  timestampFormat: TimestampFormat;
  className?: string;
  alwaysVisible?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            {...uncopiedTextProps(
              formatDayAwareTimestamp(createdAt, timestampFormat),
              cn(
                "pointer-events-none absolute me-1 shrink-0 whitespace-nowrap rounded-md text-muted-foreground text-xs tabular-nums opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100",
                alwaysVisible && "pointer-events-auto static opacity-100",
                className,
              ),
            )}
          />
        }
      />
      <TooltipPopup>{formatChatTimestampTooltip(createdAt, timestampFormat)}</TooltipPopup>
    </Tooltip>
  );
}

export function ActivityShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}
