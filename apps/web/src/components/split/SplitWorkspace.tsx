// The split view (DESIGN.md 6k): `?view=panes`, conversations side by side like tmux panes. It takes
// the single view's place in the page (a SidebarInset) and must sit inside the page's DndContext
// (paneDnd.tsx), which the sidebar's session rows share.
//
// Panes are drawn as one flat, keyed list placed by the frames lib/paneLayout.ts computes, not as
// nested boxes. Splitting, closing, moving and swapping only change a pane's rectangle, so its
// conversation stays mounted (scroll position, subagent stack, unsent text).
import {
  DragOverlay,
  useDndMonitor,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type Over,
} from "@dnd-kit/core";
import type { ServerMessage, SessionSummary, ShellInfo } from "@maru/shared";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MouseEventHandler,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { SquareTerminalIcon } from "lucide-react";
import { createPortal } from "react-dom";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { matchPaneKey } from "~/lib/paneKeys";
import { leaveToShell } from "~/lib/shellKeys";
import {
  canInsertAt,
  computeFrames,
  dropZoneAt,
  focusedPane,
  insertPreview,
  panesOf,
  pointerZoneAt,
  ratioForDrag,
  type DividerFrame,
  type DropZone,
  type Edge,
  type Frames,
  type FrameOptions,
  type PaneContent,
  type PaneLayout,
  type PaneLeaf,
  type Rect,
} from "~/lib/paneLayout";
import { sourcePaneId } from "~/lib/paneDrag";
import { allPanes } from "~/lib/paneTabs";
import { createShellIn, getShellList, onShellsRead, refreshShells, useShellList } from "~/lib/shellList";
import { onSessionSummary, rekeySession } from "~/lib/sessionViewState";
import { socketHub } from "~/lib/socket";
import { cn } from "~/lib/utils";
import { displayName } from "~/model";
import { ClaudeAI, OpenAI } from "../Icons";
import { reportProjectFailure } from "../ProjectDialogs";
import { Empty, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { dragSourceOf, paneTargetOf, type DragSource, type PaneDragData, type PaneDropData } from "./paneDnd";
import { SessionPane } from "./SessionPane";
import { labelsOf, ShellPane } from "./ShellPane";
import { getPaneLayout, getPaneTabs, paneActions, persistPaneLayout, requestPane, usePaneLayout, usePaneTabs } from "./paneStore";
import { SplitTabs } from "./SplitTabs";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * The smallest pane. 360px is the conversation width the right panel keeps (DESIGN.md 6e) and fits
 * the header's controls; 240px tall keeps the header, a few lines and the composer.
 */
export const PANE_FRAME: FrameOptions = { minWidth: 360, minHeight: 240, gap: 1 };
/** Said when a split is refused because the line it would join cannot take another pane at the minimum size. */
const NO_ROOM = "No room for another pane";
/** Below this width only the focused pane shows and splitting is off. */
export const NARROW_QUERY = "(max-width: 899px)";
/** How long a removed or missing session is left to settle (a move re-adds it under a new key) before its pane closes. */
const GONE_SETTLE_MS = 1500;
/** A session missing when the page loads is checked again after this, past a restarting server's first index scan. */
const MISSING_RECHECK_MS = 10_000;

export function SplitWorkspace({ sessions }: { sessions: Map<string, SessionSummary> }) {
  const layout = usePaneLayout();
  const narrow = useMediaQuery(NARROW_QUERY);
  const containerRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(containerRef);
  const panes = panesOf(layout.root);
  const focused = focusedPane(layout);
  const frames = useMemo(
    () => (size ? computeFrames(layout.root, size.w, size.h, PANE_FRAME) : null),
    [layout.root, size],
  );
  const full: Rect | null = size ? { x: 0, y: 0, w: size.w, h: size.h } : null;
  const rectOf = (id: string): Rect | null => (narrow ? full : (frames?.panes.get(id) ?? null));
  const shown = narrow ? (focused ? [focused] : []) : panes;
  const summaries = useSessionSummaries(sessions, panes);
  // Shell panes (DESIGN.md 6k): the shell list is read while any tab has one, and a pane whose
  // shell the server no longer lists closes.
  const anyShellPane = allPanes(usePaneTabs()).some((p) => p.shellId !== null);
  const shellList = useShellList(anyShellPane);
  const shellLabels = useMemo(() => labelsOf(shellList), [shellList]);
  useEffect(() => onShellsRead(paneActions.reconcileShells), []);
  const shellOf = (id: string): ShellInfo | null => shellList?.find((s) => s.id === id) ?? null;
  // The default name of a tab: its first session's name, from the list or from a pane's own read.
  const sessionName = (key: string): string | null => {
    const s = sessions.get(key) ?? summaries.get(key);
    return s ? displayName(s) : null;
  };
  usePaneKeys(layout, narrow, frames, sessions);
  const focusedSessionCwd = focused?.sessionKey ? (summaries.get(focused.sessionKey)?.cwd ?? null) : null;
  const drag = usePaneDrops(containerRef, narrow, rectOf, frames, full, focusedSessionCwd);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <SplitTabs sessionName={sessionName} />
      <div ref={containerRef} data-split-view="" className="relative isolate min-h-0 min-w-0 flex-1 bg-border">
        {layout.root === null ? <EmptySplitView /> : null}
        {size
          ? shown.map((pane) => {
              const rect = rectOf(pane.id);
              if (!rect) return null;
              return (
                <PaneFrame
                  key={pane.id}
                  pane={pane}
                  rect={rect}
                  session={pane.sessionKey ? (summaries.get(pane.sessionKey) ?? null) : null}
                  shell={pane.shellId ? shellOf(pane.shellId) : null}
                  shellLabel={pane.shellId ? (shellLabels.get(pane.shellId) ?? null) : null}
                  focused={pane.id === focused?.id}
                  ringShown={shown.length > 1}
                />
              );
            })
          : null}
        {!narrow && frames ? frames.dividers.map((d) => <PaneDivider key={d.splitId} divider={d} containerRef={containerRef} />) : null}
        {drag?.noRoom ? (
          <div
            aria-hidden
            data-drop-noroom=""
            className="pointer-events-none absolute z-30 flex items-center justify-center rounded-md bg-destructive/10 ring-2 ring-inset ring-destructive/50"
            style={{ left: drag.noRoom.x + 3, top: drag.noRoom.y + 3, width: drag.noRoom.w - 6, height: drag.noRoom.h - 6 }}
          >
            <span className="rounded-md bg-background px-2 py-1 text-xs font-medium text-destructive-foreground shadow-sm">{NO_ROOM}</span>
          </div>
        ) : null}
        {drag?.preview ? (
          <div
            aria-hidden
            data-drop-preview={drag.target ? `${drag.target.paneId ?? "empty"}:${drag.target.zone}` : undefined}
            className="pointer-events-none absolute z-30 rounded-md bg-primary/15 ring-2 ring-inset ring-primary/60"
            style={{ left: drag.preview.x + 3, top: drag.preview.y + 3, width: drag.preview.w - 6, height: drag.preview.h - 6 }}
          />
        ) : null}
      </div>
      {/* Mounted for a pane drag only: an overlay draws a box for any drag of the page's context,
          and the sidebar draws its own for a row. */}
      {drag?.source.kind === "pane"
        ? createPortal(
            <DragOverlay dropAnimation={null}>
              <PaneDragChip title={drag.source.title} sessionKey={drag.source.sessionKey} shellId={drag.source.shellId} grab={drag.grab} />
            </DragOverlay>,
            document.body,
          )
        : null}
    </SidebarInset>
  );
}

// ---- Panes ----

const PaneFrame = memo(function PaneFrame(props: {
  pane: PaneLeaf;
  rect: Rect;
  session: SessionSummary | null;
  shell: ShellInfo | null;
  shellLabel: string | null;
  focused: boolean;
  ringShown: boolean;
}) {
  const { pane, rect } = props;
  const title = pane.shellId
    ? (props.shellLabel ?? props.shell?.command ?? "Shell")
    : props.session
      ? displayName(props.session)
      : pane.sessionKey
        ? "Loading"
        : "No session";
  const drop = useDroppable({ id: `pane-target:${pane.id}`, data: { kind: "pane-target", paneId: pane.id } satisfies PaneDropData });
  const drag = useDraggable({
    id: `pane:${pane.id}`,
    data: { kind: "pane", paneId: pane.id, sessionKey: pane.sessionKey, shellId: pane.shellId, title } satisfies PaneDragData,
  });
  const onHeaderMouseDown = useHeaderActivator(drag.listeners);
  // dnd-kit starts a drag only for a draggable with a node; the frame is both the drop target and that node.
  const { setNodeRef: setDropRef } = drop;
  const { setNodeRef: setDragRef } = drag;
  const setRef = useMemo(
    () => (el: HTMLDivElement | null) => {
      setDropRef(el);
      setDragRef(el);
    },
    [setDropRef, setDragRef],
  );
  return (
    <div
      ref={setRef}
      data-pane-id={pane.id}
      data-pane-focused={props.focused || undefined}
      data-page-surface=""
      className={cn("@container absolute isolate flex min-h-0 min-w-0 flex-col overflow-hidden bg-background", drag.isDragging && "opacity-60")}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onPointerDownCapture={() => paneActions.focus(pane.id)}
      onFocusCapture={() => paneActions.focus(pane.id)}
    >
      {pane.shellId !== null ? (
        <ShellPane pane={pane} shell={props.shell} label={props.shellLabel} focused={props.focused} onHeaderMouseDown={onHeaderMouseDown} />
      ) : (
        <SessionPane pane={pane} session={props.session} focused={props.focused} onHeaderMouseDown={onHeaderMouseDown} />
      )}
      {props.ringShown && props.focused ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-20 ring-2 ring-inset ring-primary/70" />
      ) : null}
    </div>
  );
});

/**
 * dnd-kit's activator listeners, started only from the pane's own header and not from a control in
 * it (title links, the mode switch, buttons) or from anything portaled out of the pane (its sheet).
 */
function useHeaderActivator(listeners: ReturnType<typeof useDraggable>["listeners"]): MouseEventHandler<HTMLDivElement> | undefined {
  return useMemo(() => {
    const onMouseDown = listeners?.onMouseDown as ((event: ReactMouseEvent<HTMLElement>) => void) | undefined;
    if (!onMouseDown) return undefined;
    return (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target instanceof Element ? event.target : null;
      const header = target?.closest("header");
      if (!header || header.parentElement !== event.currentTarget) return;
      if (target!.closest('button, a, input, textarea, select, [role="button"], [role="radio"], [role="group"], [role="tab"]')) return;
      onMouseDown(event);
    };
  }, [listeners]);
}

function EmptySplitView() {
  const { setNodeRef } = useDroppable({ id: "pane-target:empty", data: { kind: "pane-target", paneId: null } satisfies PaneDropData });
  return (
    <div ref={setNodeRef} data-page-surface="" className="absolute inset-0 flex flex-col bg-background">
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>Drag a session or terminal here</EmptyTitle>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

/**
 * The chip under the pointer while a pane is dragged. The overlay box is the pane's frame (the
 * draggable node) and moves with the pointer, so the chip sits where the header was grabbed.
 */
function PaneDragChip({
  title,
  sessionKey,
  shellId,
  grab,
}: {
  title: string;
  sessionKey: string | null;
  shellId: string | null;
  grab: { x: number; y: number } | null;
}) {
  const provider = sessionKey?.split(":", 1)[0];
  return (
    <div
      className="absolute flex h-9 w-64 cursor-grabbing items-center gap-2 rounded-md bg-popover px-2.5 text-sm font-medium text-foreground shadow-lg ring-1 ring-border"
      style={{ left: (grab?.x ?? 0) - 18, top: (grab?.y ?? 0) - 18 }}
    >
      {shellId !== null ? (
        <SquareTerminalIcon aria-hidden className="size-3.5 shrink-0" />
      ) : provider === "claude" ? (
        <ClaudeAI aria-hidden className="size-3.5 shrink-0" />
      ) : provider === "codex" ? (
        <OpenAI aria-hidden className="size-3.5 shrink-0 text-black dark:text-white" />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </div>
  );
}

// ---- Dividers ----

function PaneDivider({ divider, containerRef }: { divider: DividerFrame; containerRef: React.RefObject<HTMLDivElement | null> }) {
  const row = divider.dir === "row";
  const latest = useRef(divider);
  latest.current = divider;
  const [dragging, setDragging] = useState(false);
  // The drag as the handlers see it; releasing the capture fires lostpointercapture before a re-render.
  const active = useRef(false);
  const frame = useRef<number | null>(null);
  const pos = useRef(0);

  const axisPos = (event: ReactPointerEvent) => {
    const box = containerRef.current!.getBoundingClientRect();
    return row ? event.clientX - box.left : event.clientY - box.top;
  };
  const end = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    if (!active.current) return;
    active.current = false;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    setDragging(false);
    if (commit) paneActions.ratio(latest.current.splitId, ratioForDrag(latest.current, pos.current), false);
    persistPaneLayout();
  };

  const hit = 9;
  const style = row
    ? { left: divider.rect.x + divider.rect.w / 2 - hit / 2, top: divider.rect.y, width: hit, height: divider.rect.h }
    : { left: divider.rect.x, top: divider.rect.y + divider.rect.h / 2 - hit / 2, width: divider.rect.w, height: hit };
  return (
    <div
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label="Resize pane"
      data-split-id={divider.splitId}
      data-dragging={dragging || undefined}
      className={cn("group absolute z-10 flex items-center justify-center", row ? "cursor-col-resize" : "cursor-row-resize")}
      style={style}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        pos.current = axisPos(event);
        document.body.style.cursor = row ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";
        active.current = true;
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!active.current) return;
        pos.current = axisPos(event);
        if (frame.current !== null) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          paneActions.ratio(latest.current.splitId, ratioForDrag(latest.current, pos.current), false);
        });
      }}
      onPointerUp={(event) => end(event, true)}
      onPointerCancel={(event) => end(event, false)}
      onLostPointerCapture={(event) => end(event, true)}
      onDoubleClick={() => paneActions.equalize(divider.splitId)}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none bg-transparent transition-colors group-hover:bg-ring group-data-[dragging]:bg-ring",
          row ? "h-full w-[3px]" : "h-[3px] w-full",
        )}
      />
    </div>
  );
}

// ---- Size ----

function useElementSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } | null {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const w = Math.floor(el.clientWidth);
      const h = Math.floor(el.clientHeight);
      setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

// ---- Sessions ----

/**
 * Summaries of the panes' sessions: the list's, or for a session off the list (opened from the
 * settings' full list) the one `/api/session` gives. Also tidies the layout: a session that moved
 * to another account follows to its new key, and a pane whose session is gone closes. Gone needs
 * a 404 from `/api/session` after a sign the server gives (the list drops the key, a Codex thread
 * reports `thread.removed`, a Claude thread reports `thread.error` because its transcript went
 * away), or two 404s ten seconds apart for a session already missing at load (a restarting server
 * answers before its first scan ends). A 404 first looks for the same session under the
 * provider's other accounts, so an off-list session follows a move too.
 */
function useSessionSummaries(sessions: Map<string, SessionSummary>, panes: PaneLeaf[]): Map<string, SessionSummary> {
  const [offList, setOffList] = useState<Map<string, SessionSummary>>(new Map());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const asked = useRef(new Set<string>());
  const keys = panes.flatMap((p) => (p.sessionKey ? [p.sessionKey] : []));
  const keyList = keys.join("\n");

  // A key the list lost while another account gained the same session: the session moved. Its view
  // state and its pane go to the new key before the pane draws it (lib/sessionViewState.ts).
  useEffect(() => {
    const resolve = (key: string) => {
      if (sessions.has(key)) return key;
      const [provider, , id] = splitKey(key);
      for (const s of sessions.values()) if (s.provider === provider && s.id === id) return s.key;
      return undefined;
    };
    for (const pane of allPanes(getPaneTabs())) {
      const now = pane.sessionKey ? resolve(pane.sessionKey) : undefined;
      if (pane.sessionKey && now && now !== pane.sessionKey) rekeySession(pane.sessionKey, now);
    }
    paneActions.reconcile(resolve);
  }, [sessions]);
  // A change made from this page (a rehome) hands an off-list session's new summary here.
  useEffect(() => onSessionSummary((s) => setOffList((prev) => (prev.has(s.key) ? new Map(prev).set(s.key, s) : prev))), []);

  const confirmGone = useRef((key: string, delayMs: number) => {
    setTimeout(() => {
      if (sessionsRef.current.has(key) || !allPanes(getPaneTabs()).some((p) => p.sessionKey === key)) return;
      void lookup(key).then(async (r) => {
        if (r !== "missing" || sessionsRef.current.has(key)) return;
        const moved = await movedSession(key);
        if (moved) {
          setOffList((prev) => new Map(prev).set(moved.key, moved));
          rekeySession(key, moved.key);
        }
        paneActions.reconcile((k) => (k === key ? (moved?.key ?? null) : k));
      });
    }, delayMs);
  });

  // Read off-list sessions once each.
  useEffect(() => {
    for (const key of keyList ? keyList.split("\n") : []) {
      if (sessions.has(key) || asked.current.has(key)) continue;
      asked.current.add(key);
      void lookup(key).then((r) => {
        if (r === "missing") confirmGone.current(key, MISSING_RECHECK_MS);
        else if (r !== "unknown") setOffList((prev) => new Map(prev).set(key, r));
        if (r !== "missing") asked.current.delete(key);
      });
    }
  }, [keyList, sessions]);

  // Signs of a removal: a session left the list, a Codex thread was deleted, a Claude thread lost its transcript.
  useEffect(
    () =>
      socketHub().onMessage((msg: ServerMessage) => {
        const shown = (key: string) => allPanes(getPaneTabs()).some((p) => p.sessionKey === key);
        if (msg.type === "index" && msg.event.type === "remove" && shown(msg.event.key)) confirmGone.current(msg.event.key, GONE_SETTLE_MS);
        if (msg.type === "thread.error" && shown(msg.threadId)) confirmGone.current(msg.threadId, GONE_SETTLE_MS);
        if (msg.type === "thread.events") {
          for (const ev of msg.events) {
            if (ev.t === "thread.removed" && ev.reason === "deleted" && shown(ev.threadId)) confirmGone.current(ev.threadId, GONE_SETTLE_MS);
          }
        }
      }),
    [],
  );

  return useMemo(() => {
    const out = new Map<string, SessionSummary>();
    for (const key of keys) {
      const s = sessions.get(key) ?? offList.get(key);
      if (s) out.set(key, s);
    }
    return out;
    // keyList stands for keys.
  }, [keyList, sessions, offList]);
}

function splitKey(key: string): [string, string, string] {
  const first = key.indexOf(":");
  const second = key.indexOf(":", first + 1);
  return [key.slice(0, first), key.slice(first + 1, second), key.slice(second + 1)];
}

/** The same session under another account of its provider (a move), if the server has one. */
async function movedSession(key: string): Promise<SessionSummary | null> {
  const [provider, account, id] = splitKey(key);
  let accounts: Array<{ id: string; provider: string }>;
  try {
    accounts = ((await (await fetch("/api/accounts")).json()) as { accounts: Array<{ id: string; provider: string }> }).accounts;
  } catch {
    return null;
  }
  for (const a of accounts) {
    if (a.provider !== provider || a.id === account) continue;
    const r = await lookup(`${provider}:${a.id}:${id}`);
    if (typeof r === "object") return r;
  }
  return null;
}

async function lookup(key: string): Promise<SessionSummary | "missing" | "unknown"> {
  try {
    const res = await fetch(`/api/session?${new URLSearchParams({ key })}`);
    if (res.status === 404) return "missing";
    if (!res.ok) return "unknown";
    return ((await res.json()) as { session: SessionSummary }).session;
  } catch {
    return "unknown";
  }
}

// ---- Keys ----

/**
 * The split view's keys (lib/paneKeys.ts), on window in the capture phase. ⌥⌘T passes through: only
 * the focused pane's ThreadView hears window keys (`windowKeys`, lib/windowKeys.ts), so it switches
 * that pane and moves the keyboard to its input as in the single view.
 */
function usePaneKeys(layout: PaneLayout, narrow: boolean, frames: Frames | null, sessions: Map<string, SessionSummary>) {
  const state = useRef({ layout, narrow, frames, sessions });
  state.current = { layout, narrow, frames, sessions };

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = matchPaneKey(event, IS_MAC);
      if (!action || action.type === "toggleMode") return;
      // Outside a Mac these are Ctrl keys (Ctrl+D, Ctrl+W, Ctrl+[): a shell that has the keys gets them.
      if (leaveToShell(event, IS_MAC)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      const s = state.current;
      const list = panesOf(s.layout.root);
      const focused = focusedPane(s.layout);
      if (action.type === "close" && action.onlyWithPanes && list.length < 2) return;
      // A number past the last tab and closing the only tab go on to the browser, as ⌘W with one pane does.
      const tabCount = getPaneTabs().tabs.length;
      if (action.type === "tabAt" && action.index >= tabCount) return;
      if (action.type === "closeTab" && tabCount < 2) return;
      // A pane number past the last pane goes on to the browser, as a tab number does.
      if (action.type === "paneAt" && action.index >= list.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      switch (action.type) {
        case "split": {
          if (s.narrow || !focused || !s.frames) return;
          if (!canInsertAt(s.layout, s.frames, focused.id, action.edge, PANE_FRAME)) {
            toastManager.add({ type: "info", title: NO_ROOM });
            return;
          }
          paneActions.split(focused.id, action.edge);
          return;
        }
        case "close":
          if (focused) paneActions.closeByUser(focused.id);
          focusInput(focusedPane(getPaneLayout())?.id ?? null);
          return;
        case "focus":
          paneActions.moveFocus(action.dir);
          focusInput(focusedPane(getPaneLayout())?.id ?? null);
          return;
        case "cycle":
          paneActions.cycleFocus(action.delta);
          focusInput(focusedPane(getPaneLayout())?.id ?? null);
          return;
        case "togglePanel":
          if (focused) requestPane({ paneId: focused.id, kind: "togglePanel" });
          return;
        case "newTab":
          paneActions.addTab();
          focusInput(null);
          return;
        case "tab":
          paneActions.cycleTab(action.delta);
          focusInput(focusedPane(getPaneLayout())?.id ?? null);
          return;
        case "reopenPane":
          if (!s.narrow) void reopenClosedPane(() => state.current);
          return;
        case "paneAt":
          paneActions.focus(list[action.index]!.id);
          focusInput(list[action.index]!.id);
          return;
        case "tabAt":
          paneActions.selectTabAt(action.index);
          focusInput(focusedPane(getPaneLayout())?.id ?? null);
          return;
        case "closeTab":
          paneActions.closeTab(getPaneTabs().active);
          focusInput(focusedPane(getPaneLayout())?.id ?? null);
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}

/**
 * ⌘⇧T: brings back the pane the user closed last in this tab (`reopenClosedPane` in lib/paneLayout.ts).
 * A record whose session left the list or whose shell ended is dropped. The shell list is read first
 * when a closed pane held a shell, because the page reads it only while a shell pane is open.
 */
async function reopenClosedPane(read: () => { frames: Frames | null; sessions: Map<string, SessionSummary> }): Promise<void> {
  if (paneActions.closedContents().some((c) => c.type === "shell")) await refreshShells();
  const { frames, sessions } = read();
  if (!frames) return;
  const shells = getShellList();
  const exists = (c: PaneContent) => (c.type === "session" ? sessions.has(c.key) : shells === null || shells.some((x) => x.id === c.id));
  const fits = (l: PaneLayout, targetId: string, edge: Edge) => canInsertAt(l, frames, targetId, edge, PANE_FRAME);
  const outcome = paneActions.reopenClosed(exists, fits);
  if (outcome === "noRoom") toastManager.add({ type: "info", title: NO_ROOM });
  else if (outcome !== "nothing") focusInput(focusedPane(getPaneLayout())?.id ?? null);
}

/** Moves typing to pane `paneId`'s input once it has rendered; a read-only pane takes focus off the old one. */
function focusInput(paneId: string | null): void {
  requestAnimationFrame(() => {
    const pane = paneId ? document.querySelector(`[data-pane-id="${CSS.escape(paneId)}"]`) : null;
    const input = pane?.querySelector<HTMLTextAreaElement>("textarea:not([disabled])");
    if (input) {
      input.focus();
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest("[data-pane-id]")) active.blur();
  });
}

// ---- Drops ----

interface DropTarget {
  paneId: string | null;
  zone: DropZone;
}

interface DragState {
  source: DragSource;
  target: DropTarget | null;
  preview: Rect | null;
  /** The pane under the pointer when it is at an edge that has no room for another pane. */
  noRoom: Rect | null;
  /** Where the pointer grabbed a dragged pane, inside its frame. */
  grab: { x: number; y: number } | null;
}

/**
 * Drops on panes, from the sidebar's session rows, terminal row and shell rows, and from pane headers, through the page's
 * DndContext. `over` names the pane under the pointer (or the empty view); the zone inside it
 * comes from the pointer, which this hook follows while a drag runs.
 */
function usePaneDrops(
  containerRef: React.RefObject<HTMLDivElement | null>,
  narrow: boolean,
  rectOf: (id: string) => Rect | null,
  frames: Frames | null,
  full: Rect | null,
  focusedSessionCwd: string | null,
): DragState | null {
  const [drag, setDrag] = useState<DragState | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const stopTracking = useRef<(() => void) | null>(null);
  const env = useRef({ narrow, rectOf, frames, full, focusedSessionCwd });
  env.current = { narrow, rectOf, frames, full, focusedSessionCwd };

  /** What the pointer is over: a drop target with its preview, an edge with no room (`noRoom`), or nothing. */
  const targetOf = (source: DragSource, over: Over | null): { target: DropTarget | null; preview: Rect | null; noRoom: Rect | null } | null => {
    const data = paneTargetOf(over?.data.current);
    const box = containerRef.current?.getBoundingClientRect();
    const { narrow: isNarrow, rectOf: rect, frames: pixels, full: whole } = env.current;
    if (!data || !box || !pointer.current) return null;
    // Collisions go by rectangles, so a pane under the phone's sidebar sheet still collides; the
    // pointer is on the sidebar there, not on the pane.
    if (document.elementsFromPoint(pointer.current.x, pointer.current.y).some((el) => el.closest('[data-sidebar="sidebar"]'))) return null;
    if (data.paneId === null) return whole ? { target: { paneId: null, zone: "center" }, preview: whole, noRoom: null } : null;
    const r = rect(data.paneId);
    if (!r) return null;
    const layout = getPaneLayout();
    // A pane dropped on itself, or a session on the pane that already shows it, changes nothing.
    if (sourcePaneId(layout, source) === data.paneId) return null;
    if (isNarrow) return { target: { paneId: data.paneId, zone: "center" }, preview: r, noRoom: null };
    const x = pointer.current.x - box.left;
    const y = pointer.current.y - box.top;
    // A dragged pane leaves its place before it joins the line, so the room is measured without it.
    const moving = source.kind === "pane" ? source.paneId : undefined;
    const allow = (edge: Edge) => pixels !== null && canInsertAt(layout, pixels, data.paneId!, edge, PANE_FRAME, moving);
    const zone = dropZoneAt(r, x, y, allow);
    if (!zone) return pointerZoneAt(r, x, y) ? { target: null, preview: null, noRoom: r } : null;
    if (zone === "center") return { target: { paneId: data.paneId, zone }, preview: r, noRoom: null };
    const preview = pixels ? insertPreview(layout, pixels, data.paneId, zone, PANE_FRAME, moving) : null;
    return preview ? { target: { paneId: data.paneId, zone }, preview, noRoom: null } : null;
  };

  const update = (event: DragMoveEvent) => {
    setDrag((prev) => {
      if (!prev) return prev;
      const next = targetOf(prev.source, event.over) ?? { target: null, preview: null, noRoom: null };
      const same =
        prev.target?.paneId === next.target?.paneId &&
        prev.target?.zone === next.target?.zone &&
        sameRect(prev.preview, next.preview) &&
        sameRect(prev.noRoom, next.noRoom);
      return same ? prev : { ...prev, ...next };
    });
  };

  const finish = () => {
    stopTracking.current?.();
    stopTracking.current = null;
    pointer.current = null;
    setDrag(null);
  };

  useDndMonitor({
    onDragStart(event: DragStartEvent) {
      const source = dragSourceOf(event.active.data.current);
      if (!source) return;
      const start = event.activatorEvent as MouseEvent | null;
      pointer.current = start && "clientX" in start ? { x: start.clientX, y: start.clientY } : null;
      const onMove = (e: PointerEvent | MouseEvent) => {
        pointer.current = { x: e.clientX, y: e.clientY };
      };
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("mousemove", onMove, true);
      stopTracking.current = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("mousemove", onMove, true);
      };
      // The frame from the DOM: dnd-kit fills `active.rect` only after this event, so it is null here.
      const frame =
        source.kind === "pane" ? document.querySelector(`[data-pane-id="${CSS.escape(source.paneId)}"]`)?.getBoundingClientRect() : null;
      const grab = frame && pointer.current ? { x: pointer.current.x - frame.left, y: pointer.current.y - frame.top } : null;
      setDrag({ source, target: null, preview: null, noRoom: null, grab });
    },
    onDragMove: update,
    onDragOver: update,
    onDragEnd(event: DragEndEvent) {
      const source = dragSourceOf(event.active.data.current);
      if (!source || !stopTracking.current) return;
      const hit = targetOf(source, event.over);
      finish();
      if (!hit?.target) return;
      const target = hit.target;
      if (source.kind === "pane") {
        if (target.paneId !== null) paneActions.dropPane(source.paneId, target.paneId, target.zone);
      } else if (source.kind === "shell-new") {
        // The terminal row: a new shell in the focused pane's session folder (DESIGN.md 6s) opens where it was dropped.
        const { paneId, zone } = target;
        void createShellIn(env.current.focusedSessionCwd).then(
          (shell) => {
            paneActions.dropShell(shell.id, paneId, zone);
            focusInput(focusedPane(getPaneLayout())?.id ?? null);
          },
          (err: unknown) => reportProjectFailure("Could not create the terminal", err),
        );
        return;
      } else if (source.kind === "shell") {
        // A shell row of the sidebar's terminal group: that shell opens where it was dropped (a shell
        // another pane already shows drags that pane along, as a session does).
        paneActions.dropShell(source.shellId, target.paneId, target.zone);
      } else {
        paneActions.dropSession(source.sessionKey, target.paneId, target.zone);
      }
      focusInput(focusedPane(getPaneLayout())?.id ?? null);
    },
    onDragCancel() {
      if (stopTracking.current) finish();
    },
  });

  // A drag that outlives the view (the view closes mid-drag) stops following the pointer.
  useEffect(() => () => stopTracking.current?.(), []);

  return drag;
}


function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
