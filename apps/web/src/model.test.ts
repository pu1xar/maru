import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project, SessionSummary } from "@maru/shared";
import {
  ARCHIVE_GROUP_KEY,
  ARCHIVE_OPEN_KEY,
  PINNED_GROUP_KEY,
  UNASSIGNED_GROUP_KEY,
  countProjectSessions,
  dropLineAt,
  dropSpotOf,
  dropTargetOf,
  foldKeyOf,
  folderLineAt,
  folderSpotOf,
  groupByProject,
  groupSessionKeys,
  isGroupFolded,
  moveInOrder,
  pinnedSessionKeys,
  placeKeyOf,
  planDrop,
  planFolderDrop,
  projectGroupKey,
  recentCwds,
  sameDropSpot,
  sameFolderSpot,
  type DropTarget,
  type DropZone,
  type SessionFilter,
} from "./model.ts";

const NO_FILTER: SessionFilter = { query: "", provider: "all", activeOnly: false };

/** The keys a place or pin plan writes. */
const keysOf = (p: ReturnType<typeof planDrop> | null | undefined) => (p && p.kind !== "archive" ? p.keys : undefined);

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    key: `claude:a:${id}`, provider: "claude", account: "a", id, cwd: "/w", name: id, title: null,
    preview: null, status: "closed", owner: "none", pid: null, tmuxPane: null, parentKey: null,
    updatedAt: 0, createdAt: null, sizeBytes: null, entrypoint: null, projectId: null,
    ...over,
  };
}

function project(id: string, sortOrder: number, createdAt = 0): Project {
  return { id, name: `P ${id}`, defaultCwd: null, sortOrder, createdAt };
}

// 보관함 is tested on its own below; it is always the last folder.
const shape = (groups: ReturnType<typeof groupByProject>) =>
  groups.filter((g) => g.kind !== "archive").map((g) => [g.key, g.sessions.map((s) => s.id)]);

test("projects follow sortOrder, 미분류 comes last, rows sort by recent activity", () => {
  const projects = [project("b", 1), project("a", 0), project("c", 1, -5)];
  const sessions = [
    session("old", { projectId: "a", updatedAt: 1 }),
    session("new", { projectId: "a", updatedAt: 9 }),
    session("loose", { updatedAt: 3 }),
    session("child", { projectId: "a", parentKey: "claude:a:new", updatedAt: 99 }),
  ];
  assert.deepEqual(shape(groupByProject(sessions, projects, NO_FILTER)), [
    ["project:a", ["new", "old"]],
    ["project:c", []],
    ["project:b", []],
    [UNASSIGNED_GROUP_KEY, ["loose"]],
  ]);
});

test("a session pointing at an unknown or missing project goes to 미분류", () => {
  const sessions = [
    session("gone", { projectId: "deleted" }),
    session("legacy", { projectId: undefined }),
  ];
  assert.deepEqual(shape(groupByProject(sessions, [project("a", 0)], NO_FILTER)), [
    ["project:a", []],
    [UNASSIGNED_GROUP_KEY, ["gone", "legacy"]],
  ]);
});

test("미분류 is left out when every session has a project", () => {
  const groups = groupByProject([session("s", { projectId: "a" })], [project("a", 0)], NO_FILTER);
  assert.deepEqual(shape(groups), [["project:a", ["s"]]]);
  assert.deepEqual(shape(groupByProject([], [], NO_FILTER)), []);
});

test("a filter drops folders without a match, including empty projects", () => {
  const projects = [project("a", 0), project("b", 1), project("empty", 2)];
  const sessions = [
    session("a-claude", { projectId: "a", status: "running" }),
    session("a-codex", { projectId: "a", provider: "codex", key: "codex:a:a-codex" }),
    session("b-closed", { projectId: "b", name: "deploy notes" }),
    session("loose", { name: "deploy script", status: "open-idle" }),
  ];
  const run = (f: Partial<SessionFilter>) => shape(groupByProject(sessions, projects, { ...NO_FILTER, ...f }));

  assert.deepEqual(run({ provider: "codex" }), [["project:a", ["a-codex"]]]);
  assert.deepEqual(run({ activeOnly: true }), [
    ["project:a", ["a-claude"]],
    [UNASSIGNED_GROUP_KEY, ["loose"]],
  ]);
  assert.deepEqual(run({ query: "  DEPLOY " }), [
    ["project:b", ["b-closed"]],
    [UNASSIGNED_GROUP_KEY, ["loose"]],
  ]);
  assert.deepEqual(run({ query: "nothing matches" }), []);
  // Whitespace alone is no filter, so empty projects stay.
  assert.deepEqual(run({ query: "   " }).map(([key]) => key), [
    "project:a", "project:b", "project:empty", UNASSIGNED_GROUP_KEY,
  ]);
});

test("reorder moves one place, stops at the ends and leaves its input alone", () => {
  const order = ["a", "b", "c"];
  assert.deepEqual(moveInOrder(order, "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveInOrder(order, "b", 1), ["a", "c", "b"]);
  assert.equal(moveInOrder(order, "a", -1), null);
  assert.equal(moveInOrder(order, "c", 1), null);
  assert.equal(moveInOrder(order, "missing", 1), null);
  assert.deepEqual(order, ["a", "b", "c"]);
  // A second move before the server's list arrives starts from the first move's result.
  const first = moveInOrder(order, "c", -1)!;
  assert.deepEqual(moveInOrder(first, "c", -1), ["c", "a", "b"]);
});

test("project session count ignores filters and subagents", () => {
  const sessions = [
    session("x", { projectId: "a" }),
    session("y", { projectId: "a", status: "closed", provider: "codex" }),
    session("child", { projectId: "a", parentKey: "claude:a:x" }),
    session("z", { projectId: "b" }),
  ];
  assert.equal(countProjectSessions(sessions, "a"), 2);
  assert.equal(countProjectSessions(sessions, "none"), 0);
});

test("고정됨 comes first in pin order; a pinned session stays in its own folder too, and the filters treat both rows alike", () => {
  const projects = [project("a", 0)];
  const sessions = [
    session("a1", { projectId: "a", position: 0 }),
    session("a2", { projectId: "a", position: 1, pinPosition: 1 }),
    session("loose", { position: 0, pinPosition: 0, provider: "codex", key: "codex:a:loose", status: "running" }),
    session("child", { projectId: "a", parentKey: "claude:a:a1", pinPosition: 5 }),
  ];
  const run = (f: Partial<SessionFilter>) => shape(groupByProject(sessions, projects, { ...NO_FILTER, ...f }));
  assert.deepEqual(run({}), [
    [PINNED_GROUP_KEY, ["loose", "a2"]],
    ["project:a", ["a1", "a2"]],
    [UNASSIGNED_GROUP_KEY, ["loose"]],
  ]);
  assert.equal(groupByProject(sessions, projects, NO_FILTER)[0]?.kind, "pinned");
  // Both rows of a pinned session are the same object, so they show the same status and name.
  const [pinnedGroup, groupA] = groupByProject(sessions, projects, NO_FILTER);
  assert.equal(pinnedGroup?.sessions[1], groupA?.sessions[1]);
  assert.deepEqual(run({ provider: "claude" }), [
    [PINNED_GROUP_KEY, ["a2"]],
    ["project:a", ["a1", "a2"]],
  ]);
  assert.deepEqual(run({ activeOnly: true }), [
    [PINNED_GROUP_KEY, ["loose"]],
    [UNASSIGNED_GROUP_KEY, ["loose"]],
  ]);
  assert.deepEqual(run({ query: "a1" }), [["project:a", ["a1"]]]);
  assert.deepEqual(run({ query: "a2" }), [
    [PINNED_GROUP_KEY, ["a2"]],
    ["project:a", ["a2"]],
  ]);
  // No pins: no 고정됨.
  const unpinned = sessions.map((s) => ({ ...s, pinPosition: null }));
  assert.deepEqual(shape(groupByProject(unpinned, projects, NO_FILTER)).map(([k]) => k), ["project:a", UNASSIGNED_GROUP_KEY]);
  // Pinned members still count in their project's order, and in 고정됨's.
  assert.deepEqual(groupSessionKeys(sessions, projects, "a"), ["claude:a1", "claude:a2"]);
  assert.deepEqual(pinnedSessionKeys(sessions), ["codex:loose", "claude:a2"]);
});

test("a drop plans the server write for 고정됨 and for Groups", () => {
  const projects = [project("a", 0), project("b", 1)];
  const sessions = [
    session("a1", { projectId: "a", position: 0 }),
    session("a2", { projectId: "a", position: 1, pinPosition: 0 }),
    session("a3", { projectId: "a", position: 2 }),
    session("b1", { projectId: "b", position: 0 }),
    session("p2", { pinPosition: 1, position: 0 }),
  ];
  const pinnedTarget = (row?: DropTarget["row"]): DropTarget => ({ groupKey: PINNED_GROUP_KEY, pinned: true, projectId: null, ...(row ? { row } : {}) });
  const groupTarget = (id: string, row?: DropTarget["row"]): DropTarget => ({ groupKey: projectGroupKey(id), pinned: false, projectId: id, ...(row ? { row } : {}) });
  const plan = (moving: string, fromGroup: string, target: DropTarget) => planDrop({ sessions, projects, moving, fromGroup, target });

  // Reorder inside 고정됨.
  assert.deepEqual(plan("claude:p2", PINNED_GROUP_KEY, pinnedTarget({ key: "claude:a2", edge: "before" })),
    { kind: "pin", keys: ["claude:p2", "claude:a2"] });
  // A Group row between pinned rows, or on the 고정됨 header (top).
  assert.deepEqual(plan("claude:b1", projectGroupKey("b"), pinnedTarget({ key: "claude:a2", edge: "after" })),
    { kind: "pin", keys: ["claude:a2", "claude:b1", "claude:p2"] });
  assert.deepEqual(plan("claude:b1", projectGroupKey("b"), pinnedTarget()),
    { kind: "pin", keys: ["claude:b1", "claude:a2", "claude:p2"] });
  // A pinned session's Group row into 고정됨: only the pin order changes.
  assert.deepEqual(plan("claude:a2", projectGroupKey("a"), pinnedTarget({ key: "claude:p2", edge: "after" })),
    { kind: "pin", keys: ["claude:p2", "claude:a2"] });
  // A 고정됨 row on a Group: its Group place moves there and the pin stays (a place write has no
  // pin in it). The pinned member a2 keeps its place in a.
  assert.deepEqual(plan("claude:p2", PINNED_GROUP_KEY, groupTarget("a", { key: "claude:a3", edge: "before" })),
    { kind: "place", projectId: "a", keys: ["claude:a1", "claude:a2", "claude:p2", "claude:a3"] });
  assert.deepEqual(plan("claude:a2", PINNED_GROUP_KEY, groupTarget("a")),
    { kind: "place", projectId: "a", keys: ["claude:a2", "claude:a1", "claude:a3"] });
  // Inside a Group, pinned or not, the Group order changes.
  assert.deepEqual(plan("claude:a2", projectGroupKey("a"), groupTarget("a", { key: "claude:a1", edge: "before" })),
    { kind: "place", projectId: "a", keys: ["claude:a2", "claude:a1", "claude:a3"] });
  assert.deepEqual(plan("claude:a1", projectGroupKey("a"), groupTarget("b")),
    { kind: "place", projectId: "b", keys: ["claude:a1", "claude:b1"] });
  // Its own header, itself, its other row, or a row that is gone: nothing.
  assert.equal(plan("claude:p2", PINNED_GROUP_KEY, pinnedTarget()), null);
  assert.equal(plan("claude:a1", projectGroupKey("a"), groupTarget("a")), null);
  assert.equal(plan("claude:a1", projectGroupKey("a"), groupTarget("a", { key: "claude:a1", edge: "after" })), null);
  assert.equal(plan("claude:a2", PINNED_GROUP_KEY, groupTarget("a", { key: "claude:a2", edge: "before" })), null);
  assert.equal(plan("claude:a2", projectGroupKey("a"), pinnedTarget({ key: "claude:a2", edge: "after" })), null);
  assert.equal(plan("claude:a1", projectGroupKey("a"), groupTarget("b", { key: "claude:gone", edge: "after" })), null);
  assert.equal(placeKeyOf("codex:codex-personal:019a-x"), "codex:019a-x");
});

test("a drag's spot is what a drop writes: header, row side, or nothing", () => {
  const projects = [project("a", 0), project("b", 1)];
  const sessions = [
    session("a1", { projectId: "a", position: 0 }),
    session("a2", { projectId: "a", position: 1 }),
    session("b1", { projectId: "b", position: 0 }),
    session("b2", { projectId: "b", position: 1 }),
  ];
  const zoneA = { groupKey: projectGroupKey("a"), pinned: false, projectId: "a" };
  const zoneB = { groupKey: projectGroupKey("b"), pinned: false, projectId: "b" };
  const moving = { sessionKey: "claude:a:a1", fromGroup: projectGroupKey("a") };
  const row = { top: 100, height: 36 };
  const spot = (zone: Parameters<typeof dropSpotOf>[0]["zone"], draggedTop: number) =>
    dropSpotOf({ zone, zoneRect: row, draggedRect: { top: draggedTop, height: 36 }, moving });
  const write = (s: ReturnType<typeof dropSpotOf>) =>
    s && planDrop({ sessions, projects, moving: "claude:a1", fromGroup: moving.fromGroup, target: dropTargetOf(s) });

  // Another Group's header: its top.
  const header = spot(zoneB, 0);
  assert.deepEqual(header, zoneB);
  assert.deepEqual(write(header), { kind: "place", projectId: "b", keys: ["claude:a1", "claude:b1", "claude:b2"] });
  // A row: the side of its middle (118) the dragged row's middle is on.
  const above = spot({ ...zoneB, sessionKey: "claude:a:b2" }, 81);
  assert.deepEqual(above, { ...zoneB, row: { sessionKey: "claude:a:b2", edge: "before" } });
  assert.deepEqual(keysOf(write(above)), ["claude:b1", "claude:a1", "claude:b2"]);
  const below = spot({ ...zoneB, sessionKey: "claude:a:b2" }, 100);
  assert.deepEqual(below?.row, { sessionKey: "claude:a:b2", edge: "after" });
  assert.deepEqual(keysOf(write(below)), ["claude:b1", "claude:b2", "claude:a1"]);
  // Nothing to show where nothing happens: no zone, its own header, the dragged row itself.
  assert.equal(spot(null, 0), null);
  assert.equal(spot(zoneA, 0), null);
  assert.equal(spot({ ...zoneA, sessionKey: "claude:a:a1" }, 0), null);
  // A row without measured boxes has no side yet.
  assert.equal(dropSpotOf({ zone: { ...zoneB, sessionKey: "claude:a:b1" }, zoneRect: null, draggedRect: row, moving }), null);

  assert.ok(sameDropSpot(above, { ...zoneB, row: { sessionKey: "claude:a:b2", edge: "before" } }));
  assert.ok(!sameDropSpot(above, below));
  assert.ok(!sameDropSpot(header, above));
  assert.ok(sameDropSpot(null, null));
  assert.ok(!sameDropSpot(header, null));
});

test("a pinned session's two rows: the spot names the folder, and only that folder's row draws the line", () => {
  const projects = [project("a", 0)];
  const sessions = [
    session("a1", { projectId: "a", position: 0, pinPosition: 0 }),
    session("a2", { projectId: "a", position: 1, pinPosition: 1 }),
    session("a3", { projectId: "a", position: 2 }),
  ];
  const zoneA = { groupKey: projectGroupKey("a"), pinned: false, projectId: "a" };
  const zonePinned = { groupKey: PINNED_GROUP_KEY, pinned: true, projectId: null };
  const row = { top: 100, height: 36 };
  const spot = (zone: Parameters<typeof dropSpotOf>[0]["zone"], fromGroup: string, draggedTop: number) =>
    dropSpotOf({ zone, zoneRect: row, draggedRect: { top: draggedTop, height: 36 }, moving: { sessionKey: "claude:a:a1", fromGroup } });
  const write = (s: ReturnType<typeof dropSpotOf>, fromGroup: string) =>
    s && planDrop({ sessions, projects, moving: "claude:a1", fromGroup, target: dropTargetOf(s) });

  // Over the session's other row, from either side: nothing (it would land next to itself).
  assert.equal(spot({ ...zoneA, sessionKey: "claude:a:a1" }, PINNED_GROUP_KEY, 120), null);
  assert.equal(spot({ ...zonePinned, sessionKey: "claude:a:a1" }, projectGroupKey("a"), 120), null);
  // The 고정됨 row on its own Group's header: the top of that Group, still pinned.
  const top = spot(zoneA, PINNED_GROUP_KEY, 0);
  assert.deepEqual(top, zoneA);
  assert.deepEqual(write(top, PINNED_GROUP_KEY), { kind: "place", projectId: "a", keys: ["claude:a1", "claude:a2", "claude:a3"] });
  // The 고정됨 row below a2 in the Group: the line is on a2's Group row, not on a2's 고정됨 row.
  const inGroup = spot({ ...zoneA, sessionKey: "claude:a:a2" }, PINNED_GROUP_KEY, 120);
  assert.equal(dropLineAt(inGroup, projectGroupKey("a"), "claude:a:a2"), "after");
  assert.equal(dropLineAt(inGroup, PINNED_GROUP_KEY, "claude:a:a2"), null);
  assert.deepEqual(keysOf(write(inGroup, PINNED_GROUP_KEY)), ["claude:a2", "claude:a1", "claude:a3"]);
  // The Group row below a2 in 고정됨: the line is on a2's 고정됨 row and the pin order changes.
  const inPinned = spot({ ...zonePinned, sessionKey: "claude:a:a2" }, projectGroupKey("a"), 120);
  assert.equal(dropLineAt(inPinned, PINNED_GROUP_KEY, "claude:a:a2"), "after");
  assert.equal(dropLineAt(inPinned, projectGroupKey("a"), "claude:a:a2"), null);
  assert.deepEqual(write(inPinned, projectGroupKey("a")), { kind: "pin", keys: ["claude:a2", "claude:a1"] });
  assert.ok(!sameDropSpot(inGroup, inPinned));
  // A header spot draws no line.
  assert.equal(dropLineAt(top, projectGroupKey("a"), "claude:a:a2"), null);
  assert.equal(dropLineAt(null, projectGroupKey("a"), "claude:a:a2"), null);
});

test("cwd suggestions are distinct top-level cwds, most recent first", () => {
  const sessions = [
    session("1", { cwd: "/old", updatedAt: 1 }),
    session("2", { cwd: "/both", updatedAt: 2 }),
    session("3", { cwd: "/both", updatedAt: 8 }),
    session("4", { cwd: "/mid", updatedAt: 5 }),
    session("5", { cwd: null, updatedAt: 9 }),
    session("6", { cwd: "/sub", updatedAt: 10, parentKey: "claude:a:3" }),
  ];
  assert.deepEqual(recentCwds(sessions), ["/both", "/mid", "/old"]);
});

// ---- 보관함 (DESIGN.md 6d) ----

const shapeAll = (groups: ReturnType<typeof groupByProject>) => groups.map((g) => [g.key, g.sessions.map((s) => s.id)]);

test("보관함 is the last folder, holds archived sessions only, newest archived first, and is there empty without a filter", () => {
  const projects = [project("a", 0)];
  const sessions = [
    session("a1", { projectId: "a", position: 0 }),
    session("old", { projectId: "a", position: 1, archivedAt: 100 }),
    session("new", { projectId: "a", position: 2, archivedAt: 300, pinPosition: 0 }),
    session("loose", { archivedAt: 200 }),
  ];
  const groups = groupByProject(sessions, projects, NO_FILTER);
  // An archived pinned session is not in 고정됨 and no archived session is in its Group.
  assert.deepEqual(shapeAll(groups), [["project:a", ["a1"]], [ARCHIVE_GROUP_KEY, ["new", "loose", "old"]]]);
  assert.equal(groups.at(-1)?.kind, "archive");
  // Empty and unfiltered: the folder is there to drop onto, with nothing in it.
  assert.deepEqual(groupByProject([session("a1", { projectId: "a" })], projects, NO_FILTER).at(-1)?.sessions, []);
  // A filter keeps it only for a match, and the search finds an archived session.
  const q = (query: string): SessionFilter => ({ query, provider: "all", activeOnly: false });
  assert.deepEqual(shapeAll(groupByProject(sessions, projects, q("loose"))), [[ARCHIVE_GROUP_KEY, ["loose"]]]);
  assert.deepEqual(shapeAll(groupByProject(sessions, projects, q("a1"))), [["project:a", ["a1"]]]);
  // Subagent threads stay out, as everywhere.
  assert.deepEqual(groupByProject([session("t", { archivedAt: 1, parentKey: "claude:a:x" })], [], q("t")), []);
});

test("an archived session is not in the key lists a Group or 고정됨 write sends", () => {
  const projects = [project("a", 0)];
  const sessions = [
    session("a1", { projectId: "a", position: 0, pinPosition: 0 }),
    session("a2", { projectId: "a", position: 1, pinPosition: 1, archivedAt: 5 }),
  ];
  assert.deepEqual(groupSessionKeys(sessions, projects, "a"), ["claude:a1"]);
  assert.deepEqual(pinnedSessionKeys(sessions), ["claude:a1"]);
});

test("보관함 starts folded, a search opens it, and its fold entry is the opposite of the others", () => {
  const archive = { kind: "archive", key: ARCHIVE_GROUP_KEY } as const;
  const group = { kind: "project", key: "project:a" } as const;
  assert.equal(isGroupFolded(archive, new Set(), false), true);
  assert.equal(isGroupFolded(archive, new Set([ARCHIVE_OPEN_KEY]), false), false);
  assert.equal(isGroupFolded(archive, new Set(), true), false);
  assert.equal(isGroupFolded(group, new Set(), true), false);
  assert.equal(isGroupFolded(group, new Set(["project:a"]), true), true);
  assert.equal(foldKeyOf(archive), ARCHIVE_OPEN_KEY);
  assert.equal(foldKeyOf(group), "project:a");
});

test("a drag into 보관함 archives, a drag out places or pins, and 보관함 draws no row line", () => {
  const projects = [project("a", 0)];
  const sessions = [
    session("a1", { projectId: "a", position: 0 }),
    session("a2", { projectId: "a", position: 1, pinPosition: 0 }),
    session("z", { projectId: "a", position: 2, archivedAt: 9 }),
    session("y", { archivedAt: 8 }),
  ];
  const zone = { groupKey: ARCHIVE_GROUP_KEY, pinned: false, projectId: null, archive: true } as const;
  const row = { top: 0, height: 36 };
  const moving = { sessionKey: "claude:a:a1", fromGroup: projectGroupKey("a") };
  const over = (z: Parameters<typeof dropSpotOf>[0]["zone"], fromGroup = moving.fromGroup, sessionKey = moving.sessionKey) =>
    dropSpotOf({ zone: z, zoneRect: row, draggedRect: { top: 30, height: 36 }, moving: { sessionKey, fromGroup } });
  // On the header, and on a row of 보관함: the folder, no line between rows.
  const onHeader = over(zone);
  assert.deepEqual(onHeader, zone);
  const onRow = over({ ...zone, sessionKey: "claude:a:z" });
  assert.deepEqual(onRow, zone);
  assert.equal(dropLineAt(onRow, ARCHIVE_GROUP_KEY, "claude:a:z"), null);
  const plan = (fromGroup: string, spot: ReturnType<typeof dropSpotOf>, moving = "claude:a1") =>
    spot && planDrop({ sessions, projects, moving, fromGroup, target: dropTargetOf(spot) });
  assert.deepEqual(plan(projectGroupKey("a"), onHeader), { kind: "archive", key: "claude:a1" });
  // A pinned session's 고정됨 row archives too (its pin is kept, not cleared).
  assert.deepEqual(plan(PINNED_GROUP_KEY, over(zone, PINNED_GROUP_KEY, "claude:a:a2"), "claude:a2"), { kind: "archive", key: "claude:a2" });
  // From 보관함 onto its own header or its own rows: nothing.
  assert.equal(over(zone, ARCHIVE_GROUP_KEY, "claude:a:z"), null);
  // Out of 보관함 onto a Group header: a place of that Group, which the server takes out of 보관함 with.
  const groupZone = { groupKey: projectGroupKey("a"), pinned: false, projectId: "a" } as const;
  const out = over(groupZone, ARCHIVE_GROUP_KEY, "claude:a:z");
  assert.deepEqual(plan(ARCHIVE_GROUP_KEY, out, "claude:z"), { kind: "place", projectId: "a", keys: ["claude:z", "claude:a1", "claude:a2"] });
  // Out of 보관함 onto 고정됨: a pin.
  const pinZone = { groupKey: PINNED_GROUP_KEY, pinned: true, projectId: null } as const;
  assert.deepEqual(plan(ARCHIVE_GROUP_KEY, over(pinZone, ARCHIVE_GROUP_KEY, "claude:a:y"), "claude:y"), { kind: "pin", keys: ["claude:y", "claude:a2"] });
});

// ---- Dragging a Group (folder) header ----

const zoneOfProject = (projectId: string | null, extra: Partial<DropZone> = {}): DropZone => ({
  groupKey: projectId ? projectGroupKey(projectId) : UNASSIGNED_GROUP_KEY, pinned: false, projectId, ...extra,
});

test("a Group dropped on another takes its place: above when moving up, below when moving down", () => {
  const order = ["a", "b", "c", "d"];
  assert.deepEqual(folderSpotOf({ zone: zoneOfProject("b"), order, moving: "d" }), { projectId: "b", edge: "before" });
  assert.deepEqual(folderSpotOf({ zone: zoneOfProject("c"), order, moving: "a" }), { projectId: "c", edge: "after" });
  // A row of that Group carries the same project id as its header.
  assert.deepEqual(
    folderSpotOf({ zone: zoneOfProject("b", { sessionKey: "claude:x:s" }), order, moving: "d" }),
    { projectId: "b", edge: "before" },
  );
  assert.deepEqual(planFolderDrop(order, "d", { projectId: "b", edge: "before" }), ["a", "d", "b", "c"]);
  assert.deepEqual(planFolderDrop(order, "a", { projectId: "c", edge: "after" }), ["b", "c", "a", "d"]);
  assert.deepEqual(order, ["a", "b", "c", "d"]);
});

test("Pinned, Unsorted and Archive stay put: a drop there is the first or the last Group place", () => {
  const order = ["a", "b", "c"];
  const pinned: DropZone = { groupKey: PINNED_GROUP_KEY, pinned: true, projectId: null };
  const archive: DropZone = { groupKey: ARCHIVE_GROUP_KEY, pinned: false, archive: true, projectId: null };
  assert.deepEqual(folderSpotOf({ zone: pinned, order, moving: "c" }), { projectId: "a", edge: "before" });
  assert.deepEqual(planFolderDrop(order, "c", folderSpotOf({ zone: pinned, order, moving: "c" })!), ["c", "a", "b"]);
  assert.deepEqual(folderSpotOf({ zone: zoneOfProject(null), order, moving: "a" }), { projectId: "c", edge: "after" });
  assert.deepEqual(folderSpotOf({ zone: archive, order, moving: "a" }), { projectId: "c", edge: "after" });
  // Already first (last): no spot, so no line and no write.
  assert.equal(folderSpotOf({ zone: pinned, order, moving: "a" }), null);
  assert.equal(folderSpotOf({ zone: zoneOfProject(null), order, moving: "c" }), null);
});

test("a Group drag has no spot over itself, outside every zone, or for unknown ids", () => {
  const order = ["a", "b", "c"];
  assert.equal(folderSpotOf({ zone: zoneOfProject("b"), order, moving: "b" }), null);
  assert.equal(folderSpotOf({ zone: null, order, moving: "b" }), null);
  assert.equal(folderSpotOf({ zone: zoneOfProject("gone"), order, moving: "b" }), null);
  assert.equal(folderSpotOf({ zone: zoneOfProject("a"), order, moving: "gone" }), null);
  assert.equal(folderSpotOf({ zone: zoneOfProject("a"), order: [], moving: "a" }), null);
  assert.equal(planFolderDrop(order, "b", { projectId: "a", edge: "after" }), null);
  assert.equal(planFolderDrop(order, "b", { projectId: "b", edge: "after" }), null);
});

test("a Group's line is drawn on that Group only and spots compare by Group and edge", () => {
  const spot = { projectId: "b", edge: "after" } as const;
  assert.equal(folderLineAt(spot, "b"), "after");
  assert.equal(folderLineAt(spot, "a"), null);
  assert.equal(folderLineAt(spot, null), null);
  assert.equal(folderLineAt(null, "b"), null);
  assert.ok(sameFolderSpot(spot, { projectId: "b", edge: "after" }));
  assert.ok(!sameFolderSpot(spot, { projectId: "b", edge: "before" }));
  assert.ok(sameFolderSpot(null, null));
  assert.ok(!sameFolderSpot(spot, null));
});

test("a Group drag orders the full list, also while a filter hides some Groups", () => {
  // The order comes from every project, not from the Groups the filter shows.
  const projects = [project("a", 0), project("b", 1), project("c", 2)];
  const shown = groupByProject([session("x", { projectId: "a" }), session("z", { projectId: "c" })], projects, {
    ...NO_FILTER, query: "x",
  });
  assert.deepEqual(shown.filter((g) => g.kind === "project").map((g) => g.project!.id), ["a"]);
  const order = projects.map((p) => p.id);
  assert.deepEqual(planFolderDrop(order, "c", { projectId: "a", edge: "before" }), ["c", "a", "b"]);
});
