// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: components/NoActiveThreadState.tsx (inset, header and empty state). The selected
// session's conversation is ThreadView, with the right panel (DESIGN.md 6e) beside it; T3's
// mod+alt+b toggles that panel.
import type { SessionSummary } from "@maru/shared";
import { BotIcon, PanelLeftIcon, PowerIcon, SearchXIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { AGENTS_TAB, FileOpenContext, filesShown, useRightPanel } from "~/rightPanel";
import { useServerDown } from "~/lib/serverDown";
import { leaveToShell } from "~/lib/shellKeys";
import { useSessionAgents } from "~/lib/sessionAgents";
import { socketHub } from "~/lib/socket";
import { FilesButton, RightPanel, RightPanelToggle, useRightPanelLayout } from "./files/RightPanel";
import { FirstRunNotice } from "./FirstRunNotice";
import { ServerDownState, ThreadView, type ThreadNavigation } from "./ThreadView";
import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset, useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { PaneHeader } from "./PaneHeader";
import { plural } from "../lib/plural.ts";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * What the address's `?s=` resolved to when no session is shown: nothing chosen, a key the server
 * does not know, or a key still being looked up.
 */
export type NoSessionReason = "none" | "missing" | "resolving";

export function SessionDetail({
  session,
  noSession = "none",
  listEmpty = false,
  onClearSelection,
}: {
  session: SessionSummary | null;
  noSession?: NoSessionReason;
  /** The server has answered and lists no session (the first-run note, FirstRunNotice). */
  listEmpty?: boolean;
  onClearSelection?: () => void;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {session ? (
        <SessionWorkspace key={session.key} session={session} />
      ) : (
        <div data-page-surface="" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
          {noSession === "missing" ? (
            <MissingSessionState onClear={onClearSelection} />
          ) : noSession === "resolving" ? (
            <ResolvingSessionState />
          ) : (
            <NoActiveSessionState listEmpty={listEmpty} />
          )}
        </div>
      )}
    </SidebarInset>
  );
}

/** One session's conversation and its right panel; keyed by session so each keeps its own tabs. */
function SessionWorkspace({ session }: { session: SessionSummary }) {
  const panel = useRightPanel(session.key);
  const { open } = panel.state;
  const toggle = () => panel.setOpen(!open);
  const agentsShown = open && panel.state.active === AGENTS_TAB;
  // Every subagent and workflow of the session while the agents tab shows them; otherwise the
  // running count only, for the header button and the tab's badge.
  const { agents, error: agentsError, running: runningAgents } = useSessionAgents(session.key, agentsShown);
  const [navigateTo, setNavigateTo] = useState<ThreadNavigation | null>(null);
  const layout = useRightPanelLayout();

  // Window keydown listener for the panel shortcut.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const mod = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      // code, not key: a Korean input source turns the B key into a jamo.
      if (!mod || !event.altKey || event.shiftKey || event.code !== "KeyB") return;
      // Outside a Mac this is Ctrl+Alt+B, which a shell that has the keys gets (lib/shellKeys.ts).
      if (leaveToShell(event, IS_MAC)) return;
      event.preventDefault();
      panel.setOpen(!open);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  return (
    <div ref={layout.observeRow} className="flex min-h-0 min-w-0 flex-1 flex-row">
      <div data-page-surface="" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <FileOpenContext value={panel.openFile}>
          <ThreadView
            session={session}
            navigateTo={navigateTo}
            headerActions={
              <>
              {session.owner === "ui" && session.status !== "running" && session.status !== "waiting-input" && !session.backgroundTasks ? (
                // The process this app started (a Codex thread it holds) stays up for the next
                // message; closing it lets the session count as closed (terminal resume, delete,
                // move). Closing would end background tasks too, so it waits for them.
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        aria-label="Close process"
                        onClick={() => socketHub().send({ type: "thread.close", threadId: session.key })}
                        className="gap-1"
                      />
                    }
                  >
                    <PowerIcon />
                    <span className="@max-[26rem]/thread-header:sr-only">Close</span>
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">End the process this window started</TooltipPopup>
                </Tooltip>
              ) : null}
              {/* Files opens the panel on its Files tab (the panel's own first tab), ahead of the Activity count. */}
              <FilesButton pressed={filesShown(panel.state)} onToggle={panel.toggleFiles} />
              {/* The running count shows in one place at a time: here while the panel is closed,
                  then on the Activity tab beside the list (T3 keeps it in the Lineage heading only). */}
              {runningAgents && !open ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        aria-label={`${plural(runningAgents, "subagent")} running`}
                        onClick={panel.showAgents}
                        className="gap-1 tabular-nums"
                      />
                    }
                  >
                    <BotIcon />
                    {runningAgents}
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">Running subagents</TooltipPopup>
                </Tooltip>
              ) : null}
              {/* An open inline panel carries the toggle at the right end of its tab strip, the same spot:
                  13px from the window edge, mirroring the sidebar toggle, past the header's wider gutter. */}
              {open && layout.inline ? null : (
                <span className="-me-[calc(var(--workspace-gutter-end)-var(--workspace-controls-right)-1px)] flex shrink-0">
                  <RightPanelToggle open={open} onToggle={toggle} />
                </span>
              )}
              </>
            }
          />
        </FileOpenContext>
      </div>
      <RightPanel
        panel={panel}
        layout={layout}
        cwd={session.cwd}
        agents={{
          sessionKey: session.key,
          agents,
          running: runningAgents,
          error: agentsError,
          onOpenThread: (threadId, title) => setNavigateTo((prev) => ({ threadId, title, seq: (prev?.seq ?? 0) + 1 })),
        }}
      />
    </div>
  );
}

function NoSessionHeader({ label }: { label: string }) {
  return (
    <PaneHeader className="border-b border-border">
      <span className="text-sm font-medium text-foreground md:text-muted-foreground">{label}</span>
    </PaneHeader>
  );
}

function NoActiveSessionState({ listEmpty }: { listEmpty: boolean }) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <>
      <NoSessionHeader label="No session open" />
      <Empty className="flex-1">
        <div className="w-full max-w-lg px-8 py-12">
          <EmptyHeader className="max-w-none">
            <EmptyTitle>Choose a session</EmptyTitle>
          </EmptyHeader>
          <FirstRunNotice listEmpty={listEmpty} />
          {isMobile ? (
            <EmptyContent className="mx-auto mt-6">
              <Button variant="outline" onClick={() => setOpenMobile(true)}>
                <PanelLeftIcon />
                Session list
              </Button>
            </EmptyContent>
          ) : null}
        </div>
      </Empty>
    </>
  );
}

/** `?s=` names a session the server does not have (deleted, moved, or a mistyped link). */
function MissingSessionState({ onClear }: { onClear: (() => void) | undefined }) {
  return (
    <>
      <NoSessionHeader label="No session" />
      <Empty className="flex-1">
        <EmptyHeader>
          <SearchXIcon aria-hidden className="mb-3 size-5 text-muted-foreground" />
          <EmptyTitle>Session not found</EmptyTitle>
        </EmptyHeader>
        {onClear ? (
          <Button variant="outline" size="sm" onClick={onClear}>
            <XIcon aria-hidden />
            Clear selection
          </Button>
        ) : null}
      </Empty>
    </>
  );
}

/** `?s=` is being looked up (the list or `/api/session` has not answered yet). */
function ResolvingSessionState() {
  const serverDown = useServerDown();
  return (
    <>
      <NoSessionHeader label="" />
      {serverDown ? <ServerDownState /> : <div className="flex-1" />}
    </>
  );
}
