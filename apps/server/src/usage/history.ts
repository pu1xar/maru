// Usage over time (DESIGN.md 6j): every account's windows as the poller read them, kept in the
// state file so the dashboard can draw how usage moved. A reading is written only when it differs
// from the series' last one, so a row holds until the next row of its series.
//
// Rows are kept without an end (user rule: no retention limit); DESIGN.md 6j has how fast they grow.
// GET /api/usage/history answers the last 7 days, the span of the longest window.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AccountUsage, UsageHistory, UsageHistorySeries } from "@maru/shared";

/** The span the history route answers: one 7-day window. */
export const HISTORY_SPAN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Reset times that differ by less than this are the same reading. The Claude endpoint sends
 * microseconds (`...T10:00:00.101341+00:00`) that may move between reads of the same window.
 */
const RESET_TOLERANCE_MS = 60_000;

interface Last {
  used: number;
  resetsAt: number | null;
  at: number;
}

/** One window of a kept reading: used percent and reset time (ms). */
export interface LastWindow {
  used: number;
  resetsAt: number | null;
}

export class UsageHistoryStore {
  private readonly db: DatabaseSync;
  /** The newest row of each series (`account` NUL `window`), loaded at start and kept in step. */
  private readonly last = new Map<string, Last>();
  /** Rows this process wrote, by account. */
  readonly written = new Map<string, number>();

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS usage_history (
        account TEXT NOT NULL,
        win TEXT NOT NULL,
        at INTEGER NOT NULL,
        provider TEXT NOT NULL,
        minutes INTEGER,
        used REAL NOT NULL,
        resets_at INTEGER,
        PRIMARY KEY (account, win, at)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS usage_history_at ON usage_history (at);
    `);
    // SQLite takes the bare columns from the row that holds MAX(at).
    const rows = this.db.prepare("SELECT account, win, MAX(at) AS at, used, resets_at FROM usage_history GROUP BY account, win").all();
    for (const r of rows) {
      this.last.set(seriesKey(String(r.account), String(r.win)), {
        at: Number(r.at),
        used: Number(r.used),
        resetsAt: r.resets_at === null ? null : Number(r.resets_at),
      });
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Write the account's windows that changed since the series' last row. A reading counts when the
   * account answered (status ok) with a fresh value: a Codex rollout snapshot older than 6 hours
   * (`stale`) is not one. Its time is when it was read (`capturedAt`), else `now`.
   * Returns the rows written.
   */
  record(u: AccountUsage, now: number): number {
    if (u.status !== "ok" || u.stale) return 0;
    const at = u.capturedAt ?? now;
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO usage_history (account, win, at, provider, minutes, used, resets_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    let n = 0;
    for (const w of u.windows) {
      if (w.usedPercent === null || !Number.isFinite(w.usedPercent)) continue;
      const key = seriesKey(u.account, w.id);
      const prev = this.last.get(key);
      if (prev && (at <= prev.at || sameReading(prev, w.usedPercent, w.resetsAt))) continue;
      const r = insert.run(u.account, w.id, at, u.provider, w.minutes, w.usedPercent, w.resetsAt);
      this.last.set(key, { at, used: w.usedPercent, resetsAt: w.resetsAt });
      if (Number(r.changes) > 0) n++;
    }
    if (n) this.written.set(u.account, (this.written.get(u.account) ?? 0) + n);
    return n;
  }

  /**
   * Every series' rows in [from, to], oldest first, each led by its last row before `from` so the
   * line starts at the left edge. A series with no row in the span and none before it is absent.
   */
  read(from: number, to: number): UsageHistory {
    const inSpan = this.db
      .prepare("SELECT account, win, provider, minutes, at, used, resets_at FROM usage_history WHERE at >= ? AND at <= ? ORDER BY at")
      .all(from, to);
    const before = this.db
      .prepare("SELECT account, win, provider, minutes, MAX(at) AS at, used, resets_at FROM usage_history WHERE at < ? GROUP BY account, win")
      .all(from);
    const series = new Map<string, UsageHistorySeries>();
    const add = (r: Record<string, unknown>) => {
      const key = seriesKey(String(r.account), String(r.win));
      let s = series.get(key);
      if (!s) {
        s = {
          provider: r.provider === "codex" ? "codex" : "claude",
          account: String(r.account),
          window: String(r.win),
          minutes: r.minutes === null ? null : Number(r.minutes),
          points: [],
        };
        series.set(key, s);
      }
      s.points.push({ at: Number(r.at), usedPercent: Number(r.used), resetsAt: r.resets_at === null ? null : Number(r.resets_at) });
    };
    for (const r of before) add(r);
    for (const r of inSpan) add(r);
    return { from, to, series: [...series.values()] };
  }

  /**
   * An account's newest Claude reading as the endpoint's shape, from the newest row of each window:
   * what a restart can show while the endpoint answers 429. Null when no seven_day row was kept.
   */
  lastClaudeReading(account: string): { fiveHour: LastWindow | null; sevenDay: LastWindow; at: number } | null {
    const seven = this.last.get(seriesKey(account, "seven_day"));
    if (!seven) return null;
    const five = this.last.get(seriesKey(account, "five_hour"));
    const of = (l: Last): LastWindow => ({ used: l.used, resetsAt: l.resetsAt });
    return { fiveHour: five ? of(five) : null, sevenDay: of(seven), at: Math.max(seven.at, five?.at ?? 0) };
  }

  /** Rows kept, and the oldest row's time (for the growth figures in DESIGN.md 6j). */
  size(): { rows: number; oldest: number | null } {
    const r = this.db.prepare("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM usage_history").get();
    return { rows: Number(r?.n ?? 0), oldest: r?.oldest == null ? null : Number(r.oldest) };
  }
}

function seriesKey(account: string, window: string): string {
  return `${account}\u0000${window}`;
}

function sameReading(prev: Last, used: number, resetsAt: number | null): boolean {
  if (prev.used !== used) return false;
  if (prev.resetsAt === null || resetsAt === null) return prev.resetsAt === resetsAt;
  return Math.abs(prev.resetsAt - resetsAt) < RESET_TOLERANCE_MS;
}
