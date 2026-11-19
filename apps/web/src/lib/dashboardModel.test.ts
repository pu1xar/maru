import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AccountUsage, DashboardAgent, DashboardAttention, DashboardSessionRef, DashboardTask, SessionSummary, UsageHistory, UsageSnapshot,
} from "@maru/shared";
import {
  attentionKey, chartSeries, dayTicks, formatAgo, formatElapsed, groupRunning, keepDismissed, runningCount, stepPath, taskKey, valueAt,
  visibleAttention,
} from "./dashboardModel.ts";

function ref(id: string, over: Partial<DashboardSessionRef> = {}): DashboardSessionRef {
  return { key: `claude:a:${id}`, provider: "claude", account: "a", label: id, cwd: "/w", status: "running", owner: "ui", ...over };
}

function summary(id: string): SessionSummary {
  return {
    key: `claude:a:${id}`, provider: "claude", account: "a", id, cwd: "/w", name: null, title: null, preview: null, status: "open-idle",
    owner: "ui", pid: null, tmuxPane: null, parentKey: null, updatedAt: 0, createdAt: null, sizeBytes: null, entrypoint: null,
  };
}

function task(session: DashboardSessionRef, id: string, over: Partial<DashboardAgent> = {}): DashboardTask {
  return {
    session,
    agent: {
      id, kind: "agent", title: id, status: "running", agentType: null, model: null, parentAgentId: null, childThreadId: null,
      startedAt: null, updatedAt: null, completedAt: null, progress: null, ...over,
    },
  };
}

test("time text", () => {
  assert.equal(formatElapsed(45_000), "45s");
  assert.equal(formatElapsed(185_000), "3m 05s");
  assert.equal(formatElapsed(3_720_000), "1h 02m");
  assert.equal(formatElapsed(27 * 3_600_000), "1d 3h");
  assert.equal(formatAgo(1_000, 30_000), "just now");
  assert.equal(formatAgo(0, 3 * 60_000), "3m ago");
  assert.equal(formatAgo(0, 5 * 3_600_000), "5h ago");
  const at = new Date(2026, 10, 15, 14, 3).getTime();
  assert.equal(formatAgo(at, at + 2 * 86_400_000), "Nov 15 14:03");
});

test("groupRunning: a session's turn and tasks together, oldest session first, subagents under their parent", () => {
  const a = ref("a");
  const b = ref("b", { status: "open-idle" });
  const c = ref("c", { status: "open-idle" });
  const t = (iso: string) => new Date(iso).toISOString();
  const work = {
    turns: [{ session: a, startedAt: Date.parse("2026-11-16T03:00:00Z"), stop: { enabled: true, reason: null } }],
    tasks: [
      task(a, "child", { parentAgentId: "parent", startedAt: t("2026-11-16T03:05:00Z") }),
      task(a, "wf", { kind: "workflow", status: "cancelled", startedAt: t("2026-11-16T02:00:00Z"), resume: { enabled: true, reason: null } }),
      task(a, "parent", { startedAt: t("2026-11-16T03:01:00Z") }),
      task(b, "bg", { startedAt: t("2026-11-16T01:00:00Z") }),
      // A session with nothing running and only an old stopped workflow.
      task(c, "old", { kind: "workflow", status: "interrupted", startedAt: t("2026-11-10T01:00:00Z"), resume: { enabled: true, reason: null } }),
    ],
  };
  const g = groupRunning(work);
  assert.deepEqual(
    g.active.map((x) => [x.session.key, x.turn !== null, x.tasks.map((y) => `${y.task.agent.id}/${y.depth}`), x.stopped.map((y) => y.agent.id)]),
    [
      ["claude:a:b", false, ["bg/0"], []],
      ["claude:a:a", true, ["parent/0", "child/1"], ["wf"]],
    ],
  );
  assert.equal(g.active[1]?.since, Date.parse("2026-11-16T03:00:00Z"));
  assert.deepEqual(g.idle.map((x) => [x.session.key, x.stopped.map((y) => y.agent.id)]), [["claude:a:c", ["old"]]]);

  // A workflow stopped from this page stays among the listed rows, with 이어서 실행 at hand.
  const here = groupRunning(work, new Set([taskKey(work.tasks[1]!), taskKey(work.tasks[4]!)]));
  assert.deepEqual(here.active.find((x) => x.session.key === "claude:a:a")?.tasks.map((y) => y.task.agent.id), ["parent", "child", "wf"]);
  assert.equal(here.active.find((x) => x.session.key === "claude:a:a")?.since, Date.parse("2026-11-16T02:00:00Z"));
  assert.deepEqual(here.active.map((x) => x.session.key), ["claude:a:c", "claude:a:b", "claude:a:a"]);
  assert.equal(here.idle.length, 0);
  assert.equal(runningCount(work), 4, "the turn and three running rows; stopped workflows are not counted");
});

test("dismissed errors stay hidden until the session errs again", () => {
  const e1: DashboardAttention = { kind: "error", session: ref("a"), summary: summary("a"), at: 100, message: "x", code: null, send: { enabled: true, reason: null } };
  const q: DashboardAttention = { kind: "question", session: ref("b"), summary: summary("b"), since: null, titles: [] };
  const dismissed = new Set([attentionKey(e1)]);
  assert.deepEqual(visibleAttention([e1, q], dismissed).map((a) => a.kind), ["question"]);
  const e2 = { ...e1, at: 200 };
  assert.deepEqual(visibleAttention([e2, q], dismissed).map((a) => a.kind), ["error", "question"]);
  assert.deepEqual([...keepDismissed(dismissed, [e2, q])], [], "the old key is let go once its error is gone");
});

function account(acct: string, over: Partial<AccountUsage> = {}): AccountUsage {
  return {
    provider: "claude", account: acct, email: null, plan: null, free: false, active: false, status: "ok", error: null,
    windows: [{ id: "seven_day", minutes: 10080, usedPercent: 50, resetsAt: null }], source: "anthropic_oauth", stale: false,
    capturedAt: null, ...over,
  };
}

test("chartSeries: steps from the span's left edge to now; the color slot follows the account", () => {
  const from = 1_000;
  const now = 10_000;
  const snapshot: UsageSnapshot = {
    generatedAt: now,
    accounts: [account("free-one", { free: true }), account("a"), account("b", { windows: [] }), account("c", { status: "expired", windows: [] })],
  };
  const history: UsageHistory = {
    from, to: now,
    series: [
      { provider: "claude", account: "a", window: "seven_day", minutes: 10080, points: [{ at: 500, usedPercent: 40, resetsAt: null }, { at: 4_000, usedPercent: 45, resetsAt: null }] },
      { provider: "claude", account: "a", window: "five_hour", minutes: 300, points: [{ at: 600, usedPercent: 9, resetsAt: null }] },
      { provider: "claude", account: "c", window: "seven_day", minutes: 10080, points: [{ at: 2_000, usedPercent: 70, resetsAt: null }] },
    ],
  };
  const s = chartSeries(history, snapshot, "7d", from, now);
  assert.deepEqual(s.map((x) => [x.account, x.slot, x.points.map((p) => [p.t, p.v])]), [
    ["a", 1, [[1_000, 40], [4_000, 45], [10_000, 50]]],
    // No live value: the line ends at its last reading.
    ["c", 3, [[2_000, 70]]],
  ]);
  // The live value equal to the last reading carries it to now.
  const same = chartSeries(history, { ...snapshot, accounts: [account("a", { windows: [{ id: "seven_day", minutes: 10080, usedPercent: 45, resetsAt: null }] })] }, "7d", from, now);
  assert.deepEqual(same[0]?.points.map((p) => [p.t, p.v]), [[1_000, 40], [4_000, 45], [10_000, 45]]);
  assert.deepEqual(chartSeries(history, snapshot, "5h", from, now).map((x) => x.account), ["a"]);
  assert.equal(valueAt(s[0]!.points, 3_999), 40);
  assert.equal(valueAt(s[0]!.points, 4_000), 45);
  assert.equal(valueAt(s[0]!.points, 999), null);
  assert.equal(stepPath(s[0]!.points, (t) => t / 1000, (v) => 100 - v), "M1 60H4V55H10V50");
});

test("dayTicks: the local midnights inside the span", () => {
  const from = new Date(2026, 10, 9, 15, 0).getTime();
  const to = new Date(2026, 10, 16, 15, 0).getTime();
  const ticks = dayTicks(from, to);
  assert.equal(ticks.length, 7);
  assert.equal(new Date(ticks[0]!).getDate(), 10);
  assert.ok(ticks.every((t) => new Date(t).getHours() === 0 && new Date(t).getMinutes() === 0));
});
