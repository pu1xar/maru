// The lean window's page (DESIGN.md 6x): `/?s=<id>&window=lean`, one session's conversation with its
// header and the composer, and nothing else: no sidebar, no top tab strip, no right panel. The
// same ThreadView the single view and the split view draw, so the keys (Esc Send now, the area
// zoom wheel), question cards, queued messages, the goal line and attachments all work as they do
// there. The header is the window's title bar in the desktop app (its drag region and its room for
// the traffic lights); the pin at its right end keeps the window above the others.
import type { SessionSummary } from "@maru/shared";
import { PinIcon, PowerIcon } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { Button } from "./components/ui/button";
import { Spinner } from "./components/ui/spinner";
import { Empty, EmptyHeader, EmptyTitle } from "./components/ui/empty";
import { ThreadView } from "./components/ThreadView";
import { ToastProvider } from "./components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./components/ui/tooltip";
import { desktopBridge } from "./lib/desktopBridge";
import { GroupNamesContext } from "./lib/groupNames";
import { announceLeanDrag, announceLeanWindow, rememberOwnSize } from "./lib/leanWindow";
import { SESSION_DRAG_TYPE } from "./lib/leanWindow.logic";
import { isBareSessionId, keyForSessionId } from "./lib/sessionUrl";
import { socketHub } from "./lib/socket";
import { displayName } from "./model";
import { useSessions } from "./useSessions";

export function LeanApp() {
  const { sessions, projects, loaded } = useSessions();
  const [wanted] = useState(() => new URLSearchParams(window.location.search).get("s"));
  const [fetched, setFetched] = useState<SessionSummary | null>(null);
  const [missing, setMissing] = useState(false);

  const listed = useMemo(() => {
    if (!wanted) return null;
    const key = isBareSessionId(wanted) ? keyForSessionId(wanted, sessions.values()) : wanted;
    return key ? (sessions.get(key) ?? null) : null;
  }, [wanted, sessions]);
  // A session off the list (an archived or moved-away one) is asked of the server once the list is in.
  useEffect(() => {
    if (!wanted || listed || fetched || !loaded) return;
    const ctrl = new AbortController();
    const query: Record<string, string> = isBareSessionId(wanted) ? { id: wanted } : { key: wanted };
    fetch(`/api/session?${new URLSearchParams(query)}`, { signal: ctrl.signal })
      .then((r) => {
        if (r.status === 404) setMissing(true);
        return r.ok ? (r.json() as Promise<{ session: SessionSummary }>) : null;
      })
      .then((b) => {
        if (b) setFetched(b.session);
      })
      .catch(() => {
        // Unreachable server: the look-up runs again with the next list.
      });
    return () => ctrl.abort();
  }, [wanted, listed, fetched, loaded, sessions]);

  const session = listed ?? fetched;
  const groupNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  // The OS window's title is the session's name; the other pages learn that this window is open.
  useEffect(() => {
    document.title = session ? displayName(session) : "maru";
  }, [session]);
  const key = session?.key ?? null;
  useEffect(() => {
    if (!key) return;
    announceLeanWindow(key);
    rememberOwnSize(key);
  }, [key]);

  return (
    <ToastProvider activeSessionKey={key}>
      {/* A collapsed sidebar's header rule gives the header room for the traffic lights; the
          header's start padding is exactly what the desktop app keeps clear (index.css). */}
      <div
        data-lean-window=""
        data-sidebar-state="collapsed"
        style={{ "--workspace-titlebar-content-left": "var(--workspace-controls-left)" } as CSSProperties}
        className="flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden bg-background"
      >
        {session ? (
          <GroupNamesContext value={groupNames}>
            <div data-page-surface="" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
              <ThreadView
                key={session.key}
                session={session}
                // A browser's popup is put back into a tab's split view by dragging its header onto
                // that tab (HTML5 drag, ExternalSessionDrop). The desktop app's header is the window's
                // drag region: moving the window over the main window does it (main process).
                headerDrag={
                  desktopBridge()
                    ? undefined
                    : {
                        title: "Drag onto a maru tab to move it into the split view",
                        onDragStart: (e) => {
                          e.dataTransfer.setData(SESSION_DRAG_TYPE, session.key);
                          e.dataTransfer.effectAllowed = "move";
                          announceLeanDrag(session.key);
                        },
                        onDragEnd: () => announceLeanDrag(null),
                      }
                }
                headerActions={
                  <div className="-me-[calc(var(--workspace-gutter-end)-var(--workspace-controls-right)-1px)] flex shrink-0 items-center gap-0.5">
                    {session.owner === "ui" && session.status !== "running" && session.status !== "waiting-input" && !session.backgroundTasks ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              size="icon-xs"
                              variant="ghost-muted"
                              aria-label="Close process"
                              onClick={() => socketHub().send({ type: "thread.close", threadId: session.key })}
                            />
                          }
                        >
                          <PowerIcon />
                        </TooltipTrigger>
                        <TooltipPopup side="bottom">End the process this window started</TooltipPopup>
                      </Tooltip>
                    ) : null}
                    <KeepOnTopPin />
                  </div>
                }
              />
            </div>
          </GroupNamesContext>
        ) : (
          <div data-page-surface="" className="flex min-h-0 flex-1 flex-col bg-background">
            <Empty className="flex-1">
              <EmptyHeader>
                {missing ? <EmptyTitle>This session no longer exists</EmptyTitle> : <Spinner aria-label="Loading conversation" className="size-4" />}
              </EmptyHeader>
            </Empty>
          </div>
        )}
      </div>
    </ToastProvider>
  );
}

/**
 * The pin at the header's right end (aria-label "Keep on top"). Only the desktop app can keep a
 * window above the others (a browser's pop-up cannot), so a browser shows no pin.
 */
function KeepOnTopPin() {
  const bridge = desktopBridge();
  const supported = !!bridge?.setKeepOnTop && !!bridge.getKeepOnTop;
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!bridge?.getKeepOnTop) return;
    let live = true;
    void bridge.getKeepOnTop().then((v) => live && setOn(v), () => {});
    const off = bridge.onKeepOnTop?.((v) => setOn(v));
    return () => {
      live = false;
      off?.();
    };
  }, [bridge]);
  if (!supported) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            data-keep-on-top={on ? "on" : "off"}
            size="icon-xs"
            variant={on ? "secondary" : "ghost-muted"}
            aria-label="Keep on top"
            aria-pressed={on}
            onClick={() => void bridge!.setKeepOnTop!(!on).then(setOn, () => {})}
          />
        }
      >
        <PinIcon className={on ? "fill-current" : undefined} />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{on ? "Kept on top, click to release" : "Keep on top"}</TooltipPopup>
    </Tooltip>
  );
}
