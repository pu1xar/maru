import { test } from "node:test";
import assert from "node:assert/strict";
import type { AccountUsage, SessionSummary, UsageSnapshot } from "@maru/shared";
import { groupByProject } from "../../../web/src/model.ts";
import {
  activityCounts,
  filterLabel,
  groupMoves,
  headerBadges,
  listEmptyText,
  listIsEmpty,
  rowIdOf,
  sidebarSections,
  usageRows,
} from "./sidebarModel.ts";

let n = 0;
const s = (o: Partial<SessionSummary>): SessionSummary =>
  ({ key: `claude:acct:${++n}`, provider: "claude", id: String(n), account: "acct", status: "open-idle", owner: "none", pinPosition: null, archivedAt: null, projectId: null, updatedAt: n, ...o }) as SessionSummary;
const NO_FILTER = { query: "", provider: "all" as const, activeOnly: false };

test("the header counts what the web counts: every session by activity, only work and attention shown", () => {
  const sessions = [s({ status: "running" }), s({ status: "running" }), s({ status: "waiting-input" }), s({ status: "open-idle", backgroundAgents: 1 }), s({ status: "closed" }), s({ status: "open-idle" }), s({ status: "error", archivedAt: 5 })];
  const counts = activityCounts(sessions);
  assert.deepEqual(counts, { running: 2, "waiting-input": 1, background: 1, closed: 1, "open-idle": 1, error: 1 });
  const badges = headerBadges(counts);
  // Most urgent first: input, running, background, error.
  assert.deepEqual(badges.map((b) => [b.activity, b.count, b.variant, b.mark.shape]), [
    ["waiting-input", 1, "warning", "question"],
    ["running", 2, "info", "solid"],
    ["background", 1, "info", "dashed"],
    ["error", 1, "error", "alert"],
  ]);
  assert.deepEqual(headerBadges({ closed: 4, "open-idle": 2 }), []);
});

test("a folded folder hides its rows and says what they do; Archive starts folded and shows its count at 0", () => {
  const sessions = [s({ status: "running", projectId: "p1" }), s({ status: "open-idle", projectId: "p1" }), s({ archivedAt: 9 })];
  const groups = groupByProject(sessions, [{ id: "p1", name: "Alpha", position: 0 } as never], NO_FILTER);
  const sections = sidebarSections(groups, new Set(["project:p1"]), false);
  const alpha = sections.find((x) => x.key === "project:p1")!;
  assert.equal(alpha.folded, true);
  assert.deepEqual(alpha.data, []);
  assert.equal(alpha.dot, "working");
  assert.equal(alpha.dotLabel, ", running");
  assert.equal(alpha.showCount, true);
  const archive = sections.find((x) => x.key === "archive")!;
  assert.equal(archive.folded, true);
  assert.equal(archive.foldKey, "archive:open");
  assert.equal(archive.data.length, 0);
  // Opened by the server's `archive:open` entry, or by a search for as long as its text is there.
  assert.equal(sidebarSections(groups, new Set(["archive:open"]), false).find((x) => x.key === "archive")!.data.length, 1);
  assert.equal(sidebarSections(groups, new Set(), true).find((x) => x.key === "archive")!.folded, false);
  // An open folder shows rows and no dot or count.
  const open = sidebarSections(groups, new Set(), false).find((x) => x.key === "project:p1")!;
  assert.equal(open.data.length, 2);
  assert.equal(open.dot, null);
  assert.equal(open.showCount, false);
  // Empty Archive still counts at 0 when folded.
  const empty = sidebarSections(groupByProject([], [], NO_FILTER), new Set(), false).find((x) => x.key === "archive")!;
  assert.equal(empty.showCount, true);
});

test("a pinned session's two rows have two ids", () => {
  assert.notEqual(rowIdOf("pinned", "claude:a:1"), rowIdOf("unassigned", "claude:a:1"));
});

test("the empty line and the filter label read as the web's", () => {
  assert.equal(listEmptyText(false, false), null);
  assert.equal(listEmptyText(true, false), "No sessions");
  assert.equal(listEmptyText(true, true), "No matching sessions");
  assert.equal(listIsEmpty(groupByProject([], [], NO_FILTER)), true);
  assert.equal(listIsEmpty(groupByProject([s({})], [], NO_FILTER)), false);
  assert.equal(filterLabel("all", false), "Filter");
  assert.equal(filterLabel("codex", true), "Filter: Codex only, Open sessions only");
  assert.equal(filterLabel("all", true), "Filter: Open sessions only");
});

const account = (o: Partial<AccountUsage>): AccountUsage =>
  ({ provider: "claude", account: "claude-personal", email: null, plan: null, free: false, active: false, status: "ok", error: null, windows: [], source: null, stale: false, capturedAt: null, ...o }) as AccountUsage;

test("usage rows: FREE hidden, 5h grey over 7d by how close the limit is, empty track amber when the account needs attention", () => {
  const snapshot: UsageSnapshot = {
    generatedAt: 1,
    accounts: [
      account({ account: "claude-a", windows: [{ id: "5h", minutes: 300, usedPercent: 77, resetsAt: null }, { id: "7d", minutes: 10080, usedPercent: 91.4, resetsAt: null }] }),
      account({ account: "claude-free", free: true }),
      account({ provider: "codex", account: "codex-b", windows: [{ id: "7d", minutes: 10080, usedPercent: 40, resetsAt: null }] }),
      account({ account: "claude-c", status: "expired", windows: [] }),
      account({ account: "claude-d", windows: [{ id: "5h", minutes: 300, usedPercent: 120, resetsAt: null }] }),
    ],
  };
  const rows = usageRows(snapshot, 0);
  assert.deepEqual(rows.map((r) => r.key), ["claude:claude-a", "codex:codex-b", "claude:claude-c", "claude:claude-d"]);
  assert.deepEqual(rows[0]!.bars, [{ pct: 77, tone: "muted", attention: false }, { pct: 91.4, tone: "error", attention: false }]);
  assert.deepEqual(rows[1]!.bars, [{ pct: 40, tone: "info", attention: false }]);
  assert.deepEqual(rows[2]!.bars, [{ pct: null, tone: "muted", attention: true }]);
  // A lone 5h window is its only bar, grey, clamped to 100.
  assert.deepEqual(rows[3]!.bars, [{ pct: 100, tone: "muted", attention: false }]);
  assert.equal(rows[0]!.label, "a");
  assert.equal(rows[0]!.summary, "claude-a, 5h 77%, 7d 91%");
  assert.deepEqual(usageRows(null, 0), []);
});

test("a Group's long-press moves are the full order one place up or down, null at the ends", () => {
  const project = (id: string, sortOrder: number) => ({ id, name: id, defaultCwd: null, sortOrder, createdAt: 0 });
  // Handed over out of order: the drawer's order is the server's sortOrder, as the web's list.
  const projects = [project("c", 2), project("a", 0), project("b", 1)];
  assert.deepEqual(groupMoves(projects, "a"), { up: null, down: ["b", "a", "c"] });
  assert.deepEqual(groupMoves(projects, "b"), { up: ["b", "a", "c"], down: ["a", "c", "b"] });
  assert.deepEqual(groupMoves(projects, "c"), { up: ["a", "c", "b"], down: null });
  assert.deepEqual(groupMoves([project("only", 0)], "only"), { up: null, down: null });
  assert.deepEqual(groupMoves(projects, "gone"), { up: null, down: null });
});
