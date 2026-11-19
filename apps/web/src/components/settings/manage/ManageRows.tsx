// The rows of the session management table. What a row holds and does follows the
// an earlier dashboard's MANAGE table (the earlier dashboard MANAGE_HTML: render() and unitRowHtml()): the
// selection, the account, the name over its folder, the short id, size, last update, and the
// session's actions. The look is T3's settings table (DiagnosticsSettings: cell padding, row
// dividers, right-aligned mono numbers) and its archived-thread rows (ArchivedThreadsPanel: the
// same buttons at the same place on every row). Local change: every action is in the row's ⋮ menu
// (open, rename, resume command, list, subagents and workflows, folder, account move, delete),
// the delete button stays in a fixed slot beside it, a lock mark by the name of a session in the
// sidebar list (the list is the lock, DESIGN.md 6), and a button that cannot run
// keeps its slot with the reason in its tooltip. The name is a button that opens the conversation
// (F2 or the row menu renames). Columns hide by the table's own width (the `manage` container in
// ManagePanel), since the settings menu and the session sidebar take part of the window. A row
// carries no status mark (running, waiting, error, open, closed; user request 2026-11-18): what a
// session is doing is the sidebar's to show, and a blocked action says why in its own tooltip.
import type { AccountInfo, SessionSummary, UnitRow } from "@maru/shared";
import {
  ArrowRightLeftIcon,
  CopyIcon,
  FolderInputIcon,
  ListFilterIcon,
  ListMinusIcon,
  ListPlusIcon,
  LockIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WorkflowIcon,
  BotIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { relativeTime } from "~/model";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Menu, MenuItem, MenuItemDetail, MenuPopup, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger, MenuTrigger } from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  rowAccount,
  rowActive,
  rowId,
  rowLocked,
  rowName,
  rowPath,
  rowProvider,
  rowSize,
  rowUpdated,
  shortAccount,
  tildePath,
  type ManageRow,
  type UnitLabel,
} from "../manageModel";
import { ProviderIcon, formatSize, formatWhen } from "../parts";
import { plural } from "../../../lib/plural.ts";

/** T3's table cell: `px-3 py-2`; the first and last cells line up with the toolbar above. */
export const CELL = "px-3 py-2 align-middle text-xs";
export const FIRST_CELL = "pl-3 sm:pl-4";
export const LAST_CELL = "pr-3 sm:pr-4";
/**
 * Columns leave as the table (container `manage`) narrows, so the name keeps about 12rem: the id
 * below 45rem, the last update below 39rem (the account column narrows there too), the size below
 * 33rem.
 */
export const HIDE_ID = "@max-[45rem]/manage:hidden";
export const HIDE_TS = "@max-[39rem]/manage:hidden";
export const HIDE_SIZE = "@max-[33rem]/manage:hidden";
/** Below 28rem the fixed buttons fold into the row menu, which holds them too. */
const HIDE_TIGHT = "@max-[28rem]/manage:hidden";
export const ROW = "hover:bg-muted/20 data-[state=selected]:bg-muted/40";

/** A folder with its start cut off when it does not fit, never its end. */
function FolderLine({ path }: { path: string }) {
  return (
    <div title={path} className="truncate text-left text-xs text-muted-foreground [direction:rtl]">
      <bdi dir="ltr">{path}</bdi>
    </div>
  );
}

/**
 * A fixed action slot. A blocked action keeps its place and its pointer events, so the reason
 * shows on hover; the click does nothing.
 */
function Act(props: {
  label: string;
  /** The tooltip, when it differs from the label (a toggle's label names it; its tip, the next step). */
  tip?: string;
  blocked?: string | null;
  destructive?: boolean;
  pressed?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const blocked = props.blocked ?? null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant={props.destructive ? "ghost-destructive" : "ghost-muted"}
            aria-label={props.label}
            aria-pressed={props.pressed}
            aria-disabled={blocked ? true : undefined}
            className={props.className}
            onClick={() => {
              if (!blocked) props.onClick();
            }}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{blocked ? `${props.label}: ${blocked}` : (props.tip ?? props.label)}</TooltipPopup>
    </Tooltip>
  );
}

/** A small lock beside a name: a session in the sidebar list, or a unit whose session is in it. */
function LockMark() {
  return (
    <span role="img" aria-label="Locked" className="shrink-0">
      <LockIcon aria-hidden className="size-3 text-warning-foreground" />
    </span>
  )
}

/** The selection box; a row a delete cannot take shows a disabled box with the reason. */
function SelectBox(props: { label: string; checked: boolean; blocked: string | null; onChange: (on: boolean) => void }) {
  if (!props.blocked) {
    return <Checkbox aria-label={props.label} checked={props.checked} onCheckedChange={(on) => props.onChange(on)} />;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex align-middle" />}>
        <Checkbox aria-label={`${props.label}, ${props.blocked}`} checked={false} disabled />
      </TooltipTrigger>
      <TooltipPopup side="top">{props.blocked}</TooltipPopup>
    </Tooltip>
  );
}

export interface SessionRowActions {
  onOpen: () => void;
  onRename: (name: string) => Promise<void>;
  onToggleList: () => void;
  onCopyResume: () => void;
  onMove: (to: string) => void;
  onRehome: () => void;
  onDelete: () => void;
  /** This session's subagents and workflows, by kind; null when it has none. */
  units: { subagent: number; workflow: number } | null;
  onShowUnits: (kind: "subagent" | "workflow") => void;
}

/** Why a session's move, folder change or resume command cannot run now. */
const OPEN_REASON = "Open";

/** Why a row cannot be deleted (or selected for a delete), or null when it can. */
export function deleteBlock(r: ManageRow): string | null {
  if (rowLocked(r)) return "Locked";
  if (rowActive(r)) return r.kind === "orphan" ? "In use by a process" : "Open";
  return null;
}

export function SessionRowView(props: {
  row: ManageRow;
  now: number;
  selected: boolean;
  onSelect: (on: boolean) => void;
  accounts: readonly AccountInfo[];
  actions: SessionRowActions;
}) {
  const { row: r, actions: a } = props;
  const provider = rowProvider(r);
  const account = rowAccount(r);
  const id = rowId(r);
  const active = rowActive(r);
  const locked = rowLocked(r);
  const orphan = r.kind === "orphan";
  const session = r.kind === "session" ? r.session : null;
  const inList = r.kind === "session" && r.inList;
  const movable = !active && !orphan;
  const targets = props.accounts.filter((x) => x.provider === provider && x.id !== account);
  const path = tildePath(rowPath(r));
  const name = rowName(r);
  const blocked = deleteBlock(r);

  // A click on the name opens the conversation at once; F2 and the row menu rename it.
  const [editing, setEditing] = useState(false);
  const startRename = () => {
    if (session) setEditing(true);
  };
  // A rename ended by a key hands focus back to the name; one ended by a click elsewhere leaves it
  // where the click put it.
  const nameButton = useRef<HTMLButtonElement>(null);
  const refocusName = useRef(false);
  useEffect(() => {
    if (!editing && refocusName.current) {
      refocusName.current = false;
      nameButton.current?.focus();
    }
  }, [editing]);
  // From the menu, the rename box opens once the menu has closed, and the menu then keeps focus
  // where the box put it: handing focus back to its trigger would blur the box and cancel it.
  const renameAfterMenu = useRef(false);
  // Likewise for the folder dialog: it autofocuses its path field, which the menu must not take back.
  const dialogAfterMenu = useRef(false);

  const label = name ?? id;
  return (
    <tr data-manage-row={r.key} data-state={props.selected ? "selected" : undefined} className={ROW}>
      <td className={cn(CELL, FIRST_CELL, "pr-0")}>
        <SelectBox label={`Select ${label}`} checked={props.selected} blocked={blocked} onChange={props.onSelect} />
      </td>
      <td className={CELL}>
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground" title={account}>
          <ProviderIcon provider={provider} />
          <span className="truncate">{shortAccount(account)}</span>
        </span>
      </td>
      <td className={CELL}>
        {editing && session ? (
          <InlineName
            initial={session.name ?? ""}
            onDone={async (next, byKey) => {
              refocusName.current = byKey;
              setEditing(false);
              if (next !== null && next.trim() && next.trim() !== (session.name ?? "")) await a.onRename(next.trim());
            }}
          />
        ) : orphan ? (
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning-foreground" />
            <span className="truncate">no transcript</span>
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            <button
              ref={nameButton}
              type="button"
              title={name ?? undefined}
              onClick={() => a.onOpen()}
              onKeyDown={(e) => {
                if (e.key === "F2") {
                  e.preventDefault();
                  startRename();
                }
              }}
              className="min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {name}
            </button>
            {locked ? <LockMark /> : null}
          </span>
        )}
        <FolderLine path={path} />
      </td>
      <td className={cn(CELL, HIDE_ID, "font-mono text-muted-foreground")}>
        <span className="block truncate" title={id}>
          {id.slice(0, 8)}
        </span>
      </td>
      <td className={cn(CELL, HIDE_SIZE, "text-right font-mono whitespace-nowrap text-muted-foreground tabular-nums")}>
        {formatSize(rowSize(r))}
      </td>
      <td className={cn(CELL, HIDE_TS, "whitespace-nowrap text-muted-foreground tabular-nums")} title={formatWhen(rowUpdated(r))}>
        {relativeTime(rowUpdated(r), props.now)}
      </td>
      <td className={cn(CELL, LAST_CELL)}>
        <div className="flex items-center justify-end gap-1">
          <Act className={HIDE_TIGHT} label={orphan ? "Delete leftover files permanently" : "Delete"} blocked={blocked} destructive onClick={a.onDelete}>
            <Trash2Icon />
          </Act>
          <Menu
            onOpenChange={(open) => {
              if (open) {
                renameAfterMenu.current = false;
                dialogAfterMenu.current = false;
              }
            }}
            onOpenChangeComplete={(open) => {
              if (!open && renameAfterMenu.current) startRename();
            }}
          >
            <Tooltip>
              <TooltipTrigger render={<MenuTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label={`${label} actions`} />} />}>
                <MoreHorizontalIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">Actions</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end" className="min-w-52" finalFocus={() => !renameAfterMenu.current && !dialogAfterMenu.current}>
              {session ? (
                <>
                  <MenuItem onClick={a.onOpen}>
                    <MessageSquareIcon />
                    Open conversation
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      renameAfterMenu.current = true;
                    }}
                  >
                    <PencilIcon />
                    Rename
                  </MenuItem>
                  <MenuItem disabled={active} onClick={a.onCopyResume}>
                    <CopyIcon />
                    Copy resume command
                    {active ? <MenuItemDetail>{OPEN_REASON}</MenuItemDetail> : null}
                  </MenuItem>
                  <MenuItem onClick={a.onToggleList}>
                    {inList ? <ListMinusIcon /> : <ListPlusIcon />}
                    {inList ? "Remove from list" : "Add to list"}
                  </MenuItem>
                  {a.units?.subagent ? (
                    <MenuItem onClick={() => a.onShowUnits("subagent")}>
                      <BotIcon />
                      View subagents
                      <MenuItemDetail>{a.units.subagent}</MenuItemDetail>
                    </MenuItem>
                  ) : null}
                  {a.units?.workflow ? (
                    <MenuItem onClick={() => a.onShowUnits("workflow")}>
                      <WorkflowIcon />
                      View workflows
                      <MenuItemDetail>{a.units.workflow}</MenuItemDetail>
                    </MenuItem>
                  ) : null}
                  {provider === "claude" ? (
                    <MenuItem
                      disabled={!movable}
                      onClick={() => {
                        dialogAfterMenu.current = true;
                        a.onRehome();
                      }}
                    >
                      <FolderInputIcon />
                      Change working folder
                      {movable ? null : <MenuItemDetail>{OPEN_REASON}</MenuItemDetail>}
                    </MenuItem>
                  ) : null}
                  {targets.length ? (
                    <MenuSub>
                      <MenuSubTrigger disabled={!movable}>
                        <ArrowRightLeftIcon />
                        Move to another account
                        {movable ? null : <MenuItemDetail>{OPEN_REASON}</MenuItemDetail>}
                      </MenuSubTrigger>
                      <MenuSubPopup className="min-w-40">
                        {targets.map((t) => (
                          <MenuItem key={t.id} onClick={() => a.onMove(t.id)}>
                            {shortAccount(t.id)}
                            <MenuItemDetail>{t.id}</MenuItemDetail>
                          </MenuItem>
                        ))}
                      </MenuSubPopup>
                    </MenuSub>
                  ) : null}
                  <MenuSeparator />
                </>
              ) : null}
              <MenuItem variant="destructive" disabled={blocked !== null} onClick={a.onDelete}>
                <Trash2Icon />
                {orphan ? "Delete leftover files permanently" : "Delete"}
                {blocked ? <MenuItemDetail>{blocked}</MenuItemDetail> : null}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </td>
    </tr>
  );
}

/**
 * Rename in place: Enter saves, Escape or leaving the box cancels (the dashboard's way).
 * `byKey` tells a key from a click elsewhere, which has focus going somewhere of its own.
 */
function InlineName({ initial, onDone }: { initial: string; onDone: (name: string | null, byKey: boolean) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (next: string | null, byKey: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(next, byKey);
  };
  return (
    <input
      autoFocus
      aria-label="New name"
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(value, true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null, true);
        }
      }}
      onBlur={() => finish(null, false)}
      className="h-6 w-full rounded-md border border-ring bg-background px-1.5 text-sm text-foreground outline-none"
    />
  );
}

export type { UnitLabel };

/**
 * A subagent or workflow unit (unitRowHtml). Across sessions the row names its parent session (a
 * button that narrows the table to that session's units); narrowed to one session, the banner
 * names the parent and the row names the unit itself.
 */
export function UnitRowView(props: {
  unit: UnitRow;
  now: number;
  parentName: string;
  parentPath: string | null;
  /** Set when the table is narrowed to this unit's session. */
  label: UnitLabel | null | undefined;
  narrowed: boolean;
  onFilterParent: () => void;
  onOpenParent: (() => void) | null;
  onDelete: () => void;
}) {
  const u = props.unit;
  const sub = props.parentPath ? tildePath(props.parentPath) : u.enc;
  const blocked = u.open ? "Session is open" : null;
  return (
    <tr data-manage-unit={`${u.account}:${u.id}:${u.unitId}`} className={ROW}>
      <td className={cn(CELL, FIRST_CELL)}>
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground" title={u.account}>
          <ProviderIcon provider="claude" />
          <span className="truncate">{shortAccount(u.account)}</span>
        </span>
      </td>
      <td className={CELL}>
        {props.narrowed ? (
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-sm font-medium text-foreground" title={props.label?.title ?? u.unitId}>
                {props.label?.title ?? u.unitId}
              </span>
              {u.locked ? <LockMark /> : null}
            </span>
            <div className="truncate text-xs text-muted-foreground">{props.label?.detail ?? u.kind}</div>
          </>
        ) : (
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                title={props.parentName}
                onClick={props.onFilterParent}
                className="min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {props.parentName}
              </button>
              {u.locked ? <LockMark /> : null}
            </span>
            <FolderLine path={sub} />
          </>
        )}
      </td>
      <td className={cn(CELL, HIDE_ID, "font-mono text-muted-foreground")}>
        <span title={u.unitId} className="block truncate">
          {u.unitId}
        </span>
      </td>
      <td className={cn(CELL, HIDE_SIZE, "text-right font-mono whitespace-nowrap text-muted-foreground tabular-nums")} title={plural(u.files, "file")}>
        {formatSize(u.sizeBytes)}
      </td>
      <td className={cn(CELL, HIDE_TS, "whitespace-nowrap text-muted-foreground tabular-nums")} title={formatWhen(u.updatedAt)}>
        {relativeTime(u.updatedAt, props.now)}
      </td>
      <td className={cn(CELL, LAST_CELL)}>
        <div className="flex items-center justify-end gap-1">
          <Act className={HIDE_TIGHT} label="Delete permanently" blocked={blocked} destructive onClick={props.onDelete}>
            <Trash2Icon />
          </Act>
          <Menu>
            <Tooltip>
              <TooltipTrigger render={<MenuTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label={`${u.kind} ${u.unitId} actions`} />} />}>
                <MoreHorizontalIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">Actions</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end" className="min-w-52">
              <MenuItem onClick={props.onFilterParent}>
                <ListFilterIcon />
                {props.narrowed ? "View units of all sessions" : `View only ${u.kind}s of this session`}
              </MenuItem>
              {props.onOpenParent ? (
                <MenuItem onClick={props.onOpenParent}>
                  <MessageSquareIcon />
                  Open parent conversation
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem variant="destructive" disabled={blocked !== null} onClick={props.onDelete}>
                <Trash2Icon />
                Delete permanently
                {blocked ? <MenuItemDetail>{blocked}</MenuItemDetail> : null}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </td>
    </tr>
  );
}
