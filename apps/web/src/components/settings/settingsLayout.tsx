// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: components/settings/SettingsGroup.tsx, components/settings/settingsLayout.tsx
// (SettingsSection, SettingsRow, SettingResetButton, SettingsPageContainer) and
// components/WorkspacePageContainer.tsx. Local change: T3's settings scopes, search targets,
// inheritance markers and managed-policy states are left out; the parts keep T3's look. Every
// settings page is a SettingsPageContainer of SettingsSections.
import { Undo2Icon } from "lucide-react";
import type { ComponentProps, ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SettingsGroup({
  variant = "grouped",
  divided = true,
  className,
  ...props
}: ComponentProps<"div"> & { variant?: "grouped" | "plain"; divided?: boolean }) {
  return (
    <div
      data-slot="settings-group"
      {...props}
      className={cn(
        "relative overflow-visible text-foreground",
        variant === "grouped" ? "rounded-xl border border-border/60 bg-card/40 shadow-xs/5" : "space-y-1",
        variant === "grouped" &&
          divided &&
          "[&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none",
        className,
      )}
    />
  );
}

/**
 * `hideTitle` (T3's prop) keeps the title for screen readers only, for a page whose one section
 * would repeat the breadcrumb's page name. Local change: the header row stays for its action,
 * at the end as before (T3 drops the row with the title).
 */
export function SettingsSection({
  title,
  hideTitle = false,
  icon,
  headerAction,
  headerActionClassName,
  variant = "grouped",
  children,
  className,
  ...sectionProps
}: Omit<ComponentPropsWithoutRef<"section">, "title"> & {
  title: string;
  hideTitle?: boolean;
  icon?: ReactNode;
  headerAction?: ReactNode;
  /** Classes for the action's box; `shrink` lets a wide action (a scrolling control) fit the row. */
  headerActionClassName?: string;
  variant?: "grouped" | "plain";
  children: ReactNode;
}) {
  return (
    <section {...sectionProps} className={cn("space-y-2.5", className)}>
      <div
        className={cn(
          "flex min-h-7 flex-wrap items-center gap-x-4 gap-y-2 px-3 sm:px-4",
          hideTitle ? "justify-end" : "justify-between",
        )}
      >
        {hideTitle ? (
          <h2 className="sr-only">{title}</h2>
        ) : (
          <h2 className="flex min-h-7 min-w-0 items-center gap-2 text-base font-semibold text-foreground">
            {icon}
            {title}
          </h2>
        )}
        <div className={cn("flex min-h-7 min-w-7 shrink-0 flex-wrap items-center justify-end gap-2", headerActionClassName)}>{headerAction}</div>
      </div>
      <SettingsGroup variant={variant}>{children}</SettingsGroup>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  children,
  className,
  ...rowProps
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      {...rowProps}
      data-slot="settings-row"
      className={cn(
        "group/settings-row @container/settings-row rounded-xl px-3 sm:px-4",
        children ? "pt-3 pb-1" : "py-3",
        className,
      )}
    >
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_auto] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">{resetAction}</span>
          </div>
          {description ? (
            <p className="max-w-2xl text-pretty text-xs leading-normal text-muted-foreground">{description}</p>
          ) : null}
          {status ? <div className="pt-0.5 text-xs text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full min-w-0 shrink-0 items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end @min-[32rem]/settings-row:[&_[data-slot=select-trigger]]:min-w-40">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SettingResetButton({
  label,
  tooltip = "Reset to default",
  onClick,
}: {
  label: string;
  tooltip?: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={`Reset ${label} to default`}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

const WIDTH_CLASS = {
  readable: "max-w-4xl",
  wide: "max-w-5xl",
  expanded: "max-w-6xl",
} as const;

/** The scrolling page under the settings header (T3's SettingsPageContainer and WorkspacePageContainer). */
export function SettingsPageContainer({
  children,
  className,
  width = "readable",
}: {
  children: ReactNode;
  className?: string;
  width?: keyof typeof WIDTH_CLASS;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-settings-page-scroll="">
      <div className={cn("mx-auto flex w-full flex-col gap-8 px-5 pt-6 pb-12 sm:px-6", WIDTH_CLASS[width], className)}>{children}</div>
    </div>
  );
}
