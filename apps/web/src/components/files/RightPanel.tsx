// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: components/RightPanelTabs.tsx (tab strip in a fading ScrollArea with scroll buttons when
// it overflows, icon that turns into a close button on hover, middle-click close),
// ui/panel-tab-close-button.tsx, components/RightPanelSheet.tsx (a sheet at 980px and below),
// hooks/usePreviewPanelInlineSize.ts (the inline width is capped on mount, on window resize and
// whenever the shared row resizes), preview/RightPanelResizeHandle.tsx, preview/PreviewPanelShell.tsx
// (focus goes back to the panel toggle when the panel closes) and chat/PanelLayoutControls.tsx
// (the toggle). Local changes: the tabs are the file explorer and the agents tab, pinned outside
// the scroll area in that order, and file tabs kept per session (~/rightPanel.ts). The explorer is
// T3's Files surface (FileExplorer.tsx) as a fixed tab that shows by default; T3 opens it from its
// add menu and, like any surface, keeps it where it was opened, so a panel that starts with it has
// it first. The toggle sits at the conversation header's right end while the panel is closed and
// at the tab strip's right end while it is open, the same spot.
import type { SessionAgentView } from "@maru/shared";
import { BotIcon, ChevronLeftIcon, ChevronRightIcon, FileIcon, FilesIcon, FolderIcon, PanelRightIcon, XIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { useResizeDrag } from "~/hooks/useResizeDrag";
import { areaZoomAttributes, useAreaZoom } from "~/lib/areaZoom";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { shortPath } from "~/model";
import {
  AGENTS_TAB,
  EXPLORER_TAB,
  FileOpenContext,
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  currentFileTab,
  panelFitsInline,
  panelMaxWidth,
  panelShownWidth,
  shownPanelTab,
  type FileTarget,
  type useRightPanel,
} from "~/rightPanel";
import { useThread } from "~/useThread";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AreaZoomIndicator } from "../AreaZoomIndicator";
import { AgentsView } from "./AgentsView";
import { FilePreview } from "./FilePreview";

// Its own chunk with the tree's icon sprite, loaded when the explorer first shows.
const FileExplorer = lazy(() => import("./FileExplorer").then((m) => ({ default: m.FileExplorer })));

const WIDTH_STORAGE_KEY = "maru_right_panel_width";
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const PANEL_SHORTCUT_LABEL = IS_MAC ? "⌥⌘B" : "Ctrl+Alt+B";
const PANEL_LABEL = "Right panel";
/** A scroll position within this many px of an end counts as at that end. */
const TAB_SCROLL_EDGE_TOLERANCE = 1;

type Panel = ReturnType<typeof useRightPanel>;

/** What the agents tab shows (GET /api/session-agents) and the session its actions go to. */
export interface AgentsSource {
  sessionKey: string;
  agents: readonly SessionAgentView[];
  /** Running subagents and workflows, current even while the rows are not read (the tab's badge). */
  running: number;
  error: string | null;
  onOpenThread: (threadId: string, title: string) => void;
}

/** Whether the panel sits inline and how wide it may be there, measured from the row it shares. */
export interface RightPanelLayout {
  inline: boolean;
  maxWidth: number;
  /** Ref for the row that holds the conversation and the panel. */
  observeRow: (row: HTMLElement | null) => (() => void) | undefined;
}

/**
 * Measures the row before paint (a ref callback), then on window resize and whenever the row
 * resizes (sidebar drag, sidebar toggle). Only the derived values are state, so a row resize that
 * leaves them unchanged does not re-render the session view.
 */
export function useRightPanelLayout(): RightPanelLayout {
  const [inline, setInline] = useState(() => panelFitsInline(window.innerWidth, null));
  const [maxWidth, setMaxWidth] = useState(() => panelMaxWidth(window.innerWidth, null));
  // Created once: a new ref function each render would stop and restart the observer.
  const [observeRow] = useState(() => (row: HTMLElement | null) => {
    if (!row) return undefined;
    const measure = () => {
      setInline(panelFitsInline(window.innerWidth, row.clientWidth));
      setMaxWidth(panelMaxWidth(window.innerWidth, row.clientWidth));
    };
    measure();
    let frame = 0;
    const onResize = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    window.addEventListener("resize", onResize);
    const stopObserving = observeResize(row, measure);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      stopObserving();
    };
  });
  return { inline, maxWidth, observeRow };
}

function readWidth(): number {
  try {
    const v = Number(window.localStorage.getItem(WIDTH_STORAGE_KEY));
    return Number.isFinite(v) && v >= PANEL_MIN_WIDTH ? v : PANEL_DEFAULT_WIDTH;
  } catch {
    return PANEL_DEFAULT_WIDTH;
  }
}

function basenameOf(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1) || p;
}

/**
 * Set while a toggle that has focus unmounts. Opening and closing swap the header toggle for the
 * tab strip's in one commit; the toggle mounted in that commit takes the focus over.
 */
let toggleFocusHandoff = false;

/**
 * The header's Files button (user request 2026-11-19: "Files 아이콘도 있으면 좋겠음"): opens the
 * panel on its Files tab, or closes it while that tab shows. The icon is the Files tab's own.
 */
export function FilesButton({ pressed, onToggle }: { pressed: boolean; onToggle: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            data-files-button=""
            aria-pressed={pressed}
            size="icon-xs"
            variant={pressed ? "secondary" : "ghost-muted"}
            aria-label="Files"
            className="shrink-0"
            onClick={onToggle}
          />
        }
      >
        <FilesIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Files</TooltipPopup>
    </Tooltip>
  );
}

/** Opens and closes the panel. `data-right-panel-toggle` is where focus goes when the panel closes. */
export function RightPanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (toggleFocusHandoff) {
      toggleFocusHandoff = false;
      el.focus();
    }
    return () => {
      // Runs before the button leaves the DOM, so it still holds focus here.
      if (el.ownerDocument.activeElement !== el) return;
      toggleFocusHandoff = true;
      // Nothing took it over in this commit (the session view went away): forget it.
      queueMicrotask(() => {
        toggleFocusHandoff = false;
      });
    };
  }, []);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            ref={ref}
            className="shrink-0"
            pressed={open}
            onPressedChange={onToggle}
            aria-label={PANEL_LABEL}
            data-right-panel-toggle=""
            variant="ghost"
            size="sm"
          />
        }
      >
        <PanelRightIcon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {PANEL_LABEL} ({PANEL_SHORTCUT_LABEL})
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The panel always as a sheet, opened and closed by its owner instead of the session's open flag:
 * a split view pane (DESIGN.md 6k) shows the session's tabs without changing how the single view
 * left its panel.
 */
export interface RightPanelSheet {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A link in a previewed file opens here (the owner keeps the panel's open flag as it was). */
  onOpenFile: (target: FileTarget) => void;
  className?: string;
}

const SHEET_CLASS = "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0";

/**
 * The panel beside the conversation, or a sheet over it when the row cannot hold both (or `sheet`
 * asks for one). `cwd` is the session's folder, where the file explorer starts.
 */
export function RightPanel(
  props: { panel: Panel; agents: AgentsSource; cwd: string | null } & (
    | { layout: RightPanelLayout; sheet?: undefined }
    | { sheet: RightPanelSheet; layout?: undefined }
  ),
) {
  const { panel, agents, cwd } = props;
  if (props.sheet || !props.layout.inline) {
    const open = props.sheet ? props.sheet.open : panel.state.open;
    const setOpen = props.sheet ? props.sheet.onOpenChange : panel.setOpen;
    return (
      <Sheet open={open} onOpenChange={(next) => setOpen(next)}>
        <SheetPopup side="right" showCloseButton={false} className={props.sheet?.className ?? SHEET_CLASS}>
          <SheetTitle className="sr-only">{PANEL_LABEL}</SheetTitle>
          <RightPanelContent
            panel={panel}
            agents={agents}
            cwd={cwd}
            sheet
            onClose={() => setOpen(false)}
            onOpenFile={props.sheet?.onOpenFile ?? panel.openFile}
          />
        </SheetPopup>
      </Sheet>
    );
  }
  if (!panel.state.open) return null;
  return <InlinePanel panel={panel} agents={agents} cwd={cwd} maxWidth={props.layout.maxWidth} />;
}

function InlinePanel({ panel, agents, cwd, maxWidth }: { panel: Panel; agents: AgentsSource; cwd: string | null; maxWidth: number }) {
  // The width the user chose. What shows is that width within the current cap; a narrower window
  // shrinks the panel without forgetting the choice.
  const [chosen, setChosen] = useState(readWidth);
  const width = panelShownWidth(chosen, maxWidth);
  const hostRef = useRef<HTMLElement | null>(null);
  const { onPointerDown, refresh, ...handle } = useResizeDrag<HTMLDivElement>((event) => {
    const before = chosen;
    return {
      width: event.currentTarget.parentElement?.getBoundingClientRect().width ?? width,
      edge: "left",
      bounds: { min: PANEL_MIN_WIDTH, max: maxWidth },
      resize: (w) => {
        setChosen(w);
        return w;
      },
      finish: (w, moved) => {
        // A click on the handle is not a choice; keep the width chosen before it.
        if (!moved) return setChosen(before);
        try {
          window.localStorage.setItem(WIDTH_STORAGE_KEY, String(Math.round(w)));
        } catch {
          // The width then lasts for this page only.
        }
      },
    };
  });
  // The cap can change mid-drag (window resize, sidebar toggle); the drag follows it.
  useLayoutEffect(() => refresh({ min: PANEL_MIN_WIDTH, max: maxWidth }), [refresh, maxWidth]);

  // Closing removes the panel; if focus was in it, it goes to the toggle that takes its place.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return () => {
      const doc = host.ownerDocument;
      if (!host.contains(doc.activeElement)) return;
      queueMicrotask(() => {
        if (doc.activeElement === null || doc.activeElement === doc.body) {
          doc.querySelector<HTMLElement>("[data-right-panel-toggle]")?.focus();
        }
      });
    };
  }, []);

  return (
    <aside
      ref={hostRef}
      aria-label={PANEL_LABEL}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-sidebar-divider bg-side-surface"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        ref={handle.ref}
        className="group/resize absolute inset-y-0 left-0 z-40 w-1 cursor-col-resize touch-none select-none any-pointer-coarse:-left-2 any-pointer-coarse:w-4"
        onPointerDown={onPointerDown}
        onPointerMove={handle.onPointerMove}
        onPointerUp={handle.onPointerUp}
        onPointerCancel={handle.onPointerCancel}
        onLostPointerCapture={handle.onLostPointerCapture}
        onDoubleClick={() => {
          setChosen(PANEL_DEFAULT_WIDTH);
          try {
            window.localStorage.removeItem(WIDTH_STORAGE_KEY);
          } catch {
            // Nothing stored to clear.
          }
        }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover/resize:bg-border group-active/resize:bg-primary/60 any-pointer-coarse:left-2"
        />
      </div>
      <RightPanelContent
        panel={panel}
        agents={agents}
        cwd={cwd}
        sheet={false}
        onClose={() => panel.setOpen(false)}
        onOpenFile={panel.openFile}
      />
    </aside>
  );
}

/**
 * The session's folder for the explorer: `cwd`, else, for a session listed without one, the folder
 * its conversation reports. The conversation is read only in that case.
 */
function SessionFolder(props: { sessionKey: string; cwd: string | null; children: (folder: string | null) => ReactNode }) {
  return props.cwd !== null ? props.children(props.cwd) : <ThreadFolder sessionKey={props.sessionKey}>{props.children}</ThreadFolder>;
}

function ThreadFolder(props: { sessionKey: string; children: (folder: string | null) => ReactNode }) {
  const { state } = useThread(props.sessionKey);
  return props.children(state.snapshot?.state.cwd ?? null);
}

/**
 * The tab strip and the shown tab: the panel's body, inline or in a sheet. `onClose` closes the
 * panel or the owner's sheet; a file opened inside (an explorer row, a link in a previewed file)
 * goes to `onOpenFile`, the owner's way of opening it.
 */
export function RightPanelContent({
  panel,
  agents,
  cwd,
  sheet,
  onClose,
  onOpenFile,
}: {
  panel: Panel;
  agents: AgentsSource;
  cwd: string | null;
  sheet: boolean;
  onClose: () => void;
  onOpenFile: (target: FileTarget) => void;
}) {
  const shown = shownPanelTab(panel.state);
  const running = agents.running;
  // Ctrl+wheel over the panel zooms its tabs and contents (lib/areaZoom.ts), inline or in a sheet.
  const zoomKey = useId();
  const zoom = useAreaZoom("panel");
  // The explorer mounts the first time it shows and then stays, hidden behind other tabs, so its
  // open folders, reads and scroll position survive a look at a file (T3 keeps hidden tabs mounted).
  const [explorerMounted, setExplorerMounted] = useState(shown === "explorer");
  if (shown === "explorer" && !explorerMounted) setExplorerMounted(true);
  return (
    <SessionFolder sessionKey={agents.sessionKey} cwd={cwd}>
      {(folder) => (
        <div {...areaZoomAttributes("panel", zoomKey, zoom)} className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-side-surface">
          <AreaZoomIndicator zoomKey={zoomKey} area="panel" className="top-[calc(var(--workspace-topbar-height)+0.5rem)] right-3" />
          <TabStrip panel={panel} shown={shown} running={running} folder={folder} onClose={onClose} />
          {explorerMounted && folder ? (
            <Suspense fallback={null}>
              <FileExplorer
                key={folder}
                root={folder}
                current={currentFileTab(panel.state)}
                onOpenFile={onOpenFile}
                hidden={shown !== "explorer"}
                sheet={sheet}
              />
            </Suspense>
          ) : null}
          {shown === "explorer" ? (
            folder ? null : <p className="px-4 py-3 text-xs text-muted-foreground">Session folder unknown</p>
          ) : shown === "agents" ? (
            <AgentsView sessionKey={agents.sessionKey} agents={agents.agents} error={agents.error} onOpenThread={agents.onOpenThread} />
          ) : (
            // A file link in a previewed Markdown file (MarkdownFileLink reads this context) opens
            // the way the owner opens files, as a chip in the conversation does.
            <FileOpenContext value={onOpenFile}>
              <FilePreview
                key={shown.path}
                target={shown}
                onOpen={onOpenFile}
                onKind={(kind) => panel.setKind(shown.path, kind)}
              />
            </FileOpenContext>
          )}
        </div>
      )}
    </SessionFolder>
  );
}

const TAB_CLASS = "flex h-6 shrink-0 cursor-pointer items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs";
const TAB_STATE_CLASS = {
  active: "bg-accent text-foreground",
  idle: "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
} as const;

function TabStrip({
  panel,
  shown,
  running,
  folder,
  onClose,
}: {
  panel: Panel;
  shown: ReturnType<typeof shownPanelTab>;
  running: number;
  folder: string | null;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scroll, setScroll] = useState({ overflow: false, left: false, right: false });

  // Created once, like the layout observer: it owns listeners on the ScrollArea viewport.
  const [attachList] = useState(() => (root: HTMLDivElement | null) => {
    listRef.current = root;
    const viewport = root?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return undefined;
    const update = () => {
      const overflow = viewport.scrollWidth - viewport.clientWidth > TAB_SCROLL_EDGE_TOLERANCE;
      const left = overflow && viewport.scrollLeft > TAB_SCROLL_EDGE_TOLERANCE;
      const right =
        overflow && viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - TAB_SCROLL_EDGE_TOLERANCE;
      setScroll((prev) =>
        prev.overflow === overflow && prev.left === left && prev.right === right ? prev : { overflow, left, right },
      );
    };
    // A vertical mouse wheel scrolls the strip sideways; horizontal input scrolls natively.
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

  // Scrolls the strip (DOM state outside React) so the shown tab is in view when the tabs overflow.
  const shownPath = typeof shown === "string" ? null : shown.path;
  useEffect(() => {
    if (!shownPath || !scroll.overflow) return;
    listRef.current
      ?.querySelector<HTMLElement>("[data-active-tab='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [shownPath, scroll.overflow]);

  // Closing a tab from inside the strip moves focus to the tab shown in its place, not to the page.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const refocus = useRef(false);
  const closeTab = (path: string) => {
    refocus.current = !!stripRef.current?.contains(document.activeElement);
    panel.closeFile(path);
  };
  const tabs = panel.state.tabs;
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const tab = stripRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    (tab?.matches("button") ? tab : tab?.querySelector<HTMLElement>("button:not([aria-label])"))?.focus();
  }, [tabs]);

  const scrollTabs = (direction: -1 | 1) => {
    const viewport = listRef.current?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport.scrollBy({ left: direction * Math.max(120, viewport.clientWidth * 0.75), behavior: reduceMotion ? "auto" : "smooth" });
  };

  return (
    // The toggle at the end sits 13px from the window edge, mirroring the sidebar toggle.
    <div
      ref={stripRef}
      data-titlebar=""
      className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2 pr-[calc(var(--workspace-controls-right)+1px)]"
    >
      <button
        type="button"
        data-active-tab={shown === "explorer"}
        aria-current={shown === "explorer" ? "true" : undefined}
        // A native title: a sheet focuses this first tab on opening, and a tooltip would open with it.
        title={folder ? shortPath(folder) : undefined}
        className={cn(
          TAB_CLASS,
          "outline-none focus-visible:ring-2 focus-visible:ring-ring",
          shown === "explorer" ? TAB_STATE_CLASS.active : TAB_STATE_CLASS.idle,
        )}
        onClick={() => panel.activate(EXPLORER_TAB)}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <FilesIcon aria-hidden className="size-3" />
        </span>
        Files
      </button>
      <button
        type="button"
        data-active-tab={shown === "agents"}
        aria-current={shown === "agents" ? "true" : undefined}
        className={cn(
          TAB_CLASS,
          "outline-none focus-visible:ring-2 focus-visible:ring-ring",
          shown === "agents" ? TAB_STATE_CLASS.active : TAB_STATE_CLASS.idle,
        )}
        onClick={() => panel.activate(AGENTS_TAB)}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <BotIcon aria-hidden className="size-3" />
        </span>
        Activity
        {running ? (
          <span className="ms-1 rounded-full bg-info/20 px-1.5 text-3xs font-medium text-info-foreground tabular-nums">
            {running}
          </span>
        ) : null}
      </button>
      <ScrollArea ref={attachList} radius="none" hideScrollbars scrollFade className="min-w-0 flex-1">
        <div className="flex h-full w-max min-w-full items-center gap-1">
          {tabs.map((t) => (
            <FileTab
              key={t.path}
              tab={t}
              active={t.path === shownPath}
              onSelect={() => panel.activate(t.path)}
              onClose={() => closeTab(t.path)}
            />
          ))}
        </div>
      </ScrollArea>
      {scroll.overflow ? (
        <div role="group" aria-label="Scroll tabs" className="flex shrink-0 items-center gap-0.5">
          <ScrollTabsButton label="Scroll tabs left" disabled={!scroll.left} onClick={() => scrollTabs(-1)}>
            <ChevronLeftIcon />
          </ScrollTabsButton>
          <ScrollTabsButton label="Scroll tabs right" disabled={!scroll.right} onClick={() => scrollTabs(1)}>
            <ChevronRightIcon />
          </ScrollTabsButton>
        </div>
      ) : null}
      <RightPanelToggle open onToggle={onClose} />
    </div>
  );
}

function ScrollTabsButton(props: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // A disabled button gets no pointer events; the span keeps the tooltip working.
          <span className="inline-flex">
            <Button aria-label={props.label} disabled={props.disabled} onClick={props.onClick} size="icon-xs" variant="ghost">
              {props.children}
            </Button>
          </span>
        }
      />
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** Keeps a middle press from starting the browser's autoscroll; the click closes the tab. */
function preventMiddleButton(event: MouseEvent) {
  if (event.button === 1) event.preventDefault();
}

function FileTab(props: { tab: FileTarget; active: boolean; onSelect: () => void; onClose: () => void }) {
  const name = basenameOf(props.tab.path);
  const Icon = props.tab.kind === "directory" ? FolderIcon : FileIcon;
  return (
    <div
      data-active-tab={props.active}
      className={cn("group/tab max-w-36", TAB_CLASS, props.active ? TAB_STATE_CLASS.active : TAB_STATE_CLASS.idle)}
      // The whole tab is a pointer target; the name button is the keyboard one.
      onClick={props.onSelect}
      onMouseDown={preventMiddleButton}
      onMouseUp={preventMiddleButton}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <TabCloseButton label={`Close ${name}`} onClick={props.onClose}>
        <Icon aria-hidden className="size-3" />
      </TabCloseButton>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-current={props.active ? "true" : undefined}
              className="flex min-w-0 cursor-pointer items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.stopPropagation();
                props.onSelect();
              }}
            />
          }
        >
          <span className="truncate">{name}</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">{shortPath(props.tab.path)}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** The tab's icon, which turns into a close button while the tab is hovered or the button has focus. */
function TabCloseButton(props: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      className="group/close relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
    >
      <span className="relative flex size-3 items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden">
        {props.children}
      </span>
      <XIcon aria-hidden className="hidden size-3 group-hover/tab:block group-focus-visible/close:block" />
    </button>
  );
}
