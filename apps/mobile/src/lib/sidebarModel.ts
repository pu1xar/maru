// What the drawer shows, decided without React Native: the header's count badges, the folders with
// their fold, dot and count, the empty-list line, the filter's summary and the usage rows. The
// rules are the web sidebar's (SessionSidebar.tsx), read through the web's own pure files, so a
// folder folded on one client reads folded on the other and a badge counts what the web counts.
import type { AccountUsage, Project, SessionSummary, UsageSnapshot } from "@maru/shared";
import {
  ACTIVITY_COUNT_ORDER,
  FOLDER_DOT_LABEL,
  resolveFolderDot,
  sessionActivity,
  type FolderDot,
  type SessionActivity,
} from "../../../web/src/components/sessionActivity.logic.ts";
import { foldKeyOf, isGroupFolded, moveInOrder, sortProjects, type ProviderFilter, type SessionGroup } from "../../../web/src/model.ts";
import { fiveHourWindow, shortAccount, usageSummary, weeklyWindow } from "../../../web/src/lib/usageFormat.ts";
import { activityMark, type SessionMark } from "./sessionMark.ts";
import type { BadgeVariant } from "./sidebarColors.ts";

/** Every session by what it is doing (the web's App.tsx counts all of them, archived ones too). */
export function activityCounts(sessions: Iterable<SessionSummary>): Partial<Record<SessionActivity, number>> {
  const counts: Partial<Record<SessionActivity, number>> = {};
  for (const s of sessions) {
    const a = sessionActivity(s);
    counts[a] = (counts[a] ?? 0) + 1;
  }
  return counts;
}

export interface HeaderBadge {
  activity: SessionActivity;
  count: number;
  variant: BadgeVariant;
  mark: SessionMark;
}

// SessionSidebar.tsx STATUS_BADGE_VARIANT, for the activities the header counts.
const BADGE_VARIANT: Partial<Record<SessionActivity, BadgeVariant>> = {
  "waiting-input": "warning",
  running: "info",
  background: "info",
  error: "error",
};

/** Only what asks for attention or is at work, most urgent first; idle and closed counts say little. */
export function headerBadges(counts: Partial<Record<SessionActivity, number>>): HeaderBadge[] {
  return ACTIVITY_COUNT_ORDER.flatMap((activity) => {
    const mark = activityMark(activity);
    const variant = BADGE_VARIANT[activity];
    const count = counts[activity];
    return mark && variant && count ? [{ activity, count, variant, mark }] : [];
  });
}

export interface SidebarSection {
  key: string;
  group: SessionGroup;
  folded: boolean;
  /** The fold key the server's list toggles (`foldKeyOf`). */
  foldKey: string;
  /** What a folded folder says about the sessions it hides. */
  dot: FolderDot | null;
  dotLabel: string;
  /** A folded folder shows its count; Archive shows it at 0 too (the web's rule). */
  showCount: boolean;
  /** The rows shown: none while folded. */
  data: SessionSummary[];
}

/** The web's list from top to bottom: each folder with its rows, or without them while folded. */
export function sidebarSections(groups: readonly SessionGroup[], folded: ReadonlySet<string>, searching: boolean): SidebarSection[] {
  return groups.map((group) => {
    const isFolded = isGroupFolded(group, folded, searching);
    const dot = isFolded ? resolveFolderDot(group.sessions) : null;
    return {
      key: group.key,
      group,
      folded: isFolded,
      foldKey: foldKeyOf(group),
      dot,
      dotLabel: dot ? FOLDER_DOT_LABEL[dot] : "",
      showCount: isFolded && (group.sessions.length > 0 || group.kind === "archive"),
      data: isFolded ? [] : group.sessions,
    };
  });
}

/**
 * The new Group orders a long press on a Group's header can offer (the web's Move up and Move
 * down, DESIGN.md 6w): the full id list with the Group one place higher or lower, each null at its
 * end. The server's order, the web's `sortProjects`, is the one the drawer shows.
 */
export function groupMoves(projects: readonly Project[], projectId: string): { up: string[] | null; down: string[] | null } {
  const order = sortProjects(projects).map((p) => p.id);
  return { up: moveInOrder(order, projectId, -1), down: moveInOrder(order, projectId, 1) };
}

/** One row's id: a pinned session has a row in Pinned and one in its Group, so its key alone repeats. */
export function rowIdOf(groupKey: string, sessionKey: string): string {
  return `${groupKey}|${sessionKey}`;
}

/** The web's empty line (SidebarListEmpty), or null while the first list has not arrived. */
export function listEmptyText(loaded: boolean, filtered: boolean): string | null {
  if (!loaded) return null;
  return filtered ? "No matching sessions" : "No sessions";
}

/** The folders hold nothing to show: no session anywhere, and no Archive folder either. */
export function listIsEmpty(groups: readonly SessionGroup[]): boolean {
  return !groups.some((g) => g.kind !== "archive" || g.sessions.length > 0);
}

/** The filter button's label: what is narrowed, or plain "Filter". */
export function filterLabel(provider: ProviderFilter, activeOnly: boolean): string {
  const parts = [provider === "claude" ? "Claude only" : provider === "codex" ? "Codex only" : null, activeOnly ? "Open sessions only" : null].filter(Boolean);
  return parts.length > 0 ? `Filter: ${parts.join(", ")}` : "Filter";
}

export type BarTone = "muted" | "info" | "warning" | "error";

export interface UsageBar {
  /** 0 to 100, or null when the window has no reading (an empty track). */
  pct: number | null;
  /** The fill: the 5h window is grey, others tell how close the limit is. */
  tone: BarTone;
  /** An empty track in amber: the account needs attention (token, login, error). */
  attention: boolean;
}

export interface UsageRow {
  key: string;
  provider: AccountUsage["provider"];
  label: string;
  /** The account the sessions run under now: its name reads in the foreground color. */
  active: boolean;
  stale: boolean;
  summary: string;
  bars: UsageBar[];
}

function toneOf(pct: number): BarTone {
  if (pct >= 90) return "error";
  if (pct >= 70) return "warning";
  return "info";
}

function barOf(w: { usedPercent: number | null } | null, a: AccountUsage, grey: boolean): UsageBar {
  if (!w || w.usedPercent === null) {
    return { pct: null, tone: "muted", attention: !grey && (a.status === "expired" || a.status === "auth_missing" || a.status === "error") };
  }
  const pct = Math.max(0, Math.min(100, w.usedPercent));
  return { pct, tone: grey ? "muted" : toneOf(pct), attention: false };
}

/** The usage lines at the foot (UsageFooter.tsx): FREE accounts stay hidden; 5h on top in grey, 7d below. */
export function usageRows(snapshot: UsageSnapshot | null, now: number): UsageRow[] {
  if (!snapshot) return [];
  return snapshot.accounts
    .filter((a) => !a.free)
    .map((a) => {
      const five = fiveHourWindow(a.windows);
      const week = weeklyWindow(a.windows);
      const bars = !five ? [barOf(week, a, false)] : week === five ? [barOf(five, a, true)] : [barOf(five, a, true), barOf(week, a, false)];
      return {
        key: `${a.provider}:${a.account}`,
        provider: a.provider,
        label: shortAccount(a),
        active: a.active,
        stale: a.stale,
        summary: usageSummary(a, now),
        bars,
      };
    });
}
