// The dashboard's pure rules (DESIGN.md 6j): how the work list groups by session, which errors the
// user put away, and the usage chart's series, scales and ticks. The components draw what these
// return; dashboardModel.test.ts checks them.
import type {
  AccountUsage, DashboardAttention, DashboardSessionRef, DashboardTask, DashboardTurn, DashboardWork, UsageHistory,
  UsageSnapshot, UsageWindow,
} from "@maru/shared";
import { monthDay } from "./dateText.ts";

// ---- time text ----

/** `45s`, `3m 05s`, `1h 02m`, `2d 3h`: how long something has run. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** `just now`, `3m ago`, `2h ago`, then the date (`Nov 15 14:03`): when something happened. */
export function formatAgo(at: number, now: number): string {
  const d = Math.max(0, now - at);
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  const t = new Date(at);
  const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  return `${monthDay(t)} ${hm}`;
}

// ---- running work, by session ----

export interface RunningGroup {
  session: DashboardSessionRef;
  /** The session's turn in progress, if any. */
  turn: DashboardTurn | null;
  /**
   * Its running subagents and workflows, and the workflows stopped from this page (so 이어서 실행
   * stays at hand), each with its depth under the subagent that started it.
   */
  tasks: { task: DashboardTask; depth: number }[];
  /** Its other workflows that stopped and can run again, oldest first: shown on request. */
  stopped: DashboardTask[];
  /** When the earliest of the turn and the listed tasks began, ms; null when none says. */
  since: number | null;
}

const ACTIVE = new Set(["running", "pending", "waiting"]);

/** Tells task rows apart across sessions. */
export function taskKey(t: DashboardTask): string {
  return `${t.session.key}:${t.agent.kind}:${t.agent.id}`;
}

function startOf(t: DashboardTask): number | null {
  const ms = t.agent.startedAt ? Date.parse(t.agent.startedAt) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function nest(list: DashboardTask[]): { task: DashboardTask; depth: number }[] {
  const order = (a: DashboardTask, b: DashboardTask) =>
    (ACTIVE.has(a.agent.status) ? 0 : 1) - (ACTIVE.has(b.agent.status) ? 0 : 1) ||
    (startOf(a) ?? Infinity) - (startOf(b) ?? Infinity) ||
    a.agent.id.localeCompare(b.agent.id);
  const ids = new Set(list.map((t) => t.agent.id));
  const children = new Map<string, DashboardTask[]>();
  const roots: DashboardTask[] = [];
  for (const t of list) {
    const parent = t.agent.parentAgentId;
    if (parent && ids.has(parent) && parent !== t.agent.id) {
      const c = children.get(parent) ?? [];
      c.push(t);
      children.set(parent, c);
    } else {
      roots.push(t);
    }
  }
  const out: { task: DashboardTask; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (t: DashboardTask, depth: number) => {
    if (seen.has(t.agent.id)) return;
    seen.add(t.agent.id);
    out.push({ task: t, depth });
    for (const c of (children.get(t.agent.id) ?? []).sort(order)) walk(c, depth + 1);
  };
  for (const r of roots.sort(order)) walk(r, 0);
  return out;
}

/**
 * Turns and tasks gathered under their session.
 * - `active`: sessions with a turn in progress, a running subagent or workflow, or a workflow
 *   stopped from this page (`stoppedHere`, taskKey). Oldest first, so a row keeps its place while
 *   others come and go. Running rows come before stopped ones, a subagent's own subagents under it.
 * - `idle`: sessions whose only rows are workflows that stopped earlier and can run again. A long
 *   session gathers many of those; the card keeps them out of the way until asked.
 */
export function groupRunning(
  work: Pick<DashboardWork, "turns" | "tasks">,
  stoppedHere: ReadonlySet<string> = new Set(),
): { active: RunningGroup[]; idle: RunningGroup[] } {
  const groups = new Map<string, RunningGroup>();
  const groupOf = (session: DashboardSessionRef) => {
    let g = groups.get(session.key);
    if (!g) {
      g = { session, turn: null, tasks: [], stopped: [], since: null };
      groups.set(session.key, g);
    }
    return g;
  };
  for (const turn of work.turns) groupOf(turn.session).turn = turn;
  const shown = new Map<string, DashboardTask[]>();
  for (const t of work.tasks) {
    const g = groupOf(t.session);
    if (ACTIVE.has(t.agent.status) || stoppedHere.has(taskKey(t))) {
      const list = shown.get(g.session.key) ?? [];
      list.push(t);
      shown.set(g.session.key, list);
    } else {
      g.stopped.push(t);
    }
  }
  for (const [key, list] of shown) groups.get(key)!.tasks = nest(list);
  for (const g of groups.values()) {
    g.stopped.sort((a, b) => (startOf(a) ?? Infinity) - (startOf(b) ?? Infinity) || a.agent.id.localeCompare(b.agent.id));
    const starts = [g.turn?.startedAt ?? null, ...g.tasks.map((x) => startOf(x.task))].filter((x): x is number => x !== null);
    g.since = starts.length ? Math.min(...starts) : null;
  }
  const all = [...groups.values()];
  const byAge = (a: RunningGroup, b: RunningGroup) =>
    (a.since ?? Infinity) - (b.since ?? Infinity) || a.session.label.localeCompare(b.session.label);
  return {
    active: all.filter((g) => g.turn || g.tasks.length).sort(byAge),
    idle: all.filter((g) => !g.turn && !g.tasks.length).sort((a, b) => a.session.label.localeCompare(b.session.label)),
  };
}

/** Running subagents and workflows (stopped workflows that can run again are not counted). */
export function runningCount(work: Pick<DashboardWork, "turns" | "tasks">): number {
  return work.turns.length + work.tasks.filter((t) => ACTIVE.has(t.agent.status)).length;
}

// ---- attention ----

/** Tells attention rows apart; an error carries its time, so a new error of the same session is new. */
export function attentionKey(a: DashboardAttention): string {
  return a.kind === "error" ? `error:${a.session.key}@${a.at ?? ""}` : `${a.kind}:${a.session.key}`;
}

/** Errors the user put away stay away until the session errs again (a new time). */
export function visibleAttention(list: readonly DashboardAttention[], dismissed: ReadonlySet<string>): DashboardAttention[] {
  return list.filter((a) => a.kind !== "error" || !dismissed.has(attentionKey(a)));
}

/** The put-away keys still worth keeping: those of errors the server still reports. */
export function keepDismissed(dismissed: ReadonlySet<string>, list: readonly DashboardAttention[]): Set<string> {
  const live = new Set(list.map(attentionKey));
  return new Set([...dismissed].filter((k) => live.has(k)));
}

// ---- usage ----

export type ChartWindow = "7d" | "5h";
export const WINDOW_MINUTES: Record<ChartWindow, number> = { "7d": 10080, "5h": 300 };

/** The account's window of this length (Claude five_hour and seven_day, Codex primary and secondary). */
export function windowOf(a: Pick<AccountUsage, "windows">, minutes: number): UsageWindow | null {
  return a.windows.find((w) => w.minutes === minutes) ?? null;
}

/** Accounts the dashboard shows: FREE ones stay hidden, as in the sidebar foot. */
export function shownAccounts(snapshot: UsageSnapshot | null): AccountUsage[] {
  return (snapshot?.accounts ?? []).filter((a) => !a.free);
}

/**
 * Each account's place in the chart palette: its position among all accounts in the server's
 * order (Claude first, in config order). The color follows the account, so hiding one never
 * repaints the others.
 */
export function seriesSlots(snapshot: UsageSnapshot | null): Map<string, number> {
  return new Map((snapshot?.accounts ?? []).map((a, i) => [a.account, i]));
}

/** Slots the chart palette has (dashboard.css `--dashboard-series-<n>`); an account past them is drawn in the muted color. */
export const SERIES_SLOTS = 8;

export interface ChartPoint {
  t: number;
  v: number;
}

export interface ChartSeries {
  account: string;
  provider: AccountUsage["provider"];
  slot: number;
  points: ChartPoint[];
}

/**
 * The lines for one window length over [from, now]: each shown account's recorded readings, the
 * one before the span moved to its left edge, and the live reading carried to `now`. A reading
 * holds until the next one (the server writes only changes), so the lines are steps.
 */
export function chartSeries(
  history: UsageHistory | null,
  snapshot: UsageSnapshot | null,
  win: ChartWindow,
  from: number,
  now: number,
): ChartSeries[] {
  const minutes = WINDOW_MINUTES[win];
  const slots = seriesSlots(snapshot);
  const out: ChartSeries[] = [];
  for (const a of shownAccounts(snapshot)) {
    const s = history?.series.find((x) => x.account === a.account && x.minutes === minutes);
    const points: ChartPoint[] = [];
    for (const p of s?.points ?? []) {
      if (p.at > now) continue;
      const t = Math.max(p.at, from);
      if (points.length && points[points.length - 1]!.t === t) points[points.length - 1] = { t, v: p.usedPercent };
      else points.push({ t, v: p.usedPercent });
    }
    const live = a.status === "ok" && !a.stale ? windowOf(a, minutes)?.usedPercent ?? null : null;
    if (live !== null) {
      if (!points.length || points[points.length - 1]!.v !== live) points.push({ t: now, v: live });
      if (points[points.length - 1]!.t !== now) points.push({ t: now, v: live });
    }
    if (points.length) out.push({ account: a.account, provider: a.provider, slot: slots.get(a.account) ?? SERIES_SLOTS, points });
  }
  return out;
}

/** The value a step series holds at `t`; null before its first reading. */
export function valueAt(points: readonly ChartPoint[], t: number): number | null {
  let v: number | null = null;
  for (const p of points) {
    if (p.t > t) break;
    v = p.v;
  }
  return v;
}

/** An SVG path of a step line: each value runs flat to the next reading, then moves straight up or down. */
export function stepPath(points: readonly ChartPoint[], x: (t: number) => number, y: (v: number) => number): string {
  if (!points.length) return "";
  const r = (n: number) => Math.round(n * 10) / 10;
  let d = `M${r(x(points[0]!.t))} ${r(y(points[0]!.v))}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    d += `H${r(x(p.t))}V${r(y(p.v))}`;
  }
  return d;
}

/** Local midnights inside (from, to], for the day ticks of the 7-day axis. */
export function dayTicks(from: number, to: number): number[] {
  const out: number[] = [];
  const d = new Date(from);
  d.setHours(24, 0, 0, 0);
  while (d.getTime() <= to) {
    out.push(d.getTime());
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** `Nov 15`: a day tick's label. */
export function dayLabel(ms: number): string {
  const d = new Date(ms);
  return monthDay(d);
}

/** `Nov 15 14:03`: the crosshair's time. */
export function pointLabel(ms: number): string {
  const d = new Date(ms);
  return `${monthDay(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
