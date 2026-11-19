// Layout follows T3 Code's ChatView (header, conversation area, composer dock), ChatHeader's
// one-line breadcrumb and ChatCanvas's `data-chat-canvas` lane; see WorkspaceBreadcrumb.tsx and ui/
// for the adapted pieces. The data wiring, the subagent stack, the chat/terminal switch
// (DESIGN.md 6i) and the meta line under the title (account, folder, holder; SessionMetaLine.tsx,
// DESIGN.md 6l) are maru's own. Whether this view can send is said in the composer's place
// (ThreadComposer); the header says no sentence about it.
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import type { SessionSummary, ThreadSnapshot } from "@maru/shared";
import { CircleAlertIcon, MessageSquareTextIcon, SquareTerminalIcon, TerminalIcon, WifiOffIcon } from "lucide-react";

import {
  BackgroundOfferContext, BACKGROUND_KEY_LABEL, canBackground, sendBackground,
  useBackgroundKey, useForegroundCalls, type BackgroundOffer,
} from "~/lib/backgroundTasks";
import { userHistory } from "~/lib/composerHistory.logic";
import { useServerDown } from "~/lib/serverDown";
import { takePendingFind } from "~/lib/pendingFind";
import { sendQueuedNow } from "~/lib/queuedMessages";
import { canSendNow } from "~/lib/queuedMessages.logic";
import { leaveToShell } from "~/lib/shellKeys";
import { readThreadStack, rememberThreadStack, type ThreadStackEntry } from "~/lib/threadStack";
import { cn } from "~/lib/utils";
import { displayName } from "~/model";
import { useTerminalThemeStyle } from "~/lib/terminalTheme";
import { useViewMode, type ViewMode } from "~/lib/viewMode";
import { WindowKeysContext } from "~/lib/windowKeys";
import { useThread } from "~/useThread";
import { AreaZoomIndicator } from "./AreaZoomIndicator";
import { ClaudeAI, OpenAI } from "./Icons";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { OWNER_FOLDED_CLASS, SessionMetaLine } from "./SessionMetaLine";
import { ACTIVITY_LABEL, sessionActivity, sessionTopStatus } from "./sessionPresentation";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "./WorkspaceBreadcrumb";
import { PaneHeader } from "./PaneHeader";
import { ThreadComposer } from "./chat/ThreadComposer";
import { ThreadFindBar } from "./chat/ThreadFindBar";
import { useThreadFind, type FindTimelineProps } from "./chat/useThreadFind";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { Spinner } from "./ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// The timeline, its markdown pipeline and the virtual list load in their own chunk.
const ThreadTimeline = lazy(() =>
  import("./chat/ThreadTimeline").then((m) => ({ default: m.ThreadTimeline })),
);
// The terminal mode (transcript and input) shares that markdown pipeline and loads the same way.
const TerminalView = lazy(() => import("./terminal/TerminalView"));

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MODE_SHORTCUT_LABEL = IS_MAC ? "\u2325\u2318T" : "Ctrl+Alt+T";

type StackEntry = ThreadStackEntry;

/** The header's container name: its parts fold by the header's own width (CP-02), not the window's. */
const HEADER_CONTAINER = "@container/thread-header";

let scrollbarGutter: number | null = null;

/**
 * Width of one scrollbar gutter on a `scrollbar-gutter: stable both-edges` scroller, measured once
 * on a probe that the page's scrollbar rules style like the timeline. T3's ChatCanvas measures the
 * timeline itself the same way, (offsetWidth - clientWidth) / 2; the padding rule in index.css
 * subtracts it so the timeline's text column lines up with the composer's.
 */
function timelineGutterWidth(): number {
  if (scrollbarGutter !== null) return scrollbarGutter;
  if (typeof document === "undefined") return 0;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;visibility:hidden;pointer-events:none;width:100px;height:100px;overflow-y:scroll;scrollbar-gutter:stable both-edges";
  document.body.append(probe);
  scrollbarGutter = Math.max(0, (probe.offsetWidth - probe.clientWidth) / 2);
  probe.remove();
  return scrollbarGutter;
}

/**
 * The conversation of the selected session. Opening a subagent card pushes its child thread on a
 * stack; the breadcrumb pops back. Mount it with `key={session.key}`. The stack is the session's
 * (lib/threadStack.ts), so a view that mounts again (after another screen or a rehome) opens the
 * thread it showed.
 */
/** A request from outside the conversation (the right panel) to show a child thread. */
export interface ThreadNavigation {
  threadId: string;
  title: string | null;
  seq: number;
}

export function ThreadView({
  session,
  headerActions,
  headerDrag,
  navigateTo,
  windowKeys = true,
}: {
  session: SessionSummary;
  headerActions?: ReactNode;
  /** Makes the header's title a drag source (a browser's lean window, DESIGN.md 6x). */
  headerDrag?: { onDragStart: (e: DragEvent<HTMLElement>) => void; onDragEnd: () => void; title: string };
  navigateTo?: ThreadNavigation | null;
  /**
   * This conversation hears the window-wide keys (lib/windowKeys.ts). The split view passes false
   * for every pane but the focused one, so a key acts on one pane.
   */
  windowKeys?: boolean;
}) {
  const [stack, setStack] = useState<readonly StackEntry[]>(() => readThreadStack(session.key));
  useEffect(() => rememberThreadStack(session.key, stack), [session.key, stack]);
  // Opens a child thread the right panel picked, one level under the session.
  useEffect(() => {
    if (navigateTo) setStack([{ threadId: navigateTo.threadId, title: navigateTo.title }]);
  }, [navigateTo]);
  const threadId = stack.at(-1)?.threadId ?? session.key;
  const { state, loadOlder, loadOlderUntil } = useThread(threadId);
  const serverDown = useServerDown();
  const snapshot = state.snapshot;
  const composerHistory = useMemo(() => userHistory(snapshot), [snapshot]);
  // A banner above the timeline (the three below) turns its top fade off, as in T3's ChatView.
  const timelineTopBanner = (serverDown && !!snapshot) || !!state.removed || (!!state.error && !!snapshot);
  const [gutter] = useState(timelineGutterWidth);

  const openChildThread = (childThreadId: string) => {
    if (childThreadId === threadId) return;
    const subagent = snapshot?.subagents.find((s) => s.childThreadId === childThreadId);
    setStack((prev) => {
      const leaving = prev.length > 0 ? prev.slice(0, -1) : prev;
      const current = prev.at(-1);
      const updated = current ? [...leaving, { ...current, title: snapshot?.title ?? current.title }] : prev;
      return [...updated, { threadId: childThreadId, title: subagent?.title ?? subagent?.prompt ?? null }];
    });
  };
  const popTo = (depth: number) => setStack((prev) => prev.slice(0, depth));

  // Ctrl+B and the "백그라운드로" buttons send foreground Bash and Agent calls to the background
  // (lib/backgroundTasks.ts, DESIGN.md 4.5): the session's own thread only, never a subagent's.
  const canSendBackground = canBackground(session, stack.length > 0);
  const foregroundCalls = useForegroundCalls(session.key);
  useBackgroundKey({ sessionKey: session.key, enabled: canSendBackground, foregroundCount: foregroundCalls.size });
  const backgroundOffer = useMemo<BackgroundOffer>(
    () => ({
      send: canSendBackground ? (toolUseId: string) => void sendBackground(session.key, toolUseId) : null,
      keyLabel: BACKGROUND_KEY_LABEL,
      calls: foregroundCalls,
      sendNow: canSendNow(session, stack.length > 0) ? () => void sendQueuedNow(session.key) : null,
    }),
    [canSendBackground, session, stack.length, foregroundCalls],
  );

  const [mode, setViewMode] = useViewMode(session.key);
  const terminalTheme = useTerminalThemeStyle() as CSSProperties;
  // A switch hands the keyboard to the new view's input (the terminal input takes it when it
  // mounts; the chat composer is here at once). A field elsewhere keeps it.
  const composerHostRef = useRef<HTMLDivElement | null>(null);
  const setMode = (next: ViewMode) => {
    setViewMode(next);
    if (next !== "chat") return;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && active.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
      composerHostRef.current?.querySelector<HTMLTextAreaElement>("textarea:not(:disabled)")?.focus({ preventScroll: true });
    });
  };
  // mod+alt+T switches chat and terminal (mod+B and mod+alt+B are the sidebar and the right panel).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!windowKeys || event.defaultPrevented || event.repeat) return;
      const mod = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      // code, not key: a Korean input source turns the T key into a jamo.
      if (!mod || !event.altKey || event.shiftKey || event.code !== "KeyT") return;
      // Outside a Mac this is Ctrl+Alt+T, which a shell that has the keys gets (lib/shellKeys.ts).
      if (leaveToShell(event, IS_MAC)) return;
      event.preventDefault();
      setMode(mode === "terminal" ? "chat" : "terminal");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  // Find in the thread (DESIGN.md 6u): mod+F opens it over the chat timeline. The browser's own find
  // sees only the rows the virtual list has drawn, so this one takes the key while a conversation
  // is shown; a part of the page that has its own find (the files panel) handles the key first and
  // keeps it. In the split view only the focused pane hears it (windowKeys).
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const find = useThreadFind({
    threadId, snapshot, loadingOlder: state.loadingOlder, loadOlderUntil, canvasRef,
    ready: snapshot !== null && !state.resuming,
  });
  const openFind = find.openFind;
  useEffect(() => {
    if (mode !== "chat") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!windowKeys || event.defaultPrevented || event.repeat) return;
      const mod = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      // code, not key: a Korean input source turns the F key into a jamo.
      if (!mod || event.altKey || event.shiftKey || event.code !== "KeyF") return;
      // Outside a Mac this is Ctrl+F, which a shell that has the keys gets (lib/shellKeys.ts).
      if (leaveToShell(event, IS_MAC)) return;
      event.preventDefault();
      openFind();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, windowKeys, openFind]);
  // A search over every session opened this conversation at a hit (DESIGN.md 6u).
  useEffect(
    () =>
      takePendingFind(session.key, threadId, (pending) => {
        if (mode !== "chat") setViewMode("chat");
        openFind(pending);
      }, () => setStack([])),
    [session.key, threadId, openFind, mode, setViewMode],
  );

  // Ctrl+wheel over the header or the body steps the conversation text size, or in the terminal
  // mode the terminal text size (lib/areaZoom.ts); the mark shows in this view only.
  const zoomKey = useId();
  const zoomArea = mode === "terminal" ? "terminal" : "chat";

  const rootTitle = displayName(session);
  const currentTitle =
    stack.length === 0 ? rootTitle : snapshot?.title || stack.at(-1)?.title || "subagent";

  return (
    <WindowKeysContext value={windowKeys}>
    <BackgroundOfferContext value={backgroundOffer}>
      {/* No bottom border: the timeline fades out under the header instead (T3 ChatView, CP-11). */}
      <PaneHeader className={HEADER_CONTAINER} data-zoom-area={zoomArea} data-zoom-key={zoomKey}>
        {session.provider === "claude" ? (
          <ClaudeAI aria-hidden className="size-4 shrink-0 @max-[21rem]/thread-header:hidden" />
        ) : (
          <OpenAI aria-hidden className="size-4 shrink-0 text-foreground @max-[21rem]/thread-header:hidden" />
        )}
        <div
          className="flex min-w-0 flex-1 flex-col justify-center"
          draggable={headerDrag ? true : undefined}
          onDragStart={headerDrag?.onDragStart}
          onDragEnd={headerDrag?.onDragEnd}
          title={headerDrag?.title}
          data-session-drag-handle={headerDrag ? "" : undefined}
        >
          <WorkspaceBreadcrumb ariaLabel="Conversation location" className="overflow-clip [overflow-clip-margin:2px]">
            <ThreadBreadcrumb
              rootTitle={rootTitle}
              stack={stack}
              currentTitle={currentTitle}
              onPopTo={popTo}
            />
          </WorkspaceBreadcrumb>
          <SessionMetaLine session={session} />
        </div>
        <SessionStateIcons session={session} />
        <ViewModeToggle mode={mode} onChange={setMode} />
        {headerActions}
      </PaneHeader>
      {/* The conversation text size (Settings, Appearance) applies inside; `contents` adds no box. */}
      <div data-chat-text="" data-zoom-area={zoomArea} data-zoom-key={zoomKey} className="contents">
      <div
        ref={canvasRef}
        data-chat-canvas=""
        style={{ "--chat-timeline-gutter": `${gutter}px` } as CSSProperties}
        data-page-surface=""
        className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      >
        <AreaZoomIndicator zoomKey={zoomKey} area={zoomArea} className="top-3 right-3" />
        {mode === "chat" && find.bar ? <ThreadFindBar {...find.bar} /> : null}
        {serverDown && snapshot ? (
          <Banner icon={<WifiOffIcon aria-hidden className="size-3.5" />}>Disconnected from server</Banner>
        ) : null}
        {state.removed ? (
          <Banner tone="warning" icon={<CircleAlertIcon aria-hidden className="size-3.5" />}>
            {state.removed === "deleted" ? "This conversation was deleted" : "This conversation was archived"}
          </Banner>
        ) : null}
        {state.error && snapshot ? (
          <Banner tone="error" icon={<CircleAlertIcon aria-hidden className="size-3.5" />}>
            {state.error}
          </Banner>
        ) : null}
        {mode === "terminal" ? (
          // The terminal's own dark surface while its chunk loads (TerminalView, DESIGN.md 6i).
          <Suspense fallback={<div className="term-root dark" style={terminalTheme}><TimelineLoading /></div>}>
            <TerminalView
              session={session}
              isSubagent={stack.length > 0}
              snapshot={snapshot}
              cwd={snapshot?.state.cwd ?? session.cwd ?? undefined}
              loadingOlder={state.loadingOlder}
              onLoadOlder={loadOlder}
              onOpenChildThread={openChildThread}
              onShowThread={(id, title) => setStack(id === session.key ? [] : [{ threadId: id, title }])}
              placeholder={<ConversationArea snapshot={null} error={state.error} cwd={undefined} loadingOlder={false} onLoadOlder={loadOlder} onOpenChildThread={openChildThread} />}
            />
          </Suspense>
        ) : (
          <ConversationArea
            snapshot={snapshot}
            error={state.error}
            cwd={snapshot?.state.cwd ?? session.cwd ?? undefined}
            loadingOlder={state.loadingOlder}
            onLoadOlder={loadOlder}
            onOpenChildThread={openChildThread}
            topFadeEnabled={!timelineTopBanner}
            find={find.timeline}
          />
        )}
      </div>
      {mode === "chat" ? (
        <div ref={composerHostRef} className="contents">
          <ThreadComposer
            session={session}
            threadState={stack.length > 0 ? null : snapshot?.state ?? null}
            promptCache={stack.length > 0 ? null : snapshot?.tokenUsage?.promptCache ?? null}
            isSubagent={stack.length > 0}
            history={composerHistory}
            onOpenParent={stack.length > 0 ? () => popTo(stack.length - 1) : undefined}
          />
        </div>
      ) : null}
      </div>
    </BackgroundOfferContext>
    </WindowKeysContext>
  );
}

function ThreadBreadcrumb({
  rootTitle,
  stack,
  currentTitle,
  onPopTo,
}: {
  rootTitle: string;
  stack: readonly StackEntry[];
  currentTitle: string;
  onPopTo: (depth: number) => void;
}) {
  const current = (
    <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
      <CurrentTitle title={currentTitle} />
    </WorkspaceBreadcrumbItem>
  );
  if (stack.length === 0) {
    return (
      <>
        {current}
      </>
    );
  }
  // Root, then the direct parent; deeper ancestors fold into "...".
  const parentDepth = stack.length - 1;
  const parentTitle = parentDepth === 0 ? null : stack[parentDepth - 1]?.title || "subagent";
  return (
    <>
      <BreadcrumbLink title={rootTitle} onClick={() => onPopTo(0)} />
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
      {parentDepth > 1 ? (
        <>
          <WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbText aria-label="Intermediate steps hidden">...</WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator>
            <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbSeparator>
        </>
      ) : null}
      {parentTitle !== null ? (
        <>
          <BreadcrumbLink title={parentTitle} onClick={() => onPopTo(parentDepth)} />
          <WorkspaceBreadcrumbSeparator>
            <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbSeparator>
        </>
      ) : null}
      {current}
    </>
  );
}

/** The thread title; its tooltip holds the whole title (the account and folder are on the meta line). */
function CurrentTitle({ title }: { title: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<h1 dir="auto" className="min-w-0" />}>
        <WorkspaceBreadcrumbText>{title}</WorkspaceBreadcrumbText>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <span dir="auto" className="block max-w-sm font-medium wrap-anywhere">{title}</span>
      </TooltipPopup>
    </Tooltip>
  );
}

function BreadcrumbLink({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <WorkspaceBreadcrumbItem className="max-w-[30%] shrink">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`Open parent conversation: ${title}`}
              onClick={onClick}
              className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <WorkspaceBreadcrumbText dir="auto">{title}</WorkspaceBreadcrumbText>
        </TooltipTrigger>
        <TooltipPopup side="bottom">{title}</TooltipPopup>
      </Tooltip>
    </WorkspaceBreadcrumbItem>
  );
}

/**
 * Chat or terminal: the same thread drawn as the chat timeline or as Claude Code's TUI. One button
 * that shows the view in use and switches to the other on click (user request 2026-11-18: "버튼
 * 하나로 두고 클릭하면 바뀌는 식으로(현재 ui를 보여주면 댐)"); the other view and the shortcut are in the tooltip.
 */
function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  const chat = mode === "chat";
  const label = chat ? "Chat view, switch to terminal" : "Terminal view, switch to chat";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            data-view-mode-toggle=""
            data-view-mode={mode}
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            className="shrink-0"
            onClick={() => onChange(chat ? "terminal" : "chat")}
          />
        }
      >
        {chat ? <MessageSquareTextIcon aria-hidden className="size-3.5" /> : <SquareTerminalIcon aria-hidden className="size-3.5" />}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {label} ({MODE_SHORTCUT_LABEL})
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The session's state as the sidebar row shows it: the terminal mark while a terminal holds it and
 * the running, waiting or failed icon. A closed or quietly open session shows nothing; whether this
 * view can send is the composer's to say. The terminal mark shows only while the meta line's
 * holder chip is folded away (a narrow header), so the header says it once; with nothing else to
 * show, the whole group folds the same way (no empty slot in the header's gap, nothing read twice).
 */
function SessionStateIcons({ session }: { session: SessionSummary }) {
  const activity = sessionActivity(session);
  const top = sessionTopStatus(activity);
  const terminalHeld = session.owner === "terminal" && session.status !== "closed";
  if (!top && !terminalHeld) return null;
  const label = [terminalHeld ? "Open in a terminal" : null, top ? ACTIVITY_LABEL[activity] : null]
    .filter((x) => x !== null)
    .join(", ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span role="img" aria-label={label} className={cn("inline-flex shrink-0 items-center gap-1.5", !top && OWNER_FOLDED_CLASS)} />
        }
      >
        {terminalHeld ? <TerminalIcon aria-hidden className={cn("size-3.5 text-secondary-label", OWNER_FOLDED_CLASS)} /> : null}
        {top ? <top.icon aria-hidden className={cn("size-3.5", top.className)} /> : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

function Banner({
  tone = "info",
  icon,
  children,
}: {
  tone?: "info" | "warning" | "error";
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        "chat-composer-lane flex shrink-0 items-center gap-2 border-b border-border py-1.5 text-xs",
        tone === "error"
          ? "text-error-foreground"
          : tone === "warning"
            ? "text-warning-foreground"
            : "text-muted-foreground",
      )}
    >
      <span className="mx-auto flex w-full max-w-(--chat-content-max-width) min-w-0 items-center gap-2">
        {icon}
        <span className="min-w-0 wrap-anywhere">{children}</span>
      </span>
    </div>
  );
}

function ConversationArea({
  snapshot,
  error,
  cwd,
  loadingOlder,
  onLoadOlder,
  onOpenChildThread,
  topFadeEnabled = false,
  find = null,
}: {
  snapshot: ThreadSnapshot | null;
  error: string | null;
  cwd: string | undefined;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onOpenChildThread: (childThreadId: string) => void;
  /** Find in the thread (DESIGN.md 6u). */
  find?: FindTimelineProps | null;
    /** No banner above the timeline: it fades out under the header (T3's topFadeEnabled). */
  topFadeEnabled?: boolean;
}) {
  const serverDown = useServerDown();
  // Bumped by the fallback's button; a new key lets the boundary try the timeline again.
  const [renderAttempt, setRenderAttempt] = useState(0);
  if (!snapshot) {
    if (error) {
      return (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>Could not open the conversation</EmptyTitle>
            <EmptyDescription className="wrap-anywhere">{error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }
    // Nothing is on its way while the server is unreachable, so no spinner then.
    if (serverDown) return <ServerDownState />;
    return <TimelineLoading />;
  }
  return (
    <RenderErrorBoundary
      resetKeys={[snapshot.threadId, renderAttempt]}
      fallback={
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>Could not render the conversation</EmptyTitle>
          </EmptyHeader>
          <Button variant="outline" size="sm" onClick={() => setRenderAttempt((n) => n + 1)}>
            Render again
          </Button>
        </Empty>
      }
    >
      <Suspense fallback={<TimelineLoading />}>
        <ThreadTimeline
          snapshot={snapshot}
          cwd={cwd}
          loadingOlder={loadingOlder}
          onLoadOlder={onLoadOlder}
          onOpenChildThread={onOpenChildThread}
          topFadeEnabled={topFadeEnabled}
          find={find}
        />
      </Suspense>
    </RenderErrorBoundary>
  );
}

/** How long a load stays a blank canvas before the spinner shows (most snapshots arrive sooner). */
const LOADING_SPINNER_DELAY_MS = 400;

/** Blank at first like T3's timeline, then a spinner if the snapshot is slow to come. */
function TimelineLoading() {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), LOADING_SPINNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
      {late ? (
        <>
          <Spinner aria-hidden className="size-4" />
          Loading conversation
        </>
      ) : null}
    </div>
  );
}

/** The conversation's place while the server is unreachable; the sidebar's dot names the same state. */
export function ServerDownState() {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <WifiOffIcon aria-hidden className="mb-3 size-5 text-muted-foreground" />
        <EmptyTitle>Disconnected from server</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}
