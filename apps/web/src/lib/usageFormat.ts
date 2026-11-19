// Text and colors for account usage (DESIGN.md 6a), shared by the sidebar foot (UsageFooter), the
// settings screen's usage tab and the dashboard. Time left is short everywhere ("3.3d", "5.6h",
// "42m"); the exact reset time is in the tooltip.
import type { AccountUsage, UsageWindow } from "@maru/shared";

import { shortAccount as shortAccountLabel } from "../model.ts";

export const USAGE_STATUS_TEXT: Record<AccountUsage["status"], string> = {
  ok: "",
  free: "FREE",
  expired: "Token expired",
  auth_missing: "Login info missing",
  off: "Usage off",
  rate_limited: "Rate limited",
  error: "Error",
  no_data: "No data yet",
};

export function windowLabel(w: UsageWindow): string {
  if (w.minutes === 300) return "5h";
  if (w.minutes === 10080) return "7d";
  if (w.minutes === 43200) return "mo";
  if (w.minutes !== null) return w.minutes >= 1440 ? `${Math.round(w.minutes / 1440)}d` : `${Math.round(w.minutes / 60)}h`;
  return w.id;
}

export function resetIn(ms: number | null, now: number): string {
  // No time when there is none, or when the reset already passed (the reading is older than it).
  if (ms === null || ms <= now) return "";
  const s = (ms - now) / 1000;
  const one = (n: number) => String(Math.floor(n * 10) / 10);
  const minutes = Math.max(1, Math.ceil(s / 60));
  if (minutes < 60) return `${minutes}m`;
  // Rounded up to 60 minutes, a reset just under an hour away reads 1h, not 0.9h.
  if (s < 86400) return `${one(Math.max(1, s / 3600))}h`;
  return `${one(s / 86400)}d`;
}

export function barClass(pct: number): string {
  if (pct >= 90) return "bg-error";
  if (pct >= 70) return "bg-warning";
  return "bg-info";
}

/** A window's bar fill: the 5h window in grey, others by how close the limit is (user request). */
export function windowBarClass(w: Pick<UsageWindow, "minutes">, pct: number): string {
  return w.minutes === 300 ? "bg-muted-foreground" : barClass(pct);
}

/** The usage row's account label without its provider prefix (`claude-work` -> `work`). */
export function shortAccount(a: Pick<AccountUsage, "account">): string {
  return shortAccountLabel(a.account);
}

/** What the settings usage line writes in a window's time-left slot for a reading over 6 hours old, whose reset has passed. */
export const STALE_RESET_TEXT = "old";

/** The time-left slot of a settings usage line: the time left, or "old" for a stale reading. */
export function windowResetText(w: Pick<UsageWindow, "resetsAt">, now: number, stale: boolean): string {
  return stale ? STALE_RESET_TEXT : resetIn(w.resetsAt, now);
}

/**
 * The windows of one settings usage line in their columns: the 5h window first (null when the
 * account has none, so its weekly bar still lines up under the other accounts' weekly bars), then
 * the rest in the source's order. No windows, no columns.
 */
export function windowSlots<T extends { minutes: number | null }>(windows: readonly T[]): Array<T | null> {
  if (windows.length === 0) return [];
  const five = windows.find((w) => w.minutes === 300) ?? null;
  return [five, ...windows.filter((w) => w !== five)];
}

/** Why an account with no reading shows no bars (the line says it in their place), and whether it needs attention (token, login, error). */
export function usageNote(a: Pick<AccountUsage, "status" | "error">): { text: string; attention: boolean } | null {
  const text = a.error ?? USAGE_STATUS_TEXT[a.status] ?? "";
  if (!text) return null;
  return { text, attention: a.status === "expired" || a.status === "auth_missing" || a.status === "error" };
}

/** The weekly window (7 days); without one, the longest window the account reports. */
export function weeklyWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  return (
    windows.find((w) => w.minutes === 10080) ??
    [...windows].sort((x, y) => (y.minutes ?? 0) - (x.minutes ?? 0))[0] ??
    null
  );
}

/** The 5h window, when the account reports one. */
export function fiveHourWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  return windows.find((w) => w.minutes === 300) ?? null;
}

/** The windows the foot shows, short first: 5h (when there is one) and the weekly one. */
export function footerWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  const five = fiveHourWindow(windows);
  const week = weeklyWindow(windows);
  return [five, week].filter((w, i, all): w is UsageWindow => w !== null && all.indexOf(w) === i);
}

/** One hover line: "5h 77% (2.1h)". A stale reading (over 6 hours old) leaves the time out, as the other screens do. */
export function windowLine(w: UsageWindow, now: number, stale = false): string {
  const pct = w.usedPercent === null ? "-" : `${Math.round(w.usedPercent)}%`;
  const left = stale ? "" : resetIn(w.resetsAt, now);
  return left ? `${windowLabel(w)} ${pct} (${left})` : `${windowLabel(w)} ${pct}`;
}

/** What an account's bar line says in words: "claude-work, 5h 77% (2.1h), 7d 40% (2.1d)". */
export function usageSummary(a: AccountUsage, now: number): string {
  const shown = footerWindows(a.windows).filter((w) => w.usedPercent !== null);
  const parts = [a.account];
  if (shown.length > 0) parts.push(...shown.map((w) => windowLine(w, now, a.stale)));
  else parts.push(a.error ?? (USAGE_STATUS_TEXT[a.status] || "No data"));
  if (a.stale) parts.push("Data older than 6 hours");
  if (a.active) parts.push("Running");
  return parts.join(", ");
}
