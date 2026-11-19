// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/WorkLog.tsx
// Local changes: the lint suppression comment is a plain comment. Rows inside an expanded tool
// group sit one level below the group's summary line (user request 2026-11-16): the list is
// indented, the line is one size step smaller and dimmed until hovered, focused or opened.
import {
  createContext,
  use,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";

const GroupedRows = createContext(false);

/** Groups may span virtualized timeline items. Each part owns its trailing space. */
export function WorkLogBlock({
  layout = "standalone",
  continues = false,
  children,
}: {
  layout?: "standalone" | "group-header" | "group-content";
  continues?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div
      className={
        continues || layout === "group-header"
          ? "pb-0"
          : layout === "group-content"
            ? "pb-1"
            : "pb-2"
      }
    >
      {children}
    </div>
  );
}

/**
 * The rows of an expanded tool group. The 1.75rem indent plus a row's 0.125rem inline padding and
 * its icon slot's 0.125rem side space puts each child icon at 2rem, where the summary line's label
 * starts (0.125rem padding, 1.5rem icon slot, 0.375rem gap), the way a tree nests a child under
 * its parent's name.
 */
export function WorkLogList({ children }: { children: ReactNode }) {
  return (
    <GroupedRows value>
      <div className="flex min-w-0 flex-col ps-7">{children}</div>
    </GroupedRows>
  );
}

/** Size class for a row's leading icon: a child row in an expanded group is one step smaller. */
export function useWorkLogIconSize() {
  return use(GroupedRows) ? "size-3.5" : "size-4";
}

type RowContent = {
  icon?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  wrapLabel?: boolean;
};

function WorkLogLine({ icon, label, trailing, wrapLabel }: RowContent) {
  const nested = use(GroupedRows);
  return (
    <div
      className={cn(
        "flex min-h-6 min-w-0 gap-1.5 leading-relaxed select-none [&_*]:select-none",
        wrapLabel ? "items-start" : "items-center",
        // Only the line recedes: an opened row's detail below it keeps full contrast, and the
        // line comes back when the row is hovered, focused from the keyboard or opened.
        nested
          ? "text-xs opacity-(--work-group-entry-opacity) transition-opacity group-hover/timeline-row:opacity-100 group-focus-visible/timeline-row:opacity-100 group-aria-expanded/timeline-row:opacity-100"
          : "text-sm",
      )}
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {icon ? (
          <span className={cn("relative shrink-0 leading-0", nested ? "w-4.5" : "w-6")}>
            {/* vertical-align lifts the slot's bottom edge to half the cap height minus half the
                slot above the baseline, so the slot's middle meets the label's cap middle. */}
            <span
              className={cn(
                "inline-block overflow-hidden",
                nested
                  ? "size-4.5 align-[calc(0.5cap_-_0.5625rem)]"
                  : "size-6 align-[calc(0.5cap_-_0.75rem)]",
              )}
            >
              <span className="flex size-full items-center justify-center">{icon}</span>
            </span>
          </span>
        ) : null}
        <div
          className={cn(
            "min-w-0 flex-1 text-secondary-label",
            !wrapLabel && "truncate [&_*]:whitespace-nowrap",
          )}
        >
          {label}
        </div>
      </div>
      {trailing}
    </div>
  );
}

const interactionClassName =
  "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function useRowClassName(interactive: boolean) {
  const grouped = use(GroupedRows);
  return cn(
    "group/timeline-row relative w-full min-w-0 rounded-md px-0.5 text-left transition-colors",
    grouped ? "py-0" : "py-0.5",
    interactive && interactionClassName,
  );
}

export function WorkLogButton({
  icon,
  label,
  trailing,
  wrapLabel = false,
  ...buttonProps
}: RowContent & Omit<ComponentProps<"button">, "className" | "style" | "children">) {
  const className = useRowClassName(true);
  return (
    <button {...buttonProps} type="button" className={className}>
      <WorkLogLine icon={icon} label={label} trailing={trailing} wrapLabel={wrapLabel} />
    </button>
  );
}

/** Div disclosure permits selectable detail and nested actions. */
export function WorkLogRow({
  icon,
  label,
  trailing,
  wrapLabel = false,
  children,
  ...rowProps
}: RowContent & Omit<ComponentProps<"div">, "className" | "style">) {
  const className = useRowClassName(rowProps.onClick !== undefined);
  return (
    <div {...rowProps} className={className}>
      <WorkLogLine icon={icon} label={label} trailing={trailing} wrapLabel={wrapLabel} />
      {children}
    </div>
  );
}

const LIVE_EDGE_PX = 4;

export function WorkLogDetails({
  children,
  kind = "text",
  followLive = false,
}: {
  children: ReactNode;
  kind?: "text" | "panel" | "media";

  followLive?: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const atLiveEdgeRef = useRef(true);
  // Text detail starts under its row's label: its margin and padding match the icon slot and gap
  // (1.5rem + 0.375rem, or 1.125rem + 0.375rem for a child row in an expanded group).
  const nested = use(GroupedRows);
  // pins the scroller's scrollTop to the bottom after each commit while following live output
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (followLive && atLiveEdgeRef.current && scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  });
  return (
    <div
      ref={scrollerRef}
      onScroll={(event) => {
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
        atLiveEdgeRef.current = scrollHeight - scrollTop - clientHeight <= LIVE_EDGE_PX;
      }}
      className={cn(
        "cursor-auto",
        kind === "text"
          ? cn(
              "flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text",
              nested ? "ms-5.5" : "ms-7",
            )
          : kind === "panel"
            ? "mt-0.5 mb-1.5 pb-2"
            : "mt-1",
      )}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}
