import { test } from "node:test";
import assert from "node:assert/strict";
import { TRASH_THRESHOLD_BYTES, type OrphanSession, type SessionSummary, type UnitRow } from "@maru/shared";
import {
  DEFAULT_MANAGE_SORT,
  EMPTY_FIELDS,
  EMPTY_FILTER,
  MANAGE_VIEWS,
  MANAGE_VIEW_LABEL,
  bulkNoun,
  migrateManageView,
  otherViewsHint,
  unitKindOfView,
  viewCounts,
  viewMatchCounts,
  dayEnd,
  dayStart,
  deleteBytesOf,
  deleteOutcome,
  filterOfFields,
  needsSubtreeBytes,
  unitLabelsOf,
  pruneSelection,
  visibleSelection,
  facetCount,
  filterActive,
  inView,
  kbToSliderPos,
  matchesRow,
  matchesUnit,
  nextManageSort,
  pageOf,
  pagerItems,
  rowActive,
  rowDeletable,
  runSequential,
  sessionLevelRows,
  shortAccount,
  sliderMaxKb,
  sliderPosToKb,
  sortRows,
  sortUnits,
  tildePath,
  type ManageFilter,
  type ManageRow,
} from "./manageModel.ts";

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  const provider = over.provider ?? "claude";
  const account = over.account ?? "claude-a";
  return {
    key: `${provider}:${account}:${id}`, provider, account, id, cwd: "/w", name: id, title: null,
    preview: null, status: "closed", owner: "none", pid: null, tmuxPane: null, parentKey: null,
    updatedAt: 0, createdAt: null, sizeBytes: null, entrypoint: null, projectId: null, locked: false,
    ...over,
  };
}

function orphan(id: string, over: Partial<OrphanSession> = {}): OrphanSession {
  return {
    provider: "claude", account: "claude-a", id, paths: [`/Users/me/.claude/projects/-w/${id}`], files: 1,
    sizeBytes: 2048, updatedAt: 0, locked: false, open: false, ...over,
  };
}

function unit(id: string, unitId: string, over: Partial<UnitRow> = {}): UnitRow {
  return {
    kind: unitId.startsWith("wf_") ? "workflow" : "subagent", unitId, sizeBytes: 10, files: 1, updatedAt: 0,
    account: "claude-a", id, name: `session ${id}`, enc: "-w", open: false, locked: false, ...over,
  };
}

const ids = (rows: ManageRow[]) => rows.map((r) => (r.kind === "session" ? r.session.id : `o:${r.orphan.id}`));

test("sessionLevelRows: listed copy wins, subagent threads stay out, orphans join with their own key", () => {
  const rows = sessionLevelRows(
    [session("a", { name: "live" }), session("sub", { parentKey: "claude:claude-a:a" })],
    [session("a", { name: "stale" }), session("b")],
    [orphan("x")],
  );
  assert.deepEqual(ids(rows), ["a", "b", "o:x"]);
  assert.equal(rows[0]!.kind === "session" && rows[0]!.session.name, "live");
  assert.equal(rows[2]!.key, "orphan:claude:claude-a:x");
});

test("views, activity and deletability of sessions and orphans", () => {
  const [locked, open, plain, held] = sessionLevelRows(
    [session("l", { locked: true }), session("o", { status: "running" }), session("p")],
    [],
    [orphan("h", { open: true })],
  );
  assert.deepEqual(
    [inView(locked!, "locked"), inView(locked!, "all"), inView(plain!, "locked"), inView(plain!, "all"), inView(plain!, "orphans"), inView(held!, "orphans"), inView(held!, "all"), inView(locked!, "subagents")],
    [true, true, false, true, false, true, true, false],
  );
  assert.deepEqual([rowActive(open!), rowActive(held!)], [true, true]);
  assert.deepEqual([rowDeletable(locked!), rowDeletable(open!), rowDeletable(plain!), rowDeletable(held!)], [false, false, true, false]);
});

test("migrateManageView carries an earlier build's view and level into the one view", () => {
  const cases: Array<[string | null, string | null, string]> = [
    ["locked", null, "locked"],
    ["locked", "l3", "locked"],
    ["current", "l2", "all"],
    ["current", null, "all"],
    ["current", "l3", "subagents"],
    ["current", "l45", "workflows"],
    ["current", "nonsense", "all"],
    ["all", null, "all"],
    ["subagents", "l45", "subagents"],
    ["orphans", null, "orphans"],
    [null, null, "all"],
    [null, "l3", "all"],
    ["nonsense", "l3", "all"],
  ];
  for (const [view, level, want] of cases) assert.equal(migrateManageView(view, level), want, `${view} + ${level}`);
});

test("viewCounts count the same whole; locked orphans count as locked; unread is null", () => {
  const rows = sessionLevelRows([session("a", { locked: true }), session("b")], [session("c")], [orphan("x"), orphan("y", { locked: true })]);
  const units = [unit("a", "agent-1"), unit("a", "agent-2"), unit("b", "wf_1", { locked: true })];
  assert.deepEqual(viewCounts(rows, units, true), { all: 5, locked: 2, subagents: 2, workflows: 1, orphans: 2 });
  assert.deepEqual(viewCounts(rows, null, false), { all: null, locked: null, subagents: null, workflows: null, orphans: null });
  assert.equal(unitKindOfView("subagents"), "subagent");
  assert.equal(unitKindOfView("all"), null);
  for (const v of MANAGE_VIEWS) assert.equal(typeof MANAGE_VIEW_LABEL[v], "string");
  assert.deepEqual(MANAGE_VIEWS.map((v) => MANAGE_VIEW_LABEL[v]), ["All", "Locked", "Subagents", "Workflows", "Orphans"]);
});

test("otherViewsHint names the other views that match, in the buttons' order", () => {
  const counts = { all: 5, locked: 0, subagents: 3, workflows: 0, orphans: 2 };
  assert.equal(otherViewsHint("locked", counts), "No matches here. 5 in All, 3 in Subagents, 2 in Orphans");
  assert.equal(otherViewsHint("all", counts), "No matches here. 3 in Subagents, 2 in Orphans");
  assert.equal(otherViewsHint("all", { all: 0, locked: 0, subagents: 0, workflows: 0, orphans: 0 }), null);
  const rows = sessionLevelRows([session("a", { name: "alpha" })], [], []);
  assert.deepEqual(viewMatchCounts(rows, [unit("a", "agent-1", { name: "alpha" })], { ...EMPTY_FILTER, query: "alpha" }), {
    all: 1, locked: 0, subagents: 1, workflows: 0, orphans: 0,
  });
});

test("bulkNoun calls only all-orphan sets orphans", () => {
  const [s, o] = sessionLevelRows([session("a")], [], [orphan("x")]);
  assert.deepEqual([bulkNoun([s!]), bulkNoun([o!]), bulkNoun([s!, o!]), bulkNoun([])], ["session", "orphan", "session", "session"]);
});

test("matchesRow: popover facets, list facet, search over sessions and orphan paths", () => {
  const rows = sessionLevelRows(
    [session("a", { cwd: "/proj/alpha", sizeBytes: 100 * 1024, updatedAt: 1000 })],
    [session("b", { provider: "codex", account: "codex-x", preview: "Fix the parser", sizeBytes: null, updatedAt: 2000 })],
    [orphan("zz", { sizeBytes: 5 * 1024, updatedAt: 3000 })],
  );
  const pick = (over: Partial<ManageFilter>) => ids(rows.filter((r) => matchesRow(r, { ...EMPTY_FILTER, ...over })));
  assert.deepEqual(pick({}), ["a", "b", "o:zz"]);
  assert.deepEqual(pick({ provider: "codex" }), ["b"]);
  assert.deepEqual(pick({ account: "claude-a" }), ["a", "o:zz"]);
  assert.deepEqual(pick({ list: "in" }), ["a"]);
  assert.deepEqual(pick({ list: "out" }), ["b", "o:zz"]);
  assert.deepEqual(pick({ query: "PARSER" }), ["b"]);
  assert.deepEqual(pick({ query: "alpha" }), ["a"]);
  assert.deepEqual(pick({ query: "projects/-w/zz" }), ["o:zz"]);
  // KB bounds are inclusive; an unknown size fails any size bound.
  assert.deepEqual(pick({ minKb: 5 }), ["a", "o:zz"]);
  assert.deepEqual(pick({ maxKb: 5 }), ["o:zz"]);
  assert.deepEqual(pick({ from: 2000 }), ["b", "o:zz"]);
  assert.deepEqual(pick({ to: 2000 }), ["a", "b"]);
});

test("facetCount and filterActive", () => {
  assert.equal(facetCount(EMPTY_FILTER), 0);
  assert.equal(filterActive(EMPTY_FILTER), false);
  assert.equal(filterActive({ ...EMPTY_FILTER, query: " x " }), true);
  assert.equal(facetCount({ ...EMPTY_FILTER, query: "x" }), 0);
  assert.equal(facetCount({ ...EMPTY_FILTER, minKb: 1, maxKb: 9, from: 1, provider: "claude", account: "a", list: "out" }), 5);
});

test("matchesUnit: parent, provider, account, size, query over unit and session fields", () => {
  const units = [unit("s1", "agent-aa", { sizeBytes: 4096 }), unit("s2", "wf_1-2", { name: "parser work", account: "claude-b" })];
  const pick = (over: Partial<ManageFilter>, parent: string | null = null) =>
    units.filter((u) => matchesUnit(u, { ...EMPTY_FILTER, ...over }, parent)).map((u) => u.unitId);
  assert.deepEqual(pick({}), ["agent-aa", "wf_1-2"]);
  assert.deepEqual(pick({}, "claude-a:s1"), ["agent-aa"]);
  assert.deepEqual(pick({ provider: "codex" }), []);
  assert.deepEqual(pick({ account: "claude-b" }), ["wf_1-2"]);
  assert.deepEqual(pick({ minKb: 4 }), ["agent-aa"]);
  assert.deepEqual(pick({ query: "Parser" }), ["wf_1-2"]);
  assert.deepEqual(pick({ query: "agent-a" }), ["agent-aa"]);
  // The list facet is a session matter; units ignore it.
  assert.deepEqual(pick({ list: "in" }), ["agent-aa", "wf_1-2"]);
});

test("sorting: default newest first, heads flip, unknown size counts as 0, text in Korean order", () => {
  const rows = sessionLevelRows(
    [session("a", { updatedAt: 2, sizeBytes: 30, name: "beta" }), session("b", { updatedAt: 3, sizeBytes: null, name: "알파" })],
    [session("c", { updatedAt: 1, sizeBytes: 10, name: "alpha", account: "claude-z" })],
    [],
  );
  assert.deepEqual(ids(sortRows(rows, DEFAULT_MANAGE_SORT)), ["b", "a", "c"]);
  assert.deepEqual(ids(sortRows(rows, { key: "ts", dir: 1 })), ["c", "a", "b"]);
  assert.deepEqual(ids(sortRows(rows, { key: "size", dir: -1 })), ["a", "c", "b"]);
  // Korean collation, as the dashboard's localeCompare("ko"): Hangul before Latin.
  assert.deepEqual(ids(sortRows(rows, { key: "name", dir: 1 })), ["b", "c", "a"]);
  assert.deepEqual(ids(sortRows(rows, { key: "account", dir: -1 })), ["c", "a", "b"]);
  assert.deepEqual(nextManageSort(DEFAULT_MANAGE_SORT, "ts"), { key: "ts", dir: 1 });
  assert.deepEqual(nextManageSort({ key: "ts", dir: 1 }, "name"), { key: "name", dir: -1 });
  // Accounts sort by the shown name, not the prefixed label: codex-alpha before claude-zeta.
  const accts = sessionLevelRows(
    [session("z", { account: "claude-zeta" }), session("x", { provider: "codex", account: "codex-alpha" }), session("y", { provider: "codex", account: "codex-zeta" })],
    [],
    [],
  );
  assert.deepEqual(ids(sortRows(accts, { key: "account", dir: 1 })), ["x", "z", "y"]);
  const units = [unit("s", "agent-b", { sizeBytes: 5, updatedAt: 9 }), unit("s", "agent-a", { sizeBytes: 50, updatedAt: 1 })];
  assert.deepEqual(
    sortUnits([unit("s", "agent-c", { account: "claude-zeta" }), unit("s", "agent-d", { account: "claude-alpha" })], { key: "account", dir: 1 }).map((u) => u.unitId),
    ["agent-d", "agent-c"],
  );
  assert.deepEqual(sortUnits(units, { key: "size", dir: -1 }).map((u) => u.unitId), ["agent-a", "agent-b"]);
  assert.deepEqual(sortUnits(units, { key: "id", dir: 1 }).map((u) => u.unitId), ["agent-a", "agent-b"]);
  assert.deepEqual(sortUnits(units, DEFAULT_MANAGE_SORT).map((u) => u.unitId), ["agent-b", "agent-a"]);
});

test("selection: only shown deletable rows count, hidden ones are pruned", () => {
  const rows = sessionLevelRows([session("a"), session("b"), session("c", { locked: true })], [], []);
  const [a, b, c] = rows;
  const selected = new Set([a!.key, b!.key, c!.key]);
  // The search now shows only a and c: b is hidden, c cannot be deleted.
  const known = new Set(rows.map((r) => r.key));
  assert.deepEqual(ids(visibleSelection([a!, c!], selected)), ["a"]);
  assert.deepEqual([...pruneSelection(selected, [a!, c!], known)!], [a!.key]);
  assert.equal(pruneSelection(new Set([a!.key]), [a!, b!], known), null);
  // A row missing for a moment (out of the list, candidates not read yet) keeps its selection.
  assert.equal(pruneSelection(new Set([b!.key]), [a!], new Set([a!.key])), null);
});

test("narrowed units sort and search by the name the row shows", () => {
  const units = [unit("s", "agent-a", { name: "parent" }), unit("s", "agent-b", { name: "parent" })];
  const shown = (u: UnitRow) => (u.unitId === "agent-a" ? "Zeta review" : "Alpha probe");
  assert.deepEqual(sortUnits(units, { key: "name", dir: 1 }, shown).map((u) => u.unitId), ["agent-b", "agent-a"]);
  assert.deepEqual(sortUnits(units, { key: "name", dir: -1 }, shown).map((u) => u.unitId), ["agent-a", "agent-b"]);
  assert.deepEqual(units.filter((u) => matchesUnit(u, { ...EMPTY_FILTER, query: "alpha" }, null, shown)).map((u) => u.unitId), ["agent-b"]);
});

test("a Codex size, once the server fills it, filters, sorts and sets the slider like any other", () => {
  const rows = sessionLevelRows(
    [session("c", { provider: "codex", account: "codex-x", sizeBytes: 3 * 1024 * 1024 }), session("a", { sizeBytes: 10 * 1024 })],
    [session("u", { provider: "codex", account: "codex-x", sizeBytes: null })],
    [],
  );
  assert.deepEqual(ids(rows.filter((r) => matchesRow(r, { ...EMPTY_FILTER, minKb: 1024 }))), ["c"]);
  assert.deepEqual(ids(sortRows(rows, { key: "size", dir: -1 })), ["c", "a", "u"]);
  assert.equal(sliderMaxKb(rows.map((r) => (r.kind === "session" ? r.session.sizeBytes : null))), 4096);
  assert.equal(deleteOutcome(3 * 1024 * 1024), "trash");
});

test("deleteOutcome follows the trash threshold", () => {
  assert.equal(deleteOutcome(null), null);
  assert.equal(deleteOutcome(1024 * 1024), "purge");
  assert.equal(deleteOutcome(1024 * 1024 + 1), "trash");
});

test("account and folder text", () => {
  assert.equal(shortAccount("claude-work"), "work");
  assert.equal(shortAccount("codex-x"), "x");
  assert.equal(tildePath("/Users/someone/projects/a"), "~/projects/a");
  assert.equal(tildePath(null), "?");
});
test("size slider: log scale over KB, ends map to 0 and the maximum", () => {
  assert.equal(sliderMaxKb([null, 10]), 64);
  assert.equal(sliderMaxKb([300 * 1024 * 1024]), 2 ** 19);
  const max = 1024;
  assert.equal(sliderPosToKb(0, max), 0);
  assert.equal(sliderPosToKb(1000, max), max);
  assert.equal(kbToSliderPos(0, max), 0);
  assert.equal(kbToSliderPos(max * 4, max), 1000);
  const mid = sliderPosToKb(500, max);
  assert.ok(mid > 20 && mid < 40, String(mid));
  assert.equal(kbToSliderPos(mid, max), 500);
});

test("pageOf reaches every row and clamps; pagerItems marks gaps", () => {
  const rows = Array.from({ length: 205 }, (_, i) => i);
  const seen = [1, 2, 3].flatMap((p) => pageOf(rows, p, 100).rows);
  assert.deepEqual(seen, rows);
  assert.equal(pageOf(rows, 9, 100).page, 3);
  assert.deepEqual([pageOf([], 1, 100).first, pageOf([], 1, 100).last], [0, 0]);
  assert.deepEqual(pagerItems(6, 12), [1, null, 4, 5, 6, 7, 8, null, 12]);
});

test("runSequential runs one at a time and keeps going after a failure", async () => {
  let running = 0;
  let max = 0;
  const results = await runSequential(
    [1, 2, 3],
    async (n) => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      if (n === 2) throw new Error("refused");
      return n * 10;
    },
    (e) => (e instanceof Error ? e.message : String(e)),
  );
  assert.equal(max, 1);
  assert.deepEqual(results.map((r) => (r.ok ? r.value : r.error)), [10, "refused", 30]);
});

test("date inputs", () => {
  assert.equal(dayStart(""), null);
  assert.equal(dayStart("2026-13-99"), null);
  assert.equal(dayEnd("2026-11-15")! - dayStart("2026-11-15")!, 24 * 3600 * 1000 - 1);
});

test("filterOfFields: a bound that is not a number or a day stays open, the rest is read as typed", () => {
  assert.deepEqual(filterOfFields("q", EMPTY_FIELDS), { ...EMPTY_FILTER, query: "q" });
  const f = filterOfFields("", { ...EMPTY_FIELDS, minKb: "10", maxKb: "x", from: "2026-11-15", to: "nope", provider: "codex", account: "codex-a", list: "out" });
  assert.equal(f.minKb, 10);
  assert.equal(f.maxKb, null);
  assert.equal(f.from, dayStart("2026-11-15"));
  assert.equal(f.to, null);
  assert.equal(f.provider, "codex");
  assert.equal(f.account, "codex-a");
  assert.equal(f.list, "out");
  assert.equal(filterOfFields("", { ...EMPTY_FIELDS, minKb: "-5" }).minKb, 0);
});

test("deleteBytesOf: over the threshold the transcript settles it, under it Claude adds its subtrees and Codex stays unknown", () => {
  const big = TRASH_THRESHOLD_BYTES + 1;
  assert.equal(deleteBytesOf(session("a", { sizeBytes: null }), 5), null);
  assert.equal(deleteBytesOf(session("a", { sizeBytes: big }), null), big);
  assert.equal(deleteBytesOf(session("a", { sizeBytes: 100 }), null), null);
  assert.equal(deleteBytesOf(session("a", { sizeBytes: 100 }), 50), 150);
  assert.equal(deleteBytesOf(session("a", { provider: "codex", account: "codex-a", sizeBytes: 100 }), 50), null);
  assert.equal(deleteBytesOf(session("a", { provider: "codex", account: "codex-a", sizeBytes: big }), null), big);
  assert.equal(needsSubtreeBytes(session("a", { sizeBytes: 100 })), true);
  assert.equal(needsSubtreeBytes(session("a", { sizeBytes: big })), false);
  assert.equal(needsSubtreeBytes(session("a", { sizeBytes: null })), false);
  assert.equal(needsSubtreeBytes(session("a", { provider: "codex", account: "codex-a", sizeBytes: 100 })), false);
});

test("unitLabelsOf: a subagent by its agent id, a workflow by its own id", () => {
  const labels = unitLabelsOf({
    agents: [
      { kind: "agent", id: "ab12", title: "Explore", agentType: "Explore", model: "haiku" },
      { kind: "agent", id: "cd34", title: "Plain", agentType: null, model: null },
      { kind: "workflow", id: "wf_1", title: "Review", workflow: { agents: [{}, {}] } },
    ],
  } as unknown as Parameters<typeof unitLabelsOf>[0]);
  assert.deepEqual(labels.get("agent-ab12"), { title: "Explore", detail: "Explore, haiku" });
  assert.deepEqual(labels.get("agent-cd34"), { title: "Plain", detail: null });
  assert.equal(labels.get("wf_1")?.title, "Review");
});
