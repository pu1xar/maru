// The settings screen's session management. Its information and behavior follow the
// an earlier dashboard's MANAGE page (the earlier dashboard MANAGE_HTML): one row of views (All, Locked, Subagents,
// Workflows, Orphans) with their counts, one search line with the filter, the ⋮ menu's
// "Delete all except locked" and the trash, the filter result and selection deletes, the sortable table
// and its pager. The look is the app's settings page (SettingsSection and T3 parts, the table after
// T3's ui/table and DiagnosticsSettings). Local change: the rows are every session of every
// account, in the user's list or not, and the orphans (DESIGN.md 6d, 6); each write goes to this
// app's server one session at a time (sessionManage.ts); the dashboard's message log and T3 link
// give way to the conversation view. The table is a size container (`manage`): its columns fold by
// its own width (ManageRows.tsx).
import type { AccountInfo, OrphanList, SessionAgentsResponse, SessionSummary, SessionUnits, UnitRow } from "@maru/shared";
import { TRASH_THRESHOLD_BYTES } from "@maru/shared";
import { ArrowDownIcon, ArrowUpIcon, FunnelIcon, MoreHorizontalIcon, SearchIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { refreshSessionSummary } from "~/lib/sessionViewState";
import { cn } from "~/lib/utils";
import { displayName } from "~/model";
import {
  chooseSession,
  deleteOrphan,
  deleteSession,
  describeError,
  fetchAccounts,
  fetchAllCandidates,
  fetchAllUnits,
  fetchOrphans,
  fetchSessionUnits,
  moveSession,
  renameSession,
  resumeCommand,
} from "~/projectsApi";
import { RehomeFolderDialog } from "../../RehomeFolderDialog";
import { DeleteSessionDialog, refreshTrash, useTrash } from "../../SessionManageDialogs";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui/table";
import { toastManager } from "../../ui/toast";
import { ToggleGroup, ToggleGroupItem } from "../../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { BulkRunDialog, type BulkJob } from "../BulkRunDialog";
import {
  DEFAULT_MANAGE_SORT,
  facetCount,
  filterActive,
  filterOfFields,
  inView,
  matchesRow,
  matchesUnit,
  nextManageSort,
  pageOf,
  pruneSelection,
  rowAccount,
  rowActive,
  rowDeletable,
  rowId,
  rowLocked,
  rowName,
  rowPath,
  rowProvider,
  rowSize,
  sessionLevelRows,
  shortAccount,
  sliderMaxKb,
  sortRows,
  sortUnits,
  tildePath,
  unitGroupKey,
  unitKindOfView,
  unitLabelsOf,
  visibleSelection,
  bulkNoun,
  migrateManageView,
  otherViewsHint,
  viewCounts,
  viewMatchCounts,
  DEFAULT_MANAGE_VIEW,
  MANAGE_VIEWS,
  MANAGE_VIEW_LABEL,
  type ManageFilter,
  type ManageRow,
  type ManageSort,
  type ManageSortKey,
  type ManageView,
} from "../manageModel";
import { Pager, formatSize } from "../parts";
import { SettingsSection } from "../settingsLayout";
import { DeleteUnitDialog, EMPTY_FIELDS, FilterForm, TrashModal, type FilterFields } from "./ManagePopovers";
import { CELL, FIRST_CELL, HIDE_ID, HIDE_SIZE, HIDE_TS, LAST_CELL, SessionRowView, UnitRowView, type UnitLabel } from "./ManageRows";
import { plural } from "../../../lib/plural.ts";

const PAGE_SIZE = 100;
/** The 세션 관리 search, kept across tab switches while the page lives. */
let keptQuery = "";
const VIEW_KEY = "maru_manage_view";
/** Read once to carry an earlier build's two-part choice (view and level) into the one view, then removed. */
const OLD_LEVEL_KEY = "maru_manage_level";

/** The remembered view; an earlier build's stored values are carried over (migrateManageView). */
function readStoredView(): ManageView {
  try {
    const v = migrateManageView(window.localStorage.getItem(VIEW_KEY), window.localStorage.getItem(OLD_LEVEL_KEY));
    window.localStorage.setItem(VIEW_KEY, v);
    window.localStorage.removeItem(OLD_LEVEL_KEY);
    return v;
  } catch {
    return DEFAULT_MANAGE_VIEW;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice holds for this page only.
  }
}

type DeleteResult = { kind: "session"; outcome: "trashed" | "deleted"; sizeBytes: number; threads: number } | { kind: "orphan"; freedBytes: number };

/** Deletes one row: a session through the trash rule, an orphan for good. */
async function deleteRow(r: ManageRow): Promise<DeleteResult> {
  if (r.kind === "session") {
    const s = r.session;
    const d = await deleteSession({ provider: s.provider, account: s.account, id: s.id });
    return { kind: "session", outcome: d.outcome, sizeBytes: d.sizeBytes, threads: d.ids.length };
  }
  const o = r.orphan;
  const d = await deleteOrphan({ provider: o.provider, account: o.account, id: o.id });
  return { kind: "orphan", freedBytes: d.freedBytes };
}



const TRASH_NOTE = `Sessions over ${TRASH_THRESHOLD_BYTES / 1048576} MB go to Trash, the rest are permanently deleted right away`;

/** Names for the units of one session, from its session-agents list (unitLabelsOf). */
async function fetchUnitLabels(account: string, id: string): Promise<Map<string, UnitLabel>> {
  const res = await fetch(`/api/session-agents?${new URLSearchParams({ key: `claude:${account}:${id}` })}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return unitLabelsOf((await res.json()) as SessionAgentsResponse);
}

/** The session table section under the usage section (SettingsView), with its dialogs. */
export function ManageSection(props: {
  listed: SessionSummary[];
  now: number;
  /** A session (`account:id`) whose subagents the page opens with, from the address. */
  focus: string | null;
  onOpenSession: (session: SessionSummary) => void;
  onRekey: (from: string, to: string, familyIds?: readonly string[]) => void;
}) {
  const { listed } = props;

  // ---- Data: the list over /ws; candidates, orphans and units read here, again after writes ----
  const [candidates, setCandidates] = useState<SessionSummary[] | null>(null);
  const [orphans, setOrphans] = useState<OrphanList | null>(null);
  const [units, setUnits] = useState<UnitRow[] | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const seq = useRef({ c: 0, o: 0, u: 0 });
  const fail = (what: string) => (err: unknown) => setLoadError(`${what}: ${describeError(err)}`);
  const reloadCandidates = () => {
    const mine = ++seq.current.c;
    fetchAllCandidates()
      .then((all) => mine === seq.current.c && setCandidates(all))
      .catch(fail("Could not load sessions outside the list"));
  };
  const reloadOrphans = () => {
    const mine = ++seq.current.o;
    fetchOrphans()
      .then((o) => mine === seq.current.o && setOrphans(o))
      .catch(fail("Could not load orphans"));
  };
  const reloadUnits = () => {
    const mine = ++seq.current.u;
    fetchAllUnits()
      .then((u) => mine === seq.current.u && setUnits(u.units))
      .catch(fail("Could not load subagents and workflows"));
  };
  const listedKeys = useMemo(() => listed.filter((s) => !s.parentKey).map((s) => s.key).sort().join("\n"), [listed]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's candidates when the list's membership changes
  useEffect(() => {
    reloadCandidates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listedKeys]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads orphans, units and accounts once on mount
  useEffect(() => {
    reloadOrphans();
    reloadUnits();
    refreshTrash();
    fetchAccounts().then(setAccounts).catch(() => {
      // The account move then offers no target; the rest works without it.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const reloadAll = () => {
    reloadCandidates();
    reloadOrphans();
    reloadUnits();
  };

  // ---- View, filters, sort, page ----
  const [view, setViewState] = useState<ManageView>(() => (props.focus ? "subagents" : readStoredView()));
  const [parent, setParent] = useState<string | null>(props.focus);
  // The search survives a tab switch and closing settings (user request), for this page.
  // A focus screen (one session's subagents) starts clean; the kept search is for the plain list.
  const [query, setQueryState] = useState(() => (props.focus ? "" : keptQuery));
  const setQuery = (next: string) => {
    keptQuery = next;
    setQueryState(next);
  };
  const [fields, setFields] = useState<FilterFields>(EMPTY_FIELDS);
  const [sort, setSort] = useState<ManageSort>(DEFAULT_MANAGE_SORT);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [popover, setPopover] = useState<"filter" | "bulk" | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);

  const setView = (v: ManageView) => {
    setViewState(v);
    store(VIEW_KEY, v);
    setPage(1);
    setSelected(new Set());
    setParent(null);
    setPopover(null);
  };

  const filter: ManageFilter = filterOfFields(query, fields);
  const facets = facetCount(filter);

  const allRows = useMemo(() => sessionLevelRows(listed, candidates ?? [], orphans?.sessions ?? []), [listed, candidates, orphans]);
  const viewRows = allRows.filter((r) => inView(r, view));
  const unitKind = unitKindOfView(view);
  const unitRows = units ?? [];

  // Narrowed to one session, its units are named by its session-agents list (null while reading
  // or when the list cannot be read: the rows then show their ids). The name column sorts and the
  // search matches by that name, as the rows show it.
  const [unitLabels, setUnitLabels] = useState<{ parent: string; labels: Map<string, UnitLabel> } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the narrowed session's unit names from the server
  useEffect(() => {
    if (!parent || !unitKind) return;
    const [account, ...rest] = parent.split(":");
    if (!account || !rest.length) return;
    let live = true;
    fetchUnitLabels(account, rest.join(":"))
      .then((labels) => live && setUnitLabels({ parent, labels }))
      .catch(() => {
        // The rows fall back to their unit ids.
      });
    return () => {
      live = false;
    };
  }, [parent, unitKind, units]);
  const labelsNow = parent && unitLabels?.parent === parent ? unitLabels.labels : null;
  const shownUnitName = parent ? (u: UnitRow) => labelsNow?.get(u.unitId)?.title ?? u.unitId : undefined;

  const kindUnits = unitKind ? unitRows.filter((u) => u.kind === unitKind) : [];
  const matchedRows = unitKind ? [] : sortRows(viewRows.filter((r) => matchesRow(r, filter)), sort);
  const matchedUnits = unitKind ? sortUnits(kindUnits.filter((u) => matchesUnit(u, filter, parent, shownUnitName)), sort, shownUnitName) : [];
  const total = unitKind ? kindUnits.length : viewRows.length;
  const matched = unitKind ? matchedUnits.length : matchedRows.length;
  const rowsRead = candidates !== null && orphans !== null;
  const counts = viewCounts(allRows, units, rowsRead);
  const rowsPage = pageOf(matchedRows, page, PAGE_SIZE);
  const unitsPage = pageOf(matchedUnits, page, PAGE_SIZE);
  const pageView = unitKind ? unitsPage : rowsPage;
  const maxKb = sliderMaxKb(allRows.map(rowSize));
  const accountOptions = [
    ...new Set([
      ...accounts.filter((a) => fields.provider === "all" || a.provider === fields.provider).map((a) => a.id),
      ...allRows.filter((r) => fields.provider === "all" || rowProvider(r) === fields.provider).map(rowAccount),
    ]),
  ].sort();

  // Sessions and units known by key, for parent names, folders and the size cell's link.
  const sessionByUnitKey = useMemo(() => {
    const m = new Map<string, SessionSummary>();
    for (const r of allRows) if (r.kind === "session" && r.session.provider === "claude") m.set(unitGroupKey(r.session.account, r.session.id), r.session);
    return m;
  }, [allRows]);
  const unitKindsBySession = useMemo(() => {
    const m = new Map<string, { subagent: number; workflow: number }>();
    for (const u of unitRows) {
      const k = unitGroupKey(u.account, u.id);
      const c = m.get(k) ?? { subagent: 0, workflow: 0 };
      c[u.kind]++;
      m.set(k, c);
    }
    return m;
  }, [unitRows]);

  // ---- Selection: deletable rows shown on this page; what the search, a facet or the page hides
  // leaves the selection, so "선택 삭제" never counts a row the table does not show ----
  const shownRows = unitKind ? [] : rowsPage.rows;
  const selectedRows = visibleSelection(shownRows, selected);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops selected rows the table stops showing (search, facet, page, a delete elsewhere)
  const knownKeys = useMemo(() => new Set(allRows.map((r) => r.key)), [allRows]);
  useEffect(() => {
    const kept = pruneSelection(selected, shownRows, knownKeys);
    if (kept) setSelected(kept);
  });
  const pageSelectable = unitKind ? [] : rowsPage.rows.filter(rowDeletable);
  const pageAllSelected = pageSelectable.length > 0 && pageSelectable.every((r) => selected.has(r.key));
  const toggle = (keys: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  const filteredDeletable = !unitKind && filterActive(filter) ? matchedRows.filter(rowDeletable) : [];
  const unlockedAll = allRows.filter(rowDeletable);

  // ---- Dialogs ----
  const [bulk, setBulk] = useState<{ seq: number; open: boolean; job: BulkJob<ManageRow, DeleteResult> } | null>(null);
  // The folder dialog (typed path with the subfolders listed, 6z), mounted until it has closed.
  const [rehoming, setRehoming] = useState<{ seq: number; session: SessionSummary } | null>(null);
  const [deleting, setDeleting] = useState<{ seq: number; open: boolean; session: SessionSummary } | null>(null);
  const [unitDelete, setUnitDelete] = useState<{ seq: number; open: boolean; unit: UnitRow } | null>(null);
  const startBulk = (title: string, notes: string[], items: ManageRow[]) => {
    setPopover(null);
    setBulk((prev) => ({
      seq: (prev?.seq ?? 0) + 1,
      open: true,
      job: {
        title,
        description: [...notes, ...(items.some((r) => r.kind === "session") ? [TRASH_NOTE] : [])].join(". "),
        confirmLabel: "Delete",
        items,
        label: (r) => rowName(r) ?? `${rowId(r).slice(0, 8)} (no transcript)`,
        sublabel: (r) => [shortAccount(rowAccount(r)), formatSize(rowSize(r)), tildePath(rowPath(r))].join(", "),
        run: deleteRow,
        detail: (d) =>
          d.kind === "orphan"
            ? `Orphan permanently deleted, ${formatSize(d.freedBytes)}`
            : `${d.outcome === "trashed" ? "Moved to Trash" : "Permanently deleted"}, ${formatSize(d.sizeBytes)}${d.threads > 1 ? `, ${plural(d.threads, "thread")}` : ""}`,
        onFinished: (results) => {
          toggle(results.filter((x) => x.ok).map((x) => x.item.key), false);
          refreshTrash();
          reloadAll();
        },
      },
    }));
  };
  const deleteSelected = () => startBulk(`Delete ${plural(selectedRows.length, bulkNoun(selectedRows))}?`, [], selectedRows);
  const deleteFiltered = () => {
    const locked = matchedRows.filter(rowLocked).length;
    const busy = matchedRows.filter((r) => rowActive(r) && !rowLocked(r)).length;
    startBulk(
      `Delete ${plural(filteredDeletable.length, `filtered ${bulkNoun(filteredDeletable)}`)}?`,
      [busy ? `${plural(busy, "running session")} skipped` : "", locked ? `${plural(locked, "locked session")} skipped` : ""].filter(Boolean),
      filteredDeletable,
    );
  };
  const deleteAllUnlocked = () => {
    const locked = allRows.filter(rowLocked).length;
    const busy = allRows.filter((r) => rowActive(r) && !rowLocked(r)).length;
    startBulk(
      `Delete all ${plural(unlockedAll.length, "unlocked session")}?`,
      [locked ? `${plural(locked, "locked session")} stay` : "", busy ? `${plural(busy, "running session")} skipped` : ""].filter(Boolean),
      unlockedAll,
    );
  };

  // ---- Row actions ----
  // Lock, list and rename show their result in the row itself, so only a failure gets a toast: the
  // app's toasts sit over this page's header controls for a few seconds.
  const toastFail = (title: string) => (err: unknown) => toastManager.add({ type: "error", title, description: describeError(err) });
  const rowActions = (r: ManageRow) => {
    const s = r.kind === "session" ? r.session : null;
    const unitCounts = s ? unitKindsBySession.get(unitGroupKey(s.account, s.id)) : undefined;
    return {
      onOpen: () => {
        if (s) props.onOpenSession(s);
      },
      onRename: async (name: string) => {
        if (!s) return;
        try {
          await renameSession({ provider: s.provider, account: s.account, id: s.id, name });
          reloadCandidates();
        } catch (err) {
          toastFail("Could not rename")(err);
        }
      },
      onToggleList: () => {
        if (!s || r.kind !== "session") return;
        const chosen = !r.inList;
        chooseSession({ provider: s.provider, id: s.id, chosen })
          .then(() => {
            // In the list means locked, so adding drops it from the selection (a lock cannot be deleted).
            if (chosen) toggle([r.key], false);
            reloadCandidates();
          })
          .catch(toastFail(chosen ? "Could not add to the list" : "Could not remove from the list"));
      },
      onCopyResume: () => {
        if (!s) return;
        // The menu that asked for it has closed, so the toast is the only sign the copy happened.
        resumeCommand({ provider: s.provider, account: s.account, id: s.id })
          .then((cmd) => writeTextToClipboard(cmd.command).then(() => cmd))
          .then((cmd) => toastManager.add({ type: "success", title: "Copied resume command", description: cmd.command }))
          .catch(toastFail("Could not copy the resume command"));
      },
      onMove: (to: string) => {
        if (!s) return;
        moveSession({ provider: s.provider, id: s.id, from: s.account, to })
          .then((m) => {
            toastManager.add({ type: "success", title: `Moved to ${to}`, description: m.resumeCommand });
            props.onRekey(s.key, `${s.provider}:${to}:${s.id}`, m.ids);
            reloadAll();
          })
          .catch(toastFail("Could not move to another account"));
      },
      onRehome: () => {
        if (s) setRehoming((prev) => ({ seq: (prev?.seq ?? 0) + 1, session: s }));
      },
      onDelete: () => {
        if (s) setDeleting((prev) => ({ seq: (prev?.seq ?? 0) + 1, open: true, session: s }));
        else startBulk("Delete orphan?", ["Permanently deleted, not moved to Trash"], [r]);
      },
      units: s && unitCounts ? unitCounts : null,
      onShowUnits: (kind: "subagent" | "workflow") => {
        if (!s) return;
        const next: ManageView = kind === "subagent" ? "subagents" : "workflows";
        setViewState(next);
        store(VIEW_KEY, next);
        setParent(unitGroupKey(s.account, s.id));
        setPage(1);
        setSelected(new Set());
      },
    };
  };

  // ---- Unit level: the parent filter's banner, with the subtree totals ----
  const [parentDetail, setParentDetail] = useState<SessionUnits | { error: string } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the filtered parent's subtree totals from the server
  useEffect(() => {
    setParentDetail(null);
    if (!parent) return;
    const [account, ...rest] = parent.split(":");
    if (!account || !rest.length) return;
    let live = true;
    fetchSessionUnits(account, rest.join(":"))
      .then((d) => live && setParentDetail(d))
      .catch((err: unknown) => live && setParentDetail({ error: describeError(err) }));
    return () => {
      live = false;
    };
  }, [parent, units]);
  const parentName = (account: string, id: string, fallback: string | null) => {
    const s = sessionByUnitKey.get(unitGroupKey(account, id));
    return s ? displayName(s) : fallback || id.slice(0, 8);
  };

  const trash = useTrash();
  const trashCount = trash?.items.length ?? 0;
  const emptyText = unitKind
    ? units
      ? `No ${MANAGE_VIEW_LABEL[view].toLowerCase()}`
      : "Loading units"
    : !rowsRead
      ? "Loading"
      : view === "all"
        ? "No sessions"
        : `No ${MANAGE_VIEW_LABEL[view].toLowerCase()}${view === "locked" ? " sessions" : ""}`;
  // A search or filter that leaves nothing here says where it would find something.
  const emptyHint =
    matched === 0 && total > 0 && parent === null && filterActive(filter) ? otherViewsHint(view, viewMatchCounts(allRows, unitRows, filter)) : null;
  const banner =
    unitKind && parent
      ? (() => {
          const [account, ...rest] = parent.split(":");
          const id = rest.join(":");
          const any = unitRows.find((u) => unitGroupKey(u.account, u.id) === parent);
          return { name: parentName(account ?? "", id, any?.name ?? null) };
        })()
      : null;

  const sortHead = (key: ManageSortKey, label: string, className?: string) => {
    const active = sort.key === key;
    const Arrow = sort.dir === 1 ? ArrowUpIcon : ArrowDownIcon;
    return (
      <TableHead scope="col" aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"} className={cn(TH, className)}>
        <button
          type="button"
          onClick={() => {
            setSort((prev) => nextManageSort(prev, key));
            setPage(1);
          }}
          className={cn(
            "inline-flex max-w-full cursor-pointer items-center gap-0.5 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            active && "text-foreground",
          )}
        >
          <span className="truncate">{label}</span>
          {active ? <Arrow aria-hidden className="size-3 shrink-0" /> : null}
        </button>
      </TableHead>
    );
  };
  const unitLevel = unitKind !== null;
  const columns = unitLevel ? 6 : 7;

  return (
    <>
      <SettingsSection
        title="Sessions"
        headerActionClassName="min-w-0 max-w-full shrink"
        headerAction={
          <div className="max-w-full overflow-x-auto">
            <ToggleGroup
              aria-label="Session view"
              value={[view]}
              onValueChange={(v) => {
                const next = v[0];
                if (MANAGE_VIEWS.some((x) => x === next)) setView(next as ManageView);
              }}
            >
              {MANAGE_VIEWS.map((v) => (
                <ToggleGroupItem key={v} value={v}>
                  {MANAGE_VIEW_LABEL[v]} <Count n={counts[v]} />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        }
      >
        {/* Search line: the filter, the ⋮ menu and the trash sit at its end */}
        <div className="flex items-center gap-1.5 px-3 py-3 sm:px-4">
          <div className="relative flex min-w-0 flex-1 items-center">
            <SearchIcon aria-hidden className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" />
            <Input
              nativeInput
              type="search"
              size="sm"
              value={query}
              onChange={(e) => {
                setQuery(e.currentTarget.value);
                setPage(1);
              }}
              placeholder="Name, first prompt, path, ID, account"
              aria-label="Search session management"
              autoComplete="off"
              className="[&_input]:ps-8 [&_input]:pe-8"
            />
            {query ? (
              <Button size="icon-micro" variant="ghost-muted" className="absolute right-1.5" aria-label="Clear search" onClick={() => setQuery("")}>
                <XIcon className="size-3" />
              </Button>
            ) : null}
          </div>
          <Popover open={popover === "filter"} onOpenChange={(open) => setPopover(open ? "filter" : null)}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <PopoverTrigger
                    render={
                      <Button size="icon-sm" variant={facets > 0 ? "secondary" : "ghost-muted"} aria-label={facets ? `Session filter (${facets})` : "Session filter"} className="relative" />
                    }
                  />
                }
              >
                <FunnelIcon />
                {facets ? <CornerCount n={facets} /> : null}
              </TooltipTrigger>
              <TooltipPopup side="top">Filter</TooltipPopup>
            </Tooltip>
            <PopoverPopup align="end" className="p-0 [&>div]:p-4">
              <FilterForm
                fields={fields}
                onChange={(next) => {
                  setFields(next);
                  setPage(1);
                }}
                maxKb={maxKb}
                accounts={accountOptions}
                facets={facets}
                onDone={() => setPopover(null)}
              />
            </PopoverPopup>
          </Popover>
          <Menu open={popover === "bulk"} onOpenChange={(open) => setPopover(open ? "bulk" : null)}>
            <Tooltip>
              <TooltipTrigger render={<MenuTrigger render={<Button size="icon-sm" variant="ghost-muted" aria-label="Session actions" />} />}>
                <MoreHorizontalIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">Session actions</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end" className="min-w-56">
              <MenuItem variant="destructive" disabled={unlockedAll.length === 0} onClick={deleteAllUnlocked}>
                <Trash2Icon />
                <span className="flex-1">Delete all except locked</span>
                <span className="text-xs tabular-nums opacity-70">{unlockedAll.length}</span>
              </MenuItem>
            </MenuPopup>
          </Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button size="icon-sm" variant="ghost-muted" aria-label={trashCount ? `Trash (${trashCount})` : "Trash"} className="relative" onClick={() => setTrashOpen(true)} />
              }
            >
              <Trash2Icon />
              {trashCount ? <CornerCount n={trashCount} /> : null}
            </TooltipTrigger>
            <TooltipPopup side="top">Trash</TooltipPopup>
          </Tooltip>
        </div>

        {/* Filter result and selection deletes */}
        {filteredDeletable.length || selectedRows.length ? (
          <div className="flex flex-wrap items-center justify-end gap-2 px-3 py-2 sm:px-4">
            {selectedRows.length ? (
              <Button size="xs" variant="ghost-muted" onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
            ) : null}
            {filteredDeletable.length ? (
              <Button size="xs" variant="destructive-outline" onClick={deleteFiltered}>
                <Trash2Icon />
                Delete filter results ({filteredDeletable.length})
              </Button>
            ) : null}
            {selectedRows.length ? (
              <Button size="xs" variant="destructive-outline" onClick={deleteSelected}>
                <Trash2Icon />
                Delete selected ({selectedRows.length})
              </Button>
            ) : null}
          </div>
        ) : null}

        {loadError ? (
          <div role="alert" className="flex items-center gap-3 px-3 py-2 text-sm text-destructive-foreground sm:px-4">
            <span className="min-w-0 flex-1 wrap-anywhere">{loadError}</span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setLoadError(null);
                reloadAll();
              }}
            >
              Reload
            </Button>
          </div>
        ) : null}

        {banner ? (
          <div className="flex items-center gap-3 bg-info/8 px-3 py-2 text-xs text-foreground sm:px-4">
            <Tooltip>
              {/* Focusable so the keyboard reaches the subtree totals in its tooltip too. */}
              <TooltipTrigger render={<span tabIndex={0} className="min-w-0 truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />}>
                {unitKind === "subagent" ? "Subagents" : "Workflows"} of <b className="font-medium">{banner.name}</b>
              </TooltipTrigger>
              <TooltipPopup side="top">
                {parentDetail && !("error" in parentDetail)
                  ? `subtree ${formatSize(parentDetail.totalBytes)}, units ${formatSize(parentDetail.unitBytes)}${parentDetail.remainderBytes > 0 ? `, other files ${formatSize(parentDetail.remainderBytes)}` : ""}`
                  : parentDetail
                    ? parentDetail.error
                    : "Loading size"}
              </TooltipPopup>
            </Tooltip>
            <Button size="xs" variant="ghost-muted" className="ms-auto shrink-0" onClick={() => setParent(null)}>
              <XIcon />
              Show all
            </Button>
          </div>
        ) : null}

        {/* A size container: the columns fold by the table's own width (ManageRows.tsx). */}
        <div className="@container/manage">
          <Table containerClassName="overflow-x-clip" className="table-fixed border-collapse">
            <colgroup>
              {unitLevel ? null : <col className="w-10" />}
              <col className="w-28 @max-[39rem]/manage:w-24" />
              <col />
              <col className={cn(unitLevel ? "w-36" : "w-22", HIDE_ID)} />
              <col className={cn("w-20", HIDE_SIZE)} />
              <col className={cn("w-22", HIDE_TS)} />
              <col className={unitLevel ? "w-21 @max-[28rem]/manage:w-13" : "w-29 @max-[28rem]/manage:w-13"} />
            </colgroup>
            <TableHeader className="[&_tr]:border-border/60">
              <TableRow className="hover:bg-transparent">
                {unitLevel ? null : (
                  <TableHead scope="col" className={cn(TH, FIRST_CELL, "pr-0")}>
                    {pageSelectable.length === 0 ? (
                      <Tooltip>
                        <TooltipTrigger render={<span className="inline-flex align-middle" />}>
                          <Checkbox aria-label="Select all deletable sessions on this page, none can be deleted here" checked={false} disabled />
                        </TooltipTrigger>
                        <TooltipPopup side="top">{view === "locked" ? "Locked" : "Nothing on this page can be deleted"}</TooltipPopup>
                      </Tooltip>
                    ) : (
                      <Checkbox
                        aria-label="Select all deletable sessions on this page"
                        checked={pageAllSelected}
                        indeterminate={!pageAllSelected && pageSelectable.some((r) => selected.has(r.key))}
                        onCheckedChange={(on) => toggle(pageSelectable.map((r) => r.key), on)}
                      />
                    )}
                  </TableHead>
                )}
                {sortHead("account", "Account", unitLevel ? FIRST_CELL : undefined)}
                {sortHead("name", unitLevel ? (parent ? unitKind : "Parent session") : "Name")}
                {sortHead("id", "ID", HIDE_ID)}
                {sortHead("size", "Size", cn("text-right [&>button]:justify-end", HIDE_SIZE))}
                {sortHead("ts", "Updated", HIDE_TS)}
                <TableHead scope="col" className={cn(TH, LAST_CELL, "text-right")}>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y divide-border/50">
              {unitKind
                ? unitsPage.rows.map((u) => {
                    const owner = sessionByUnitKey.get(unitGroupKey(u.account, u.id));
                    return (
                      <UnitRowView
                        key={`${u.account}:${u.id}:${u.kind}:${u.unitId}`}
                        unit={u}
                        now={props.now}
                        parentName={parentName(u.account, u.id, u.name)}
                        parentPath={owner?.cwd ?? null}
                        narrowed={parent !== null}
                        label={labelsNow?.get(u.unitId) ?? null}
                        onFilterParent={() => {
                          const k = unitGroupKey(u.account, u.id);
                          setParent((p) => (p === k ? null : k));
                          setPage(1);
                        }}
                        onOpenParent={owner ? () => props.onOpenSession(owner) : null}
                        onDelete={() => setUnitDelete((prev) => ({ seq: (prev?.seq ?? 0) + 1, open: true, unit: u }))}
                      />
                    );
                  })
                : rowsPage.rows.map((r) => (
                    <SessionRowView
                      key={r.key}
                      row={r}
                      now={props.now}
                      selected={selected.has(r.key)}
                      onSelect={(on) => toggle([r.key], on)}
                      accounts={accounts}
                      actions={rowActions(r)}
                    />
                  ))}
              {pageView.rows.length === 0 ? (
                <tr>
                  <TableCell colSpan={columns} className={cn(CELL, "px-3 py-4 text-muted-foreground sm:px-4")}>
                    {matched === 0 && total > 0 ? (emptyHint ?? "No matches here") : emptyText}
                  </TableCell>
                </tr>
              ) : null}
            </TableBody>
          </Table>
          <Pager
            page={pageView.page}
            pages={pageView.pages}
            onPage={setPage}
            info={`${filterActive(filter) || parent ? `${matched} of ${total}` : `${total}`}${pageView.pages > 1 ? `, showing ${pageView.first}-${pageView.last}` : ""}`}
          />
        </div>
      </SettingsSection>

      <TrashModal open={trashOpen} onClose={() => setTrashOpen(false)} />
      {bulk ? (
        <BulkRunDialog
          key={bulk.seq}
          open={bulk.open}
          job={bulk.job}
          onClose={() => setBulk((prev) => (prev ? { ...prev, open: false } : prev))}
          onClosed={() => setBulk((prev) => (prev && !prev.open ? null : prev))}
        />
      ) : null}
      {rehoming ? (
        <RehomeFolderDialog
          key={rehoming.seq}
          session={rehoming.session}
          sessions={listed}
          onClosed={() => setRehoming((prev) => (prev?.seq === rehoming.seq ? null : prev))}
          onDone={() => {
            reloadAll();
            // The conversation behind settings may show this session off the list (lib/sessionViewState.ts).
            void refreshSessionSummary(rehoming.session.key);
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteSessionDialog
          key={deleting.seq}
          open={deleting.open}
          session={deleting.session}
          onClose={() => setDeleting((prev) => (prev ? { ...prev, open: false } : prev))}
          onClosed={() => setDeleting((prev) => (prev && !prev.open ? null : prev))}
          onDeleted={() => {
            toggle([deleting.session.key], false);
            reloadAll();
          }}
        />
      ) : null}
      {unitDelete ? (
        <DeleteUnitDialog
          key={unitDelete.seq}
          open={unitDelete.open}
          unit={unitDelete.unit}
          onClose={() => setUnitDelete((prev) => (prev ? { ...prev, open: false } : prev))}
          onClosed={() => setUnitDelete((prev) => (prev && !prev.open ? null : prev))}
          onDeleted={() => reloadUnits()}
        />
      ) : null}
    </>
  );
}

/** T3's settings table head (DiagnosticsSettings) without its uppercase, which Korean does not take. */
const TH = "sticky top-0 z-[1] h-auto border-b border-border/60 bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground";

function Count({ n }: { n: number | null }) {
  return <span className="text-xs text-muted-foreground tabular-nums">{n ?? "-"}</span>;
}

/** A count over a toolbar button's corner (Badge sm, 10px). */
function CornerCount({ n }: { n: number }) {
  return (
    <Badge size="sm" className="pointer-events-none absolute -top-1.5 -right-1.5 tabular-nums">
      {n}
    </Badge>
  );
}
