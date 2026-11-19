// Which sidebar Groups are folded (DESIGN.md 6v). The server holds the list, shared by every client
// (/ws `hello.foldedGroups` and `foldedGroups`, PUT /api/group-fold). This browser keeps a copy
// under CACHE_KEY only so the first paint shows the last known folds before /ws answers. The value
// is the list of fold keys (`foldKeyOf` in model.ts: a Group's key, or `archive:open` for an open
// 보관함).
//
// An earlier build kept the list in this browser alone under LEGACY_KEY. That list is sent to the
// server once (POST /api/group-fold/import) and then removed.

export const COLLAPSED_GROUPS_CACHE_KEY = "maru_sidebar_folded_cache";
export const COLLAPSED_GROUPS_LEGACY_KEY = "maru_sidebar_collapsed_groups";

/** The stored keys, or none when nothing is stored, storage is blocked, or the value is not a list of strings. */
export function parseCollapsedGroups(raw: string | null): Set<string> {
  if (raw === null) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((k) => typeof k === "string") ? new Set(value) : new Set();
  } catch {
    return new Set();
  }
}

/**
 * What the first paint folds: the copy of the server's list, else the older build's own list (so
 * the first load after the upgrade does not flash everything open before the import lands).
 */
export function readCollapsedGroupsCache(storage: Pick<Storage, "getItem"> = window.localStorage): Set<string> {
  try {
    const cached = storage.getItem(COLLAPSED_GROUPS_CACHE_KEY);
    return parseCollapsedGroups(cached ?? storage.getItem(COLLAPSED_GROUPS_LEGACY_KEY));
  } catch {
    return new Set();
  }
}

export function writeCollapsedGroupsCache(keys: ReadonlySet<string>, storage: Pick<Storage, "setItem"> = window.localStorage): void {
  try {
    storage.setItem(COLLAPSED_GROUPS_CACHE_KEY, JSON.stringify([...keys].sort()));
  } catch {
    // Storage blocked or full: the first paint shows no folds until /ws answers.
  }
}

/** The older build's list, or null when there is none to send. */
export function readLegacyCollapsedGroups(storage: Pick<Storage, "getItem"> = window.localStorage): string[] | null {
  try {
    const raw = storage.getItem(COLLAPSED_GROUPS_LEGACY_KEY);
    return raw === null ? null : [...parseCollapsedGroups(raw)];
  } catch {
    return null;
  }
}

export function clearLegacyCollapsedGroups(storage: Pick<Storage, "removeItem"> = window.localStorage): void {
  try {
    storage.removeItem(COLLAPSED_GROUPS_LEGACY_KEY);
  } catch {
    // Storage blocked: the list is sent again with the next connect, and the server ignores it.
  }
}

// The pure set update lives in model.ts (the Android app reads it too); the web keeps importing it from here.
export { withFolded } from "../model.ts";
