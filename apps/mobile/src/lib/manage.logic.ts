// The logic of the Sessions section of the settings sheet (the web's settings/manage/ManagePanel.tsx,
// ManageRows.tsx and ManagePopovers.tsx): what a view of the table holds for the loaded data and
// the user's view, level, filter, sort and page, which actions a row offers and why one is blocked,
// and the texts of the confirmations. The rows, filters, sort, paging and delete rules are the web's
// own (settings/manageModel.ts, imported); this adds what the phone lays out differently. The words
// are English: the interface is moving to English, and new text starts there. React Native-free.
import type { AccountInfo, OrphanSession, SessionSummary, TrashItem, TrashList, UnitRow } from "@maru/shared";
// By path: a node test cannot resolve a value import of @maru/shared from this folder (lib/api.ts).
import { TRASH_THRESHOLD_BYTES } from "../../../../packages/shared/src/sessionManage.ts";
import { relativeTime } from "../../../web/src/model.ts";
import {
  DEFAULT_MANAGE_SORT,
  bulkNoun,
  filterActive,
  inView,
  matchesRow,
  matchesUnit,
  otherViewsHint,
  pageOf,
  rowAccount,
  rowActive,
  rowDeletable,
  rowId,
  rowLocked,
  rowName,
  rowPath,
  rowProvider,
  rowSize,
  rowUpdated,
  sessionLevelRows,
  shortAccount,
  sortRows,
  sortUnits,
  tildePath,
  unitGroupKey,
  unitKindOfView,
  viewCounts,
  viewMatchCounts,
  visibleSelection,
  MANAGE_VIEW_LABEL,
  type ManageFilter,
  type ManageRow,
  type ManageSort,
  type ManageSortKey,
  type ManageView,
  type PageView,
  type UnitLabel,
  type ViewCounts,
} from "../../../web/src/components/settings/manageModel.ts";
import { formatSize, formatWhen } from "../../../web/src/components/settings/parts.logic.ts";

/** Rows per page, as the web's table. */
export const MANAGE_PAGE_SIZE = 100;

// ---- The view: what the table shows for the data and the user's choices ----

export interface ManageInput {
  /** The list's sessions as /ws keeps them. */
  listed: readonly SessionSummary[];
  /** Sessions outside the list and orphans; null until read. */
  candidates: readonly SessionSummary[] | null;
  orphans: readonly OrphanSession[] | null;
  /** Subagent and workflow units of every session; null until read. */
  units: readonly UnitRow[] | null;
  view: ManageView;
  /** A session (`account:id`) whose units a view of units is narrowed to. */
  parent: string | null;
  filter: ManageFilter;
  sort: ManageSort;
  page: number;
  selected: ReadonlySet<string>;
  /** The name a unit shows when it is narrowed to one session (its session-agents title). */
  unitName?: (u: UnitRow) => string | null;
}

export interface ManageViewModel {
  allRows: ManageRow[];
  viewRows: ManageRow[];
  /** The unit kind of the view, or null for a view of sessions. */
  unitKind: "subagent" | "workflow" | null;
  /** The session rows the search and filter leave, sorted, before paging. */
  matchedRows: ManageRow[];
  rowsPage: PageView<ManageRow>;
  unitsPage: PageView<UnitRow>;
  /** The page of the current view. */
  pageView: PageView<ManageRow> | PageView<UnitRow>;
  /** Rows (or units) of the view before the search and filter, and how many they leave. */
  total: number;
  matched: number;
  /** Every view's count from the same whole (null while it is not read). */
  counts: ViewCounts;
  /** The other views that match the search and filter, `No matches here. 3 in Subagents`; null when there is no search, a parent is set, or nothing matches elsewhere. */
  hint: string | null;
  /** Selected rows a delete takes: shown on this page and deletable. */
  selectedRows: ManageRow[];
  /** The deletable rows of this page, for the select-all box. */
  pageSelectable: ManageRow[];
  pageAllSelected: boolean;
  /** Deletable rows under an active search or filter. */
  filteredDeletable: ManageRow[];
  /** Every deletable row (the bulk menu's "delete all except locked"). */
  unlockedAll: ManageRow[];
}

/** The web ManagePanel's derivations for one render, in one place. */
export function manageViewModel(input: ManageInput): ManageViewModel {
  const { filter } = input;
  const allRows = sessionLevelRows(input.listed, input.candidates ?? [], input.orphans ?? []);
  const viewRows = allRows.filter((r) => inView(r, input.view));
  const unitKind = unitKindOfView(input.view);
  const unitRows = input.units ?? [];
  const kindUnits = unitKind ? unitRows.filter((u) => u.kind === unitKind) : [];
  const matchedRows = unitKind ? [] : sortRows(viewRows.filter((r) => matchesRow(r, filter)), input.sort);
  const matchedUnits = unitKind
    ? sortUnits(kindUnits.filter((u) => matchesUnit(u, filter, input.parent, input.unitName)), input.sort, input.unitName)
    : [];
  const rowsPage = pageOf(matchedRows, input.page, MANAGE_PAGE_SIZE);
  const unitsPage = pageOf(matchedUnits, input.page, MANAGE_PAGE_SIZE);
  const shownRows = unitKind ? [] : rowsPage.rows;
  const pageSelectable = shownRows.filter(rowDeletable);
  const queryOrFacet = filterActive(filter);
  const matched = unitKind ? matchedUnits.length : matchedRows.length;
  const total = unitKind ? kindUnits.length : viewRows.length;
  return {
    allRows,
    viewRows,
    unitKind,
    matchedRows,
    rowsPage,
    unitsPage,
    pageView: unitKind ? unitsPage : rowsPage,
    total,
    matched,
    counts: viewCounts(allRows, input.units, input.candidates !== null && input.orphans !== null),
    hint: matched === 0 && total > 0 && input.parent === null && queryOrFacet ? otherViewsHint(input.view, viewMatchCounts(allRows, unitRows, filter)) : null,
    selectedRows: visibleSelection(shownRows, input.selected),
    pageSelectable,
    pageAllSelected: pageSelectable.length > 0 && pageSelectable.every((r) => input.selected.has(r.key)),
    filteredDeletable: !unitKind && queryOrFacet ? matchedRows.filter(rowDeletable) : [],
    unlockedAll: allRows.filter(rowDeletable),
  };
}

/** What the table says when it has no rows. */
export function emptyText(m: Pick<ManageViewModel, "unitKind" | "matched" | "total" | "hint">, s: { unitsRead: boolean; rowsRead: boolean; view: ManageView }): string {
  if (m.matched === 0 && m.total > 0) return m.hint ?? "No matches here";
  if (m.unitKind) return s.unitsRead ? `No ${MANAGE_VIEW_LABEL[s.view].toLowerCase()}` : "Reading units";
  if (!s.rowsRead) return "Reading sessions";
  return s.view === "all" ? "No sessions" : `No ${MANAGE_VIEW_LABEL[s.view].toLowerCase()}${s.view === "locked" ? " sessions" : ""}`;
}

/** The pager's count line: `12 of 80`, with the shown range past one page. */
export function pagerInfo(m: Pick<ManageViewModel, "total" | "matched" | "pageView">, narrowed: boolean): string {
  const pv = m.pageView;
  return `${narrowed ? `${m.matched} of ${m.total}` : `${m.total}`}${pv.pages > 1 ? `, showing ${pv.first}-${pv.last}` : ""}`;
}

// ---- Sort (the web's column heads; the phone picks it in the filter sheet) ----

const SORT_KEYS: readonly { key: ManageSortKey; label: string; first: string; second: string }[] = [
  { key: "ts", label: "Updated", first: "newest first", second: "oldest first" },
  { key: "size", label: "Size", first: "largest first", second: "smallest first" },
  { key: "name", label: "Name", first: "Z to A", second: "A to Z" },
  { key: "account", label: "Account", first: "Z to A", second: "A to Z" },
  { key: "id", label: "ID", first: "Z to A", second: "A to Z" },
];

/** `ts:-1`, the stored form of a sort choice. */
export const sortValue = (s: ManageSort): string => `${s.key}:${s.dir}`;

/** The sort choices: each column both ways, the descending one first (a head's first click). */
export const SORT_OPTIONS: readonly { value: string; label: string }[] = SORT_KEYS.flatMap((k) => [
  { value: sortValue({ key: k.key, dir: -1 }), label: `${k.label}, ${k.first}` },
  { value: sortValue({ key: k.key, dir: 1 }), label: `${k.label}, ${k.second}` },
]);

export function parseSort(value: string): ManageSort {
  const [key, dir] = value.split(":");
  const found = SORT_KEYS.find((k) => k.key === key);
  return found && (dir === "1" || dir === "-1") ? { key: found.key, dir: dir === "1" ? 1 : -1 } : DEFAULT_MANAGE_SORT;
}

// ---- A row's text ----

/** The phone's third line under a session: the account, size and last update (the web table's columns, which fold at this width). */
export function sessionMeta(r: ManageRow, now: number): string {
  return [shortAccount(rowAccount(r)), formatSize(rowSize(r)), relativeTime(rowUpdated(r), now)].join(", ");
}

/** A unit's third line: its account, size and last update. */
export function unitMeta(u: UnitRow, now: number): string {
  return [shortAccount(u.account), formatSize(u.sizeBytes), relativeTime(u.updatedAt, now)].join(", ");
}

export const rowLabel = (r: ManageRow): string => rowName(r) ?? rowId(r);
export const rowFolder = (r: ManageRow): string => tildePath(rowPath(r));

/** Why a row cannot be deleted (or selected for a delete), or null when it can. */
export function deleteBlock(r: ManageRow): string | null {
  if (rowLocked(r)) return "Locked";
  if (rowActive(r)) return r.kind === "orphan" ? "A process is using it" : "In use";
  return null;
}

/** Why a unit cannot be deleted: its session is held. */
export function unitDeleteBlock(u: UnitRow): string | null {
  return u.open ? "Its session is in use" : null;
}

// ---- The row menu ----

export type RowActionId = "open" | "rename" | "copyResume" | "toggleList" | "subagents" | "workflows" | "rehome" | "move" | "delete";

export interface RowAction {
  id: RowActionId;
  label: string;
  /** Beside the label: a count, or the reason the action cannot run now. */
  detail: string | null;
  disabled: boolean;
  destructive: boolean;
}

const IN_USE = "In use";

/**
 * The actions of a row, in the web's menu order (ManageRows.tsx): open, rename, copy the resume
 * command, list membership, the units, working folder, account move, delete. An action that
 * cannot run now keeps its place and says why. `listedKeys` are the sessions the app can open (the
 * list's), `unitCounts` this session's subagents and workflows, `moveTargets` the other accounts of
 * its provider.
 */
export function rowActions(
  r: ManageRow,
  ctx: { listedKeys: ReadonlySet<string>; unitCounts: { subagent: number; workflow: number } | null; moveTargets: number },
): RowAction[] {
  const act = (id: RowActionId, label: string, over: Partial<RowAction> = {}): RowAction => ({ id, label, detail: null, disabled: false, destructive: false, ...over });
  const out: RowAction[] = [];
  const blocked = deleteBlock(r);
  if (r.kind === "session") {
    const active = rowActive(r);
    const movable = !active;
    out.push(act("open", "Open conversation", ctx.listedKeys.has(r.key) ? {} : { disabled: true, detail: "Not in the list" }));
    out.push(act("rename", "Rename"));
    out.push(act("copyResume", "Copy resume command", active ? { disabled: true, detail: IN_USE } : {}));
    out.push(act("toggleList", r.inList ? "Remove from list" : "Add to list"));
    if (ctx.unitCounts?.subagent) out.push(act("subagents", "Show subagents", { detail: String(ctx.unitCounts.subagent) }));
    if (ctx.unitCounts?.workflow) out.push(act("workflows", "Show workflows", { detail: String(ctx.unitCounts.workflow) }));
    if (rowProvider(r) === "claude") out.push(act("rehome", "Change working folder", movable ? {} : { disabled: true, detail: IN_USE }));
    if (ctx.moveTargets > 0) out.push(act("move", "Move to another account", movable ? {} : { disabled: true, detail: IN_USE }));
  }
  out.push(act("delete", r.kind === "orphan" ? "Delete leftover files" : "Delete", { destructive: true, disabled: blocked !== null, detail: blocked }));
  return out;
}

/** The accounts a session can move to: the same provider's other accounts. */
export function moveTargets(r: ManageRow, accounts: readonly AccountInfo[]): AccountInfo[] {
  return accounts.filter((x) => x.provider === rowProvider(r) && x.id !== rowAccount(r));
}

// ---- Confirmations ----

/** The phone's delete confirmation: where the session goes, from its size. */
export function deleteDescription(outcome: "trash" | "purge" | null, bytes: number | null): string {
  if (outcome === "trash") return `Moves it to the trash, ${formatSize(bytes)}`;
  if (outcome === "purge") return `Deleted for good at once, ${formatSize(bytes)}`;
  return `Over ${formatSize(TRASH_THRESHOLD_BYTES)} goes to the trash, otherwise it is deleted for good at once`;
}

export const TRASH_NOTE = `Sessions over ${TRASH_THRESHOLD_BYTES / 1048576} MB go to the trash, the rest are deleted for good at once`;

export interface BulkPlan {
  title: string;
  notes: string[];
  items: ManageRow[];
}

/** "Delete selected": the rows checked on this page. */
export function selectedPlan(rows: ManageRow[]): BulkPlan {
  const noun = bulkNoun(rows);
  return { title: `Delete ${rows.length} ${rows.length === 1 ? noun : `${noun}s`}?`, notes: [], items: rows };
}

/** "Delete filter result": the deletable rows of the search and filter, leaving out held and locked ones. */
export function filteredPlan(matchedRows: readonly ManageRow[], deletable: ManageRow[]): BulkPlan {
  const locked = matchedRows.filter(rowLocked).length;
  const busy = matchedRows.filter((r) => rowActive(r) && !rowLocked(r)).length;
  return {
    title: `Delete ${deletable.length} filtered ${deletable.length === 1 ? bulkNoun(deletable) : `${bulkNoun(deletable)}s`}?`,
    notes: [busy ? `${busy} in use are left out` : "", locked ? `${locked} locked are left out` : ""].filter(Boolean),
    items: deletable,
  };
}

/** "Delete all except locked": every deletable row. */
export function unlockedPlan(allRows: readonly ManageRow[], deletable: ManageRow[]): BulkPlan {
  const locked = allRows.filter(rowLocked).length;
  const busy = allRows.filter((r) => rowActive(r) && !rowLocked(r)).length;
  return {
    title: `Delete all ${deletable.length} unlocked ${deletable.length === 1 ? "session" : "sessions"}?`,
    notes: [locked ? `${locked} locked stay` : "", busy ? `${busy} in use are left out` : ""].filter(Boolean),
    items: deletable,
  };
}

/** The description line of a bulk delete: its notes, and the trash rule when a session is among the items. */
export function bulkDescription(plan: BulkPlan): string {
  return [...plan.notes, ...(plan.items.some((r) => r.kind === "session") ? [TRASH_NOTE] : [])].join(". ");
}

/** A bulk item's name and its second line before the run. */
export function bulkItemLabel(r: ManageRow): string {
  return rowName(r) ?? `${rowId(r).slice(0, 8)} (no transcript)`;
}
export function bulkItemSub(r: ManageRow): string {
  return [shortAccount(rowAccount(r)), formatSize(rowSize(r)), tildePath(rowPath(r))].join(", ");
}

/** The result line of a delete that went through. */
export function deleteDetail(d: { kind: "session"; outcome: "trashed" | "deleted"; sizeBytes: number; threads: number } | { kind: "orphan"; freedBytes: number }): string {
  return d.kind === "orphan"
    ? `Leftovers deleted for good, ${formatSize(d.freedBytes)}`
    : `${d.outcome === "trashed" ? "Moved to the trash" : "Deleted for good"}, ${formatSize(d.sizeBytes)}${d.threads > 1 ? `, ${d.threads} threads` : ""}`;
}

/** The run sheet's progress line. */
export function bulkProgress(done: number, total: number, failed: number, running: boolean): string {
  return running ? `${done} of ${total} done` : `${total - failed} of ${total} succeeded, ${failed} failed`;
}

// ---- Trash ----

/** Count and size of the trash, with the unreadable entries when there are any. */
export function trashSummary(list: TrashList | null): string {
  if (!list) return "Reading";
  return `${list.items.length} items, ${formatSize(list.totalBytes)}${list.unreadable.length ? `, ${list.unreadable.length} unreadable` : ""}`;
}

/** Entries newest first. */
export function trashEntries(list: TrashList | null): TrashItem[] {
  return [...(list?.items ?? [])].sort((a, b) => b.deletedAt - a.deletedAt);
}

/** The second line of a trash entry. */
export function trashMeta(item: TrashItem): string {
  return `${item.account}, ${formatSize(item.sizeBytes)}${item.threads > 1 ? `, ${item.threads} threads` : ""}, deleted ${formatWhen(item.deletedAt)}`;
}

// ---- Units ----

/** A unit's name: the session-agents title when narrowed to its session, else its parent's name. */
export function unitTitle(u: UnitRow, labels: ReadonlyMap<string, UnitLabel> | null): string {
  return labels?.get(u.unitId)?.title ?? u.unitId;
}

export { unitGroupKey };
