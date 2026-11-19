// The split view's tab strip (DESIGN.md 6k): tmux's windows as a bar on top, one tab per split
// layout. It is the page's PageHeader (the height, the room for the floating sidebar toggle,
// `data-titlebar` for the desktop app's drag region), whose own bottom line is replaced by pieces, drawn like
// the tabs of a browser or a code editor: tabs fill the bar's height with a divider between them,
// the shown tab is the content's own surface and the bar's bottom line breaks under it, every tab
// has its own close button, the + follows the last tab, and a middle click closes. The bottom line
// is drawn piece by piece (each tab, the gutters, the free space) because the shown tab must be able
// to be see-through (the desktop window backdrop) and so cannot cover a line behind it. Renaming is
// F2 or the menu, never a double click.
// Tabs reorder by dragging through the page's DndContext (paneDnd.tsx); the menu moves them too,
// which is also how a touch screen does it.
import { useDndMonitor, useDraggable, useDroppable } from "@dnd-kit/core";
import { ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { observeResize } from "~/lib/observeResize";
import { paneKeyLabels } from "~/lib/paneKeys";
import { firstSessionKey, indexOfTab, tabLabel, type PaneTab } from "~/lib/paneTabs";
import { cn } from "~/lib/utils";
import { popupPosition, useAnchoredMenu } from "../ProjectMenus";
import { Button } from "../ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../PaneHeader";
import { PageHeader } from "../PageHeader";
import { paneActions, usePaneTabs } from "./paneStore";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const KEYS = paneKeyLabels(IS_MAC);

/** A scroll position within this many px of an end counts as at that end (RightPanel's tolerance). */
const SCROLL_EDGE_TOLERANCE = 1;

/** A tab's smallest width in spacing steps (TAB_CLASS's `min-w-28`, 7rem at the default scale); the strip scrolls once the tabs need more. */
const TAB_MIN_SPACING = 28;
/**
 * A tab fills the bar's height. It starts at 12rem and shrinks toward its minimum as tabs are
 * added (a browser's tab strip); past the minimum the strip scrolls. Each tab owns its bottom line
 * and its right divider.
 */
export const TAB_CLASS =
  "group/tab relative flex h-full w-48 min-w-28 shrink cursor-pointer items-center gap-0.5 border-r border-b border-border pl-3 pr-1.5 text-sm [-webkit-app-region:no-drag]";
export const TAB_STATE_CLASS = {
  // The shown tab is the content's surface and has no bottom line: it reads as one with the panes.
  active: "border-b-transparent bg-background text-foreground",
  idle: "text-muted-foreground hover:bg-accent hover:text-foreground",
} as const;
/** The bar's bottom line under everything that is not a tab; the bar's own surface is `bg-sidebar`. */
export const BAR_LINE_CLASS = "border-b border-border";

/** `active.data` of a tab dragged along the strip, and `over.data` of a tab a drag is over. */
interface TabDragData {
  kind: "split-tab";
  tabId: string;
}
interface TabDropData {
  kind: "split-tab-drop";
  tabId: string;
}

function tabIdOf(data: unknown, kind: TabDragData["kind"] | TabDropData["kind"]): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { kind?: unknown; tabId?: unknown };
  return d.kind === kind && typeof d.tabId === "string" ? d.tabId : null;
}

/**
 * `sessionName` gives a session's display name for the default tab name (the first session of the
 * tab), or null while it is not known.
 */
export function SplitTabs({ sessionName }: { sessionName: (sessionKey: string) => string | null }) {
  const { tabs, active } = usePaneTabs();
  const menu = useAnchoredMenu<string>();
  const [renaming, setRenaming] = useState<{ tabId: string; open: boolean } | null>(null);
  const strip = useStripScroll();
  const [drag, setDrag] = useState<{ tabId: string; overId: string | null } | null>(null);

  const labels = tabs.map((tab) => {
    const key = firstSessionKey(tab);
    return tabLabel(tab, key ? sessionName(key) : null);
  });
  const labelOf = (id: string) => labels[indexOfTab({ tabs, active }, id)] ?? "";

  // The shown tab stays in view when the tabs overflow (a new tab, a key, a menu move, a name that
  // arrives and widens the strip).
  useEffect(() => {
    if (!strip.scroll.overflow) return;
    strip.listRef.current
      ?.querySelector<HTMLElement>("[data-active-tab='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length, strip.scroll.overflow, strip.scroll.width, strip.listRef]);

  useDndMonitor({
    onDragStart(event) {
      const tabId = tabIdOf(event.active.data.current, "split-tab");
      if (tabId) setDrag({ tabId, overId: null });
    },
    onDragOver(event) {
      const tabId = tabIdOf(event.active.data.current, "split-tab");
      if (!tabId) return;
      const overId = tabIdOf(event.over?.data.current, "split-tab-drop");
      setDrag((prev) => (prev && prev.overId !== overId ? { ...prev, overId } : prev));
    },
    onDragEnd(event) {
      const tabId = tabIdOf(event.active.data.current, "split-tab");
      if (!tabId) return;
      setDrag(null);
      const overId = tabIdOf(event.over?.data.current, "split-tab-drop");
      if (overId && overId !== tabId) paneActions.moveTab(tabId, tabs.findIndex((t) => t.id === overId));
    },
    onDragCancel(event) {
      if (tabIdOf(event.active.data.current, "split-tab")) setDrag(null);
    },
  });
  const dragIndex = drag ? tabs.findIndex((t) => t.id === drag.tabId) : -1;
  const overIndex = drag?.overId ? tabs.findIndex((t) => t.id === drag.overId) : -1;

  const menuTab = menu.state ? tabs.find((t) => t.id === menu.state!.target) : undefined;
  const menuIndex = menuTab ? tabs.indexOf(menuTab) : -1;
  const renamingTab = renaming ? tabs.find((t) => t.id === renaming.tabId) : undefined;

  return (
    <>
      <PageHeader data-split-tabs="" className="gap-0 border-b-0 p-0 [[data-sidebar-state=collapsed]_&]:pl-0 max-md:[[data-sidebar-state=expanded]_&]:pl-0">
        {/* The header's own padding (the sidebar toggle's room on the left, the window controls' on
            the right) moves into these two pieces so the bottom line runs under them. */}
        <div
          aria-hidden
          className={cn("h-full shrink-0 pl-(--workspace-gutter-start)", BAR_LINE_CLASS, COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS)}
        />
        <ScrollArea ref={strip.attachList} radius="none" hideScrollbars className="h-full w-auto min-w-0 flex-[0_1_auto]">
          <div role="group" aria-label="Split tabs" className="flex h-full w-full" style={{ minWidth: `calc(var(--spacing) * ${tabs.length * TAB_MIN_SPACING})` }}>
            {tabs.map((tab, i) => (
              <StripTab
                key={tab.id}
                tab={tab}
                index={i}
                label={labels[i]!}
                active={tab.id === active}
                closable={tabs.length > 1}
                dragging={drag?.tabId === tab.id}
                dropSide={drag?.overId === tab.id && dragIndex >= 0 ? (dragIndex > overIndex ? "before" : "after") : null}
                onSelect={() => paneActions.selectTab(tab.id)}
                onClose={() => paneActions.closeTab(tab.id)}
                onRename={() => setRenaming({ tabId: tab.id, open: true })}
                onContextMenu={(event) => {
                  event.preventDefault();
                  menu.showAtPointer(tab.id, event);
                }}
              />
            ))}
          </div>
        </ScrollArea>
        <div className={cn("flex h-full shrink-0 items-center px-1", BAR_LINE_CLASS)}>
          <StripButton label={`New tab (${KEYS.newTab})`} onClick={() => paneActions.addTab()}>
            <PlusIcon />
          </StripButton>
        </div>
        {/* The free space between the tabs and the right-hand buttons: the window's drag area. */}
        <div aria-hidden className={cn("h-full min-w-0 flex-1", BAR_LINE_CLASS)} />
        <div
          className={cn(
            "flex h-full shrink-0 items-center gap-0.5 pl-1 pr-[calc(var(--workspace-controls-right)+1px)]",
            BAR_LINE_CLASS,
          )}
        >
          {strip.scroll.overflow ? (
            <div role="group" aria-label="Scroll tabs" className="flex shrink-0 items-center gap-0.5 max-sm:hidden">
              <StripButton label="Scroll tabs left" disabled={!strip.scroll.left} onClick={() => strip.scrollBy(-1)}>
                <ChevronLeftIcon />
              </StripButton>
              <StripButton label="Scroll tabs right" disabled={!strip.scroll.right} onClick={() => strip.scrollBy(1)}>
                <ChevronRightIcon />
              </StripButton>
            </div>
          ) : null}
          <StripButton
            label="Tab menu"
            onClick={(event) => menu.toggleFromButton(active, event.currentTarget)}
            popup
          >
            <MoreHorizontalIcon />
          </StripButton>
        </div>
      </PageHeader>

      <Menu open={menu.open} onOpenChange={menu.onOpenChange}>
        {menu.state && menuTab ? (
          <MenuPopup aria-label="Tab menu" anchor={menu.state.anchor} {...popupPosition(menu.state.placement)} className="min-w-52">
            <MenuItem onClick={() => setRenaming({ tabId: menuTab.id, open: true })}>
              <PencilIcon />
              Rename
              <MenuShortcut>{KEYS.rename}</MenuShortcut>
            </MenuItem>
            <MenuSeparator />
            <MenuItem disabled={menuIndex <= 0} onClick={() => paneActions.moveTab(menuTab.id, menuIndex - 1)}>
              <ChevronLeftIcon />
              Move left
            </MenuItem>
            <MenuItem disabled={menuIndex >= tabs.length - 1} onClick={() => paneActions.moveTab(menuTab.id, menuIndex + 1)}>
              <ChevronRightIcon />
              Move right
            </MenuItem>
            <MenuSeparator />
            <MenuItem disabled={tabs.length < 2} onClick={() => paneActions.closeTab(menuTab.id)}>
              <XIcon />
              {tabs.length < 2 ? "Close tab (last tab)" : "Close tab"}
              <MenuShortcut>{KEYS.closeTab}</MenuShortcut>
            </MenuItem>
          </MenuPopup>
        ) : null}
      </Menu>

      {renaming && renamingTab ? (
        <RenameTabDialog
          key={renaming.tabId}
          open={renaming.open}
          tab={renamingTab}
          defaultName={labelOf(renamingTab.id)}
          onSubmit={(name) => {
            paneActions.renameTab(renamingTab.id, name);
            setRenaming({ ...renaming, open: false });
          }}
          onClose={() => setRenaming({ ...renaming, open: false })}
          onClosed={() => setRenaming(null)}
        />
      ) : null}
    </>
  );
}

function StripTab(props: {
  tab: PaneTab;
  index: number;
  label: string;
  active: boolean;
  closable: boolean;
  dragging: boolean;
  dropSide: "before" | "after" | null;
  onSelect: () => void;
  onClose: () => void;
  onRename: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const { tab } = props;
  const drag = useDraggable({ id: `split-tab:${tab.id}`, data: { kind: "split-tab", tabId: tab.id } satisfies TabDragData });
  const drop = useDroppable({ id: `split-tab-drop:${tab.id}`, data: { kind: "split-tab-drop", tabId: tab.id } satisfies TabDropData });
  const { setNodeRef: setDragRef } = drag;
  const { setNodeRef: setDropRef } = drop;
  const setRef = useMemo(
    () => (el: HTMLDivElement | null) => {
      setDragRef(el);
      setDropRef(el);
    },
    [setDragRef, setDropRef],
  );
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "F2") return;
    event.preventDefault();
    props.onRename();
  };
  return (
    <div
      ref={setRef}
      data-tab-id={tab.id}
      data-active-tab={props.active}
      data-drop-side={props.dropSide ?? undefined}
      className={cn(
        TAB_CLASS,
        props.active ? TAB_STATE_CLASS.active : TAB_STATE_CLASS.idle,
        props.dragging && "z-10 cursor-grabbing border-b-border bg-popover text-foreground shadow-md",
      )}
      // Along the strip only: a tab moves sideways.
      style={drag.transform ? { transform: `translate3d(${drag.transform.x}px, 0, 0)` } : undefined}
      onMouseDown={(event) => {
        // A middle press would start the browser's autoscroll; its click closes the tab. dnd-kit's
        // mouse sensor starts a drag from the main button only.
        if (event.button === 1) event.preventDefault();
        (drag.listeners?.onMouseDown as ((e: ReactMouseEvent<HTMLElement>) => void) | undefined)?.(event);
      }}
      onAuxClick={(event) => {
        if (event.button === 1 && props.closable) {
          event.preventDefault();
          props.onClose();
        }
      }}
      onContextMenu={props.onContextMenu}
    >
      {props.dropSide ? (
        <span
          aria-hidden
          className={cn("pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-primary", props.dropSide === "before" ? "left-0" : "right-0")}
        />
      ) : null}
      <button
        type="button"
        aria-current={props.active ? "true" : undefined}
        title={props.label}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 outline-none focus-visible:underline"
        onClick={props.onSelect}
        onKeyDown={onKeyDown}
      >
        <span aria-hidden className="shrink-0 tabular-nums text-muted-foreground/70">
          {props.index + 1}
        </span>
        <span className="truncate">{props.label}</span>
      </button>
      {props.closable ? (
        <button
          type="button"
          aria-label={`Close ${props.label}`}
          className={cn(
            "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-sm:size-7",
            // Touch has no hover: the shown tab keeps its close button, the others have none.
            !props.active && "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100 max-sm:hidden",
          )}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={props.onClose}
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export function StripButton(props: {
  label: string;
  disabled?: boolean;
  popup?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // A disabled button gets no pointer events; the span keeps the tooltip working.
          <span className="inline-flex shrink-0">
            <Button
              aria-label={props.label}
              aria-haspopup={props.popup ? "menu" : undefined}
              disabled={props.disabled}
              onClick={props.onClick}
              size="icon-xs"
              variant="ghost"
            >
              {props.children}
            </Button>
          </span>
        }
      />
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Tracks whether the strip overflows and which ends have more, and scrolls it. The strip is a
 * ScrollArea; a vertical wheel over it scrolls it sideways (RightPanel's tab strip does the same).
 */
function useStripScroll() {
  const listRef = useRef<HTMLDivElement | null>(null);
  // `width` is the strip's content width: tab names that arrive late (a session's name) widen it.
  const [scroll, setScroll] = useState({ overflow: false, left: false, right: false, width: 0 });
  // Created once: it owns listeners on the ScrollArea viewport.
  const [attachList] = useState(() => (root: HTMLDivElement | null) => {
    listRef.current = root;
    const viewport = root?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return undefined;
    const update = () => {
      const overflow = viewport.scrollWidth - viewport.clientWidth > SCROLL_EDGE_TOLERANCE;
      const left = overflow && viewport.scrollLeft > SCROLL_EDGE_TOLERANCE;
      const right = overflow && viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - SCROLL_EDGE_TOLERANCE;
      const width = viewport.scrollWidth;
      setScroll((prev) =>
        prev.overflow === overflow && prev.left === left && prev.right === right && prev.width === width
          ? prev
          : { overflow, left, right, width },
      );
    };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      let delta = event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= viewport.clientWidth;
      const before = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (viewport.scrollLeft === before) return;
      event.preventDefault();
      update();
    };
    const content = viewport.firstElementChild;
    const stopObserving = observeResize(content ? [viewport, content] : viewport, update);
    viewport.addEventListener("scroll", update, { passive: true });
    viewport.addEventListener("wheel", onWheel, { passive: false });
    update();
    return () => {
      listRef.current = null;
      stopObserving();
      viewport.removeEventListener("scroll", update);
      viewport.removeEventListener("wheel", onWheel);
    };
  });
  const scrollBy = (direction: -1 | 1) => {
    const viewport = listRef.current?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport.scrollBy({ left: direction * Math.max(120, viewport.clientWidth * 0.75), behavior: reduceMotion ? "auto" : "smooth" });
  };
  return { listRef, attachList, scroll, scrollBy };
}

/** The sidebar's session rename dialog (ProjectDialogs.tsx) for a tab; a blank name returns to the default. */
function RenameTabDialog(props: {
  open: boolean;
  tab: PaneTab;
  /** What the tab shows while it has no name. */
  defaultName: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
  onClosed: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(props.tab.name ?? "");
  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) props.onClosed();
      }}
    >
      <DialogPopup className="sm:max-w-md" showCloseButton={false}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSubmit(name);
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename tab</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                nativeInput
                id={`${id}-name`}
                value={name}
                placeholder={props.tab.name === null ? props.defaultName : undefined}
                onChange={(event) => setName(event.currentTarget.value)}
                onFocus={(event) => event.currentTarget.select()}
                autoComplete="off"
              />
              <p className="text-muted-foreground text-xs">Leave empty to use the first session's name ("New tab" if there is none)</p>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
