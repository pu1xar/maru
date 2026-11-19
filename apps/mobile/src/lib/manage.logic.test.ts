import { test } from "node:test";
import assert from "node:assert/strict";
import type { AccountInfo, OrphanSession, SessionSummary, TrashItem, TrashList, UnitRow } from "@maru/shared";
import { DEFAULT_MANAGE_SORT, EMPTY_FILTER, type ManageFilter, type ManageRow } from "../../../web/src/components/settings/manageModel.ts";
import {
  MANAGE_PAGE_SIZE,
  SORT_OPTIONS,
  bulkDescription,
  bulkProgress,
  deleteBlock,
  deleteDescription,
  deleteDetail,
  emptyText,
  filteredPlan,
  manageViewModel,
  moveTargets,
  pagerInfo,
  parseSort,
  rowActions,
  selectedPlan,
  sessionMeta,
  sortValue,
  trashEntries,
  trashSummary,
  unitDeleteBlock,
  unlockedPlan,
  type ManageInput,
} from "./manage.logic.ts";

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  const provider = over.provider ?? "claude";
  const account = over.account ?? "claude-a";
  return {
    key: `${provider}:${account}:${id}`, provider, account, id, cwd: "/Users/me/w", name: id, title: null,
    preview: null, status: "closed", owner: "none", pid: null, tmuxPane: null, parentKey: null,
    updatedAt: 1000, createdAt: null, sizeBytes: 2048, entrypoint: null, projectId: null, locked: false,
    ...over,
  };
}
const orphan = (id: string, over: Partial<OrphanSession> = {}): OrphanSession => ({
  provider: "claude", account: "claude-a", id, paths: ["/Users/me/.claude/projects/-w/x"], files: 1, sizeBytes: 100, updatedAt: 5, locked: false, open: false, ...over,
});
const unit = (id: string, unitId: string, over: Partial<UnitRow> = {}): UnitRow => ({
  kind: unitId.startsWith("wf_") ? "workflow" : "subagent", unitId, sizeBytes: 10, files: 1, updatedAt: 0, account: "claude-a", id, name: id, enc: "-w", open: false, locked: false, ...over,
});

function input(over: Partial<ManageInput> = {}): ManageInput {
  return {
    listed: [], candidates: [], orphans: [], units: [], view: "all", parent: null,
    filter: EMPTY_FILTER, sort: DEFAULT_MANAGE_SORT, page: 1, selected: new Set(), ...over,
  };
}

test("every view's count comes from the same whole, and each view holds what its count says", () => {
  const data = {
    listed: [session("a"), session("b", { locked: true })],
    candidates: [session("c")],
    orphans: [orphan("o")],
    units: [unit("a", "agent-1"), unit("a", "agent-2"), unit("a", "wf_1")],
  };
  const m = manageViewModel(input(data));
  assert.equal(m.allRows.length, 4);
  assert.deepEqual(m.counts, { all: 4, locked: 1, subagents: 2, workflows: 1, orphans: 1 });
  const totals = (view: ManageInput["view"]) => manageViewModel(input({ ...data, view })).total;
  assert.deepEqual(
    (["all", "locked", "subagents", "workflows", "orphans"] as const).map(totals),
    [4, 1, 2, 1, 1],
    "the table holds as many as the button says",
  );
  // Locking a session leaves the All view as it is (the row stays) and moves the Locked count.
  const locked = manageViewModel(input({ ...data, listed: [session("a", { locked: true }), session("b", { locked: true })] }));
  assert.equal(locked.counts.all, 4);
  assert.equal(locked.counts.locked, 2);
  assert.equal(locked.rowsPage.rows.some((r) => r.key === "claude:claude-a:a"), true);
  // Not read yet is not zero; an orphan view with no orphans reads zero.
  const unread = manageViewModel(input({ units: null, candidates: null, orphans: null }));
  assert.deepEqual([unread.counts.subagents, unread.counts.all, unread.counts.orphans], [null, null, null]);
  assert.equal(manageViewModel(input({ listed: [session("a")] })).counts.orphans, 0);
});

test("an empty search result points at the other views that match", () => {
  const data = {
    listed: [session("a", { name: "alpha", locked: true })],
    orphans: [orphan("zeta1")],
    units: [unit("a", "agent-1", { name: "alpha" }), unit("a", "wf_1", { name: "alpha" })],
  };
  const filter: ManageFilter = { ...EMPTY_FILTER, query: "alpha" };
  const m = manageViewModel(input({ ...data, view: "orphans", filter }));
  assert.equal(m.matched, 0);
  assert.equal(m.hint, "No matches here. 1 in All, 1 in Locked, 1 in Subagents, 1 in Workflows");
  assert.equal(emptyText(m, { unitsRead: true, rowsRead: true, view: "orphans" }), m.hint);
  assert.equal(manageViewModel(input({ ...data, view: "subagents", filter: { ...EMPTY_FILTER, query: "nothing" } })).hint, null, "no match anywhere");
  assert.equal(manageViewModel(input({ ...data, view: "orphans" })).hint, null, "no search, no hint");
  assert.equal(manageViewModel(input({ ...data, view: "orphans", filter, parent: "claude-a:a" })).hint, null, "narrowed to a session, no hint");
});

test("a search and a filter narrow the rows, and the delete of that result takes the deletable ones", () => {
  const filter: ManageFilter = { ...EMPTY_FILTER, query: "alpha" };
  const m = manageViewModel(input({
    listed: [session("1", { name: "alpha one" }), session("2", { name: "alpha busy", status: "running" }), session("3", { name: "beta" })],
    filter,
  }));
  assert.equal(m.matched, 2);
  assert.equal(m.total, 3);
  assert.deepEqual(m.filteredDeletable.map((r) => r.key), ["claude:claude-a:1"]);
  assert.equal(manageViewModel(input({ listed: [session("1")] })).filteredDeletable.length, 0, "no search, no filter result");
});

test("selection counts only deletable rows shown on the page", () => {
  const listed = [session("1"), session("2", { status: "running" }), session("3", { locked: true }), session("4")];
  const m = manageViewModel(input({ listed, selected: new Set(listed.map((s) => s.key)) }));
  // The locked and the running one are shown but not deletable.
  assert.deepEqual(m.selectedRows.map((r) => r.key).sort(), ["claude:claude-a:1", "claude:claude-a:4"]);
  assert.equal(m.pageAllSelected, true);
  const part = manageViewModel(input({ listed, selected: new Set(["claude:claude-a:1"]) }));
  assert.equal(part.pageAllSelected, false);
  assert.equal(part.pageSelectable.length, 2);
});

test("a view of units pages and narrows to one session's units, named by its labels", () => {
  const units = [unit("a", "agent-1"), unit("b", "agent-2"), unit("a", "wf_1")];
  const m = manageViewModel(input({ view: "subagents", units }));
  assert.equal(m.unitKind, "subagent");
  assert.equal(m.total, 2);
  assert.equal(m.rowsPage.rows.length, 0);
  const narrowed = manageViewModel(input({ view: "subagents", units, parent: "claude-a:a", unitName: (u) => `name ${u.unitId}` }));
  assert.deepEqual(narrowed.unitsPage.rows.map((u) => u.unitId), ["agent-1"]);
  assert.equal(narrowed.filteredDeletable.length, 0);
  assert.equal(narrowed.selectedRows.length, 0);
});

test("a page holds 100 rows, and the pager says the shown range past one page", () => {
  const listed = Array.from({ length: 230 }, (_, i) => session(`s${i}`, { updatedAt: i }));
  const m = manageViewModel(input({ listed, page: 3 }));
  assert.equal(MANAGE_PAGE_SIZE, 100);
  assert.equal(m.rowsPage.rows.length, 30);
  assert.equal(pagerInfo(m, false), "230, showing 201-230");
  assert.equal(pagerInfo(manageViewModel(input({ listed: [session("a")] })), false), "1");
  assert.equal(pagerInfo(manageViewModel(input({ listed, filter: { ...EMPTY_FILTER, query: "s1" } })), true).startsWith("111 of 230"), true);
});

test("empty texts", () => {
  const e = { unitKind: null, matched: 0, total: 0, hint: null } as const;
  assert.equal(emptyText(e, { unitsRead: true, rowsRead: false, view: "all" }), "Reading sessions");
  assert.equal(emptyText(e, { unitsRead: true, rowsRead: true, view: "locked" }), "No locked sessions");
  assert.equal(emptyText(e, { unitsRead: true, rowsRead: true, view: "all" }), "No sessions");
  assert.equal(emptyText(e, { unitsRead: true, rowsRead: true, view: "orphans" }), "No orphans");
  assert.equal(emptyText({ ...e, unitKind: "subagent" }, { unitsRead: false, rowsRead: true, view: "subagents" }), "Reading units");
  assert.equal(emptyText({ ...e, unitKind: "workflow" }, { unitsRead: true, rowsRead: true, view: "workflows" }), "No workflows");
  assert.equal(emptyText({ unitKind: null, matched: 0, total: 4, hint: null }, { unitsRead: true, rowsRead: true, view: "all" }), "No matches here");
  assert.equal(emptyText({ unitKind: null, matched: 0, total: 4, hint: "No matches here. 3 in Subagents" }, { unitsRead: true, rowsRead: true, view: "all" }), "No matches here. 3 in Subagents");
});

test("the table shows no open or closed state: no label or status in a row's text", () => {
  const row: ManageRow = { kind: "session", key: "k", session: session("a", { status: "open-idle" }), inList: true };
  assert.doesNotMatch(sessionMeta(row, 2000), /open|closed|열림|닫힘/i);
  const actions = rowActions(row, { listedKeys: new Set(["k"]), unitCounts: null, moveTargets: 0 });
  assert.equal(actions.every((a) => !/열림|닫힘/.test(a.label + (a.detail ?? ""))), true);
});

test("sort choices: each column both ways, round-tripping through their value", () => {
  assert.equal(SORT_OPTIONS.length, 10);
  assert.equal(new Set(SORT_OPTIONS.map((o) => o.value)).size, 10);
  for (const o of SORT_OPTIONS) assert.equal(sortValue(parseSort(o.value)), o.value);
  assert.deepEqual(parseSort(sortValue(DEFAULT_MANAGE_SORT)), DEFAULT_MANAGE_SORT);
  assert.deepEqual(parseSort("nonsense"), DEFAULT_MANAGE_SORT);
  assert.deepEqual(parseSort("size:2"), DEFAULT_MANAGE_SORT);
});

test("a session row's menu follows the web's order, with the reason an action cannot run", () => {
  const r = (over: Partial<SessionSummary>, inList = true): ManageRow => ({ kind: "session", key: `claude:claude-a:x`, session: session("x", over), inList });
  const ctx = { listedKeys: new Set(["claude:claude-a:x"]), unitCounts: { subagent: 2, workflow: 1 }, moveTargets: 1 };
  const closed = rowActions(r({}), ctx);
  assert.deepEqual(closed.map((a) => a.id), ["open", "rename", "copyResume", "toggleList", "subagents", "workflows", "rehome", "move", "delete"]);
  assert.equal(closed.every((a) => !a.disabled), true);
  assert.equal(closed.find((a) => a.id === "subagents")?.detail, "2");
  assert.equal(closed.find((a) => a.id === "toggleList")?.label, "Remove from list");
  assert.equal(closed.find((a) => a.id === "delete")?.destructive, true);
  const busy = rowActions(r({ status: "running" }), ctx);
  const byId = Object.fromEntries(busy.map((a) => [a.id, a]));
  for (const id of ["copyResume", "rehome", "move", "delete"] as const) assert.deepEqual([byId[id]!.disabled, byId[id]!.detail], [true, "In use"], id);
  assert.equal(byId.rename!.disabled, false);
  const locked = rowActions(r({ locked: true }), ctx);
  assert.deepEqual([locked.find((a) => a.id === "delete")!.disabled, locked.find((a) => a.id === "delete")!.detail], [true, "Locked"]);
  assert.equal(locked.find((a) => a.id === "toggleList")!.detail ?? null, null, "no explanation on Locked (user decision 2026-11-19)");
  // Off the list the phone cannot open it; Codex has no folder change; no other account, no move.
  const off = rowActions(r({ provider: "codex", account: "codex-a" }, false), { ...ctx, listedKeys: new Set(), unitCounts: null, moveTargets: 0 });
  assert.deepEqual(off.map((a) => a.id), ["open", "rename", "copyResume", "toggleList", "delete"]);
  assert.deepEqual([off[0]!.disabled, off[0]!.detail], [true, "Not in the list"]);
  assert.equal(off.find((a) => a.id === "toggleList")!.label, "Add to list");
});

test("an orphan has the delete of its leftovers only", () => {
  const o: ManageRow = { kind: "orphan", key: "orphan:claude:claude-a:o", orphan: orphan("o") };
  const a = rowActions(o, { listedKeys: new Set(), unitCounts: null, moveTargets: 2 });
  assert.deepEqual(a.map((x) => x.id), ["delete"]);
  assert.equal(a[0]!.label, "Delete leftover files");
  assert.equal(deleteBlock({ kind: "orphan", key: "k", orphan: orphan("o", { open: true }) }), "A process is using it");
  assert.equal(deleteBlock(o), null);
});

test("delete blocks and a unit's block", () => {
  assert.equal(deleteBlock({ kind: "session", key: "k", session: session("a", { locked: true }), inList: true }), "Locked");
  assert.equal(deleteBlock({ kind: "session", key: "k", session: session("a", { status: "open-idle" }), inList: true }), "In use");
  assert.equal(deleteBlock({ kind: "session", key: "k", session: session("a"), inList: true }), null);
  assert.equal(unitDeleteBlock(unit("a", "agent-1", { open: true })), "Its session is in use");
  assert.equal(unitDeleteBlock(unit("a", "agent-1")), null);
});

test("move targets are the same provider's other accounts", () => {
  const accounts = [
    { id: "claude-a", provider: "claude" }, { id: "claude-b", provider: "claude" }, { id: "codex-a", provider: "codex" },
  ] as unknown as AccountInfo[];
  const row: ManageRow = { kind: "session", key: "k", session: session("a"), inList: true };
  assert.deepEqual(moveTargets(row, accounts).map((a) => a.id), ["claude-b"]);
});

test("the delete confirmation says where the session goes", () => {
  assert.equal(deleteDescription("trash", 5 * 1048576), "Moves it to the trash, 5.0 MB");
  assert.equal(deleteDescription("purge", 2048), "Deleted for good at once, 2.0 KB");
  assert.match(deleteDescription(null, null), /^Over 1\.0 MB goes to the trash/);
});

test("bulk plans name what is left out and carry the trash rule when sessions are in them", () => {
  const rows: ManageRow[] = [
    { kind: "session", key: "1", session: session("1"), inList: true },
    { kind: "session", key: "2", session: session("2", { status: "running" }), inList: true },
    { kind: "session", key: "3", session: session("3", { locked: true }), inList: true },
    { kind: "orphan", key: "o", orphan: orphan("o") },
  ];
  const deletable = rows.filter((r) => deleteBlock(r) === null);
  assert.equal(selectedPlan(deletable).title, "Delete 2 sessions?");
  assert.equal(selectedPlan([deletable[0]!]).title, "Delete 1 session?");
  const f = filteredPlan(rows, deletable);
  assert.deepEqual(f.notes, ["1 in use are left out", "1 locked are left out"]);
  assert.equal(f.title, "Delete 2 filtered sessions?");
  const u = unlockedPlan(rows, deletable);
  assert.deepEqual(u.notes, ["1 locked stay", "1 in use are left out"]);
  assert.match(bulkDescription(u), /1 locked stay\. 1 in use are left out\. Sessions over 1 MB go to the trash/);
  assert.equal(bulkDescription({ title: "", notes: [], items: [rows[3]!] }), "", "orphans alone carry no trash rule");
  assert.equal(bulkProgress(1, 3, 0, true), "1 of 3 done");
  assert.equal(bulkProgress(3, 3, 1, false), "2 of 3 succeeded, 1 failed");
  assert.equal(deleteDetail({ kind: "session", outcome: "trashed", sizeBytes: 2048, threads: 2 }), "Moved to the trash, 2.0 KB, 2 threads");
  assert.equal(deleteDetail({ kind: "orphan", freedBytes: 100 }), "Leftovers deleted for good, 100 B");
});

test("trash text: summary and newest first", () => {
  const item = (key: string, deletedAt: number): TrashItem => ({ key, provider: "claude", account: "claude-a", id: key, name: key, deletedAt, sizeBytes: 1024, threads: 1, problem: null }) as unknown as TrashItem;
  const list = { items: [item("old", 1), item("new", 9)], totalBytes: 2048, unreadable: [{}] } as unknown as TrashList;
  assert.equal(trashSummary(null), "Reading");
  assert.equal(trashSummary(list), "2 items, 2.0 KB, 1 unreadable");
  assert.deepEqual(trashEntries(list).map((i) => i.key), ["new", "old"]);
  assert.deepEqual(trashEntries(null), []);
});
