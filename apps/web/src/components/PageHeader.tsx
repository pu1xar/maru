// The bar across the top of a page (the split view's tab strip, the shell screen's tabs, Settings,
// the Dashboard; DESIGN.md 6k). One component so they share one height, one surface and one bottom
// line. Its height is `--page-header-height` (index.css: 70% of the 2.75rem top bar at the default
// sidebar scale, following the sidebar's scale), and its text, buttons and spacing take the
// sidebar's scale (`data-area-zoom`). It is a sidebar zoom area: Ctrl/Cmd+wheel and the zoom keys
// over it step the sidebar's scale, and the mark shows under the bar.
//
// The header of one conversation or shell (a split view pane's, the single view's) is a PaneHeader.
import { useId, type ComponentPropsWithoutRef } from "react";

import { areaZoomAttributes, useAreaZoom } from "~/lib/areaZoom";
import { cn } from "~/lib/utils";
import { AreaZoomIndicator } from "./AreaZoomIndicator";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS, HEADER_ROW_CLASS } from "./PaneHeader";

export function PageHeader({ className, children, ...props }: ComponentPropsWithoutRef<"header">) {
  const zoomKey = useId();
  const zoom = useAreaZoom("sidebar");
  return (
    <header
      data-titlebar=""
      data-page-header=""
      {...areaZoomAttributes("sidebar", zoomKey, zoom)}
      className={cn(
        "relative h-(--page-header-height,var(--workspace-topbar-height))! min-h-(--page-header-height,var(--workspace-topbar-height))! max-h-(--page-header-height,var(--workspace-topbar-height))! border-b border-border bg-sidebar",
        HEADER_ROW_CLASS,
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        className,
      )}
      {...props}
    >
      {children}
      <AreaZoomIndicator zoomKey={zoomKey} area="sidebar" className="top-full right-3 mt-2" />
    </header>
  );
}
