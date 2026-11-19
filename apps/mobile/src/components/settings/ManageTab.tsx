// The Sessions section (the web's settings/manage/ManagePanel.tsx), under the usage section of the
// "Sessions" tab. Its information and behavior are the web's: one row of views (All, Locked,
// Subagents, Workflows, Orphans) with their counts, one search line with the filter,
// the ⋮ menu's delete of everything unlocked and the trash, the filter result and selection deletes,
// the sortable and paged table, and a row's actions (open, rename, resume command, list membership,
// units, working folder, account move, delete). The rows are the web's data (settings/
// manageModel.ts, the same rules for views, filters, sort, selection and the delete outcome) laid out
// for a phone (ManageRows.tsx), the ⋮ menu and the dialogs are sheets (ManageSheets.tsx), and the
// table's own logic is lib/manage.logic.ts. Each write goes to the server one session at a time,
// through the routes a device token may use (lib/manageApi.ts). The web shows a result as a toast;
// a phone's sheet covers the toasts, so the result shows in a strip above the rows.
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { ArrowRightLeftIcon, BotIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon, FolderInputIcon, FunnelIcon, ListFilterIcon, ListMinusIcon, ListPlusIcon, MessageSquareIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon, UserRoundIcon, WorkflowIcon, XIcon, type LucideIcon } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import * as SecureStore from "expo-secure-store";
import type { AccountInfo, OrphanList, PurgeTrashResult, SessionSummary, SessionUnits, TrashItem, TrashList, UnitRow } from "@maru/shared";
import {
  EMPTY_FIELDS,
  facetCount,
  filterActive,
  filterOfFields,
  pagerItems,
  pruneSelection,
  rowAccount,
  rowName,
  rowProvider,
  rowSize,
  shortAccount,
  unitKindOfView,
  DEFAULT_MANAGE_VIEW,
  MANAGE_VIEWS,
  MANAGE_VIEW_LABEL,
  migrateManageView,
  type FilterFields,
  type ManageRow,
  type ManageSort,
  type ManageView,
  type UnitLabel,
  DEFAULT_MANAGE_SORT,
  unitGroupKey,
} from "../../../../web/src/components/settings/manageModel.ts";
import { formatSize } from "../../../../web/src/components/settings/parts.logic.ts";
import { displayName, recentCwds } from "../../../../web/src/model.ts";
import {
  bulkDescription,
  bulkItemLabel,
  bulkItemSub,
  deleteBlock,
  deleteDetail,
  emptyText,
  filteredPlan,
  manageViewModel,
  moveTargets,
  pagerInfo,
  parseSort,
  rowActions,
  rowLabel,
  selectedPlan,
  sortValue,
  unitDeleteBlock,
  unlockedPlan,
  type BulkPlan,
  type RowActionId,
} from "../../lib/manage.logic.ts";
import {
  chooseSession,
  deleteOrphan,
  deleteSession,
  deleteUnit,
  fetchAllCandidates,
  fetchAllUnits,
  fetchOrphans,
  fetchSessionUnits,
  fetchTrash,
  fetchUnitLabels,
  moveSession,
  purgeTrash,
  rehomeSession,
  renameSession,
  resumeCommand,
} from "../../lib/manageApi.ts";
import { fetchAccounts, type Pairing } from "../../lib/api.ts";
import { usePalette } from "../../theme.ts";
import { Press } from "../Press.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Btn } from "../ui/Btn.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { Segmented, TextField } from "../ui/Fields.tsx";
import { ErrorBox, NoticeBox } from "../ui/Notices.tsx";
import { SettingsSection } from "../ui/SettingsParts.tsx";
import { Text } from "../ui/Text.tsx";
import { ui } from "../ui/metrics.ts";
import { useChrome } from "../ui/useChrome.ts";
import { useSidebarColors } from "../sidebar/useSidebarColors.ts";
import { SessionRowView, UnitRowView } from "./manage/ManageRows.tsx";
import {
  BulkRunSheet,
  DeleteSessionSheet,
  DeleteUnitSheet,
  FilterSheet,
  MenuSheet,
  RehomeSheet,
  RenameSheet,
  TrashSheet,
  failureText,
  type BulkJob,
  type MenuEntry,
} from "./manage/ManageSheets.tsx";

const VIEW_KEY = "maru_manage_view";
/** Read once to carry an earlier build's view and level into the one view, then deleted. */
const OLD_LEVEL_KEY = "maru_manage_level";
/** The search, kept while the app lives (the web keeps it across tab switches and closing settings). */
let keptQuery = "";

type DeleteResult = { kind: "session"; outcome: "trashed" | "deleted"; sizeBytes: number; threads: number } | { kind: "orphan"; freedBytes: number };

type Dialog =
  | { kind: "menu"; row: ManageRow }
  | { kind: "unitMenu"; unit: UnitRow }
  | { kind: "rename"; session: SessionSummary }
  | { kind: "move"; row: ManageRow }
  | { kind: "rehome"; session: SessionSummary }
  | { kind: "delete"; session: SessionSummary }
  | { kind: "unitDelete"; unit: UnitRow }
  | { kind: "bulk"; seq: number; job: BulkJob<ManageRow, DeleteResult> }
  | { kind: "purgeAll"; seq: number; job: BulkJob<TrashItem, PurgeTrashResult> }
  | { kind: "filter" }
  | { kind: "bulkMenu" }
  | { kind: "trash" };

type Notice = { tone: "error" | "info"; text: string };

// The web's row menu icons (ManageRows.tsx).
const ICON: Record<RowActionId, LucideIcon> = {
  open: MessageSquareIcon,
  rename: PencilIcon,
  copyResume: CopyIcon,
  toggleList: ListPlusIcon,
  subagents: BotIcon,
  workflows: WorkflowIcon,
  rehome: FolderInputIcon,
  move: ArrowRightLeftIcon,
  delete: Trash2Icon,
};

/** Deletes one row: a session through the trash rule, an orphan for good. */
function deleteRowWith(pairing: Pairing) {
  return async (r: ManageRow): Promise<DeleteResult> => {
    if (r.kind === "session") {
      const s = r.session;
      const d = await deleteSession(pairing, { provider: s.provider, account: s.account, id: s.id });
      return { kind: "session", outcome: d.outcome, sizeBytes: d.sizeBytes, threads: d.ids.length };
    }
    const o = r.orphan;
    const d = await deleteOrphan(pairing, { provider: o.provider, account: o.account, id: o.id });
    return { kind: "orphan", freedBytes: d.freedBytes };
  };
}

export function ManageTab(props: {
  pairing: Pairing;
  /** The list's sessions as /ws keeps them. */
  sessions: ReadonlyMap<string, SessionSummary>;
  now: number;
  onOpenSession: (key: string) => void;
  /** A session moved to another account: its key changed. */
  onRekey: (from: string, to: string) => void;
}) {
  const { pairing } = props;
  const p = usePalette();
  const c = useChrome();
  const sc = useSidebarColors();
  const listed = useMemo(() => [...props.sessions.values()], [props.sessions]);

  // ---- Data: the list over /ws; candidates, orphans, units, accounts and the trash read here, again after writes ----
  const [candidates, setCandidates] = useState<SessionSummary[] | null>(null);
  const [orphans, setOrphans] = useState<OrphanList | null>(null);
  const [units, setUnits] = useState<UnitRow[] | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [trash, setTrash] = useState<TrashList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const seq = useRef({ c: 0, o: 0, u: 0 });
  const fail = (what: string) => (err: unknown) => setLoadError(`${what}: ${failureText(err)}`);
  const reloadCandidates = () => {
    const mine = ++seq.current.c;
    fetchAllCandidates(pairing)
      .then((all) => mine === seq.current.c && setCandidates(all))
      .catch(fail("Could not read the sessions outside the list"));
  };
  const reloadOrphans = () => {
    const mine = ++seq.current.o;
    fetchOrphans(pairing)
      .then((o) => mine === seq.current.o && setOrphans(o))
      .catch(fail("Could not read the orphans"));
  };
  const reloadUnits = () => {
    const mine = ++seq.current.u;
    fetchAllUnits(pairing)
      .then((u) => mine === seq.current.u && setUnits(u.units))
      .catch(fail("Could not read the subagents and workflows"));
  };
  const refreshTrash = () => {
    fetchTrash(pairing).then(setTrash, () => undefined);
  };
  const listedKeys = useMemo(() => listed.filter((s) => !s.parentKey).map((s) => s.key).sort().join("\n"), [listed]);
  useEffect(() => {
    reloadCandidates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listedKeys]);
  useEffect(() => {
    reloadOrphans();
    reloadUnits();
    refreshTrash();
    fetchAccounts(pairing).then(setAccounts, () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const reloadAll = () => {
    reloadCandidates();
    reloadOrphans();
    reloadUnits();
  };

  // ---- View, filters, sort, page (the view is remembered on this phone; an earlier build's view and level are carried over) ----
  const [view, setViewState] = useState<ManageView>(DEFAULT_MANAGE_VIEW);
  useEffect(() => {
    let live = true;
    void Promise.all([SecureStore.getItemAsync(VIEW_KEY), SecureStore.getItemAsync(OLD_LEVEL_KEY)]).then(
      ([v, l]) => {
        if (!live) return;
        const next = migrateManageView(v, l);
        setViewState(next);
        void SecureStore.setItemAsync(VIEW_KEY, next).catch(() => undefined);
        void SecureStore.deleteItemAsync(OLD_LEVEL_KEY).catch(() => undefined);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  const store = (key: string, value: string) => void SecureStore.setItemAsync(key, value).catch(() => undefined);
  const [parent, setParent] = useState<string | null>(null);
  const [query, setQueryState] = useState(keptQuery);
  const setQuery = (next: string) => {
    keptQuery = next;
    setQueryState(next);
  };
  const [fields, setFields] = useState<FilterFields>(EMPTY_FIELDS);
  const [sort, setSort] = useState<ManageSort>(DEFAULT_MANAGE_SORT);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const bulkSeq = useRef(0);

  const resetPaging = () => {
    setPage(1);
    setSelected(new Set());
    setParent(null);
  };
  const setView = (v: ManageView) => {
    setViewState(v);
    store(VIEW_KEY, v);
    resetPaging();
  };

  const filter = filterOfFields(query, fields);
  const facets = facetCount(filter);

  // Narrowed to one session, its units are named by its session-agents list (null while reading or when it cannot be read).
  const [unitLabels, setUnitLabels] = useState<{ parent: string; labels: Map<string, UnitLabel> } | null>(null);
  const unitLevel = unitKindOfView(view) !== null;
  useEffect(() => {
    if (!parent || !unitLevel) return;
    const [account, ...rest] = parent.split(":");
    if (!account || !rest.length) return;
    let live = true;
    fetchUnitLabels(pairing, account, rest.join(":"))
      .then((labels) => live && setUnitLabels({ parent, labels }))
      .catch(() => {
        // The rows fall back to their unit ids.
      });
    return () => {
      live = false;
    };
  }, [parent, unitLevel, units, pairing]);
  const labelsNow = parent && unitLabels?.parent === parent ? unitLabels.labels : null;
  const unitName = parent ? (u: UnitRow) => labelsNow?.get(u.unitId)?.title ?? u.unitId : undefined;

  const m = manageViewModel({
    listed,
    candidates,
    orphans: orphans?.sessions ?? null,
    units,
    view,
    parent,
    filter,
    sort,
    page,
    selected,
    ...(unitName ? { unitName } : {}),
  });
  const accountOptions = [
    ...new Set([
      ...accounts.filter((a) => fields.provider === "all" || a.provider === fields.provider).map((a) => a.id),
      ...m.allRows.filter((r) => fields.provider === "all" || rowProvider(r) === fields.provider).map(rowAccount),
    ]),
  ].sort();

  const sessionByUnitKey = useMemo(() => {
    const map = new Map<string, SessionSummary>();
    for (const r of m.allRows) if (r.kind === "session" && r.session.provider === "claude") map.set(unitGroupKey(r.session.account, r.session.id), r.session);
    return map;
  }, [m.allRows]);
  const unitKindsBySession = useMemo(() => {
    const map = new Map<string, { subagent: number; workflow: number }>();
    for (const u of units ?? []) {
      const k = unitGroupKey(u.account, u.id);
      const n = map.get(k) ?? { subagent: 0, workflow: 0 };
      n[u.kind]++;
      map.set(k, n);
    }
    return map;
  }, [units]);

  // Selected rows the table stops showing (search, filter, page, a delete elsewhere) leave the selection.
  const knownKeys = useMemo(() => new Set(m.allRows.map((r) => r.key)), [m.allRows]);
  const shownRows = m.unitKind ? [] : m.rowsPage.rows;
  useEffect(() => {
    const kept = pruneSelection(selected, shownRows, knownKeys);
    if (kept) setSelected(kept);
  });
  const toggle = (keys: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  // ---- Writes ----
  const failNotice = (title: string) => (err: unknown) => setNotice({ tone: "error", text: `${title}: ${failureText(err)}` });
  const startBulk = (plan: BulkPlan) => {
    setDialog({
      kind: "bulk",
      seq: ++bulkSeq.current,
      job: {
        title: plan.title,
        description: bulkDescription(plan),
        confirmLabel: "Delete",
        items: plan.items,
        label: bulkItemLabel,
        sublabel: bulkItemSub,
        run: deleteRowWith(pairing),
        detail: deleteDetail,
        onFinished: (results) => {
          toggle(results.filter((x) => x.ok).map((x) => x.item.key), false);
          refreshTrash();
          reloadAll();
        },
      },
    });
  };
  const purgeAll = () => {
    const items = [...(trash?.items ?? [])].sort((a, b) => b.deletedAt - a.deletedAt);
    setDialog({
      kind: "purgeAll",
      seq: ++bulkSeq.current,
      job: {
        title: `Delete all ${items.length} trashed ${items.length === 1 ? "item" : "items"} for good?`,
        description: `This cannot be undone. ${formatSize(trash?.totalBytes ?? 0)}`,
        confirmLabel: "Delete for good",
        items,
        label: (t) => t.name || t.id,
        sublabel: (t) => `${shortAccount(t.account)}, ${formatSize(t.sizeBytes)}`,
        run: (t) => purgeTrash(pairing, t.key),
        detail: (r) => `${formatSize(r.freedBytes)} freed`,
        onFinished: () => refreshTrash(),
      },
    });
  };

  const runRowAction = (r: ManageRow, id: RowActionId) => {
    const s = r.kind === "session" ? r.session : null;
    setDialog(null);
    setNotice(null);
    switch (id) {
      case "open":
        if (s) props.onOpenSession(s.key);
        return;
      case "rename":
        if (s) setDialog({ kind: "rename", session: s });
        return;
      case "copyResume":
        if (!s) return;
        resumeCommand(pairing, { provider: s.provider, account: s.account, id: s.id })
          .then(async (cmd) => {
            await Clipboard.setStringAsync(cmd.command);
            setNotice({ tone: "info", text: `Resume command copied: ${cmd.command}` });
          })
          .catch(failNotice("Could not copy the resume command"));
        return;
      case "toggleList":
        if (!s || r.kind !== "session") return;
        chooseSession(pairing, { provider: s.provider, id: s.id, chosen: !r.inList })
          .then(() => {
            // In the list means locked, so adding drops it from the selection (a lock cannot be deleted).
            if (!r.inList) toggle([r.key], false);
            reloadCandidates();
          })
          .catch(failNotice(r.inList ? "Could not remove it from the list" : "Could not add it to the list"));
        return;
      case "subagents":
      case "workflows": {
        if (!s) return;
        const next: ManageView = id === "subagents" ? "subagents" : "workflows";
        setViewState(next);
        store(VIEW_KEY, next);
        setParent(unitGroupKey(s.account, s.id));
        setPage(1);
        setSelected(new Set());
        return;
      }
      case "rehome":
        if (s) setDialog({ kind: "rehome", session: s });
        return;
      case "move":
        setDialog({ kind: "move", row: r });
        return;
      case "delete":
        if (s) setDialog({ kind: "delete", session: s });
        else startBulk({ title: "Delete leftover files?", notes: ["They are deleted for good, without the trash"], items: [r] });
        return;
    }
  };
  const moveTo = (s: SessionSummary, to: string) => {
    setDialog(null);
    setNotice(null);
    moveSession(pairing, { provider: s.provider, id: s.id, from: s.account, to })
      .then((res) => {
        setNotice({ tone: "info", text: `Moved to ${to}: ${res.resumeCommand}` });
        props.onRekey(s.key, `${s.provider}:${to}:${s.id}`);
        reloadAll();
      })
      .catch(failNotice("Could not move it to another account"));
  };

  // ---- Unit level: the parent filter's banner, with the subtree totals ----
  const [parentDetail, setParentDetail] = useState<SessionUnits | { error: string } | null>(null);
  useEffect(() => {
    setParentDetail(null);
    if (!parent) return;
    const [account, ...rest] = parent.split(":");
    if (!account || !rest.length) return;
    let live = true;
    fetchSessionUnits(pairing, account, rest.join(":"))
      .then((d) => live && setParentDetail(d))
      .catch((err: unknown) => live && setParentDetail({ error: failureText(err) }));
    return () => {
      live = false;
    };
  }, [parent, units, pairing]);
  const parentName = (account: string, id: string, fallback: string | null) => {
    const s = sessionByUnitKey.get(unitGroupKey(account, id));
    return s ? displayName(s) : fallback || id.slice(0, 8);
  };
  const banner =
    m.unitKind && parent
      ? (() => {
          const [account, ...rest] = parent.split(":");
          const id = rest.join(":");
          const any = (units ?? []).find((u) => unitGroupKey(u.account, u.id) === parent);
          return { name: parentName(account ?? "", id, any?.name ?? null) };
        })()
      : null;
  const bannerDetail =
    parentDetail && !("error" in parentDetail)
      ? `Subtree ${formatSize(parentDetail.totalBytes)}, units ${formatSize(parentDetail.unitBytes)}${parentDetail.remainderBytes > 0 ? `, other files ${formatSize(parentDetail.remainderBytes)}` : ""}`
      : parentDetail
        ? parentDetail.error
        : "Reading size";

  // ---- Menus ----
  const menuEntries = (r: ManageRow): MenuEntry[] => {
    const s = r.kind === "session" ? r.session : null;
    const counts = s ? unitKindsBySession.get(unitGroupKey(s.account, s.id)) : undefined;
    return rowActions(r, {
      listedKeys: new Set(listed.map((x) => x.key)),
      unitCounts: counts ?? null,
      moveTargets: moveTargets(r, accounts).length,
    }).map((a) => ({
      key: a.id,
      label: a.label,
      icon: a.id === "toggleList" && r.kind === "session" && !r.inList ? ListPlusIcon : a.id === "toggleList" ? ListMinusIcon : ICON[a.id],
      detail: a.detail,
      disabled: a.disabled,
      destructive: a.destructive,
      onPress: () => runRowAction(r, a.id),
    }));
  };
  const unitEntries = (u: UnitRow): MenuEntry[] => {
    const k = unitGroupKey(u.account, u.id);
    const owner = sessionByUnitKey.get(k);
    const blocked = unitDeleteBlock(u);
    return [
      {
        key: "filter",
        label: parent ? "Show units of all sessions" : `Show only this session's ${u.kind}s`,
        icon: ListFilterIcon,
        onPress: () => {
          setDialog(null);
          setParent((cur) => (cur === k ? null : k));
          setPage(1);
        },
      },
      ...(owner && props.sessions.has(owner.key)
        ? [{ key: "parent", label: "Open parent conversation", icon: MessageSquareIcon, onPress: () => { setDialog(null); props.onOpenSession(owner.key); } }]
        : []),
      { key: "delete", label: "Delete for good", icon: Trash2Icon, destructive: true, disabled: blocked !== null, detail: blocked, onPress: () => setDialog({ kind: "unitDelete", unit: u }) },
    ];
  };

  const pv = m.pageView;
  const narrowed = filterActive(filter) || parent !== null;

  return (
    <>
      <SettingsSection
        title="Sessions"
      >
        {/* One row of views; it scrolls sideways where the five do not fit */}
        <View style={styles.views}>
          <Segmented
            scroll
            label="Session view"
            items={MANAGE_VIEWS.map((v) => ({ value: v, label: `${MANAGE_VIEW_LABEL[v]} ${m.counts[v] ?? "-"}` }))}
            value={view}
            onPick={(v) => setView(v as ManageView)}
          />
        </View>
        {/* Search line: the filter, the ⋮ menu and the trash sit at its end */}
        <View style={styles.toolbar}>
          <View style={styles.search}>
            <TextField
              value={query}
              onChangeText={(t) => {
                setQuery(t);
                setPage(1);
              }}
              placeholder="Name, first prompt, path, ID, account"
              accessibilityLabel="Search sessions"
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
            />
            {query ? (
              <Press onPress={() => setQuery("")} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10} style={styles.clear}>
                <XIcon size={14} color={p.muted} />
              </Press>
            ) : null}
          </View>
          <View>
            <Btn size="icon" variant={facets > 0 ? "outline" : "ghost-muted"} accessibilityLabel={facets ? `Filter and sort, ${facets} set` : "Filter and sort"} icon={<FunnelIcon size={16} color={facets > 0 ? p.text : p.muted} />} onPress={() => setDialog({ kind: "filter" })} />
            {facets ? <View pointerEvents="none" style={styles.corner}><Badge variant="info" label={String(facets)} /></View> : null}
          </View>
          <Btn size="icon" variant="ghost-muted" accessibilityLabel="Session actions" icon={<MoreHorizontalIcon size={16} color={p.muted} />} onPress={() => setDialog({ kind: "bulkMenu" })} />
          <View>
            <Btn size="icon" variant="ghost-muted" accessibilityLabel={trash?.items.length ? `Trash, ${trash.items.length} items` : "Trash"} icon={<Trash2Icon size={16} color={p.muted} />} onPress={() => { refreshTrash(); setDialog({ kind: "trash" }); }} />
            {trash?.items.length ? <View pointerEvents="none" style={styles.corner}><Badge variant="info" label={String(trash.items.length)} /></View> : null}
          </View>
        </View>

        {/* Filter result and selection deletes */}
        {m.filteredDeletable.length || m.selectedRows.length ? (
          <View style={styles.bulk}>
            {m.selectedRows.length ? <Btn size="xs" variant="ghost-muted" label="Clear selection" onPress={() => setSelected(new Set())} /> : null}
            {m.filteredDeletable.length ? (
              <Btn size="xs" variant="destructive-outline" label={`Delete filter result (${m.filteredDeletable.length})`} icon={<Trash2Icon size={14} color={c.errorForeground} />} onPress={() => startBulk(filteredPlan(m.matchedRows, m.filteredDeletable))} />
            ) : null}
            {m.selectedRows.length ? (
              <Btn size="xs" variant="destructive-outline" label={`Delete selected (${m.selectedRows.length})`} icon={<Trash2Icon size={14} color={c.errorForeground} />} onPress={() => startBulk(selectedPlan(m.selectedRows))} />
            ) : null}
          </View>
        ) : null}

        {notice ? (
          <View style={{ paddingVertical: 6 }}>
            {notice.tone === "error" ? <ErrorBox message={notice.text} /> : <NoticeBox embedded message={notice.text} onClose={() => setNotice(null)} />}
          </View>
        ) : null}

        {loadError ? (
          <View style={styles.errorLine}>
            <Text accessibilityRole="alert" style={[ui.sm, { color: c.errorForeground, flex: 1 }]}>{loadError}</Text>
            <Btn size="xs" variant="outline" label="Read again" onPress={() => { setLoadError(null); reloadAll(); }} />
          </View>
        ) : null}

        {banner ? (
          <View style={[styles.banner, { backgroundColor: sc.badge.info.bg }]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[ui.xs, { color: p.text }]} numberOfLines={1}>{`${banner.name}'s ${m.unitKind === "subagent" ? "subagents" : "workflows"}`}</Text>
              <Text style={[ui.xs, { color: p.muted }]} numberOfLines={2}>{bannerDetail}</Text>
            </View>
            <Btn size="xs" variant="ghost-muted" label="Show all" icon={<XIcon size={14} color={p.muted} />} onPress={() => setParent(null)} />
          </View>
        ) : null}

        {!m.unitKind && m.pageSelectable.length > 0 ? (
          <View style={styles.selectAll}>
            <Checkbox
              label="Select every deletable session on this page"
              checked={m.pageAllSelected}
              onChange={(on) => toggle(m.pageSelectable.map((r) => r.key), on)}
            />
            <Text style={[ui.xs, { color: p.muted }]}>{`Select all on this page (${m.pageSelectable.length})`}</Text>
          </View>
        ) : null}

        {m.unitKind
          ? m.unitsPage.rows.map((u) => {
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
                  onPress={() => {
                    if (parent !== null) setDialog({ kind: "unitMenu", unit: u });
                    else {
                      setParent(unitGroupKey(u.account, u.id));
                      setPage(1);
                    }
                  }}
                  onMenu={() => setDialog({ kind: "unitMenu", unit: u })}
                />
              );
            })
          : m.rowsPage.rows.map((r) => (
              <SessionRowView
                key={r.key}
                row={r}
                now={props.now}
                selected={selected.has(r.key)}
                onSelect={(on) => toggle([r.key], on)}
                onPress={() => (r.kind === "session" && props.sessions.has(r.key) ? runRowAction(r, "open") : setDialog({ kind: "menu", row: r }))}
                onMenu={() => setDialog({ kind: "menu", row: r })}
              />
            ))}
        {pv.rows.length === 0 ? (
          <View style={styles.empty}>
            <Text style={[ui.sm, { color: p.muted }]}>{emptyText(m, { unitsRead: units !== null, rowsRead: candidates !== null && orphans !== null, view })}</Text>
          </View>
        ) : null}
        <View style={styles.pager}>
          {pv.pages > 1 ? (
            <View style={styles.pages}>
              <Btn size="xs" variant="ghost-muted" accessibilityLabel="Previous page" icon={<ChevronLeftIcon size={14} color={p.muted} />} disabled={pv.page <= 1} onPress={() => setPage(pv.page - 1)} />
              {pagerItems(pv.page, pv.pages).map((n, i) =>
                n === null ? (
                  <Text key={`gap-${i}`} style={[ui.xs, { color: p.muted, paddingHorizontal: 4 }]}>...</Text>
                ) : (
                  <Btn key={n} size="xs" variant={n === pv.page ? "outline" : "ghost-muted"} label={String(n)} onPress={() => setPage(n)} />
                ),
              )}
              <Btn size="xs" variant="ghost-muted" accessibilityLabel="Next page" icon={<ChevronRightIcon size={14} color={p.muted} />} disabled={pv.page >= pv.pages} onPress={() => setPage(pv.page + 1)} />
            </View>
          ) : null}
          <Text accessibilityLiveRegion="polite" style={[ui.xs, { color: p.muted, fontVariant: ["tabular-nums"] }]}>{pagerInfo(m, narrowed)}</Text>
        </View>
      </SettingsSection>

      {dialog?.kind === "menu" ? (
        <MenuSheet open title={rowLabel(dialog.row)} description={dialog.row.kind === "orphan" ? "Leftover files without a transcript" : null} entries={menuEntries(dialog.row)} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "unitMenu" ? (
        <MenuSheet open title={`${dialog.unit.kind} ${dialog.unit.unitId}`} entries={unitEntries(dialog.unit)} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "rename" ? (
        <RenameSheet
          open
          initial={dialog.session.name ?? ""}
          onClose={() => setDialog(null)}
          onSave={async (name) => {
            const s = dialog.session;
            await renameSession(pairing, { provider: s.provider, account: s.account, id: s.id, name });
            reloadCandidates();
          }}
        />
      ) : null}
      {dialog?.kind === "move" && dialog.row.kind === "session" ? (
        <MenuSheet
          open
          title="Move to another account"
          description={`${rowLabel(dialog.row)} is in ${rowAccount(dialog.row)}`}
          entries={moveTargets(dialog.row, accounts).map((t) => ({
            key: t.id,
            label: shortAccount(t.id),
            icon: UserRoundIcon,
            detail: t.id,
            onPress: () => moveTo((dialog.row as Extract<ManageRow, { kind: "session" }>).session, t.id),
          }))}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "rehome" ? (
        <RehomeSheet
          open
          pairing={pairing}
          session={dialog.session}
          folders={recentCwds(listed)}
          onClose={() => setDialog(null)}
          onSave={async (cwd) => {
            const s = dialog.session;
            const res = await rehomeSession(pairing, { provider: "claude", account: s.account, id: s.id, cwd });
            setNotice({ tone: "info", text: `Working folder changed to ${res.cwd}, ${res.cwdRewritten} cwd ${res.cwdRewritten === 1 ? "line" : "lines"} rewritten` });
            reloadAll();
          }}
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <DeleteSessionSheet
          open
          pairing={pairing}
          session={dialog.session}
          onClose={() => setDialog(null)}
          onDelete={async () => {
            const s = dialog.session;
            await deleteSession(pairing, { provider: s.provider, account: s.account, id: s.id });
            toggle([s.key], false);
            refreshTrash();
            reloadAll();
          }}
        />
      ) : null}
      {dialog?.kind === "unitDelete" ? (
        <DeleteUnitSheet
          open
          unit={dialog.unit}
          onClose={() => setDialog(null)}
          onDelete={async () => {
            const u = dialog.unit;
            await deleteUnit(pairing, { provider: "claude", account: u.account, id: u.id, kind: u.kind, unitId: u.unitId });
            reloadUnits();
          }}
        />
      ) : null}
      {dialog?.kind === "bulk" ? <BulkRunSheet key={dialog.seq} open job={dialog.job} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "purgeAll" ? <BulkRunSheet key={dialog.seq} open job={dialog.job} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "filter" ? (
        <FilterSheet
          open
          fields={fields}
          facets={facets}
          accounts={accountOptions}
          sort={sortValue(sort)}
          onSort={(v) => {
            setSort(parseSort(v));
            setPage(1);
          }}
          onChange={(next) => {
            setFields(next);
            setPage(1);
          }}
          onReset={() => setFields(EMPTY_FIELDS)}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "bulkMenu" ? (
        <MenuSheet
          open
          title="Session actions"
          entries={[
            {
              key: "deleteUnlocked",
              label: "Delete all except locked",
              icon: Trash2Icon,
              destructive: true,
              disabled: m.unlockedAll.length === 0,
              detail: String(m.unlockedAll.length),
              onPress: () => startBulk(unlockedPlan(m.allRows, m.unlockedAll)),
            },
          ]}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "trash" ? (
        <TrashSheet open pairing={pairing} list={trash} onChanged={refreshTrash} onPurgeAll={purgeAll} onClose={() => setDialog(null)} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  views: { paddingHorizontal: 12 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 12 },
  search: { flex: 1, minWidth: 0, justifyContent: "center" },
  clear: { position: "absolute", right: 6, width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 4 },
  // A count over a toolbar button's corner (Badge sm).
  corner: { position: "absolute", top: -6, right: -6 },
  bulk: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  errorLine: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 8 },
  banner: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 8 },
  selectAll: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 10 },
  empty: { paddingHorizontal: 12, paddingVertical: 16 },
  pager: { alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 10 },
  pages: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 4 },
});
