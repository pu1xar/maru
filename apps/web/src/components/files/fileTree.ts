// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// The state rules of the right panel's 파일 tab (FileExplorer.tsx), as pure functions. Sources:
// components/files/FileBrowserPanel.tsx (expand all skips ignored folders; a selected path's
// ancestors are expanded), components/files/useDirectoryEntries.ts (a new listing drops the
// folders under it that are gone), components/files/fileTreeExpansion.ts, and the behavior of
// the @pierre/trees tree T3 renders with (Apache License 2.0): utils/sortChildren.js (folders,
// then dot names, then case-insensitive names), flattenEmptyDirectories (a chain of folders that
// each hold one folder shows as one row "a / b"), an ignored folder's rows are ignored too,
// model/searchHelpers.js and the "hide-non-matches" search (a path matches when it contains the
// query; matches and their folders show, matching folders open), and the row keys of
// render/FileTreeView.js handleTreeKeyDown.
// Local changes: the model is maru's own instead of Pierre's path store. Search covers the
// folders loaded so far (T3 does this for host folders; for a project it also asks a server-side
// path index). A flattened chain is not formed while searching.
import type { FileTreeEntry } from "@maru/shared";

/** One child in the tree: the server's entry with its path under the root. */
export interface TreeEntry extends FileTreeEntry {
  /** `/`-joined path under the root. */
  path: string;
}

/** Each loaded folder's children, sorted; the key "" is the root. */
export type Listings = ReadonlyMap<string, readonly TreeEntry[]>;

export function joinTreePath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

export function parentTreePath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** The folders above `path`, outermost first: "a/b/c" gives ["a", "a/b"]. */
export function treeAncestors(path: string): string[] {
  const out: string[] = [];
  for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) out.push(path.slice(0, i));
  return out;
}

/** Pierre's defaultChildrenComparator: folders first, then dot names, then names ignoring case. */
export function compareTreeEntries(a: FileTreeEntry, b: FileTreeEntry): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  const aDot = a.name.startsWith(".");
  if (aDot !== b.name.startsWith(".")) return aDot ? -1 : 1;
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

/**
 * The listings with `dir`'s new children. Folders under `dir` whose top child is no longer a
 * folder there are dropped with everything below them (T3 useDirectoryEntries), and come back
 * in `removed`.
 */
export function applyListing(
  listings: Listings,
  dir: string,
  entries: readonly FileTreeEntry[],
): { listings: Map<string, readonly TreeEntry[]>; removed: string[] } {
  const next = new Map(listings);
  return { listings: next, removed: applyListingTo(next, dir, entries) };
}

/** applyListing on a map the caller owns (a batch of reads applied before one render). */
export function applyListingTo(
  listings: Map<string, readonly TreeEntry[]>,
  dir: string,
  entries: readonly FileTreeEntry[],
): string[] {
  const children = entries.map((e) => ({ ...e, path: joinTreePath(dir, e.name) })).sort(compareTreeEntries);
  listings.set(dir, children);
  const childDirs = new Set(children.filter((e) => e.kind === "directory").map((e) => e.path));
  const prefix = dir === "" ? "" : `${dir}/`;
  const removed: string[] = [];
  for (const path of listings.keys()) {
    if (path === dir || !path.startsWith(prefix)) continue;
    const slash = path.indexOf("/", prefix.length);
    if (!childDirs.has(slash < 0 ? path : path.slice(0, slash))) removed.push(path);
  }
  for (const path of removed) listings.delete(path);
  return removed;
}

/** Pierre's normalizeSearchQuery: trimmed, `/` for `\`, lowercase; "" means no search. */
export function normalizeTreeQuery(value: string): string {
  return value.trim().replaceAll("\\", "/").toLowerCase();
}

export interface TreeRow {
  /** The path the row stands for: a file, a folder, or the last folder of a flattened chain. */
  path: string;
  /** What the row shows: the name, or the chain's names joined by " / ". */
  name: string;
  /** The folders of a flattened chain, outermost first. */
  segments: readonly TreeEntry[] | null;
  kind: "file" | "directory";
  depth: number;
  /** The paths of the rows above it, one per level (indent guides are keyed by them). */
  ancestors: readonly string[];
  expanded: boolean;
  /** An open folder whose children are being read. */
  loading: boolean;
  /** Git ignores it or a folder above it. */
  ignored: boolean;
  link: boolean;
  /** It matched the search query. */
  match: boolean;
}

export interface TreeRowsInput {
  listings: Listings;
  expanded: ReadonlySet<string>;
  loading: ReadonlySet<string>;
  /** normalizeTreeQuery's result. */
  query: string;
}

export interface TreeRows {
  rows: TreeRow[];
  /** Paths matching the query; 0 without a query. */
  matchCount: number;
}

/** The single-folder chain that starts at `entry` (flattenEmptyDirectories). */
function chainFrom(listings: Listings, entry: TreeEntry): TreeEntry[] {
  const chain = [entry];
  for (;;) {
    const children = listings.get(chain.at(-1)!.path);
    if (!children || children.length !== 1 || children[0]!.kind !== "directory") return chain;
    chain.push(children[0]!);
  }
}

/** The rows in order: open folders' children follow them, a search shows only matches and their folders. */
export function buildTreeRows({ listings, expanded, loading, query }: TreeRowsInput): TreeRows {
  const rows: TreeRow[] = [];
  if (query) {
    const visible = new Set<string>();
    let matchCount = 0;
    const matches = new Set<string>();
    for (const children of listings.values()) {
      for (const e of children) {
        if (!e.path.toLowerCase().includes(query)) continue;
        matchCount++;
        matches.add(e.path);
        visible.add(e.path);
        for (const a of treeAncestors(e.path)) visible.add(a);
      }
    }
    if (matchCount === 0) return { rows, matchCount };
    const visit = (dir: string, depth: number, ancestors: readonly string[], ignored: boolean) => {
      for (const e of listings.get(dir) ?? []) {
        if (!visible.has(e.path)) continue;
        const rowIgnored = ignored || e.ignored === true;
        // A matching folder and the folders of matches are open while searching.
        const open = e.kind === "directory";
        rows.push({
          path: e.path,
          name: e.name,
          segments: null,
          kind: e.kind,
          depth,
          ancestors,
          expanded: open && listings.has(e.path),
          loading: open && loading.has(e.path),
          ignored: rowIgnored,
          link: e.link === true,
          match: matches.has(e.path),
        });
        if (open) visit(e.path, depth + 1, [...ancestors, e.path], rowIgnored);
      }
    };
    visit("", 0, [], false);
    return { rows, matchCount };
  }
  const visit = (dir: string, depth: number, ancestors: readonly string[], ignored: boolean) => {
    for (const e of listings.get(dir) ?? []) {
      if (e.kind === "file") {
        rows.push({
          path: e.path,
          name: e.name,
          segments: null,
          kind: "file",
          depth,
          ancestors,
          expanded: false,
          loading: false,
          ignored: ignored || e.ignored === true,
          link: e.link === true,
          match: false,
        });
        continue;
      }
      const chain = chainFrom(listings, e);
      const tail = chain.at(-1)!;
      const rowIgnored = ignored || chain.some((c) => c.ignored === true);
      const open = expanded.has(tail.path);
      rows.push({
        path: tail.path,
        name: chain.map((c) => c.name).join(" / "),
        segments: chain.length > 1 ? chain : null,
        kind: "directory",
        depth,
        ancestors,
        expanded: open,
        loading: open && loading.has(tail.path),
        ignored: rowIgnored,
        link: chain.some((c) => c.link === true),
        match: false,
      });
      if (open) visit(tail.path, depth + 1, [...ancestors, tail.path], rowIgnored);
    }
  };
  visit("", 0, [], false);
  return { rows, matchCount: 0 };
}

/** The row showing `path`: its own, or the flattened chain that passes through it. */
export function treeRowIndex(rows: readonly TreeRow[], path: string): number {
  return rows.findIndex((r) => r.path === path || (r.segments?.some((s) => s.path === path) ?? false));
}

/** Open folders on screen whose children are not read yet and not being read. */
export function foldersToLoad(
  rows: readonly TreeRow[],
  listings: Listings,
  loading: ReadonlySet<string>,
  failed: ReadonlySet<string>,
): string[] {
  return rows
    .filter((r) => r.kind === "directory" && r.expanded && !listings.has(r.path) && !loading.has(r.path) && !failed.has(r.path))
    .map((r) => r.path);
}

/**
 * An open folder listed with one folder opens that one too, so the flattened row it becomes
 * shows its contents. A linked folder is not opened this way, so a link cycle cannot open itself
 * without end. Unchanged set otherwise.
 */
export function openSingleChild(
  expanded: ReadonlySet<string>,
  dir: string,
  children: readonly TreeEntry[],
): ReadonlySet<string> {
  const only = children.length === 1 ? children[0]! : null;
  if (!expanded.has(dir) || !only || only.kind !== "directory" || only.link || expanded.has(only.path)) return expanded;
  return new Set(expanded).add(only.path);
}

/** The folders a row opens and closes together: every folder of a flattened chain, else its own. */
export function rowFolders(row: TreeRow): string[] {
  return row.segments ? row.segments.map((s) => s.path) : [row.path];
}

/** Expanded folders whose parent is listed without them (deleted, renamed) are dropped. */
export function pruneExpanded(expanded: ReadonlySet<string>, listings: Listings): ReadonlySet<string> {
  let next: Set<string> | null = null;
  // Each parent's child folders as a set, built once per parent the expanded paths name.
  const folders = new Map<string, Set<string> | null>();
  for (const path of expanded) {
    const parent = parentTreePath(path);
    let set = folders.get(parent);
    if (set === undefined) {
      const siblings = listings.get(parent);
      set = siblings ? new Set(siblings.filter((e) => e.kind === "directory").map((e) => e.path)) : null;
      folders.set(parent, set);
    }
    if (set === null || set.has(path)) continue;
    next ??= new Set(expanded);
    next.delete(path);
  }
  return next ?? expanded;
}

/**
 * Folders "expand all" opens: every listed folder git does not ignore and that is not a link (T3).
 * Only a folder whose listing carries ignore labels (`checked`: inside a repository) opens its
 * children, as nothing else tells installed packages apart.
 */
export function expandableFolders(listings: Listings, checked: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    if (!checked.has(dir)) return;
    for (const e of listings.get(dir) ?? []) {
      if (e.kind !== "directory" || e.ignored || e.link) continue;
      out.push(e.path);
      visit(e.path);
    }
  };
  visit("");
  return out;
}

export type TreeKeyResult = { focus: string } | { expand: string } | { collapse: string } | null;

/**
 * Pierre's handleTreeKeyDown for one key on the focused row. While searching, Pierre moves between
 * matches with the up and down keys and leaves the other keys alone.
 */
export function treeKeyAction(
  rows: readonly TreeRow[],
  focused: string | null,
  key: string,
  searching = false,
): TreeKeyResult {
  if (rows.length === 0) return null;
  const at = focused === null ? -1 : treeRowIndex(rows, focused);
  if (searching) {
    if (key !== "ArrowDown" && key !== "ArrowUp") return null;
    const matches = rows.map((r, i) => (r.match ? i : -1)).filter((i) => i >= 0);
    if (matches.length === 0) return null;
    const next =
      key === "ArrowDown"
        ? (matches.find((i) => i > at) ?? matches.at(-1)!)
        : (matches.findLast((i) => i < at) ?? (at < 0 ? matches.at(-1)! : matches[0]!));
    return { focus: rows[next]!.path };
  }
  const row = at >= 0 ? rows[at]! : null;
  const step = (offset: number): TreeKeyResult => {
    const next = at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + offset));
    return { focus: rows[next]!.path };
  };
  switch (key) {
    case "ArrowDown":
      return step(1);
    case "ArrowUp":
      return step(-1);
    case "ArrowRight":
      if (row?.kind === "directory" && !row.expanded) return { expand: row.path };
      return step(1);
    case "ArrowLeft": {
      if (row?.kind === "directory" && row.expanded) return { collapse: row.path };
      const parent = row?.ancestors.at(-1);
      return parent === undefined ? null : { focus: parent };
    }
    case "Home":
      return { focus: rows[0]!.path };
    case "End":
      return { focus: rows.at(-1)!.path };
    default:
      return null;
  }
}

/** Open folders of one root, as stored (T3 fileTreeExpansion.ts: most recently written root first). */
export interface StoredExpansion {
  root: string;
  paths: string[];
}

function storedList(value: unknown): StoredExpansion[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is StoredExpansion =>
      !!v &&
      typeof v === "object" &&
      typeof (v as StoredExpansion).root === "string" &&
      Array.isArray((v as StoredExpansion).paths) &&
      (v as StoredExpansion).paths.every((p) => typeof p === "string"),
  );
}

/** The open folders stored for `root`; none for a value that is not a stored list. */
export function storedExpansionFor(value: unknown, root: string): string[] {
  return storedList(value).find((e) => e.root === root)?.paths ?? [];
}

/** The stored list with `root`'s open folders first; a root with none is left out. */
export function withStoredExpansion(value: unknown, root: string, paths: readonly string[]): StoredExpansion[] {
  const others = storedList(value).filter((e) => e.root !== root);
  return paths.length ? [{ root, paths: [...paths] }, ...others] : others;
}

/**
 * A file path with `.` segments dropped, `..` applied and no trailing slash (a chat link can name
 * `/proj/./src/a.ts`). Paths that start with `/` or `~/`; others come back as they are.
 */
export function normalizeFilePath(p: string): string {
  const lead = p.startsWith("/") ? "/" : p === "~" || p.startsWith("~/") ? "~" : null;
  if (lead === null) return p;
  const out: string[] = [];
  for (const segment of p.slice(1).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return lead === "/" ? `/${out.join("/")}` : out.length ? `~/${out.join("/")}` : "~";
}

/** The home folder a root sits in (`/Users/<name>`), from the root itself. */
function homeOf(root: string): string | null {
  return /^\/Users\/[^/]+(?=\/|$)/.exec(root)?.[0] ?? null;
}

/** A path as the panel compares it: normalized, with `~` for that home folder. */
function comparablePath(p: string, home: string | null): string {
  const n = normalizeFilePath(p);
  return home && (n === home || n.startsWith(`${home}/`)) ? `~${n.slice(home.length)}` : n;
}

/**
 * `target` under `root` as a tree path; "" for the root itself, null outside it. A `~` path and
 * the same path under the root's home folder compare equal; another user's folder does not.
 */
export function treeRelativePath(root: string, target: string): string | null {
  const home = homeOf(normalizeFilePath(root)) ?? homeOf(normalizeFilePath(target));
  const r = comparablePath(root, home);
  const t = comparablePath(target, home);
  if (t === r) return "";
  const prefix = r.endsWith("/") ? r : `${r}/`;
  return t.startsWith(prefix) ? t.slice(prefix.length) : null;
}

/** A tree path back to the absolute path a file tab opens. */
export function treeAbsolutePath(root: string, path: string): string {
  return root.endsWith("/") ? `${root}${path}` : `${root}/${path}`;
}
