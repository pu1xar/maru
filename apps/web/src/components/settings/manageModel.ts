// Logic behind the settings screen's session management, after the an earlier dashboard's MANAGE table
// (the earlier dashboard MANAGE_HTML): the rows of the table (sessions in and outside the list, orphans,
// subagent and workflow units), their views, filters and order, the size slider's scale, paging,
// and a sequential runner for bulk writes.
import type { OrphanSession, ProviderId, SessionAgentsResponse, SessionSummary, UnitKind, UnitRow } from "@maru/shared";
import { TRASH_THRESHOLD_BYTES } from "@maru/shared";

import { displayName, shortAccount } from "../../model.ts";
import { plural } from "../../lib/plural.ts";

// The settings table and its tests read the account label from here; model.ts holds the one rule.
export { shortAccount };

// ---- Rows of the session level ----

/**
 * The one row of views the table switches between. `all`, `locked` and `orphans` list sessions
 * (`locked` the ones locked against deletion, `orphans` the leftovers whose transcript is gone);
 * `subagents` and `workflows` list units.
 */
export type ManageView = "all" | "locked" | "subagents" | "workflows" | "orphans";

export const MANAGE_VIEWS: readonly ManageView[] = ["all", "locked", "subagents", "workflows", "orphans"];

export const MANAGE_VIEW_LABEL: Record<ManageView, string> = {
  all: "All",
  locked: "Locked",
  subagents: "Subagents",
  workflows: "Workflows",
  orphans: "Orphans",
};

export const DEFAULT_MANAGE_VIEW: ManageView = "all";

/** The unit kind a view lists, or null for a view of sessions. */
export function unitKindOfView(view: ManageView): UnitKind | null {
  return view === "subagents" ? "subagent" : view === "workflows" ? "workflow" : null;
}

/**
 * The view for what an earlier build stored: its two choices (`maru_manage_view` locked or current,
 * `maru_manage_level` l2, l3 or l45) become one. A value of the current form stays; anything else is `all`.
 */
export function migrateManageView(view: string | null, level: string | null): ManageView {
  if (view !== null && (MANAGE_VIEWS as readonly string[]).includes(view)) return view as ManageView;
  if (view === "current") return level === "l3" ? "subagents" : level === "l45" ? "workflows" : "all";
  return DEFAULT_MANAGE_VIEW;
}

/** A count per view; null while what it counts is not read yet. */
export type ViewCounts = Record<ManageView, number | null>;

/**
 * Every view's count, from the same whole: all the sessions and orphans, all the units. `rowsRead`
 * is false until the sessions outside the list and the orphans are read, `units` null until the units are.
 */
export function viewCounts(rows: readonly ManageRow[], units: readonly UnitRow[] | null, rowsRead: boolean): ViewCounts {
  const n = (view: ManageView) => (rowsRead ? rows.filter((r) => inView(r, view)).length : null);
  const u = (kind: UnitKind) => (units ? units.filter((x) => x.kind === kind).length : null);
  return { all: n("all"), locked: n("locked"), subagents: u("subagent"), workflows: u("workflow"), orphans: n("orphans") };
}

/**
 * How many items each view holds under the search and filter, parent narrowing aside: what the
 * empty-result hint points at.
 */
export function viewMatchCounts(rows: readonly ManageRow[], units: readonly UnitRow[], f: ManageFilter): Record<ManageView, number> {
  const rowsIn = (view: ManageView) => rows.filter((r) => inView(r, view) && matchesRow(r, f)).length;
  const unitsOf = (kind: UnitKind) => units.filter((u) => u.kind === kind && matchesUnit(u, f, null)).length;
  return { all: rowsIn("all"), locked: rowsIn("locked"), subagents: unitsOf("subagent"), workflows: unitsOf("workflow"), orphans: rowsIn("orphans") };
}

/** `No matches here. 3 in Subagents` for the other views that do match, or null when none does. */
export function otherViewsHint(view: ManageView, counts: Record<ManageView, number>): string | null {
  const others = MANAGE_VIEWS.filter((v) => v !== view && counts[v] > 0).map((v) => `${counts[v]} in ${MANAGE_VIEW_LABEL[v]}`);
  return others.length ? `No matches here. ${others.join(", ")}` : null;
}

/** What a delete of these rows calls them: orphans are leftover files, not sessions. */
export function bulkNoun(rows: readonly ManageRow[]): "session" | "orphan" {
  return rows.length > 0 && rows.every((r) => r.kind === "orphan") ? "orphan" : "session";
}

/**
 * A row of the session level: a session (in the user's list or not), or an orphan (leftovers whose
 * session is gone, shown with a warning mark as the dashboard showed them).
 */
export type ManageRow =
  | { kind: "session"; key: string; session: SessionSummary; inList: boolean }
  | { kind: "orphan"; key: string; orphan: OrphanSession };

/**
 * Top-level sessions in the list and outside it, one row per key (the listed copy wins: /ws keeps
 * it current), then the orphans. Subagent threads (`parentKey`) stay with their parent.
 */
export function sessionLevelRows(
  listed: Iterable<SessionSummary>,
  candidates: Iterable<SessionSummary>,
  orphans: Iterable<OrphanSession>,
): ManageRow[] {
  const rows = new Map<string, ManageRow>();
  for (const s of listed) if (!s.parentKey) rows.set(s.key, { kind: "session", key: s.key, session: s, inList: true });
  for (const s of candidates) {
    if (!s.parentKey && !rows.has(s.key)) rows.set(s.key, { kind: "session", key: s.key, session: s, inList: false });
  }
  for (const o of orphans) {
    const key = `orphan:${o.provider}:${o.account}:${o.id}`;
    rows.set(key, { kind: "orphan", key, orphan: o });
  }
  return [...rows.values()];
}

export const rowProvider = (r: ManageRow): ProviderId => (r.kind === "session" ? r.session.provider : r.orphan.provider);
export const rowAccount = (r: ManageRow): string => (r.kind === "session" ? r.session.account : r.orphan.account);
export const rowId = (r: ManageRow): string => (r.kind === "session" ? r.session.id : r.orphan.id);
/** The session's name as the list shows it; an orphan has none. */
export const rowName = (r: ManageRow): string | null => (r.kind === "session" ? displayName(r.session) : null);
/** The working folder, or the orphan's first leftover path. */
export const rowPath = (r: ManageRow): string | null => (r.kind === "session" ? r.session.cwd : (r.orphan.paths[0] ?? null));
export const rowSize = (r: ManageRow): number | null => (r.kind === "session" ? r.session.sizeBytes : r.orphan.sizeBytes);
export const rowUpdated = (r: ManageRow): number => (r.kind === "session" ? r.session.updatedAt : r.orphan.updatedAt);
export const rowLocked = (r: ManageRow): boolean => (r.kind === "session" ? r.session.locked === true : r.orphan.locked);
/** A process holds it: a session that is not closed, an orphan whose id a live process registered. */
export const rowActive = (r: ManageRow): boolean => (r.kind === "session" ? r.session.status !== "closed" : r.orphan.open);
/** What a delete may take: the server refuses locked and held sessions. */
export const rowDeletable = (r: ManageRow): boolean => !rowLocked(r) && !rowActive(r);

/** Whether a session-level row belongs to a view of sessions (a view of units holds none). */
export function inView(r: ManageRow, view: ManageView): boolean {
  switch (view) {
    case "all":
      return true;
    case "locked":
      return rowLocked(r);
    case "orphans":
      return r.kind === "orphan";
    default:
      return false;
  }
}

/**
 * The selected rows a delete takes: those shown on the page and deletable. A row the search, a
 * facet or the page hides is not taken, and `pruneSelection` drops it from the selection.
 */
export function visibleSelection(shown: readonly ManageRow[], selected: ReadonlySet<string>): ManageRow[] {
  return shown.filter((r) => selected.has(r.key) && rowDeletable(r));
}

/**
 * The selection kept to the `shown` rows; null when nothing is dropped, so state need not change.
 * A key no row has right now (`known` lacks it: a session that left the list and is read back from
 * the candidates a moment later) stays, uncounted, rather than being dropped for a missing row.
 */
export function pruneSelection(selected: ReadonlySet<string>, shown: readonly ManageRow[], known: ReadonlySet<string>): Set<string> | null {
  const visible = new Set(visibleSelection(shown, selected).map((r) => r.key));
  const keep = new Set([...selected].filter((k) => visible.has(k) || !known.has(k)));
  return keep.size === selected.size ? null : keep;
}

/**
 * Where a delete sends a session of `bytes` (the server's rule: above the threshold to the trash,
 * else removed for good); null when the size is not known.
 */
export function deleteOutcome(bytes: number | null): "trash" | "purge" | null {
  if (bytes === null) return null;
  return bytes > TRASH_THRESHOLD_BYTES ? "trash" : "purge";
}

// ---- Filters (the dashboard's search box and filter popover) ----

export interface ManageFilter {
  query: string;
  provider: "all" | ProviderId;
  /** An account label, or null for every account. */
  account: string | null;
  /** In the user's list, outside it, or both. Orphans are never in the list. */
  list: "all" | "in" | "out";
  /** Size bounds in KB, inclusive; null leaves that side open. */
  minKb: number | null;
  maxKb: number | null;
  /** Last update bounds in ms since epoch, inclusive. */
  from: number | null;
  to: number | null;
}

export const EMPTY_FILTER: ManageFilter = {
  query: "", provider: "all", account: null, list: "all", minKb: null, maxKb: null, from: null, to: null,
};

/** The filter button's count: facets of the popover that are set (the search box is not one). */
export function facetCount(f: ManageFilter): number {
  return (
    Number(f.minKb !== null || f.maxKb !== null) +
    Number(f.from !== null || f.to !== null) +
    Number(f.provider !== "all") +
    Number(f.account !== null) +
    Number(f.list !== "all")
  );
}

/** Any narrowing at all, the search box included (when "필터 결과 삭제" is offered). */
export function filterActive(f: ManageFilter): boolean {
  return f.query.trim() !== "" || facetCount(f) > 0;
}

function sizeAndTime(size: number | null, ts: number, f: ManageFilter): boolean {
  if (f.minKb !== null || f.maxKb !== null) {
    // A size bound leaves out what has no known size; it cannot be shown to fall inside.
    if (size == null) return false;
    if (f.minKb !== null && size < f.minKb * 1024) return false;
    if (f.maxKb !== null && size > f.maxKb * 1024) return false;
  }
  if (f.from !== null && ts < f.from) return false;
  if (f.to !== null && ts > f.to) return false;
  return true;
}

function hit(values: Array<string | null | undefined>, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || values.some((v) => v && v.toLowerCase().includes(q));
}

export function matchesRow(r: ManageRow, f: ManageFilter): boolean {
  if (f.provider !== "all" && rowProvider(r) !== f.provider) return false;
  if (f.account !== null && rowAccount(r) !== f.account) return false;
  const inList = r.kind === "session" && r.inList;
  if (f.list === "in" && !inList) return false;
  if (f.list === "out" && inList) return false;
  if (!sizeAndTime(rowSize(r), rowUpdated(r), f)) return false;
  return r.kind === "session"
    ? hit([r.session.name, r.session.title, r.session.preview, r.session.cwd, r.session.account, r.session.id], f.query)
    : hit([r.orphan.id, r.orphan.account, ...r.orphan.paths], f.query);
}

/** The filter popover's fields as typed (the numbers and days are text until read). */
export interface FilterFields {
  minKb: string;
  maxKb: string;
  from: string;
  to: string;
  provider: "all" | "claude" | "codex";
  account: string;
  list: "all" | "in" | "out";
}

export const EMPTY_FIELDS: FilterFields = { minKb: "", maxKb: "", from: "", to: "", provider: "all", account: "", list: "all" };

/** The filter the table applies for a search text and the popover's fields: a bound that is not a number or a day is left open. */
export function filterOfFields(query: string, fields: FilterFields): ManageFilter {
  const kb = (v: string): number | null => (v === "" || !Number.isFinite(Number(v)) ? null : Math.max(0, Number(v)));
  return {
    ...EMPTY_FILTER,
    query,
    provider: fields.provider,
    account: fields.account || null,
    list: fields.list,
    minKb: kb(fields.minKb),
    maxKb: kb(fields.maxKb),
    from: dayStart(fields.from),
    to: dayEnd(fields.to),
  };
}

export function unitGroupKey(account: string, id: string): string {
  return `${account}:${id}`;
}

/**
 * A unit row under the filter; `parent` narrows to one session (`account:id`). The list facet does
 * not apply. `shown` is the text the row shows for the unit when it shows more than its parent (the
 * agent's description), searched too.
 */
export function matchesUnit(u: UnitRow, f: ManageFilter, parent: string | null, shown?: (u: UnitRow) => string | null): boolean {
  if (parent !== null && unitGroupKey(u.account, u.id) !== parent) return false;
  if (f.provider === "codex") return false;
  if (f.account !== null && u.account !== f.account) return false;
  if (!sizeAndTime(u.sizeBytes, u.updatedAt, f)) return false;
  return hit([u.unitId, u.name, u.enc, u.account, u.id, shown?.(u)], f.query);
}

// ---- Sort (a click on a column head; the same head flips, another starts descending) ----

export type ManageSortKey = "account" | "name" | "id" | "size" | "ts";
export interface ManageSort {
  key: ManageSortKey;
  dir: 1 | -1;
}
export const DEFAULT_MANAGE_SORT: ManageSort = { key: "ts", dir: -1 };

export function nextManageSort(current: ManageSort, key: ManageSortKey): ManageSort {
  return current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: -1 };
}

function compareBy(sort: ManageSort, num: (x: number) => number, str: (x: number) => string, keyOf: (x: number) => string) {
  return (a: number, b: number) => {
    const c =
      sort.key === "size" || sort.key === "ts"
        ? num(a) - num(b)
        : str(a).localeCompare(str(b), "ko", { numeric: true });
    return c * sort.dir || keyOf(a).localeCompare(keyOf(b));
  };
}

/**
 * Sorted copy. Sizes the index does not know count as 0, as the dashboard counted them. Accounts
 * sort by the name the table shows (`work`, not `claude-work`), then by provider.
 */
export function sortRows(rows: readonly ManageRow[], sort: ManageSort): ManageRow[] {
  const value = (r: ManageRow): string =>
    sort.key === "account"
      ? `${shortAccount(rowAccount(r))} ${rowProvider(r)}`
      : sort.key === "id"
        ? rowId(r)
        : (rowName(r) ?? "");
  const idx = [...rows.keys()];
  const cmp = compareBy(
    sort,
    (i) => (sort.key === "size" ? (rowSize(rows[i]!) ?? 0) : rowUpdated(rows[i]!)),
    (i) => value(rows[i]!),
    (i) => rows[i]!.key,
  );
  return idx.sort(cmp).map((i) => rows[i]!);
}

/** Sorted copy; the name column sorts by `shown` (what the row names the unit by) when given. */
export function sortUnits(units: readonly UnitRow[], sort: ManageSort, shown?: (u: UnitRow) => string | null): UnitRow[] {
  const value = (u: UnitRow): string =>
    sort.key === "account"
      ? shortAccount(u.account)
      : sort.key === "id"
        ? u.unitId
        : (shown?.(u) ?? u.name ?? u.id);
  const idx = [...units.keys()];
  const cmp = compareBy(
    sort,
    (i) => (sort.key === "size" ? units[i]!.sizeBytes : units[i]!.updatedAt),
    (i) => value(units[i]!),
    (i) => `${units[i]!.account}:${units[i]!.id}:${units[i]!.unitId}`,
  );
  return idx.sort(cmp).map((i) => units[i]!);
}

// ---- Text ----

/** `~` for the home directory. */
export function tildePath(p: string | null): string {
  if (!p) return "?";
  return p.replace(/^\/Users\/[^/]+/, "~");
}

// ---- The size slider: a log scale over KB, from 0 to a power of two above the largest row ----

export const SLIDER_STEPS = 1000;

export function sliderMaxKb(sizesBytes: Iterable<number | null>): number {
  let largest = 1;
  for (const b of sizesBytes) if (b != null) largest = Math.max(largest, b / 1024);
  return Math.max(64, 2 ** Math.ceil(Math.log2(largest)));
}

export function sliderPosToKb(pos: number, maxKb: number): number {
  const ratio = Math.max(0, Math.min(SLIDER_STEPS, pos)) / SLIDER_STEPS;
  return Math.round(Math.expm1(ratio * Math.log1p(maxKb)));
}

export function kbToSliderPos(kb: number, maxKb: number): number {
  if (!Number.isFinite(kb) || kb <= 0) return 0;
  return Math.round((Math.log1p(Math.min(kb, maxKb)) / Math.log1p(maxKb)) * SLIDER_STEPS);
}

// ---- Paging ----

export interface PageView<T> {
  rows: T[];
  /** 1-based, clamped into range. */
  page: number;
  pages: number;
  /** 1-based positions of the first and last row shown; 0 and 0 when there are none. */
  first: number;
  last: number;
}

/** One page of `rows`. Every row is on some page; a page past the end shows the last one. */
export function pageOf<T>(rows: readonly T[], page: number, size: number): PageView<T> {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (p - 1) * size;
  const shown = rows.slice(start, start + size);
  return { rows: shown, page: p, pages, first: shown.length ? start + 1 : 0, last: start + shown.length };
}

/** Page numbers to offer: the first, the last, and two on each side of the current; null is a gap. */
export function pagerItems(page: number, pages: number): Array<number | null> {
  const set = new Set([1, pages]);
  for (let p = page - 2; p <= page + 2; p++) if (p >= 1 && p <= pages) set.add(p);
  const sorted = [...set].sort((a, b) => a - b);
  const out: Array<number | null> = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push(null);
    out.push(p);
    prev = p;
  }
  return out;
}

// ---- Bulk writes ----

export type BulkResult<T, R> = { item: T; ok: true; value: R } | { item: T; ok: false; error: string };

/**
 * Runs `fn` on each item in turn (the server's management calls take one session each, and
 * several at once would race on the same files). A failure is recorded and the next item runs.
 */
export async function runSequential<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  describe: (error: unknown) => string,
  onProgress?: (results: ReadonlyArray<BulkResult<T, R>>) => void,
): Promise<Array<BulkResult<T, R>>> {
  const results: Array<BulkResult<T, R>> = [];
  for (const item of items) {
    try {
      results.push({ item, ok: true, value: await fn(item) });
    } catch (error) {
      results.push({ item, ok: false, error: describe(error) });
    }
    onProgress?.(results);
  }
  return results;
}

// ---- Date inputs ----

/** Local midnight of a `YYYY-MM-DD` date input, or null for an empty or bad value. */
export function dayStart(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const t = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(t) ? t : null;
}

/** The last millisecond of a `YYYY-MM-DD` date input's local day, or null. */
export function dayEnd(value: string): number | null {
  return dayStart(value) === null ? null : new Date(`${value}T23:59:59.999`).getTime();
}

// ---- Delete size and unit names ----

/** Whether a delete's size needs the session's subtree read: a Claude session the transcript's own size does not settle. */
export function needsSubtreeBytes(s: SessionSummary): boolean {
  return s.provider === "claude" && s.sizeBytes !== null && s.sizeBytes <= TRASH_THRESHOLD_BYTES;
}

/**
 * The size the server's delete weighs against the trash threshold, or null while it is not known.
 * Claude: the transcript and the session's subtrees in every account (`subtreeBytes`, from
 * `GET /api/session-units`, read when `needsSubtreeBytes`). Codex: the index's size settles only a
 * session over the threshold, since its subagent threads count too.
 */
export function deleteBytesOf(s: SessionSummary, subtreeBytes: number | null): number | null {
  const known = s.sizeBytes;
  if (known === null) return null;
  if (known > TRASH_THRESHOLD_BYTES) return known;
  if (s.provider === "codex") return null;
  return subtreeBytes === null ? null : known + subtreeBytes;
}

/** What the session-agents list says of a unit: its description or name, and its type and model. */
export interface UnitLabel {
  title: string;
  detail: string | null;
}

/**
 * Names for the units of one session, from its session-agents list (the right panel's 작업 tab):
 * a subagent's description, a workflow's name. Keyed by unit id (`agent-<id>`, `wf_...`).
 */
export function unitLabelsOf(body: SessionAgentsResponse): Map<string, UnitLabel> {
  const labels = new Map<string, UnitLabel>();
  for (const a of body.agents) {
    if (a.kind === "agent") {
      labels.set(`agent-${a.id}`, { title: a.title, detail: [a.agentType, a.model].filter(Boolean).join(", ") || null });
    } else {
      labels.set(a.id, { title: a.title, detail: a.workflow ? plural(a.workflow.agents.length, "agent") : null });
    }
  }
  return labels;
}
