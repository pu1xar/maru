// The folder path field (components/FolderPathField.tsx on the web, components/FolderPathInput.tsx
// in the Android app; DESIGN.md 6f, 6l and 6z): what a typed path means, which folders complete it,
// what Tab fills in, what a key does and why a path cannot be taken. The folders themselves come
// from the server (`GET /api/fs-complete`, `FolderCompletion`); everything here is a pure
// function of the typed text and that answer, so both clients behave alike.
import type { FolderCompletion } from "@maru/shared";

import { folderName } from "./sessionMeta.ts";

/** `empty` shows the recent folders, `path` is read from the server, `relative` cannot be a folder here. */
export type FolderInputKind = "empty" | "path" | "relative";

export const RELATIVE_REASON = "Enter a path starting with ~ or /";

export function folderInputKind(value: string): FolderInputKind {
  const t = value.trim();
  if (t === "") return "empty";
  return t === "~" || t.startsWith("~/") || t.startsWith("/") ? "path" : "relative";
}

/** What the server lists for the typed text: itself, except a bare `~`, which means the home folder's contents. */
export function listingQuery(value: string): string {
  const t = value.trim();
  return t === "~" ? "~/" : t;
}

/**
 * What the server reads to learn whether the typed text is a folder: the text as a folder, with
 * one trailing `/`. The listing of that folder answers `status` (missing, a file, refused).
 */
export function checkQuery(value: string): string {
  const stripped = listingQuery(value).replace(/\/+$/, "");
  return stripped === "" ? "/" : `${stripped}/`;
}

/** The typed text up to and including its last `/`: the folder whose subfolders are listed. */
export function parentPart(value: string): string {
  const t = listingQuery(value);
  return t.slice(0, t.lastIndexOf("/") + 1);
}

/** The last part typed, the prefix the listed folders start with. */
export function typedPrefix(value: string): string {
  const t = listingQuery(value);
  return t.slice(t.lastIndexOf("/") + 1);
}

/** The typed text with its last part replaced by a listed folder (an absolute path): `~/pro` and `/h/projects` give `~/projects`. */
export function withEntry(value: string, dir: string): string {
  return parentPart(value) + folderName(dir);
}

/** The longest start every name shares, ignoring case; its letters are the first name's. */
export function commonPrefix(names: readonly string[]): string {
  const first = names[0];
  if (first === undefined) return "";
  let n = first.length;
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < n && i < name.length && name[i]!.toLowerCase() === first[i]!.toLowerCase()) i++;
    n = i;
  }
  return first.slice(0, n);
}

/**
 * What Tab (and the right arrow at the end of the text) turns the text into, or null when it adds
 * nothing. A highlighted row is taken whole with its `/`, which goes one folder in. Otherwise one
 * match is taken whole with its `/`, and several fill up to the start they share (what a shell
 * does), staying put when that is what is typed already. Only names that start with the typed
 * part count (the list also holds names that merely contain it, and those fill nothing in unless
 * they are all there is).
 */
export function tabComplete(value: string, dirs: readonly string[], highlighted: number): string | null {
  const picked = highlighted >= 0 ? dirs[highlighted] : undefined;
  if (picked !== undefined) return `${withEntry(value, picked)}/`;
  const typed = typedPrefix(value);
  const starting = dirs.filter((d) => folderName(d).toLowerCase().startsWith(typed.toLowerCase()));
  const pool = starting.length > 0 ? starting : dirs;
  if (pool.length === 0) return null;
  if (pool.length === 1) return `${withEntry(value, pool[0]!)}/`;
  if (starting.length === 0) return null;
  const common = commonPrefix(pool.map(folderName));
  return common !== typed && common.length >= typed.length ? parentPart(value) + common : null;
}

/** What a key in the path field does (the component runs it; this only decides it). */
export type FolderKeyAction =
  | { type: "move"; dir: "down" | "up" }
  | { type: "complete" }
  | { type: "confirm" }
  | { type: "close" }
  | { type: "swallow" };

export interface FolderKeyState {
  key: string;
  shiftKey: boolean;
  /** An IME syllable is in progress (Korean input): the key belongs to the IME. */
  composing: boolean;
  kind: FolderInputKind;
  /** The rows shown or that would show (the subfolders, or the recent folders while empty). */
  rows: number;
  /** The highlighted row, -1 for none. */
  highlighted: number;
  /** The list is on screen. */
  listOpen: boolean;
  /** The caret is after the last character with nothing selected. */
  caretAtEnd: boolean;
}

/**
 * ArrowDown and ArrowUp pick a row, Tab or ArrowRight (at the end of the text) complete it and go
 * one folder in, Enter confirms, Escape closes the list (a second Escape is the dialog's). Null
 * leaves the key to the browser: Shift+Tab, a relative path's Tab, an ArrowRight inside the text.
 */
export function folderKeyAction(k: FolderKeyState): FolderKeyAction | null {
  if (k.composing) return null;
  switch (k.key) {
    case "ArrowDown":
    case "ArrowUp":
      return k.rows > 0 ? { type: "move", dir: k.key === "ArrowDown" ? "down" : "up" } : null;
    case "Tab":
    case "ArrowRight": {
      if (k.key === "Tab" && k.shiftKey) return null;
      if (k.key === "ArrowRight" && (!k.caretAtEnd || k.shiftKey)) return null;
      if (!k.listOpen || k.rows === 0 || k.kind === "relative") return null;
      // Nothing typed yet: a highlighted recent folder is taken, and otherwise the key moves on.
      if (k.kind === "empty" && k.highlighted < 0) return null;
      return { type: "complete" };
    }
    case "Enter":
      return k.kind === "empty" && k.highlighted < 0 ? { type: "swallow" } : { type: "confirm" };
    case "Escape":
      return k.listOpen ? { type: "close" } : null;
    default:
      return null;
  }
}

/** The highlighted row after ArrowDown or ArrowUp; -1 is none, and both keys wrap around. */
export function moveHighlight(current: number, count: number, key: "down" | "up"): number {
  if (count <= 0) return -1;
  if (key === "down") return current < 0 || current >= count - 1 ? 0 : current + 1;
  return current <= 0 ? count - 1 : current - 1;
}

export type FolderCheck = { ok: true; path: string } | { ok: false; reason: string };

const STATUS_REASON = {
  missing: "No such folder",
  "not-folder": "Not a folder",
  unreadable: "This folder cannot be read (no permission)",
} as const;

/**
 * Whether the typed text names a folder one can pick. `listed` is the server's listing of
 * `checkQuery(value)`; its `parent` is the folder with `~` and `..` resolved.
 */
export function judgeFolder(value: string, listed: FolderCompletion): FolderCheck {
  if (folderInputKind(value) !== "path") return { ok: false, reason: RELATIVE_REASON };
  if (listed.status !== "ok") return { ok: false, reason: STATUS_REASON[listed.status] };
  return { ok: true, path: listed.parent };
}

/** What the server last said about one typed text (the field keeps the latest). */
export interface FolderLookup {
  /** The typed text this answer is for. */
  key: string;
  list: FolderCompletion | null;
  check: FolderCompletion | null;
  error: string | null;
}

/** The listing of the typed text and the folder check, read together (one request when they are the same folder). */
export async function readFolders(
  value: string,
  complete: (query: string) => Promise<FolderCompletion>,
): Promise<{ list: FolderCompletion; check: FolderCompletion }> {
  const lq = listingQuery(value);
  const cq = checkQuery(value);
  const [list, check] = await Promise.all([complete(lq), cq === lq ? null : complete(cq)]);
  return { list, check: check ?? list };
}

export interface FolderFieldView {
  kind: FolderInputKind;
  /** The answer for exactly this text, when it has arrived. */
  fresh: FolderLookup | null;
  verdict: FolderCheck | null;
  /** Why an existing folder is not wanted (`reject`). */
  rejected: string | null;
  /** The folder the text names once the server read it as a folder and nothing rejects it. */
  resolvedPath: string | null;
  /** The recent folders while empty, else the subfolders of the last answer (an older answer's rows stay until the new one arrives, so the list does not blink while typing). */
  rows: string[];
  /** The text the listed rows were read for. */
  rowBase: string;
  /** What to say under the field: a relative path, a missing folder, a file, a refusal or a rejection. */
  reason: string | null;
  /** The server has not answered for this text yet. */
  checking: boolean;
}

/** Everything a path field shows, from the typed text and the last answer. */
export function folderFieldView(
  value: string,
  lookup: FolderLookup | null,
  recent: readonly string[],
  reject?: (path: string) => string | null,
): FolderFieldView {
  const kind = folderInputKind(value);
  const fresh = kind === "path" && lookup?.key === value ? lookup : null;
  const verdict = fresh?.check ? judgeFolder(value, fresh.check) : null;
  const rejected = verdict?.ok ? (reject?.(verdict.path) ?? null) : null;
  const resolvedPath = verdict?.ok && rejected === null ? verdict.path : null;
  const shownList = kind === "path" ? (fresh?.list ?? lookup?.list ?? null) : null;
  const rows = kind === "empty" ? [...recent] : (shownList?.dirs ?? []);
  const rowBase = kind === "path" ? (lookup?.key ?? value) : value;
  const reason = kind === "relative" ? RELATIVE_REASON : verdict && !verdict.ok ? verdict.reason : rejected;
  return { kind, fresh, verdict, rejected, resolvedPath, rows, rowBase, reason, checking: kind === "path" && fresh === null && lookup?.error == null };
}
