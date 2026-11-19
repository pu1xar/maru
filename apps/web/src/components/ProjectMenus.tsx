// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: the project folder and thread menus of components/Sidebar.tsx
// (handleProjectFolderContextMenu) and hooks/useThreadActionMenu.ts, drawn with the ui/menu parts
// the way SnoozeMenuButton in components/sidebar/SidebarThreadRow.tsx and
// components/pullRequest/PullRequestActionsMenu.tsx do. Local change: T3 shows these through its
// native context menu bridge; here one menu per kind opens at a row's button or at the pointer,
// and its items are maru's project actions (DESIGN.md 6c).
import type { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { AccountInfo, Project, SessionSummary } from "@maru/shared";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowDownIcon,
  ArrowRightLeftIcon,
  ArrowUpIcon,
  Columns2Icon,
  FolderCodeIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderOutputIcon,
  ListMinusIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  SquarePenIcon,
  TerminalSquareIcon,
  Trash2Icon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import { useState, type ComponentProps, type MouseEvent as ReactMouseEvent } from "react";

import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "./ui/menu";

type MenuAnchor = NonNullable<ComponentProps<typeof MenuPopup>["anchor"]>;

export interface AnchoredMenu<T> {
  /** The last target; kept after closing so the closing popup keeps its items. */
  state: {
    target: T;
    anchor: MenuAnchor;
    placement: "button" | "pointer";
    /** The button that opened the menu; null for a right-click. */
    button: HTMLElement | null;
  } | null;
  open: boolean;
  /** Opens under `button`, or closes the menu when that button opened it. */
  toggleFromButton: (target: T, button: HTMLElement) => void;
  /** Opens at the pointer for a right-click (at the element when a key opened it). */
  showAtPointer: (target: T, event: ReactMouseEvent<HTMLElement>) => void;
  onOpenChange: (open: boolean, details: MenuPrimitive.Root.ChangeEventDetails) => void;
}

/**
 * One menu shared by many rows: each row opens it for itself instead of mounting its own.
 * The menu has no Menu.Trigger, so it is placed with the popup's `anchor`.
 */
export function useAnchoredMenu<T>(): AnchoredMenu<T> {
  const [state, setState] = useState<AnchoredMenu<T>["state"]>(null);
  const [open, setOpen] = useState(false);
  return {
    state,
    open,
    toggleFromButton: (target, button) => {
      if (open && state?.button === button) {
        setOpen(false);
        return;
      }
      setState({ target, anchor: fixedAnchor(button), placement: "button", button });
      setOpen(true);
    },
    showAtPointer: (target, event) => {
      const element = event.currentTarget;
      const { clientX: x, clientY: y } = event;
      const keyboard = x === 0 && y === 0;
      setState({
        target,
        anchor: keyboard ? fixedAnchor(element) : pointAnchor(x, y, element),
        placement: keyboard ? "button" : "pointer",
        button: null,
      });
      setOpen(true);
    },
    onOpenChange: (next, details) => {
      if (next) return;
      // A press on the opening button counts as outside the popup; its click toggles the menu,
      // so closing here too would reopen it at once.
      const button = state?.button;
      if (button && open && pressedWithin(details, button)) {
        details.cancel();
        return;
      }
      setOpen(false);
    },
  };
}

function pressedWithin(details: MenuPrimitive.Root.ChangeEventDetails, element: Element): boolean {
  const event: Event | undefined = details.event;
  const node =
    details.reason === "focus-out" && event instanceof FocusEvent
      ? event.relatedTarget
      : details.reason === "outside-press"
        ? event?.target
        : null;
  return node instanceof Node && element.contains(node);
}

/**
 * The element's box at opening time. Rows re-sort as sessions update, so a live anchor would
 * carry the open menu to another place under the pointer.
 */
function fixedAnchor(element: Element): MenuAnchor {
  const rect = element.getBoundingClientRect();
  return { getBoundingClientRect: () => rect, contextElement: element };
}

function pointAnchor(x: number, y: number, element: Element): MenuAnchor {
  const rect = DOMRect.fromRect({ x, y, width: 0, height: 0 });
  return { getBoundingClientRect: () => rect, contextElement: element };
}

/** Where an anchored menu opens: under its button, or at the pointer for a right-click. */
export function popupPosition(placement: "button" | "pointer") {
  return placement === "pointer"
    ? ({ side: "bottom", align: "start", sideOffset: 2 } as const)
    : ({ side: "bottom", align: "end", sideOffset: 4 } as const);
}

/**
 * A session row's menu: pin (T3's Pin thread, first like T3's thread menu), rename, Group, the
 * dashboard's session management (resume command, account move, working folder; DESIGN.md 6a),
 * take it off the list. A session in the list is locked against deletion, so taking it off the
 * list is what unlocks it; its files are deleted from Settings > Sessions.
 */
export function SessionActionMenu(props: {
  menu: AnchoredMenu<SessionSummary>;
  /** The menu's session with its current values (the target can change while the menu is open). */
  session: SessionSummary | null;
  /** In display order. */
  projects: readonly Project[];
  onSetPinned: (session: SessionSummary, pinned: boolean) => void;
  /** Move to 보관함 (true) or take out of it (false). */
  onArchive: (session: SessionSummary, archived: boolean) => void;
  onAssign: (session: SessionSummary, projectId: string | null) => void;
  onRemoveFromList: (session: SessionSummary) => void;
  onRename: (session: SessionSummary) => void;
  /** Every account, for the account move. */
  accounts: readonly AccountInfo[];
  onCopyResume: (session: SessionSummary) => void;
  onMoveAccount: (session: SessionSummary, to: string) => void;
  onRehome: (session: SessionSummary) => void;
}) {
  const { menu, session, projects, onAssign, onRemoveFromList, onRename } = props;
  const otherAccounts = session
    ? props.accounts.filter((a) => a.provider === session.provider && a.id !== session.account)
    : [];
  const state = menu.state;
  // Same rule as the sidebar folders: a project the list does not know counts as 미분류.
  const current =
    session?.projectId != null && projects.some((p) => p.id === session.projectId)
      ? session.projectId
      : null;
  const pinned = session?.pinPosition != null;
  const archived = session?.archivedAt != null;

  return (
    <Menu open={menu.open} onOpenChange={menu.onOpenChange}>
      {state && session ? (
        <MenuPopup
          aria-label="Session menu"
          anchor={state.anchor}
          {...popupPosition(state.placement)}
          className="min-w-48"
        >
          {archived ? (
            // In 보관함 the session has no pin or Group of its own to change; coming out is the
            // first thing to do there.
            <MenuItem onClick={() => props.onArchive(session, false)}>
              <ArchiveRestoreIcon />
              Unarchive
            </MenuItem>
          ) : (
            <MenuItem onClick={() => props.onSetPinned(session, !pinned)}>
              {pinned ? <PinOffIcon /> : <PinIcon />}
              {pinned ? "Unpin" : "Pin"}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem onClick={() => onRename(session)}>
            <PencilIcon />
            Rename
          </MenuItem>
          {archived ? null : (
          <MenuSub>
            <MenuSubTrigger>
              <FolderInputIcon />
              Move to group
            </MenuSubTrigger>
            <MenuSubPopup aria-label="Groups to move to" className="min-w-48">
              {projects.length === 0 ? (
                <MenuItem disabled>No groups</MenuItem>
              ) : (
                <MenuRadioGroup
                  value={current ?? ""}
                  onValueChange={(next) => {
                    if (typeof next === "string" && next !== current) onAssign(session, next);
                  }}
                >
                  {projects.map((p) => (
                    <MenuRadioItem key={p.id} value={p.id} closeOnClick>
                      <span className="flex w-full min-w-0 items-center gap-2">
                        <FolderCodeIcon aria-hidden className="size-3.5 text-muted-foreground" />
                        <MenuItemLabel>{p.name}</MenuItemLabel>
                        <MenuRadioItemIndicator className="ms-auto" />
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              )}
              <MenuSeparator />
              <MenuItem disabled={current === null} onClick={() => onAssign(session, null)}>
                <FolderOutputIcon />
                Move to Unsorted
              </MenuItem>
            </MenuSubPopup>
          </MenuSub>
          )}
          <MenuSeparator />
          <MenuItem onClick={() => props.onCopyResume(session)}>
            <TerminalSquareIcon />
            Copy resume command
          </MenuItem>
          <MenuSub>
            <MenuSubTrigger disabled={otherAccounts.length === 0}>
              <ArrowRightLeftIcon />
              Move to another account
            </MenuSubTrigger>
            <MenuSubPopup aria-label="Accounts to move to" className="min-w-48">
              {otherAccounts.map((a) => (
                <MenuItem key={a.id} onClick={() => props.onMoveAccount(session, a.id)}>
                  <UserRoundIcon />
                  {a.id}
                </MenuItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
          {session.provider === "claude" ? (
            <MenuItem onClick={() => props.onRehome(session)}>
              <FolderOpenIcon />
              Change working folder
            </MenuItem>
          ) : null}
          <MenuSeparator />
          {archived ? null : (
            <MenuItem onClick={() => props.onArchive(session, true)}>
              <ArchiveIcon />
              Move to archive
            </MenuItem>
          )}
          <MenuItem onClick={() => onRemoveFromList(session)}>
            <ListMinusIcon />
            Remove from list
          </MenuItem>
        </MenuPopup>
      ) : null}
    </Menu>
  );
}

/** A project folder's menu: a new session in it, rename, order and delete. */
export function ProjectActionMenu(props: {
  menu: AnchoredMenu<Project>;
  /** The menu's project with its current values. */
  project: Project | null;
  /** Every project id in the order the next move starts from. */
  order: readonly string[];
  onRename: (project: Project) => void;
  onNewSession: (project: Project) => void;
  onMove: (project: Project, delta: -1 | 1) => void;
  onDelete: (project: Project) => void;
}) {
  const { menu, project, order } = props;
  const state = menu.state;
  const index = project ? order.indexOf(project.id) : -1;

  return (
    <Menu open={menu.open} onOpenChange={menu.onOpenChange}>
      {state && project ? (
        <MenuPopup
          aria-label="Group menu"
          anchor={state.anchor}
          {...popupPosition(state.placement)}
          className="min-w-48"
        >
          <MenuItem onClick={() => props.onNewSession(project)}>
            <SquarePenIcon />
            New session in this group
          </MenuItem>
          <MenuItem onClick={() => props.onRename(project)}>
            <PencilIcon />
            Rename
          </MenuItem>
          <MenuSeparator />
          <MenuItem disabled={index <= 0} onClick={() => props.onMove(project, -1)}>
            <ArrowUpIcon />
            Move up
          </MenuItem>
          <MenuItem
            disabled={index < 0 || index >= order.length - 1}
            onClick={() => props.onMove(project, 1)}
          >
            <ArrowDownIcon />
            Move down
          </MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={() => props.onDelete(project)}>
            <Trash2Icon />
            Delete
          </MenuItem>
        </MenuPopup>
      ) : null}
    </Menu>
  );
}

/**
 * A shell's menu (DESIGN.md 6s), shared by the terminal screen's tabs and the sidebar's terminal
 * rows: open it as a pane of the split view, or end it. Ending asks nothing, as a tab's close
 * button does not.
 */
export function ShellActionMenu(props: {
  menu: AnchoredMenu<string>;
  onOpenInSplit: (shellId: string) => void;
  onEnd: (shellId: string) => void;
}) {
  const { menu } = props;
  const state = menu.state;
  return (
    <Menu open={menu.open} onOpenChange={menu.onOpenChange}>
      {state ? (
        <MenuPopup aria-label="Shell menu" anchor={state.anchor} {...popupPosition(state.placement)} className="min-w-52">
          <MenuItem onClick={() => props.onOpenInSplit(state.target)}>
            <Columns2Icon />
            Open in split view
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => props.onEnd(state.target)}>
            <XIcon />
            End shell
          </MenuItem>
        </MenuPopup>
      ) : null}
    </Menu>
  );
}
