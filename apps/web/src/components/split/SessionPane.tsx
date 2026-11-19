// One pane of the split view (DESIGN.md 6k): the session's conversation as the single view draws it
// (ThreadView: chat or terminal mode, composer, subagent stack), with the pane's own controls in
// the conversation header (the close button; splitting is done by dropping onto a pane). The split view has no right panel beside the panes; a file chip in the
// conversation, the agents button and ⌥⌘B open the right panel as a sheet over the view instead
// (RightPanel's sheet, with its tab strip: the file explorer, the agents tab and file tabs). File tabs stay the session's (rightPanel.ts), so the
// single view's panel still lists them, and the sheet leaves that panel's open flag alone.
import type { SessionSummary } from "@maru/shared";
import { BotIcon, PowerIcon } from "lucide-react";
import { memo, useEffect, useState, type MouseEventHandler } from "react";

import { useSessionAgents } from "~/lib/sessionAgents";
import type { PaneLeaf } from "~/lib/paneLayout";
import { socketHub } from "~/lib/socket";
import { cn } from "~/lib/utils";
import { AGENTS_TAB, EXPLORER_TAB, FileOpenContext, shownPanelTab, useRightPanel, type FileTarget } from "~/rightPanel";
import { FilesButton, RightPanel } from "../files/RightPanel";
import { ThreadView, type ThreadNavigation } from "../ThreadView";
import { Button } from "../ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PaneHeader } from "../PaneHeader";
import { IconAction, PaneControls } from "./PaneControls";
import { onPaneRequest } from "./paneStore";

export interface SessionPaneProps {
  pane: PaneLeaf;
  /** The pane's session; null for an empty pane and while an off-list session is read. */
  session: SessionSummary | null;
  /** The focused pane: its conversation hears the window-wide keys (lib/windowKeys.ts). */
  focused: boolean;
  /** Mouse-down on the header starts dragging the pane (dnd-kit activator listeners, filtered). */
  onHeaderMouseDown: MouseEventHandler<HTMLDivElement> | undefined;
}

export const SessionPane = memo(function SessionPane(props: SessionPaneProps) {
  const { pane, session } = props;
  const column = cn(
    "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background",
    // The header is the pane's drag handle; its buttons keep their own cursor.
    "[&>header]:cursor-grab",
    // The tab strip above the panes carries the floating sidebar toggle's room, so no pane header keeps it.
    "[&>header]:pl-(--workspace-gutter-start)!",
  );
  if (pane.sessionKey === null || session === null) {
    return (
      <div data-page-surface="" data-pane-column="" className={column} onMouseDown={props.onHeaderMouseDown}>
        <PaneHeader className="border-b border-border">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">
            {pane.sessionKey === null ? "No session" : "Loading"}
          </span>
          <PaneControls paneId={pane.id} />
        </PaneHeader>
        {pane.sessionKey === null ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>Drag a session or terminal here from the sidebar</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-4" />
          </div>
        )}
      </div>
    );
  }
  return <SessionPaneBody key={session.key} {...props} session={session} column={column} />;
});

function SessionPaneBody(props: SessionPaneProps & { session: SessionSummary; column: string }) {
  const { session, pane } = props;
  const panel = useRightPanel(session.key);
  const [navigateTo, setNavigateTo] = useState<ThreadNavigation | null>(null);
  // The sheet shows the session's active tab (the file explorer by default, a file, or the agents list).
  const [sheetOpen, setSheetOpen] = useState(false);
  const agentsShown = sheetOpen && panel.state.active === AGENTS_TAB;
  const filesShown = sheetOpen && shownPanelTab(panel.state) === "explorer";
  // The single view's rule (SessionDetail): every subagent and workflow while the agents tab shows
  // them; otherwise the running count only, for the header button and the tab's badge.
  const { agents, error: agentsError, running } = useSessionAgents(session.key, agentsShown);

  // A file chip opens the file over the view. The session's panel keeps the tab, and its open
  // flag (the single view's inline panel) stays as it was.
  const openFile = (target: FileTarget) => {
    const wasOpen = panel.state.open;
    panel.openFile(target);
    if (!wasOpen) panel.setOpen(false);
    setSheetOpen(true);
  };

  // ⌥⌘B on the focused pane: the sheet, as the right panel's key does in the single view.
  useEffect(
    () =>
      onPaneRequest((r) => {
        if (r.paneId === pane.id && r.kind === "togglePanel") setSheetOpen((prev) => !prev);
      }),
    [pane.id],
  );

  return (
    <div data-page-surface="" data-pane-column="" className={props.column} onMouseDown={props.onHeaderMouseDown}>
      <FileOpenContext value={openFile}>
        <ThreadView
          session={session}
          navigateTo={navigateTo}
          windowKeys={props.focused}
          headerActions={
            <PaneControls paneId={pane.id}>
              {/* The single view's rule (SessionDetail): closing would end background tasks too, so it waits for them. */}
              {session.owner === "ui" &&
              session.status !== "running" &&
              session.status !== "waiting-input" &&
              !session.backgroundTasks ? (
                <IconAction label="Close process" hint="End the process this window started" onClick={() => socketHub().send({ type: "thread.close", threadId: session.key })}>
                  <PowerIcon />
                </IconAction>
              ) : null}
              {/* The single view's rule (SessionDetail): Files opens the sheet on its Files tab and closes it while that tab shows. */}
              <FilesButton
                pressed={filesShown}
                onToggle={() => {
                  if (filesShown) return setSheetOpen(false);
                  panel.activate(EXPLORER_TAB);
                  setSheetOpen(true);
                }}
              />
              {/* The single view's rule (SessionDetail): the running count sits here while the
                  sheet is closed and on the sheet's Activity tab while it is open. */}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      variant={agentsShown ? "secondary" : "ghost-muted"}
                      aria-label={running && !sheetOpen ? `Activity, ${running} running` : "Activity"}
                      onClick={() => {
                        if (agentsShown) return setSheetOpen(false);
                        panel.activate(AGENTS_TAB);
                        setSheetOpen(true);
                      }}
                      className="gap-1 px-1.5 tabular-nums"
                    />
                  }
                >
                  <BotIcon />
                  {running && !sheetOpen ? running : null}
                </TooltipTrigger>
                <TooltipPopup side="bottom">Activity</TooltipPopup>
              </Tooltip>
            </PaneControls>
          }
        />
      </FileOpenContext>
      <RightPanel
        panel={panel}
        cwd={session.cwd}
        sheet={{ open: sheetOpen, onOpenChange: setSheetOpen, onOpenFile: openFile, className: "w-[min(100vw,36rem)] max-w-none" }}
        agents={{
          sessionKey: session.key,
          agents,
          running,
          error: agentsError,
          onOpenThread: (threadId, title) => {
            setSheetOpen(false);
            setNavigateTo((prev) => ({ threadId, title, seq: (prev?.seq ?? 0) + 1 }));
          },
        }}
      />
    </div>
  );
}
