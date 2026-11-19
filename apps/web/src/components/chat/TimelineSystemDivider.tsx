// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/TimelineSystemDivider.tsx
// Local changes: the label and detail are separated by a comma instead of a middle dot, and the
// divider is select-none, so a drag across messages does not copy it.
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export function TimelineSystemDivider(props: {
  readonly label: string;
  readonly detail?: ReactNode | null;
  readonly tone?: "neutral" | "danger";
  readonly icon?: LucideIcon;
  readonly showDetailSeparator?: boolean;
  readonly wrapDetail?: boolean;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  const Icon = props.icon;
  const content = (
    <>
      <span
        className={cn(
          "inline-flex items-baseline gap-1.5 align-baseline font-medium",
          props.wrapDetail && "shrink-0 whitespace-nowrap",
        )}
      >
        {Icon ? <Icon className="size-3 shrink-0 self-center" /> : null}
        {props.label}
        {props.detail && props.showDetailSeparator !== false ? "," : null}
      </span>
      {props.detail ? (
        <span
          className={cn(
            "min-w-0 opacity-70",
            props.wrapDetail ? "ml-1.5 wrap-anywhere" : "inline-flex items-center",
            typeof props.detail === "string" &&
              (props.wrapDetail ? "whitespace-pre-wrap" : "max-w-80 truncate"),
          )}
        >
          {props.detail}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 py-2 text-2xs text-muted-foreground select-none",
        props.tone === "danger" && "text-destructive-foreground",
      )}
    >
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
      {props.onAction ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={props.actionLabel}
                onClick={props.onAction}
                className={cn(
                  "min-w-0 cursor-pointer rounded-full border border-border/70 bg-background px-2.5 py-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  props.wrapDetail ? "text-center" : "flex items-center gap-1.5",
                )}
              />
            }
          >
            {content}
          </TooltipTrigger>
          <TooltipPopup side="top">{props.actionLabel}</TooltipPopup>
        </Tooltip>
      ) : (
        <span
          className={cn(
            "min-w-0 rounded-full px-2 py-1",
            props.wrapDetail ? "text-center" : "flex flex-wrap items-center justify-center gap-1.5",
          )}
        >
          {content}
        </span>
      )}
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
    </div>
  );
}
