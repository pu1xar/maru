// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: components/Sidebar.tsx (list layout), sidebar/SidebarChrome.tsx (header),
// sidebar/SidebarThreadHeader.tsx (search row, icon buttons and "Add project"),
// sidebar/SidebarProjectFolderHeader.tsx (project folder and its hover action button),
// sidebar/SidebarThreadRow.tsx ("folder-multiline" row, and the trailing controls that replace the
// status on hover) and ThreadHoverCard.tsx.
// Local change: rows read maru's SessionSummary and folders are 고정됨 (T3's pinned
// threads, drawn as a folder), user projects (shown as "Group") and 미분류 (DESIGN.md 6c). A
// pinned session keeps its row in its Group, marked with a pin, and 고정됨 shows it again. The
// folder button opens the Group menu where T3 starts a new thread, and the row's trailing control
// or a right-click opens the session menu. Dragging a row uses dnd-kit with T3's 6px activation
// distance; a drop on a folder header or between rows puts the session there (model.ts dropSpotOf
// and planDrop), and the order inside a folder stays the server's. The drag context is the page's
// (components/split/paneDnd.tsx WorkspaceDndContext), shared with the split view, which takes rows
// dropped on its panes; this list hears it with useDndMonitor and handles only its own rows
// dropped on its own folders and rows. 보관함 (DESIGN.md 6d) is the last folder: archived sessions
// show there only, folded until opened, and a row dragged onto it is archived. T3's other thread actions (settle, snooze, new thread)
// have no counterpart yet, so their controls are left out. The foot is one block: T3's settings
// item under the account usage; the dashboard, the split view and the terminal group (a head row
// with the shells under it) sit under the search row.
import {
  DragOverlay,
  useDndMonitor,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DroppableContainer,
} from "@dnd-kit/core";
import type { ComponentProps, KeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AccountInfo, Project, ProviderId, SearchHit, SessionSummary, ShellInfo } from "@maru/shared";
import {
  AppWindowIcon,
  ArchiveIcon,
  ChevronDownIcon,
  Columns2Icon,
  FolderCodeIcon,
  FolderPlusIcon,
  FunnelIcon,
  HashIcon,
  InboxIcon,
  LayoutDashboardIcon,
  ListPlusIcon,
  MoreHorizontalIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  TerminalIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";

import { areaZoomStyle, useAreaZoom } from "~/lib/areaZoom";
import { cn } from "~/lib/utils";
import { shownConnection, useServerDown } from "~/lib/serverDown";
import type { Connection } from "~/useSessions";
import {
  countProjectSessions,
  displayName,
  dropLineAt,
  dropSpotOf,
  dropTargetOf,
  foldKeyOf,
  folderLineAt,
  folderSpotOf,
  isFilterActive,
  isGroupFolded,
  moveInOrder,
  planDrop,
  planFolderDrop,
  sameDropSpot,
  sameFolderSpot,
  shortPath,
  sortProjects,
  type DropPlan,
  type DropSpot,
  type DropZone,
  type FolderSpot,
  type ProviderFilter,
  type SessionGroup,
} from "~/model";
import {
  archiveSession,
  assignSession,
  chooseSession,
  moveSession,
  pinSession,
  pinSessions,
  placeSessions,
  reorderProjects,
  resumeCommand,
} from "~/projectsApi";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { closeSettings, openSettings } from "~/lib/settingsRoute";
import { focusLeanWindow, useLeanKeys } from "~/lib/leanWindow";
import { closeDashboard, openDashboard, useDashboardOpen } from "~/lib/dashboardRoute";
import { closePanesView, openPanesView, usePanesView } from "~/lib/panesRoute";
import type { NewShellDragData, ShellDragData } from "~/lib/paneDrag";
import { isShellSelected, TERMINAL_GROUP_KEY } from "~/lib/shellGroup";
import { useActiveShellId, useShellList } from "~/lib/shellList";
import { pickActive, shellLabels } from "~/lib/shellTabs";
import { closeTerminal, openTerminal, openTerminalWithNewShell, useTerminalOpen } from "~/lib/terminalRoute";
import { endShell, openShellInSplit, showShell } from "./shell/shellActions";
import { useFocusedShellId } from "./split/paneStore";
import { AddSessionDialog } from "./AddSessionDialog";
import { NewSessionDialog } from "./NewSessionDialog";
import { RehomeFolderDialog } from "./RehomeFolderDialog";
import { SessionHostNotice } from "./SessionHostNotice";
import { UsageFooter } from "./UsageFooter";
import { VersionNotice } from "./VersionNotice";
import { DesktopUpdateNotice } from "./DesktopUpdateNotice";
import { toastManager } from "./ui/toast";
import { ClaudeAI, OpenAI } from "./Icons";
import { MaruMark } from "./MaruMark";
import {
  DeleteProjectDialog,
  ProjectFormDialog,
  RenameSessionDialog,
  reportProjectFailure,
  type ProjectDialogRequest,
} from "./ProjectDialogs";
import { ProjectActionMenu, SessionActionMenu, ShellActionMenu, useAnchoredMenu } from "./ProjectMenus";
import {
  FOLDER_DOT_CLASS_NAME,
  FOLDER_DOT_LABEL,
  resolveFolderDot,
  sessionActivity,
  ACTIVITY_COUNT_ORDER,
  ACTIVITY_LABEL,
  type SessionActivity,
  sessionRecedes,
  sessionTopStatus,
} from "./sessionPresentation";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { ConversationSearchResults, warmConversationSearch } from "./ConversationSearchResults";

export interface SessionSidebarProps {
  connection: Connection;
  /** The first list has arrived from the server. */
  loaded: boolean;
  groups: SessionGroup[];
  /** Every project in display order (the menus list them all, whatever the filters show). */
  projects: Project[];
  /** Every session, for per-project counts and default-folder suggestions. */
  sessions: SessionSummary[];
  counts: Partial<Record<SessionActivity, number>>;
  now: number;
  selectedKey: string | null;
  /** null clears the selection (the brand goes back to the empty screen). */
  onSelect: (key: string | null) => void;
  /** A session got a new key (moved to another account): the page follows it where it shows. */
  onRekey: (from: string, to: string, familyIds?: readonly string[]) => void;
  collapsed: ReadonlySet<string>;
  onToggleGroup: (key: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
  provider: ProviderFilter;
  onProviderChange: (provider: ProviderFilter) => void;
  activeOnly: boolean;
  onActiveOnlyChange: (activeOnly: boolean) => void;
  /** A hit of the search over every session's conversation (DESIGN.md 6u): open its session at the hit. */
  onOpenSearchHit: (hit: SearchHit, session: SessionSummary, query: string) => void;
}

/** Opens a row's menu from its more button or from a right-click. null for 미분류's header. */
interface RowMenu {
  open: boolean;
  onButton: (button: HTMLElement) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}

export function SessionSidebar(props: SessionSidebarProps) {
  const { isMobile, setOpenMobile } = useSidebar();
  const select = (key: string) => {
    props.onSelect(key);
    // On phones the list is a sheet over the session; picking one reveals it.
    if (isMobile) setOpenMobile(false);
  };

  const sessionMenu = useAnchoredMenu<SessionSummary>();
  const projectMenu = useAnchoredMenu<Project>();
  const openSessionKey = sessionMenu.open ? (sessionMenu.state?.target.key ?? null) : null;
  // The row (rowIdOf) the session menu was opened from. A pinned session has two rows; the menu
  // is the same from either, and only the row that opened it shows its button as open.
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const openProjectId = projectMenu.open ? (projectMenu.state?.target.id ?? null) : null;
  // While a menu is open its target is looked up again, so a change from another client shows.
  const menuSession =
    (openSessionKey && props.sessions.find((s) => s.key === openSessionKey)) ||
    (sessionMenu.state?.target ?? null);
  const menuProject =
    (openProjectId && props.projects.find((p) => p.id === openProjectId)) ||
    (projectMenu.state?.target ?? null);

  // `seq` remounts the dialog for each request, so a form starts from the project's current
  // values. A closed dialog stays mounted until its exit animation ends, and a close or unmount
  // names its `seq` so a late reply from an earlier dialog leaves a newer one alone.
  const [dialog, setDialog] = useState<{
    seq: number;
    open: boolean;
    request: ProjectDialogRequest;
  } | null>(null);
  const [dialogSeq, setDialogSeq] = useState(0);
  const openDialog = (request: ProjectDialogRequest) => {
    setDialog({ seq: dialogSeq + 1, open: true, request });
    setDialogSeq(dialogSeq + 1);
  };
  const closeDialog = (seq: number) =>
    setDialog((prev) => (prev?.seq === seq ? { ...prev, open: false } : prev));
  const dropDialog = (seq: number) =>
    setDialog((prev) => (prev?.seq === seq && !prev.open ? null : prev));

  // Writes resolve without touching the shown state: the server's /ws update moves the rows.
  // A move made before that update arrives starts from the previous move's order instead of the
  // stale list; any new project list from the server replaces it.
  const [pendingOrder, setPendingOrder] = useState<{ base: Project[]; ids: string[] } | null>(null);
  const order =
    pendingOrder && pendingOrder.base === props.projects
      ? pendingOrder.ids
      : sortProjects(props.projects).map((p) => p.id);
  const move = (project: Project, delta: -1 | 1) => {
    const ids = moveInOrder(order, project.id, delta);
    if (!ids) return;
    setPendingOrder({ base: props.projects, ids });
    reorderProjects(ids).catch((err: unknown) => {
      setPendingOrder(null);
      reportProjectFailure("Could not reorder", err);
    });
  };
  const removeFromList = (s: SessionSummary) => {
    chooseSession({ provider: s.provider, id: s.id, chosen: false }).catch((err: unknown) =>
      reportProjectFailure("Could not remove from list", err),
    );
  };
  const setArchived = (s: SessionSummary, archived: boolean) => {
    archiveSession({ provider: s.provider, id: s.id, archived }).catch((err: unknown) =>
      reportProjectFailure(archived ? "Could not move to Archive" : "Could not unarchive", err),
    );
  };
  const [addOpen, setAddOpen] = useState(false);

  // ---- Session management (DESIGN.md 6a) ----
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  // Reads the account list once, for the account move menu.
  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json() as Promise<{ accounts: AccountInfo[] }>)
      .then((b) => setAccounts(b.accounts))
      .catch(() => {
        // The move menu stays empty; the other actions do not need it.
      });
  }, []);
  const target = (s: SessionSummary) => ({ provider: s.provider, account: s.account, id: s.id });
  const copyResume = (s: SessionSummary) => {
    resumeCommand(target(s))
      .then(async (r) => {
        await writeTextToClipboard(r.command);
        toastManager.add({ type: "success", title: "Copied resume command", description: r.command });
      })
      .catch((err: unknown) => reportProjectFailure("Could not build the resume command", err));
  };
  const moveAccount = (s: SessionSummary, to: string) => {
    moveSession({ provider: s.provider, id: s.id, from: s.account, to })
      .then((r) => {
        toastManager.add({ type: "success", title: `Moved to ${to}`, description: r.resumeCommand });
        // The session's key carries its account; keep it selected under the new key.
        props.onRekey(s.key, `${s.provider}:${to}:${s.id}`, r.ids);
      })
      .catch((err: unknown) => reportProjectFailure("Could not move to another account", err));
  };
  // The folder dialog (typed path with the subfolders listed, 6y), mounted until it has closed.
  const [rehoming, setRehoming] = useState<{ seq: number; session: SessionSummary } | null>(null);
  const rehome = (s: SessionSummary) => setRehoming((prev) => ({ seq: (prev?.seq ?? 0) + 1, session: s }));
  // Mounted until its exit animation ends, like the project dialogs; `seq` starts each one fresh.
  const [newSession, setNewSession] = useState<{ seq: number; open: boolean; projectId: string | null } | null>(null);
  const openNewSession = (projectId: string | null) =>
    setNewSession((prev) => ({ seq: (prev?.seq ?? 0) + 1, open: true, projectId }));
  // Same mount-until-closed pattern as the project dialogs above.
  const [renaming, setRenaming] = useState<{ seq: number; open: boolean; session: SessionSummary } | null>(null);
  const assign = (s: SessionSummary, projectId: string | null) => {
    assignSession({ provider: s.provider, id: s.id, projectId }).catch((err: unknown) =>
      reportProjectFailure(
        projectId ? "Could not move to the group" : "Could not move to Unsorted",
        err,
      ),
    );
  };
  const setPinned = (s: SessionSummary, pinned: boolean) => {
    pinSession({ provider: s.provider, id: s.id, pinned }).catch((err: unknown) =>
      reportProjectFailure(pinned ? "Could not pin" : "Could not unpin", err),
    );
  };

  // ---- Drag a row: onto a folder's header (its top), or between rows (that place) ----
  const sidebarZoom = useAreaZoom("sidebar");
  const [drag, setDrag] = useState<{ session: SessionSummary; fromGroup: string } | null>(null);
  // The page's drag is one of this list's rows. A pane dragged by its header is the split view's;
  // a ref, since the next move can come before the render that `drag` waits for.
  const ownDrag = useRef(false);
  // Where the dragged row lands if let go now. The sidebar draws this spot and a drop writes this
  // spot (the ref holds it for onDragEnd), so what shows and what happens are the same value.
  const [spot, setSpot] = useState<DropSpot | null>(null);
  const spotRef = useRef<DropSpot | null>(null);
  // A Group dragged by its header (a different drag from a row: its spot is a place among the
  // Groups, drawn as a line above or below a Group's block).
  const [folderDrag, setFolderDrag] = useState<{ projectId: string; label: string } | null>(null);
  const ownFolderDrag = useRef(false);
  const [folderSpot, setFolderSpot] = useState<FolderSpot | null>(null);
  const folderSpotRef = useRef<FolderSpot | null>(null);
  const follow = (event: DragMoveEvent | DragOverEvent) => {
    if (ownFolderDrag.current) {
      const moving = folderDragOf(event.active.data.current)?.projectId;
      const container = event.collisions?.[0]?.data?.droppableContainer as DroppableContainer | undefined;
      const nextFolder = moving ? folderSpotOf({ zone: zoneOf(container?.data.current), order, moving }) : null;
      if (sameFolderSpot(folderSpotRef.current, nextFolder)) return;
      folderSpotRef.current = nextFolder;
      setFolderSpot(nextFolder);
      return;
    }
    if (!ownDrag.current) return;
    const next = spotFor(event);
    if (sameDropSpot(spotRef.current, next)) return;
    spotRef.current = next;
    setSpot(next);
  };
  const runDrop = (plan: DropPlan) => {
    if (plan.kind === "archive") {
      const sep = plan.key.indexOf(":");
      const provider = plan.key.slice(0, sep);
      if (provider !== "claude" && provider !== "codex") return;
      archiveSession({ provider, id: plan.key.slice(sep + 1), archived: true }).catch((err: unknown) =>
        reportProjectFailure("Could not move to Archive", err),
      );
      return;
    }
    const write =
      plan.kind === "pin"
        ? pinSessions({ keys: plan.keys })
        : placeSessions({ projectId: plan.projectId, keys: plan.keys });
    write.catch((err: unknown) =>
      reportProjectFailure(
        plan.kind === "pin"
          ? "Could not pin"
          : plan.projectId
            ? "Could not move to the group"
            : "Could not reorder",
        err,
      ),
    );
  };
  // A drop over the row it started on still ends in a click there; that click is not a selection.
  const suppressClick = useRef(false);
  const onDragStart = (event: DragStartEvent) => {
    const folder = folderDragOf(event.active.data.current);
    if (folder) {
      ownFolderDrag.current = true;
      folderSpotRef.current = null;
      setFolderDrag(folder);
      return;
    }
    const data = rowDragOf(event.active.data.current);
    if (!data) return;
    ownDrag.current = true;
    spotRef.current = null;
    setDrag({ session: data.session, fromGroup: data.groupKey });
  };
  const endDrag = () => {
    ownDrag.current = false;
    setDrag(null);
    spotRef.current = null;
    setSpot(null);
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };
  const endFolderDrag = () => {
    ownFolderDrag.current = false;
    setFolderDrag(null);
    folderSpotRef.current = null;
    setFolderSpot(null);
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };
  const dropFolder = (event: DragEndEvent) => {
    const moving = folderDragOf(event.active.data.current)?.projectId;
    // Like a row's drop: this list's only while `over` is one of its zones.
    const at = zoneOf(event.over?.data.current) ? folderSpotRef.current : null;
    endFolderDrag();
    const ids = moving && at ? planFolderDrop(order, moving, at) : null;
    if (!ids) return;
    setPendingOrder({ base: props.projects, ids });
    reorderProjects(ids).catch((err: unknown) => {
      setPendingOrder(null);
      reportProjectFailure("Could not reorder", err);
    });
  };
  const onDragEnd = (event: DragEndEvent) => {
    if (ownFolderDrag.current) return dropFolder(event);
    if (!ownDrag.current) return;
    const data = rowDragOf(event.active.data.current);
    // The drop is this list's only while dnd-kit's `over` is one of its zones: the split view
    // decides by `over` too, so one drop never has two owners (`over` can trail the last move's
    // collisions by a render, which the spot follows).
    const at = zoneOf(event.over?.data.current) ? spotRef.current : null;
    endDrag();
    if (!data || !at) return;
    const plan = planDrop({
      sessions: props.sessions,
      projects: props.projects,
      moving: `${data.session.provider}:${data.session.id}`,
      fromGroup: data.groupKey,
      target: dropTargetOf(at),
    });
    if (plan) runDrop(plan);
  };
  useDndMonitor({
    onDragStart,
    onDragOver: follow,
    onDragMove: follow,
    onDragEnd,
    onDragCancel: () => {
      if (ownDrag.current) endDrag();
      if (ownFolderDrag.current) endFolderDrag();
    },
  });
  // A header spot lights that folder; a row spot draws its line.
  const dropGroup = spot && !spot.row ? spot.groupKey : null;
  // A search opens a folded 보관함 while its text is there (model.ts isGroupFolded).
  const searching = props.query.trim() !== "";
  const home = () => {
    props.onSelect(null);
    closeSettings();
    if (isMobile) setOpenMobile(false);
  };

  return (
    <>
      <SidebarChromeHeader connection={props.connection} counts={props.counts} onHome={home} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <SidebarSessionHeader
              query={props.query}
              onQueryChange={props.onQueryChange}
              provider={props.provider}
              onProviderChange={props.onProviderChange}
              activeOnly={props.activeOnly}
              onActiveOnlyChange={props.onActiveOnlyChange}
              onNewProject={() => openDialog({ kind: "create" })}
              onAddSession={() => setAddOpen(true)}
              onNewSession={() => openNewSession(null)}
            />
            <SidebarViewsMenu
              collapsed={props.collapsed}
              onToggleGroup={props.onToggleGroup}
              onNavigate={() => (isMobile ? setOpenMobile(false) : undefined)}
            />
          </SidebarGroup>
        }
      >
        <SidebarGroup className="flex-1" role="presentation">
          {!props.groups.some((g) => g.kind !== "archive" || g.sessions.length > 0) ? (
            <SidebarListEmpty
              loaded={props.loaded}
              filtered={isFilterActive({ query: props.query, provider: props.provider, activeOnly: props.activeOnly })}
            />
          ) : (
            <TooltipProvider delay={150} closeDelay={0} timeout={400}>
              <SidebarMenu className="relative flex-1 gap-px">
                {props.groups.flatMap((group) => {
                  const collapsed = isGroupFolded(group, props.collapsed, searching);
                  const project = group.project;
                  return [
                    <ProjectFolderHeader
                      key={`folder:${group.key}`}
                      group={group}
                      dropTarget={dropGroup === group.key}
                      folderLine={folderLineAt(folderSpot, project?.id ?? null)}
                      folderDragging={folderDrag !== null && folderDrag.projectId === project?.id}
                      collapsed={collapsed}
                      onToggle={() => {
                        if (!suppressClick.current) props.onToggleGroup(foldKeyOf(group));
                      }}
                      menu={
                        project
                          ? {
                              open: project.id === openProjectId,
                              onButton: (button) => projectMenu.toggleFromButton(project, button),
                              onContextMenu: (event) => projectMenu.showAtPointer(project, event),
                            }
                          : null
                      }
                    />,
                    ...(collapsed
                      ? []
                      : group.sessions.map((s, i) => {
                          const rowId = rowIdOf(group.key, s.key);
                          // A Group dropped below this one draws its line under the last row.
                          const folderEnd =
                            i === group.sessions.length - 1 &&
                            folderLineAt(folderSpot, project?.id ?? null) === "after";
                          return (
                            <SessionRow
                              key={rowId}
                              rowId={rowId}
                              session={s}
                              group={group}
                              dragActive={drag !== null || folderDrag !== null}
                              dropTarget={dropGroup === group.key}
                              dropLine={dropLineAt(spot, group.key, s.key) ?? (folderEnd ? "after" : null)}
                              isActive={s.key === props.selectedKey}
                              onSelect={() => {
                                if (!suppressClick.current) select(s.key);
                              }}
                              menu={{
                                open: s.key === openSessionKey && rowId === menuRow,
                                onButton: (button) => {
                                  setMenuRow(rowId);
                                  sessionMenu.toggleFromButton(s, button);
                                },
                                onContextMenu: (event) => {
                                  setMenuRow(rowId);
                                  sessionMenu.showAtPointer(s, event);
                                },
                              }}
                            />
                          );
                        })),
                  ];
                })}
              </SidebarMenu>
              {/* Mounted for a row drag only: an overlay draws a box for any drag of the page's
                  context, and the split view draws its own for a pane. */}
              {drag || folderDrag
                ? createPortal(
                    <DragOverlay dropAnimation={null}>
                      {/* In the body, outside the list's zoom area: the chip takes the list's zoom. */}
                      <div data-area-zoom="" style={areaZoomStyle(sidebarZoom)} className="contents">
                        {drag ? <DragChip session={drag.session} /> : <FolderDragChip label={folderDrag!.label} />}
                      </div>
                    </DragOverlay>,
                    document.body,
                  )
                : null}
            </TooltipProvider>
          )}
        </SidebarGroup>
        {searching ? (
          <SidebarGroup className="pt-0">
            <ConversationSearchResults
              query={props.query}
              onOpen={(hit, session, query) => {
                props.onOpenSearchHit(hit, session, query);
                if (isMobile) setOpenMobile(false);
              }}
            />
          </SidebarGroup>
        ) : null}
      </SidebarContent>
      {/* T3 SidebarChromeFooter: its notice pills, the account usage, then T3's settings item
          (SidebarUtilityItem) on its own row. The dashboard and the split view are menu rows under
          the search row (SidebarViewsMenu). */}
      <SidebarFooter className="border-t border-sidebar-border pt-2">
        <VersionNotice />
        <DesktopUpdateNotice />
        <SessionHostNotice />
        {/* The account usage above, then the settings row (T3 SidebarChromeFooter order, user request). */}
        <UsageFooter className="min-w-0" />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => openSettings()}>
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SessionActionMenu
        menu={sessionMenu}
        session={menuSession}
        projects={props.projects}
        onSetPinned={setPinned}
        onArchive={setArchived}
        onAssign={assign}
        onRemoveFromList={removeFromList}
        onRename={(session) => setRenaming((prev) => ({ seq: (prev?.seq ?? 0) + 1, open: true, session }))}
        accounts={accounts}
        onCopyResume={copyResume}
        onMoveAccount={moveAccount}
        onRehome={rehome}
      />
      {rehoming ? (
        <RehomeFolderDialog
          key={rehoming.seq}
          session={rehoming.session}
          sessions={props.sessions}
          onClosed={() => setRehoming((prev) => (prev?.seq === rehoming.seq ? null : prev))}
        />
      ) : null}
      {renaming ? (
        <RenameSessionDialog
          key={renaming.seq}
          open={renaming.open}
          session={renaming.session}
          onClose={() => setRenaming((prev) => (prev ? { ...prev, open: false } : prev))}
          onClosed={() => setRenaming((prev) => (prev && !prev.open ? null : prev))}
        />
      ) : null}
      <ProjectActionMenu
        menu={projectMenu}
        project={menuProject}
        order={order}
        onRename={(project) => openDialog({ kind: "rename", project })}
        onNewSession={(project) => openNewSession(project.id)}
        onMove={move}
        onDelete={(project) =>
          openDialog({
            kind: "delete",
            project,
            // Counted once: the sessions return to 미분류 over /ws before the reply arrives.
            sessionCount: countProjectSessions(props.sessions, project.id),
          })
        }
      />
      {dialog === null ? null : dialog.request.kind === "delete" ? (
        <DeleteProjectDialog
          key={dialog.seq}
          open={dialog.open}
          request={dialog.request}
          onClose={() => closeDialog(dialog.seq)}
          onClosed={() => dropDialog(dialog.seq)}
        />
      ) : (
        <ProjectFormDialog
          key={dialog.seq}
          open={dialog.open}
          request={dialog.request}
          onClose={() => closeDialog(dialog.seq)}
          onClosed={() => dropDialog(dialog.seq)}
        />
      )}
      <AddSessionDialog open={addOpen} onClose={() => setAddOpen(false)} now={props.now} />
      {newSession ? (
        <NewSessionDialog
          key={newSession.seq}
          open={newSession.open}
          projectId={newSession.projectId}
          projects={props.projects}
          sessions={props.sessions}
          onClose={() => setNewSession((prev) => (prev ? { ...prev, open: false } : prev))}
          onClosed={() => setNewSession((prev) => (prev && !prev.open ? null : prev))}
          onCreated={select}
        />
      ) : null}
    </>
  );
}

// ---- Header (SidebarChrome.tsx: SidebarChromeHeader) ----

const CONNECTION_LABEL: Record<Connection, string> = {
  open: "Connected to server",
  connecting: "Connecting to server",
  closed: "Disconnected from server, waiting to reconnect",
};

// T3 ConnectionStatusDot: connected, connecting, error.
const CONNECTION_DOT_CLASS: Record<Connection, string> = {
  open: "bg-success",
  connecting: "bg-warning",
  closed: "bg-destructive",
};

const STATUS_BADGE_VARIANT: Record<SessionActivity, ComponentProps<typeof Badge>["variant"]> = {
  "waiting-input": "warning",
  running: "info",
  background: "info",
  error: "error",
  "open-idle": "secondary",
  closed: "outline",
};

function SidebarChromeHeader(props: {
  connection: Connection;
  counts: Partial<Record<SessionActivity, number>>;
  /** The brand's action: no session selected, settings closed. */
  onHome: () => void;
}) {
  return (
    <div data-titlebar="" className="relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3">
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
        <SidebarTrigger
          variant="ghost"
          className="relative top-auto translate-y-0"
          aria-label="Toggle sidebar"
        />
      </div>
      <div className="relative z-10 flex h-8 min-w-0 flex-1 items-center gap-x-2 overflow-hidden py-0.5">
        {/* T3 SidebarBrand: the brand is a link home, here the mark alone (DESIGN.md 7c). A plain
            click stays in the page. */}
        <a
          href="/"
          aria-label="maru"
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            props.onHome();
          }}
          className="relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset md:flex"
        >
          <MaruMark aria-hidden className="size-5 shrink-0 text-foreground" />
        </a>
        <ConnectionStatusDot connection={props.connection} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* Only what asks for attention; idle and closed counts say little. */}
        {ACTIVITY_COUNT_ORDER.flatMap((st) => {
          const top = sessionTopStatus(st);
          const count = props.counts[st];
          if (!top || !count) return [];
          return [
            <Tooltip key={st}>
              <TooltipTrigger
                render={
                  <Badge
                    size="sm"
                    variant={STATUS_BADGE_VARIANT[st]}
                    className="gap-1 tabular-nums"
                    aria-label={`${ACTIVITY_LABEL[st]}: ${count}`}
                  />
                }
              >
                <top.icon aria-hidden className="size-3 shrink-0" />
                {count}
              </TooltipTrigger>
              <TooltipPopup side="bottom">{ACTIVITY_LABEL[st]}</TooltipPopup>
            </Tooltip>,
          ];
        })}
      </div>
    </div>
  );
}

// T3 ConnectionStatusDot with a tooltip; the ping marks the connecting phase. Pressing it does
// nothing, so it is an image (T3's UsageLimits bar pattern) that focus can still reach for the
// tooltip. It shows the conversation's judgment (lib/serverDown.ts): once the server is
// unreachable it stays so through the reconnect attempts.
function ConnectionStatusDot(props: { connection: Connection }) {
  const connection = shownConnection(useServerDown(), props.connection);
  const label = CONNECTION_LABEL[connection];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            tabIndex={0}
            aria-label={label}
            className="relative flex size-3 shrink-0 cursor-help items-center justify-center rounded-full outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        {connection === "connecting" ? (
          <span className="absolute inline-flex h-full w-full rounded-full bg-warning/60 duration-2000 motion-safe:animate-status-ping" />
        ) : null}
        <span
          className={cn("relative inline-flex size-2 rounded-full", CONNECTION_DOT_CLASS[connection])}
        />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The list with no folder to show (T3 Sidebar's "No threads found" status line). Blank until the
 * first list arrives, unless the server is unreachable before it: then the header dot's label, by
 * the same judgment (lib/serverDown.ts), so neither flickers on the reconnect attempts.
 */
function SidebarListEmpty(props: { loaded: boolean; filtered: boolean }) {
  const unreachable = useServerDown();
  const text = props.loaded
    ? props.filtered
      ? "No matching sessions"
      : "No sessions"
    : unreachable
      ? CONNECTION_LABEL.closed
      : null;
  if (text === null) return null;
  return (
    <p role="status" className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">
      {text}
    </p>
  );
}

// ---- Search and filter row (SidebarThreadHeader.tsx) ----

function SidebarSessionHeader(props: {
  query: string;
  onQueryChange: (query: string) => void;
  provider: ProviderFilter;
  onProviderChange: (provider: ProviderFilter) => void;
  activeOnly: boolean;
  onActiveOnlyChange: (activeOnly: boolean) => void;
  onNewProject: () => void;
  onAddSession: () => void;
  onNewSession: () => void;
}) {
  const filtered = props.provider !== "all" || props.activeOnly;
  const filterLabel = [
    props.provider === "claude" ? "Claude only" : props.provider === "codex" ? "Codex only" : null,
    props.activeOnly ? "Open sessions only" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="flex items-center gap-1">
      <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/70">
        <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
        <SidebarInput
          nativeInput
          type="search"
          value={props.query}
          onChange={(event) => props.onQueryChange(event.currentTarget.value)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Escape" && props.query) {
              event.preventDefault();
              props.onQueryChange("");
            }
          }}
          // The search reaches into every conversation too (DESIGN.md 6u): the server catches its index up meanwhile.
          onFocus={warmConversationSearch}
          placeholder="Search"
          aria-label="Search sessions and conversations"
          className="min-w-0 flex-1"
        />
        {props.query ? (
          <Button
            type="button"
            size="icon-micro"
            variant="ghost-muted"
            className="shrink-0"
            aria-label="Clear search"
            onClick={() => props.onQueryChange("")}
          >
            <XIcon className="size-3" />
          </Button>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center">
        <Menu>
          <MenuTrigger
            render={
              <SidebarHeaderIconButton
                label={filtered ? `Filter: ${filterLabel}` : "Filter"}
                isActive={filtered}
              />
            }
          >
            {props.provider === "claude" ? (
              <ClaudeAI className="size-4" />
            ) : props.provider === "codex" ? (
              <OpenAI className="size-4" />
            ) : (
              <FunnelIcon className="size-4" />
            )}
            {props.activeOnly ? (
              <span
                aria-hidden
                className="absolute top-1 right-1 size-1.5 rounded-full bg-success"
              />
            ) : null}
          </MenuTrigger>
          {/* Every text starts in one column: the radio items keep a fixed icon slot, the label
              and the switch item are inset to it. */}
          <MenuPopup align="end" className="min-w-48">
            <MenuGroup>
              <MenuGroupLabel className="ps-8">Provider</MenuGroupLabel>
              <MenuRadioGroup
                value={props.provider}
                onValueChange={(next) => {
                  if (next === "all" || next === "claude" || next === "codex") {
                    props.onProviderChange(next);
                  }
                }}
              >
                <ProviderRadioItem value="all" label="All" />
                <ProviderRadioItem
                  value="claude"
                  label="Claude"
                  icon={<ClaudeAI className="size-3.5" />}
                />
                <ProviderRadioItem
                  value="codex"
                  label="Codex"
                  icon={<OpenAI className="size-3.5" />}
                />
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
            <MenuCheckboxItem
              variant="switch"
              className="ps-8"
              checked={props.activeOnly}
              onCheckedChange={(checked) => props.onActiveOnlyChange(checked)}
            >
              Open sessions only
            </MenuCheckboxItem>
          </MenuPopup>
        </Menu>
        {/* Filter, then one add menu with the three ways to add (user request): a new session, an
            existing session onto the list, a new Group. */}
        <Menu>
          <MenuTrigger render={<SidebarHeaderIconButton label="Add" />}>
            <PlusIcon />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-48">
            <MenuItem onClick={props.onNewSession}>
              <SquarePenIcon />
              New session
            </MenuItem>
            <MenuItem onClick={props.onAddSession}>
              <ListPlusIcon />
              Add existing session
            </MenuItem>
            <MenuItem onClick={props.onNewProject}>
              <FolderPlusIcon />
              New group
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

function ProviderRadioItem(props: { value: ProviderFilter; label: string; icon?: ReactNode }) {
  return (
    <MenuRadioItem value={props.value} closeOnClick>
      <span className="flex w-full min-w-0 items-center gap-2">
        <span aria-hidden className="flex w-4 shrink-0 justify-center">
          {props.icon}
        </span>
        <span className="min-w-0 truncate">{props.label}</span>
        <MenuRadioItemIndicator className="ms-auto" />
      </span>
    </MenuRadioItem>
  );
}

function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<ComponentProps<typeof SidebarMenuButton>, "children" | "className" | "tooltip" | "aria-label">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn("relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

// ---- Project folder (SidebarProjectFolderHeader.tsx) ----

function ProjectFolderHeader(props: {
  group: SessionGroup;
  /** A dragged session would move into this folder. */
  dropTarget: boolean;
  /** A dragged Group would land above or below this Group's block. */
  folderLine: "before" | "after" | null;
  /** This Group is the one being dragged. */
  folderDragging: boolean;
  collapsed: boolean;
  onToggle: () => void;
  /** null for 고정됨, 미분류 and 보관함, which have no menu. */
  menu: RowMenu | null;
}) {
  const { group, collapsed, menu } = props;
  const dot = collapsed ? resolveFolderDot(group.sessions) : null;
  const project = group.project;
  const FolderIcon =
    group.kind === "pinned" ? PinIcon : group.kind === "archive" ? ArchiveIcon : project ? FolderCodeIcon : InboxIcon;
  const { setNodeRef } = useDroppable({
    id: `folder:${group.key}`,
    data: dropZoneOf(group) satisfies DropZone,
  });
  // Only a Group's header drags; Pinned, Unsorted and Archive stay where they are.
  const drag = useDraggable({
    id: `folder-drag:${group.key}`,
    data: { kind: "project-folder", projectId: project?.id ?? "", label: group.label } satisfies FolderDragData,
    disabled: !project,
  });
  // The line above a Group, or below one with no rows under its header (a Group with rows draws
  // its "after" line under its last row, in the list).
  const headerLine =
    props.folderLine === "before" || (props.folderLine === "after" && (collapsed || group.sessions.length === 0))
      ? props.folderLine
      : null;
  return (
    <li
      ref={setNodeRef}
      data-testid="sidebar-project-folder"
      data-folder-kind={group.kind}
      // 보관함 sits at the bottom of the list: its auto top margin takes the free height of a short
      // list, and the padding keeps the usual gap above it in a long one.
      className={cn(
        "group/project-folder relative list-none first:mt-0",
        group.kind === "archive" ? "mt-auto pt-2" : "mt-2",
      )}
    >
      {headerLine ? (
        <span
          aria-hidden
          data-folder-line={headerLine}
          className={cn(
            "pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-primary",
            // In the gap between Groups, where the dragged chip does not cover it.
            headerLine === "before" ? "-top-1" : "-bottom-1",
          )}
        />
      ) : null}
      <button
        ref={project ? drag.setNodeRef : undefined}
        {...(project ? drag.listeners : {})}
        type="button"
        data-drop-target={props.dropTarget || undefined}
        aria-expanded={!collapsed}
        onClick={props.onToggle}
        onContextMenu={
          menu
            ? (event) => {
                event.preventDefault();
                menu.onContextMenu(event);
              }
            : undefined
        }
        title={group.label}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.dropTarget && "bg-sidebar-row-hover ring-1 ring-primary/50 ring-inset",
          props.folderDragging && "opacity-40",
        )}
      >
        {/* ProjectFavicon's fallback; maru has no project favicons. */}
        <FolderIcon className="size-4 shrink-0 text-icon-muted" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90",
            // Touch screens show the menu button all the time; the name ends before it.
            menu && "pointer-coarse:me-6",
          )}
        >
          {group.label}
        </span>
        {dot ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}>
            <span className="sr-only">{FOLDER_DOT_LABEL[dot]}</span>
          </span>
        ) : null}
        {collapsed && (group.sessions.length > 0 || group.kind === "archive") ? (
          <span
            className={cn(
              "shrink-0 text-xs tabular-nums text-sidebar-muted-foreground",
              // The menu button sits over the count while it shows.
              menu &&
                "group-hover/project-folder:invisible group-has-[[data-sidebar-action-for]:focus]/project-folder:invisible pointer-coarse:invisible",
              menu?.open && "invisible",
            )}
          >
            {group.sessions.length}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </button>
      {menu ? (
        // Sits over the count, which hides on hover or focus, and left of the chevron.
        <span
          className={cn(
            "absolute inset-y-0 right-6 flex items-center opacity-0 focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100",
            menu.open && "opacity-100",
          )}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  data-sidebar-action-for={group.key}
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`${group.label} group menu`}
                  aria-haspopup="menu"
                  aria-expanded={menu.open}
                  onClick={(event) => menu.onButton(event.currentTarget)}
                />
              }
            >
              <MoreHorizontalIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>Group menu</TooltipPopup>
          </Tooltip>
        </span>
      ) : null}
    </li>
  );
}

/**
 * The views under the search row (user request): the dashboard (DESIGN.md 6j), the split view
 * (6k) and the terminal group (6s). Each is highlighted while it shows; pressing it again returns
 * to what it covered.
 */
function SidebarViewsMenu(props: {
  collapsed: ReadonlySet<string>;
  onToggleGroup: (key: string) => void;
  onNavigate: () => void;
}) {
  const { onNavigate } = props;
  const dashboard = useDashboardOpen();
  const panes = usePanesView();
  return (
    <SidebarMenu aria-label="Views" className="mt-1">
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={dashboard}
          aria-pressed={dashboard}
          onClick={() => {
            if (dashboard) closeDashboard();
            else openDashboard();
            onNavigate();
          }}
        >
          <LayoutDashboardIcon />
          <span>Dashboard</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={panes && !dashboard}
          aria-pressed={panes}
          onClick={() => {
            if (dashboard) closeDashboard();
            if (panes && !dashboard) closePanesView();
            else openPanesView();
            onNavigate();
          }}
        >
          <Columns2Icon />
          <span>Split view</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <TerminalGroup
        folded={props.collapsed.has(TERMINAL_GROUP_KEY)}
        onToggleFold={() => props.onToggleGroup(TERMINAL_GROUP_KEY)}
        onNavigate={onNavigate}
      />
    </SidebarMenu>
  );
}

/**
 * The terminal group: a head row "터미널" and the shells under it (DESIGN.md 6s). The head opens and
 * closes the terminal screen; dragging it onto a pane of the split view makes a new shell there
 * (6k), and its "+" makes a new shell on the screen. The chevron folds the list (kept in the
 * folded-Groups list like a session Group's fold). Each row is one shell of the page's shell list,
 * the list the terminal screen's tabs read (lib/shellList.ts), named as the tabs are.
 */
function TerminalGroup(props: { folded: boolean; onToggleFold: () => void; onNavigate: () => void }) {
  const { folded, onNavigate } = props;
  const terminalOpen = useTerminalOpen();
  const panesShown = usePanesView();
  const shells = useShellList(true);
  const shownShell = pickActive(shells ?? [], useActiveShellId());
  const focusedPaneShell = useFocusedShellId(panesShown);
  const labels = shellLabels(shells ?? []);
  const menu = useAnchoredMenu<string>();
  const openShellId = menu.open ? (menu.state?.target ?? null) : null;
  const count = shells?.length ?? 0;

  const head = useDraggable({ id: "terminal-row", data: { kind: "shell-new" } satisfies NewShellDragData });
  // A drop over the head it started on still ends in a click there; that click is not a toggle.
  const headSuppressClick = useRef(false);
  useEffect(() => {
    if (head.isDragging) {
      headSuppressClick.current = true;
      return;
    }
    const t = setTimeout(() => {
      headSuppressClick.current = false;
    }, 0);
    return () => clearTimeout(t);
  }, [head.isDragging]);

  return (
    <>
      <SidebarMenuItem data-terminal-group={folded ? "folded" : "open"}>
        <SidebarMenuButton
          ref={head.setNodeRef}
          {...head.listeners}
          isActive={terminalOpen}
          aria-pressed={terminalOpen}
          data-terminal-row=""
          className={cn("pe-16 pointer-coarse:pe-20", head.isDragging && "opacity-40")}
          onClick={() => {
            if (headSuppressClick.current) return;
            if (terminalOpen) closeTerminal();
            else openTerminal();
            onNavigate();
          }}
        >
          <SquareTerminalIcon />
          <span>Terminal</span>
        </SidebarMenuButton>
        {/* Over the head's right end, not inside its button role: the count (folded), the new-shell
            button (on hover, always on touch screens) and the fold chevron. */}
        <span className="absolute inset-y-0 right-1 flex items-center gap-0.5">
          {folded && count > 0 ? (
            <span className="px-1 text-xs tabular-nums text-sidebar-muted-foreground">{count}</span>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  data-terminal-new=""
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="New shell"
                  className="opacity-0 focus-visible:opacity-100 group-any-hover/menu-item:opacity-100 pointer-coarse:opacity-100"
                  onClick={() => {
                    openTerminalWithNewShell();
                    onNavigate();
                  }}
                />
              }
            >
              <PlusIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>New shell</TooltipPopup>
          </Tooltip>
          <Button
            data-terminal-fold=""
            size="icon-xs"
            variant="ghost-muted"
            aria-label={folded ? "Expand terminal list" : "Collapse terminal list"}
            aria-expanded={!folded}
            onClick={props.onToggleFold}
          >
            <ChevronDownIcon aria-hidden className={cn("size-3 transition-transform", folded && "-rotate-90")} />
          </Button>
        </span>
      </SidebarMenuItem>
      {folded || count === 0 ? null : (
        // A long list scrolls inside the header, so the session list below keeps its room.
        <li className="list-none">
          <ul data-terminal-list="" className="flex max-h-48 flex-col gap-px overflow-y-auto">
            {(shells ?? []).map((shell) => (
              <ShellRow
                key={shell.id}
                shell={shell}
                label={labels.get(shell.id) ?? shell.command}
                selected={isShellSelected({
                  shellId: shell.id,
                  terminalOpen,
                  terminalShell: shownShell,
                  panesShown,
                  focusedPaneShell,
                })}
                menuOpen={openShellId === shell.id}
                onSelect={() => {
                  showShell(shell.id);
                  onNavigate();
                }}
                onMenuButton={(button) => menu.toggleFromButton(shell.id, button)}
                onContextMenu={(event) => menu.showAtPointer(shell.id, event)}
              />
            ))}
          </ul>
        </li>
      )}
      <ShellActionMenu
        menu={menu}
        onOpenInSplit={(id) => {
          openShellInSplit(id);
          onNavigate();
        }}
        onEnd={(id) => {
          endShell(id).catch((err: unknown) => reportProjectFailure("Could not end the shell", err));
        }}
      />
      {head.isDragging
        ? createPortal(
            <DragOverlay dropAnimation={null}>
              <div className="flex h-9 w-64 cursor-grabbing items-center gap-2 rounded-md bg-popover px-2.5 text-sm font-medium text-foreground shadow-lg ring-1 ring-border">
                <SquareTerminalIcon aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">New terminal</span>
              </div>
            </DragOverlay>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * One shell under the terminal head. It looks and behaves like a session row: a click shows the
 * shell (components/shell/shellActions.ts showShell), a drag onto a pane of the split view opens it
 * there (`kind: "shell"`, lib/paneDrag.ts), and its menu (the more button or a right-click) opens
 * it in the split view or ends it.
 */
function ShellRow(props: {
  shell: ShellInfo;
  label: string;
  selected: boolean;
  menuOpen: boolean;
  onSelect: () => void;
  onMenuButton: (button: HTMLElement) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const { shell, label, selected, menuOpen } = props;
  const drag = useDraggable({
    id: `shell-row:${shell.id}`,
    data: { kind: "shell", shellId: shell.id, title: label } satisfies ShellDragData,
  });
  // A drop over the row it started on still ends in a click there; that click is not a selection.
  const suppressClick = useRef(false);
  useEffect(() => {
    if (drag.isDragging) {
      suppressClick.current = true;
      return;
    }
    const t = setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    return () => clearTimeout(t);
  }, [drag.isDragging]);
  const pick = () => {
    if (!suppressClick.current) props.onSelect();
  };
  return (
    <SidebarMenuItem data-shell-item={shell.id} className="list-none">
      <div
        ref={drag.setNodeRef}
        {...drag.listeners}
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-current={selected ? "page" : undefined}
        data-testid="sidebar-shell-row"
        data-selected={selected || undefined}
        title={shell.path}
        className={cn(
          "group/sidebar-row relative flex h-8 w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-md px-2.5 ps-9 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:pe-9",
          selected
            ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
          drag.isDragging && "opacity-40",
        )}
        onClick={pick}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          pick();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(event);
        }}
      >
        <TerminalIcon aria-hidden className="size-3.5 shrink-0 text-icon-muted" />
        <span dir="auto" className="min-w-0 flex-1 truncate text-start text-sm font-medium text-foreground">
          {label}
        </span>
      </div>
      {/* A sibling over the row's right end (as the session row's menu button is), not inside its button role. */}
      <span
        className={cn(
          "pointer-events-none absolute top-1 right-2.5 flex h-6 items-center opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-any-hover/menu-item:pointer-events-auto group-any-hover/menu-item:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
          menuOpen && "pointer-events-auto opacity-100",
        )}
      >
        <Button
          data-shell-action=""
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`${label} menu`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => props.onMenuButton(event.currentTarget)}
        >
          <MoreHorizontalIcon aria-hidden />
        </Button>
      </span>
      {drag.isDragging
        ? createPortal(
            <DragOverlay dropAnimation={null}>
              <div className="flex h-9 w-64 cursor-grabbing items-center gap-2 rounded-md bg-popover px-2.5 text-sm font-medium text-foreground shadow-lg ring-1 ring-border">
                <SquareTerminalIcon aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </div>
            </DragOverlay>,
            document.body,
          )
        : null}
    </SidebarMenuItem>
  );
}

// ---- Drag and drop ----

/**
 * One row of the sidebar: a session in a folder. A pinned session has two rows (in 고정됨 and in
 * its Group), so the session key alone does not name a row; React keys and dnd-kit ids use this.
 */
function rowIdOf(groupKey: string, sessionKey: string): string {
  return `${groupKey}|${sessionKey}`;
}

interface DragData {
  session: SessionSummary;
  groupKey: string;
}

/** A row's drag data; a pane's (`kind: "pane"`, the split view's) is not. */
function rowDragOf(data: unknown): DragData | null {
  const d = data as Partial<DragData> | null | undefined;
  return d && typeof d === "object" && d.session && typeof d.groupKey === "string" ? (d as DragData) : null;
}

/** `active.data` of a Group dragged by its header. */
interface FolderDragData {
  kind: "project-folder";
  projectId: string;
  label: string;
}

function folderDragOf(data: unknown): FolderDragData | null {
  const d = data as Partial<FolderDragData> | null | undefined;
  return d && typeof d === "object" && d.kind === "project-folder" && typeof d.projectId === "string" && d.projectId !== ""
    ? (d as FolderDragData)
    : null;
}

/** A folder's or a row's zone of this list; a pane of the split view (`kind: "pane-target"`) is not. */
function zoneOf(data: unknown): DropZone | null {
  const d = data as Partial<DropZone> | null | undefined;
  return d && typeof d === "object" && typeof d.groupKey === "string" ? (d as DropZone) : null;
}

/** A droppable's data: the folder's key, whether it is 고정됨, its project id, the row's key. */
function dropZoneOf(group: SessionGroup, sessionKey?: string): DropZone {
  return {
    groupKey: group.key,
    pinned: group.kind === "pinned",
    ...(group.kind === "archive" ? { archive: true } : {}),
    projectId: group.project?.id ?? null,
    ...(sessionKey ? { sessionKey } : {}),
  };
}

/**
 * The spot for this move. dnd-kit's `event.over` in onDragMove is the zone of the move before
 * (state that settles a render later), so one move from a row onto a header kept the row's line
 * while the drop went to the header. This move's collisions are current; the first one is the
 * zone dnd-kit itself makes `over` next.
 */
function spotFor(event: DragMoveEvent | DragOverEvent): DropSpot | null {
  const dragged = rowDragOf(event.active.data.current);
  if (!dragged) return null;
  const container = event.collisions?.[0]?.data?.droppableContainer as DroppableContainer | undefined;
  return dropSpotOf({
    zone: zoneOf(container?.data.current),
    zoneRect: container?.rect.current ?? null,
    draggedRect: event.active.rect.current.translated,
    moving: { sessionKey: dragged.session.key, fromGroup: dragged.groupKey },
  });
}

/** The Group header's look under the pointer while it is dragged. */
function FolderDragChip({ label }: { label: string }) {
  return (
    <div className="flex h-8 w-44 cursor-grabbing items-center gap-2.5 rounded-md bg-popover px-2.5 opacity-90 text-sm font-medium text-foreground shadow-lg ring-1 ring-border">
      <FolderCodeIcon aria-hidden className="size-4 shrink-0 text-icon-muted" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </div>
  );
}

/** The row's look under the pointer while it is dragged. */
function DragChip({ session }: { session: SessionSummary }) {
  return (
    <div className="flex h-9 w-64 cursor-grabbing items-center gap-2 rounded-md bg-popover px-2.5 text-sm font-medium text-foreground shadow-lg ring-1 ring-border">
      <ProviderIcon provider={session.provider} />
      <span className="min-w-0 flex-1 truncate">{displayName(session)}</span>
    </div>
  );
}

// ---- Session row (SidebarThreadRow.tsx, "folder" variant: T3's default one-line row) ----

const OWNER_LABEL: Record<SessionSummary["owner"], string | null> = {
  terminal: "Terminal",
  ui: "UI",
  none: null,
};

function ProviderIcon({ provider, className }: { provider: ProviderId; className?: string }) {
  // T3 ProviderInstanceIcon: Codex takes the foreground color, Claude its own orange.
  return provider === "claude" ? (
    <ClaudeAI aria-hidden className={cn("size-3.5 shrink-0", className)} />
  ) : (
    <OpenAI aria-hidden className={cn("size-3.5 shrink-0 text-foreground", className)} />
  );
}

function SessionRow(props: {
  /** rowIdOf(group.key, session.key). */
  rowId: string;
  session: SessionSummary;
  /** The folder the row sits in: a drop on the row puts the dragged session there (pinned in 고정됨). */
  group: SessionGroup;
  /** Some row is being dragged; hover cards stay closed meanwhile. */
  dragActive: boolean;
  dropTarget: boolean;
  /** A drop here would land above or below this row. */
  dropLine: "before" | "after" | null;
  isActive: boolean;
  onSelect: () => void;
  menu: RowMenu;
}) {
  const { session: s, isActive, menu } = props;
  // A lean window (DESIGN.md 6x) shows this session: the row says so, and the mark brings that window forward.
  const leanOpen = useLeanKeys().has(s.key);
  const drag = useDraggable({
    id: `row:${props.rowId}`,
    data: { session: s, groupKey: props.group.key } satisfies DragData,
  });
  const drop = useDroppable({
    id: `row-drop:${props.rowId}`,
    data: dropZoneOf(props.group, s.key) satisfies DropZone,
  });
  const setRowRef = (node: HTMLElement | null) => {
    drag.setNodeRef(node);
    drop.setNodeRef(node);
  };
  const menuOpen = menu.open;
  const title = displayName(s);
  const activity = sessionActivity(s);
  const topStatus = sessionTopStatus(activity);
  const recede = sessionRecedes(s.status) && !isActive;
  // Account, cwd and tmux pane live in the hover card; the row keeps what tells sessions apart.
  const terminalHeld = s.owner === "terminal" && s.status !== "closed";
  // A pinned session's row in its Group carries a pin; in 고정됨 the folder already says it. A row in
  // 보관함 has none: the pin is kept for the way out but is not in force there.
  const pinMark = s.pinPosition != null && (props.group.kind === "project" || props.group.kind === "unassigned");

  const rowSurfaceClassName = cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    isActive
      ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
      : recede
        ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
    props.dropTarget && !isActive && "bg-sidebar-row-hover",
    drag.isDragging && "opacity-40",
  );

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    props.onSelect();
  };

  return (
    <SidebarMenuItem
      data-session-item={s.key}
      className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_--spacing(9)]"
    >
      {props.dropLine ? (
        // T3's sidebar drop indicator: a line where the dragged row will land.
        <span
          aria-hidden
          data-drop-line={props.dropLine}
          className={cn(
            "pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-primary",
            props.dropLine === "before" ? "-top-px" : "-bottom-px",
          )}
        />
      ) : null}
      <Tooltip disabled={props.dragActive}>
        <TooltipTrigger
          render={
            <div
              ref={setRowRef}
              {...drag.listeners}
              role="button"
              tabIndex={0}
              aria-label={`${title}, ${ACTIVITY_LABEL[activity]}${pinMark ? ", pinned" : ""}${props.group.kind === "archive" ? ", archived" : ""}${terminalHeld ? ", open in a terminal" : ""}`}
              aria-current={isActive ? "page" : undefined}
              data-testid="sidebar-row-folder"
              // T3's folder row: `ps-9` starts the row past the folder's chevron and icon, so the
              // provider icon begins in the folder name's column. Touch screens show the menu
              // button all the time, so the row leaves room for it.
              className={cn(
                rowSurfaceClassName,
                "flex h-9 items-center gap-2.5 px-2.5 ps-9 pointer-coarse:pe-9",
              )}
              onClick={props.onSelect}
              onKeyDown={handleKeyDown}
              onContextMenu={(event) => {
                event.preventDefault();
                menu.onContextMenu(event);
              }}
            />
          }
        >
          <ProviderIcon
            provider={s.provider}
            className={cn(recede && "opacity-50 grayscale group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0")}
          />
          <span
              dir="auto"
              className={cn(
                "min-w-0 flex-1 truncate text-start text-sm transition-opacity motion-reduce:transition-none",
                recede
                  ? "font-normal text-foreground/75 group-hover/sidebar-row:text-foreground group-focus-visible/sidebar-row:text-foreground"
                  : cn("font-medium", s.status === "error" ? "text-foreground/95" : "text-foreground"),
              )}
            >
              {title}
            </span>
            {pinMark ? (
              // The row's label says it; the icon is the sighted form of the same words.
              <PinIcon aria-hidden className="size-3 shrink-0 text-secondary-label" />
            ) : null}
            {terminalHeld ? (
              // The row's label says it; the icon is the sighted form of the same words.
              <TerminalIcon aria-hidden className="size-3 shrink-0 text-secondary-label" />
            ) : null}
            {leanOpen ? <span aria-hidden className="w-6 shrink-0" /> : null}
            <span
              className={cn(
                "relative ml-auto flex h-6 min-w-6 shrink-0 items-center justify-end",
                // The menu button takes this slot while the row is hovered or the button focused.
                "group-any-hover/menu-item:invisible group-has-[[data-session-action]:focus-visible]/menu-item:invisible",
                menuOpen && "invisible",
              )}
            >
              {topStatus ? (
                // The icon alone carries the status; the row label and the hover card name it.
                <topStatus.icon aria-hidden className={cn("size-3.5 shrink-0", topStatus.className)} />
              ) : null}
            </span>
        </TooltipTrigger>
        <SessionHoverCard session={s} title={title} />
      </Tooltip>
      {/* A sibling over the row's status slot (the row's `px-2.5` from the right, the column of
          the status icons and the folder chevrons), not inside the row's button role. */}
      <span
        className={cn(
          "pointer-events-none absolute top-1.5 right-2.5 flex h-6 items-center opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-any-hover/menu-item:pointer-events-auto group-any-hover/menu-item:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
          menuOpen && "pointer-events-auto opacity-100",
        )}
      >
        <Button
          data-session-action=""
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`${title} menu`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => menu.onButton(event.currentTarget)}
        >
          <MoreHorizontalIcon aria-hidden />
        </Button>
      </span>
      {leanOpen ? (
        // A sibling of the row, like the menu button: a click here brings the lean window forward
        // and does not open the session (the row itself opens it here, as always).
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-lean-open-mark=""
                aria-label={`${title} is open in its own window, bring it forward`}
                className="absolute top-1.5 right-9 flex size-6 cursor-pointer items-center justify-center rounded-md text-secondary-label outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => focusLeanWindow(s.key)}
              />
            }
          >
            <AppWindowIcon aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Open in its own window, click to bring it forward</TooltipPopup>
        </Tooltip>
      ) : null}
    </SidebarMenuItem>
  );
}

// ThreadHoverCard.tsx: ThreadHoverCardPopup and ThreadHoverCard.
function SessionHoverCard({ session: s, title }: { session: SessionSummary; title: string }) {
  const owner = OWNER_LABEL[s.owner];
  const activity = sessionActivity(s);
  const topStatus = sessionTopStatus(activity);
  return (
    <TooltipPopup
      side="right"
      align="start"
      sideOffset={4}
      variant="glass"
      className="max-w-80 text-left whitespace-normal"
    >
      <div className="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
        <div className="min-w-0 truncate text-xs leading-tight font-medium text-foreground">
          {title}
        </div>
        <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
          <div className="flex min-w-0 items-center gap-2">
            {topStatus ? (
              <topStatus.icon className={cn("size-3 shrink-0", topStatus.className)} />
            ) : (
              // Idle or closed: a small dot, since a solid circle now means the main agent at work.
              <span aria-hidden className="flex size-3 shrink-0 items-center justify-center">
                <span className="size-1.5 rounded-full bg-muted-foreground/60" />
              </span>
            )}
            <div className="min-w-0 truncate text-foreground/75">{ACTIVITY_LABEL[activity]}</div>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <FolderCodeIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">{shortPath(s.cwd)}</div>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <ProviderIcon provider={s.provider} className="size-3 grayscale opacity-60" />
            <div className="min-w-0 truncate text-foreground/75">{s.account}</div>
          </div>
          {owner ? (
            <div className="flex min-w-0 items-center gap-2">
              <UserRoundIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">
                {owner === "Terminal" ? "Open in a terminal" : "Open in maru"}
              </div>
            </div>
          ) : null}
          {s.tmuxPane ? (
            <div className="flex min-w-0 items-center gap-2">
              <TerminalIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">tmux {s.tmuxPane}</div>
            </div>
          ) : null}
          <div className="flex min-w-0 items-center gap-2">
            <HashIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 truncate font-mono text-foreground/75">{s.id}</div>
          </div>
        </div>
      </div>
    </TooltipPopup>
  );
}
