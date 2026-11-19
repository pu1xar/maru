// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: components/WorkspacePageHeader.tsx and workspaceTitlebar.ts.
// Local changes: T3's Electron options become a `data-titlebar` mark; the desktop app's rules
// (index.css, DESIGN.md 2e) make it a drag region and keep the window controls clear. T3's
// WorkspacePageHeader is named PaneHeader here: it is the header of one conversation or shell (the
// single view's, and each split view pane's), 2.75rem tall. The bar across the top of a page is
// PageHeader.tsx.
import type { ComponentPropsWithoutRef } from "react";

import { cn } from "~/lib/utils";

/** Clears the floating sidebar toggle when the sidebar is collapsed or is a phone sheet. */
export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)] max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)]";

/** What every top bar shares: the row, the gutters, the animation of the paddings and the toggle's room. */
export const HEADER_ROW_CLASS =
  "flex shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left,padding-right] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out";

export function PaneHeader({ className, ...props }: ComponentPropsWithoutRef<"header">) {
  return (
    <header
      data-titlebar=""
      className={cn(
        "h-[var(--workspace-topbar-height)]! min-h-[var(--workspace-topbar-height)]! max-h-[var(--workspace-topbar-height)]!",
        HEADER_ROW_CLASS,
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        className,
      )}
      {...props}
    />
  );
}
