import type { Project, ProviderId, SessionSummary, UnifiedStatus } from "@maru/shared";
import { sessionDisplayName } from "@maru/shared";

export type ProviderFilter = "all" | ProviderId;

export interface SessionFilter {
  query: string;
  provider: ProviderFilter;
  activeOnly: boolean;
}

/**
 * One sidebar folder (DESIGN.md 6c): 고정됨 for pinned sessions, a user project, 미분류 for
 * sessions in no project, or 보관함 (6d) for archived sessions. A pinned session is in two
 * folders: 고정됨 and its own. An archived session is in 보관함 only.
 */
export interface SessionGroup {
  kind: "pinned" | "project" | "unassigned" | "archive";
  /** PINNED_GROUP_KEY, `project:<id>`, UNASSIGNED_GROUP_KEY, or ARCHIVE_GROUP_KEY. */
  key: string;
  /** null for 고정됨, 미분류 and 보관함. */
  project: Project | null;
  label: string;
  sessions: SessionSummary[];
}

export const PINNED_GROUP_KEY = "pinned";
export const PINNED_LABEL = "Pinned";
export const UNASSIGNED_GROUP_KEY = "unassigned";
export const UNASSIGNED_LABEL = "Unsorted";
export const ARCHIVE_GROUP_KEY = "archive";
export const ARCHIVE_LABEL = "Archive";
/**
 * Stored in the folded-Groups list (lib/collapsedGroups.ts) while the user has 보관함 open. Every
 * other folder starts open and the list holds the ones folded; 보관함 starts folded, so its entry
 * means the opposite and has a key of its own.
 */
export const ARCHIVE_OPEN_KEY = "archive:open";

export function isPinned(s: SessionSummary): boolean {
  return s.pinPosition != null;
}

export function isArchived(s: SessionSummary): boolean {
  return s.archivedAt != null;
}

/**
 * Whether a folder shows folded. 보관함 is folded unless the user opened it, and a search opens it
 * for as long as the search text is there (a match inside a folded 보관함 would hide behind its
 * count). The search does not change what is stored.
 */
export function isGroupFolded(group: Pick<SessionGroup, "kind" | "key">, folded: ReadonlySet<string>, searching: boolean): boolean {
  if (group.kind === "archive") return !(folded.has(ARCHIVE_OPEN_KEY) || searching);
  return folded.has(group.key);
}

/** The key the folded list toggles for a folder: 보관함's own entry, or the folder's key. */
export function foldKeyOf(group: Pick<SessionGroup, "kind" | "key">): string {
  return group.kind === "archive" ? ARCHIVE_OPEN_KEY : group.key;
}

/** The set with `key` folded or unfolded, as the server will have it once it takes the same command. */
export function withFolded(keys: ReadonlySet<string>, key: string, folded: boolean): Set<string> {
  const next = new Set(keys);
  if (folded) next.add(key);
  else next.delete(key);
  return next;
}

/** Order inside 보관함: the one archived last first. */
export function compareArchiveOrder(a: SessionSummary, b: SessionSummary): number {
  return (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || a.key.localeCompare(b.key);
}

export function projectGroupKey(projectId: string): string {
  return `project:${projectId}`;
}

const HOME_RE = /^\/Users\/[^/]+/;

/** A cwd with the home directory shortened to `~`. */
export function shortPath(cwd: string | null): string {
  if (!cwd) return "(no cwd)";
  return cwd.replace(HOME_RE, "~");
}

/** The account label without its provider prefix (`claude-work` -> `work`). */
export function shortAccount(account: string): string {
  return account.replace(/^(claude|codex)-/, "");
}

/** The list's name rule (packages/shared sessionDisplayName). */
export function displayName(s: SessionSummary): string {
  return sessionDisplayName(s);
}

export const STATUS_LABEL: Record<UnifiedStatus, string> = {
  running: "Running",
  "waiting-input": "Waiting for input",
  "open-idle": "Open",
  closed: "Closed",
  error: "Error",
};

export const STATUS_ORDER: UnifiedStatus[] = ["waiting-input", "running", "error", "open-idle", "closed"];

export function isActive(s: SessionSummary): boolean {
  return s.status !== "closed";
}

export function isFilterActive(f: SessionFilter): boolean {
  return f.query.trim() !== "" || f.provider !== "all" || f.activeOnly;
}

export function matchesFilter(s: SessionSummary, f: SessionFilter): boolean {
  if (f.provider !== "all" && s.provider !== f.provider) return false;
  if (f.activeOnly && !isActive(s)) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  return [s.name, s.title, s.preview, s.cwd, s.id, s.account].some((v) => v && v.toLowerCase().includes(q));
}

/** Projects in display order: `sortOrder`, then creation time as the server orders them. */
export function sortProjects(projects: readonly Project[]): Project[] {
  return [...projects].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
}

/**
 * Order inside a project: the position the server keeps (fixed when a session is first seen,
 * changed only by the user), smaller first.
 */
export function compareSessionOrder(a: SessionSummary, b: SessionSummary): number {
  return (a.position ?? -a.updatedAt) - (b.position ?? -b.updatedAt) || a.key.localeCompare(b.key);
}

/** Order inside 고정됨: the pin position the server keeps, smaller first. */
export function comparePinOrder(a: SessionSummary, b: SessionSummary): number {
  return (a.pinPosition ?? 0) - (b.pinPosition ?? 0) || a.key.localeCompare(b.key);
}

/**
 * `provider:id` keys of every top-level session in a project (null = 미분류) in order, filters
 * aside. Pinned sessions count too: they keep their place in the project. Archived sessions do
 * not: a write of these keys takes the listed sessions out of 보관함, and an archived session
 * keeps its place in the project for the way back.
 */
export function groupSessionKeys(
  sessions: Iterable<SessionSummary>,
  projects: readonly Project[],
  projectId: string | null,
): string[] {
  const known = new Set(projects.map((p) => p.id));
  return [...sessions]
    .filter((s) => !s.parentKey && !isArchived(s) && ((s.projectId != null && known.has(s.projectId) ? s.projectId : null) === projectId))
    .sort(compareSessionOrder)
    .map((s) => `${s.provider}:${s.id}`);
}

/** `provider:id` keys of every pinned top-level session in 고정됨's order, filters aside; archived ones are not shown there. */
export function pinnedSessionKeys(sessions: Iterable<SessionSummary>): string[] {
  return [...sessions]
    .filter((s) => !s.parentKey && isPinned(s) && !isArchived(s))
    .sort(comparePinOrder)
    .map((s) => `${s.provider}:${s.id}`);
}

/** A session key (`provider:account:id`) as the account-free key placements and pins use (`provider:id`). */
export function placeKeyOf(sessionKey: string): string {
  const [provider, , ...id] = sessionKey.split(":");
  return `${provider}:${id.join(":")}`;
}

/** Where a dragged row was let go: a folder header, or above or below a row in that folder. */
export interface DropTarget {
  groupKey: string;
  /** The folder is 고정됨. */
  pinned: boolean;
  /** The folder is 보관함. */
  archive?: boolean;
  /** The folder's project; null for 미분류 (and for 고정됨, where it is unused). */
  projectId: string | null;
  /** A drop between rows: the row's `provider:id` and which side of it. */
  row?: { key: string; edge: "before" | "after" };
}

/** A droppable in the sidebar: a folder header, or a row (with its session key). */
export interface DropZone {
  groupKey: string;
  pinned: boolean;
  /** The folder is 보관함: a row there is a drop on the folder, since its order is by archive time. */
  archive?: boolean;
  projectId: string | null;
  /** The row's session key (`provider:account:id`); absent for a folder header. */
  sessionKey?: string;
}

/**
 * Where a dragged row lands if it is let go now: a folder header (its top), or above or below a
 * row. The sidebar draws exactly this and a drop writes exactly this.
 */
export interface DropSpot {
  groupKey: string;
  pinned: boolean;
  archive?: boolean;
  projectId: string | null;
  /** Between rows: the row's session key and which side of it. */
  row?: { sessionKey: string; edge: "before" | "after" };
}

/**
 * The spot for one moment of a drag, from the zone under the pointer, the dragged row's box and
 * that zone's box. null where a drop changes nothing: outside every zone (the gaps between rows
 * and above headers), over a row of the dragged session (the dragged row, or the session's other
 * row in 고정됨 or in its Group: it would land next to itself), or on the header of the folder it
 * came from. The side of a row is the side of its middle that the dragged row's middle is on.
 */
export function dropSpotOf(input: {
  zone: DropZone | null;
  zoneRect: { top: number; height: number } | null;
  draggedRect: { top: number; height: number } | null;
  moving: { sessionKey: string; fromGroup: string };
}): DropSpot | null {
  const { zone, moving } = input;
  if (!zone) return null;
  const folder = {
    groupKey: zone.groupKey, pinned: zone.pinned, projectId: zone.projectId, ...(zone.archive ? { archive: true } : {}),
  };
  // 보관함 orders by archive time: a row there takes the drop as the folder, with no line.
  if (zone.sessionKey === undefined || zone.archive) return zone.groupKey === moving.fromGroup ? null : folder;
  if (zone.sessionKey === moving.sessionKey || !input.zoneRect || !input.draggedRect) return null;
  const middle = input.draggedRect.top + input.draggedRect.height / 2;
  const zoneMiddle = input.zoneRect.top + input.zoneRect.height / 2;
  return { ...folder, row: { sessionKey: zone.sessionKey, edge: middle < zoneMiddle ? "before" : "after" } };
}

export function sameDropSpot(a: DropSpot | null, b: DropSpot | null): boolean {
  if (a === null || b === null) return a === b;
  return a.groupKey === b.groupKey && a.row?.sessionKey === b.row?.sessionKey && a.row?.edge === b.row?.edge;
}

/**
 * The line a row draws for `spot`: the row is the session's row in that folder. A pinned session
 * has a row in 고정됨 and one in its Group, and only the one in the spot's folder draws it.
 */
export function dropLineAt(spot: DropSpot | null, groupKey: string, sessionKey: string): "before" | "after" | null {
  return spot?.row && spot.groupKey === groupKey && spot.row.sessionKey === sessionKey ? spot.row.edge : null;
}

/** The target planDrop reads for a spot. */
export function dropTargetOf(spot: DropSpot): DropTarget {
  return {
    groupKey: spot.groupKey,
    pinned: spot.pinned,
    projectId: spot.projectId,
    ...(spot.archive ? { archive: true } : {}),
    ...(spot.row ? { row: { key: placeKeyOf(spot.row.sessionKey), edge: spot.row.edge } } : {}),
  };
}

/**
 * The write a drop asks for (DESIGN.md 6c): `place` is PUT /api/session-order, `pin` is
 * PUT /api/session-pins, `archive` is PUT /api/session-archive (`key` is `provider:id`). A
 * `place` or `pin` of a session in 보관함 takes it out of there on the server.
 */
export type DropPlan =
  | { kind: "place"; projectId: string | null; keys: string[] }
  | { kind: "pin"; keys: string[] }
  | { kind: "archive"; key: string };

/**
 * The write for a row (`moving`, `provider:id`) dragged out of folder `fromGroup` and let go on
 * `target`, or null when nothing changes. Pins and Group places are two separate orders, and a
 * drop writes only the one of the folder it lands in.
 * - Between rows: that place. On a folder header: the top of that folder, unless it is the
 *   folder the row came from.
 * - Into 고정됨 the keys are the whole pinned order, so a pin hidden by a filter keeps its place.
 *   A Group row becomes pinned there and stays in its Group.
 * - Into a Group the keys are the whole Group, pinned members included, so they keep their place.
 *   A 고정됨 row moves its session's Group place and stays pinned.
 */
export function planDrop(input: {
  sessions: Iterable<SessionSummary>;
  projects: readonly Project[];
  moving: string;
  fromGroup: string;
  target: DropTarget;
}): DropPlan | null {
  const { moving, target } = input;
  if (target.archive) return target.groupKey === input.fromGroup ? null : { kind: "archive", key: moving };
  const others = (
    target.pinned
      ? pinnedSessionKeys(input.sessions)
      : groupSessionKeys(input.sessions, input.projects, target.projectId)
  ).filter((k) => k !== moving);
  let keys: string[];
  if (target.row) {
    const at = others.indexOf(target.row.key);
    if (at < 0 || target.row.key === moving) return null;
    others.splice(target.row.edge === "before" ? at : at + 1, 0, moving);
    keys = others;
  } else if (target.groupKey !== input.fromGroup) {
    keys = [moving, ...others];
  } else {
    return null;
  }
  if (target.pinned) return { kind: "pin", keys };
  return { kind: "place", projectId: target.projectId, keys };
}

/**
 * Sidebar folders: 고정됨, every project in order, 미분류, then 보관함.
 * - An archived session shows in 보관함 only, not in 고정됨 or its Group (it keeps its pin and
 *   Group on the server, for when it comes out). 보관함 lists the one archived last first.
 * - Subagent sessions (`parentKey`) are left out; they show under their parent.
 * - A pinned session shows in 고정됨 and also in its own folder at its place there, so 고정됨 is a
 *   second way to reach it. The filters treat both rows alike.
 * - A session whose project is not in `projects` lands in 미분류. A deleted project's sessions
 *   reach the UI as upserts after the new project list, so this covers the moment in between.
 * - With no filter, empty projects stay (a new project starts empty); with a filter, folders
 *   without a match are dropped. 고정됨 and 미분류 show only when they have sessions.
 */
export function groupByProject(
  sessions: Iterable<SessionSummary>,
  projects: readonly Project[],
  filter: SessionFilter,
): SessionGroup[] {
  const ordered = sortProjects(projects);
  const pinned: SessionGroup = {
    kind: "pinned",
    key: PINNED_GROUP_KEY,
    project: null,
    label: PINNED_LABEL,
    sessions: [],
  };
  const groups = new Map<string, SessionGroup>();
  for (const p of ordered) {
    groups.set(p.id, { kind: "project", key: projectGroupKey(p.id), project: p, label: p.name, sessions: [] });
  }
  const unassigned: SessionGroup = {
    kind: "unassigned",
    key: UNASSIGNED_GROUP_KEY,
    project: null,
    label: UNASSIGNED_LABEL,
    sessions: [],
  };
  const archive: SessionGroup = {
    kind: "archive",
    key: ARCHIVE_GROUP_KEY,
    project: null,
    label: ARCHIVE_LABEL,
    sessions: [],
  };
  for (const s of sessions) {
    if (s.parentKey) continue;
    if (!matchesFilter(s, filter)) continue;
    if (isArchived(s)) {
      archive.sessions.push(s);
      continue;
    }
    if (isPinned(s)) pinned.sessions.push(s);
    ((s.projectId != null && groups.get(s.projectId)) || unassigned).sessions.push(s);
  }
  const keepEmpty = !isFilterActive(filter);
  const result: SessionGroup[] = [];
  pinned.sessions.sort(comparePinOrder);
  if (pinned.sessions.length > 0) result.push(pinned);
  for (const g of [...groups.values(), unassigned]) {
    g.sessions.sort(compareSessionOrder);
    if (g.sessions.length > 0 || (keepEmpty && g.kind === "project")) result.push(g);
  }
  // Last, and there with nothing in it too (without a filter) so there is a folder to drop onto.
  archive.sessions.sort(compareArchiveOrder);
  if (archive.sessions.length > 0 || keepEmpty) result.push(archive);
  return result;
}

/** Top-level sessions assigned to a project, whatever the filters show. */
export function countProjectSessions(sessions: Iterable<SessionSummary>, projectId: string): number {
  let n = 0;
  for (const s of sessions) if (!s.parentKey && s.projectId === projectId) n++;
  return n;
}

/**
 * `order` (every project id, in display order) with `id` moved one place up (-1) or down (+1):
 * the body of `POST /api/projects/order`. null when it is already at that end or not listed.
 */
export function moveInOrder(order: readonly string[], id: string, delta: -1 | 1): string[] | null {
  const from = order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return null;
  const ids = [...order];
  ids.splice(from, 1);
  ids.splice(to, 0, id);
  return ids;
}

/**
 * Where a dragged Group (folder) lands among the Groups: above or below another Group. Pinned,
 * Unsorted and Archive do not move; they are the ends of the list, so a drop on them means the
 * first or the last Group place.
 */
export interface FolderSpot {
  /** The Group the dragged one lands next to. */
  projectId: string;
  edge: "before" | "after";
}

export function sameFolderSpot(a: FolderSpot | null, b: FolderSpot | null): boolean {
  if (a === null || b === null) return a === b;
  return a.projectId === b.projectId && a.edge === b.edge;
}

/**
 * `order` (every project id, display order) with `moving` placed next to `spot`'s Group: the body
 * of `POST /api/projects/order`. null when the order would not change or an id is not listed.
 */
export function planFolderDrop(order: readonly string[], moving: string, spot: FolderSpot): string[] | null {
  if (moving === spot.projectId || !order.includes(moving) || !order.includes(spot.projectId)) return null;
  const ids = order.filter((id) => id !== moving);
  const at = ids.indexOf(spot.projectId);
  ids.splice(spot.edge === "before" ? at : at + 1, 0, moving);
  return ids.every((id, i) => id === order[i]) ? null : ids;
}

/**
 * The spot for one moment of a Group drag, from the zone under the pointer (a folder header or one
 * of its rows). Over a Group the dragged one takes that Group's place, as a sortable list does:
 * moving up it lands above, moving down below. Over Pinned it is the first place; over Unsorted or
 * Archive the last. null where a drop changes nothing (outside every zone, over itself, or the
 * order would stay), so what the sidebar draws is what a drop writes.
 */
export function folderSpotOf(input: {
  zone: DropZone | null;
  order: readonly string[];
  moving: string;
}): FolderSpot | null {
  const { zone, order, moving } = input;
  if (!zone) return null;
  let spot: FolderSpot | null = null;
  if (zone.pinned) {
    const first = order[0];
    spot = first === undefined ? null : { projectId: first, edge: "before" };
  } else if (zone.archive || zone.projectId === null) {
    const last = order[order.length - 1];
    spot = last === undefined ? null : { projectId: last, edge: "after" };
  } else if (zone.projectId !== moving) {
    const to = order.indexOf(zone.projectId);
    const from = order.indexOf(moving);
    spot = to < 0 || from < 0 ? null : { projectId: zone.projectId, edge: from > to ? "before" : "after" };
  }
  return spot && planFolderDrop(order, moving, spot) ? spot : null;
}

/**
 * The line a Group's block draws for `spot`: "before" above its header, "after" below its last
 * row (its header when folded or empty).
 */
export function folderLineAt(spot: FolderSpot | null, projectId: string | null): "before" | "after" | null {
  return spot && projectId !== null && spot.projectId === projectId ? spot.edge : null;
}

/** Distinct cwds of top-level sessions, most recently active first: suggestions for a default folder. */
export function recentCwds(sessions: Iterable<SessionSummary>): string[] {
  const latest = new Map<string, number>();
  for (const s of sessions) {
    if (s.parentKey || !s.cwd) continue;
    latest.set(s.cwd, Math.max(latest.get(s.cwd) ?? 0, s.updatedAt));
  }
  return [...latest].sort((a, b) => b[1] - a[1]).map(([cwd]) => cwd);
}

export function relativeTime(ms: number, now: number): string {
  const d = Math.max(0, now - ms) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return new Date(ms).toLocaleDateString("en-US");
}

export function formatBytes(n: number | null): string {
  if (n == null) return "-";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
