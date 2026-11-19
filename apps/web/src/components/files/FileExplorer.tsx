// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: components/files/FileBrowserPanel.tsx (subheader with refresh, "Search files" field
// and expand/collapse all; Escape clears the search; mod+F focuses it; loading, retry and no-match
// lines; a selected path from outside is revealed: its folders open, the search closes and the
// row comes to the middle; folders read only when opened; open folders kept per root and reopened
// on mount), pierre-tree-theme.ts (12px sans rows, text color from the theme, hover and selected
// fills mixed from the text color, rounded rows, a spinning loading mark) and the @pierre/trees
// tree it renders (Apache License 2.0): compact density (24px rows, spacing factor 0.8) and
// style.css (row padding, indent guides that show on hover and fully under the focused row's
// folder, chevron or file icon, ignored rows dimmed, matches in semibold, 1px focus ring),
// render/FileTreeView.js (a row click opens a file or toggles a folder; arrow, Home and End keys;
// rows windowed to the viewport).
// Local changes: the tree is drawn here instead of by Pierre's shadow-DOM element, and the panel
// shows it as its own fixed tab (DESIGN.md 6e); a file opens as a file tab, so the marked row is
// that tab's file. Search covers the folders read so far (T3's host-folder mode). The desktop
// context menu and dragging a row into the composer are left out.
import type { FileTarget } from "~/rightPanel";
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { useAreaZoom } from "~/lib/areaZoom";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { InputGroup, InputGroupInput } from "../ui/input-group";
import { RefreshIcon } from "../ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildTreeRows,
  expandableFolders,
  foldersToLoad,
  normalizeTreeQuery,
  openSingleChild,
  parentTreePath,
  pruneExpanded,
  rowFolders,
  storedExpansionFor,
  treeAbsolutePath,
  treeAncestors,
  treeKeyAction,
  treeRelativePath,
  treeRowIndex,
  withStoredExpansion,
  type TreeRow,
} from "./fileTree";
import { TREE_MUTED_COLOR, ensureTreeIconSprite, resolveFileIcon, treeIconColor } from "./treeIcons";
import { useDirectoryEntries } from "./useDirectoryEntries";

const EXPANDED_STORAGE_KEY = "maru_file_tree_expanded";
/** How long a burst of open-folder changes waits before it is stored. */
const EXPANDED_WRITE_DELAY_MS = 300;
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

// Pierre compact density: 24px rows and every spacing at 0.8 of its default.
const DENSITY = 0.8;

/** The tree's px sizes. */
export interface TreeGeometry {
  rowHeight: number;
  itemPaddingX: number;
  itemMarginX: number;
  itemRowGap: number;
  levelGap: number;
  iconWidth: number;
  iconNudge: number;
  paddingInline: number;
}

/**
 * Pierre's compact sizes at the right panel's zoom (`scale` 1 is 100%, lib/areaZoom.ts). The row
 * height is whole px, so rows sit on pixel rows and the windowing math stays exact; the 12px text
 * scales through index.css (text-xs inside the zoomed panel).
 */
export function treeGeometry(scale: number): TreeGeometry {
  return {
    rowHeight: Math.round(24 * scale),
    itemPaddingX: 8 * DENSITY * scale,
    itemMarginX: 2 * DENSITY * scale,
    itemRowGap: 6 * DENSITY * scale,
    levelGap: 8 * DENSITY * scale,
    iconWidth: 16 * scale,
    iconNudge: 1 * DENSITY * scale,
    paddingInline: 16 * scale,
  };
}
/** Pierre's default overscan: rows rendered past each edge of the viewport. */
const OVERSCAN_ROWS = 10;
/** Pierre's --trees-accent, its focus ring. */
const FOCUS_RING = "#009fff";
/** Pierre's ignored hue, light then dark. */
const IGNORED_COLOR = "light-dark(#adadb1, #4a4a4e)";
/** Pierre's --trees-indent-guide-bg: the muted text color at 25%. */
const GUIDE_COLOR = "color-mix(in lab, #84848a 25%, transparent)";

function readExpanded(root: string): string[] {
  try {
    const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY);
    return raw ? storedExpansionFor(JSON.parse(raw), root) : [];
  } catch {
    return [];
  }
}

function writeExpanded(root: string, paths: readonly string[]): void {
  try {
    const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY);
    const value = withStoredExpansion(raw ? JSON.parse(raw) : null, root, paths);
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Private windows and full storage keep the open folders for this page only.
  }
}

function basenameOf(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed || p;
}

function addAll(set: ReadonlySet<string>, paths: readonly string[]): ReadonlySet<string> {
  if (paths.every((p) => set.has(p))) return set;
  const next = new Set(set);
  for (const p of paths) next.add(p);
  return next;
}

export interface FileExplorerProps {
  /** The session folder the tree starts at, absolute. */
  root: string;
  /** The file tab the panel shows or showed last; its row is marked and revealed. */
  current: FileTarget | null;
  onOpenFile: (target: FileTarget) => void;
  /** Another tab shows; the tree stays mounted so its folders and scroll position stay. */
  hidden: boolean;
  /** The panel is a sheet: T3's subheader there is taller and has a bottom border. */
  sheet: boolean;
}

export function FileExplorer({ root, current, onOpenFile, hidden, sheet }: FileExplorerProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(readExpanded(root)));
  const [expandAll, setExpandAll] = useState(false);
  const [query, setQuery] = useState("");
  const normalized = normalizeTreeQuery(query);
  // The open folders as of the last render, for reads that wait for their turn.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const dirs = useDirectoryEntries(root, {
    onListing: (dir, children) => setExpanded((prev) => openSingleChild(prev, dir, children)),
    wanted: (dir) => dir === "" || expandedRef.current.has(dir),
  });
  const { listings, loading } = dirs;
  const { rows, matchCount } = useMemo(
    () => buildTreeRows({ listings, expanded, loading, query: normalized }),
    [listings, expanded, loading, normalized],
  );
  const noMatches = normalized !== "" && matchCount === 0;

  useLayoutEffect(ensureTreeIconSprite, []);

  // Keeps the open folders for the next mount (T3 writeExpandedDirectories). One write per burst of
  // changes ("expand all" changes them every frame), and the last one before unmount.
  const pendingWrite = useRef<(() => void) | null>(null);
  useEffect(() => {
    const write = () => {
      pendingWrite.current = null;
      writeExpanded(root, [...expanded]);
    };
    pendingWrite.current = write;
    const timer = window.setTimeout(write, EXPANDED_WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [root, expanded]);
  useEffect(() => () => pendingWrite.current?.(), []);

  // Folders deleted or renamed since they were opened stop counting as open.
  useEffect(() => setExpanded((prev) => pruneExpanded(prev, listings)), [listings]);

  // Open folders on screen are read as they appear (T3 reads a folder when it is expanded).
  useEffect(() => {
    for (const dir of foldersToLoad(rows, listings, loading, dirs.failed)) void dirs.load(dir);
  });

  // "Expand all" keeps opening folders as their parents are read, until a folder is closed.
  const expandable = useMemo(() => expandableFolders(listings, dirs.checked), [listings, dirs.checked]);
  useEffect(() => {
    if (expandAll && !normalized) setExpanded((prev) => addAll(prev, expandable));
  }, [expandAll, normalized, expandable]);
  const allExpanded = expandable.length > 0 && expandable.every((p) => expanded.has(p));
  // T3 offers "expand all" for a project and not for a host folder; here, for a root git labels.
  const canExpandAll = dirs.checked.has("") && (listings.get("") ?? []).some((e) => e.kind === "directory");

  const zoom = useAreaZoom("panel");
  const geometry = useMemo(() => treeGeometry(zoom / 100), [zoom]);
  const rowHeight = geometry.rowHeight;
  const [focused, setFocused] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [view, setView] = useState({ top: 0, height: 0, gutter: 0 });
  const focusRequest = useRef<string | null>(null);

  // The scroller's position and size, a DOM element outside React.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () =>
      setView((prev) => {
        const next = { top: el.scrollTop, height: el.clientHeight, gutter: el.offsetWidth - el.clientWidth };
        return prev.top === next.top && prev.height === next.height && prev.gutter === next.gutter ? prev : next;
      });
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const stop = observeResize(el, measure);
    return () => {
      el.removeEventListener("scroll", measure);
      stop();
    };
  }, [noMatches]);

  // A new row height (the panel's zoom) keeps the row at the top of the view where it was, the
  // part of it above the edge included.
  const shownRowHeight = useRef(rowHeight);
  useLayoutEffect(() => {
    const before = shownRowHeight.current;
    shownRowHeight.current = rowHeight;
    const el = scrollRef.current;
    if (!el || before === rowHeight) return;
    el.scrollTop = (el.scrollTop / before) * rowHeight;
    setView((prev) => ({ ...prev, top: el.scrollTop }));
  }, [rowHeight]);

  const scrollToIndex = (index: number, align: "nearest" | "center") => {
    const el = scrollRef.current;
    if (!el || index < 0) return;
    const top = index * rowHeight;
    let next = el.scrollTop;
    if (align === "center") next = top - Math.max(0, (el.clientHeight - rowHeight) / 2);
    else if (top < el.scrollTop) next = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) next = top + rowHeight - el.clientHeight;
    next = Math.max(0, Math.min(next, rows.length * rowHeight - el.clientHeight));
    if (Math.abs(next - el.scrollTop) < 0.5) return;
    el.scrollTop = next;
    // Render the rows at the new position now, before the scroll event arrives.
    setView((prev) => ({ ...prev, top: el.scrollTop }));
  };

  // The marked row: the current file tab's path when it is under the root (the root itself has no row).
  const marked = (current ? treeRelativePath(root, current.path) : null) || null;
  const markedIndex = marked === null ? -1 : treeRowIndex(rows, marked);
  // A path opened from the tree is already in view; one opened elsewhere is revealed.
  const openedFromTree = useRef<string | null>(null);
  const [reveal, setReveal] = useState<string | null>(null);
  useEffect(() => {
    const fromTree = openedFromTree.current === marked;
    openedFromTree.current = null;
    if (marked === null || fromTree) return;
    setReveal(marked);
    // T3 closes the search to reveal an outside selection.
    setQuery("");
    setExpanded((prev) => addAll(prev, treeAncestors(marked)));
  }, [marked]);
  // The revealed path's folders are read together rather than one level at a time (T3
  // loadFileAncestors). A path its folder's listing lacks (made after the folder was read) reads the
  // folders again once; a path still missing (deleted, or found elsewhere by a lookup) is not revealed.
  useEffect(() => {
    if (reveal === null) return;
    let cancelled = false;
    const folders = ["", ...treeAncestors(reveal)];
    const listed = () => dirs.listingOf(parentTreePath(reveal))?.some((e) => e.path === reveal) ?? false;
    void (async () => {
      await Promise.all(folders.map((d) => dirs.load(d)));
      if (cancelled) return;
      if (!listed()) await Promise.all(folders.map((d) => dirs.load(d, true)));
      if (cancelled) return;
      if (!listed()) return setReveal(null);
      // A folder dropped as gone while its parent's older listing lacked it opens again.
      setExpanded((prev) => addAll(prev, treeAncestors(reveal)));
    })();
    return () => {
      cancelled = true;
    };
  }, [reveal, dirs.load, dirs.listingOf]);
  // Brings the revealed row to the middle once it is listed and the tab shows.
  useLayoutEffect(() => {
    if (reveal === null || hidden) return;
    const index = treeRowIndex(rows, reveal);
    if (index < 0) return;
    setReveal(null);
    setFocused(rows[index]!.path);
    scrollToIndex(index, "center");
  });

  // Keyboard focus follows the focused row once it is rendered.
  useLayoutEffect(() => {
    const want = focusRequest.current;
    if (want === null) return;
    const el = treeRef.current?.querySelector<HTMLElement>(`[data-item-path="${CSS.escape(want)}"]`);
    if (!el) return;
    focusRequest.current = null;
    el.focus({ preventScroll: true });
  });

  // A flattened row opens and closes every folder of its chain, so a chain that later breaks apart
  // (a refresh lists a second child) keeps the state the row showed.
  const toggle = (row: TreeRow, open: boolean) => {
    const folders = rowFolders(row);
    if (open) {
      setExpanded((prev) => addAll(prev, folders));
      return;
    }
    setExpandAll(false);
    setExpanded((prev) => {
      if (!folders.some((f) => prev.has(f))) return prev;
      const next = new Set(prev);
      for (const f of folders) next.delete(f);
      return next;
    });
  };

  const activate = (row: TreeRow) => {
    setFocused(row.path);
    if (normalized) {
      // A click closes the search; the row's folders stay open so it is still in view.
      setQuery("");
      setExpanded((prev) => addAll(prev, [...treeAncestors(row.path), ...(row.kind === "directory" ? [row.path] : [])]));
      if (row.kind === "directory") return;
    } else if (row.kind === "directory") {
      toggle(row, !row.expanded);
      return;
    }
    openedFromTree.current = row.path;
    onOpenFile({ path: treeAbsolutePath(root, row.path), kind: "file" });
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (normalized && event.key === "Escape") {
      // Pierre: Escape in the tree closes the search.
      event.preventDefault();
      setQuery("");
      return;
    }
    const action = treeKeyAction(rows, focused, event.key, normalized !== "");
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if ("focus" in action) {
      setFocused(action.focus);
      focusRequest.current = action.focus;
      scrollToIndex(treeRowIndex(rows, action.focus), "nearest");
      return;
    }
    const row = rows[treeRowIndex(rows, "expand" in action ? action.expand : action.collapse)];
    if (row) toggle(row, "expand" in action);
  };

  const focusSearch = () => {
    searchRef.current?.focus();
    searchRef.current?.select();
  };

  // The scroll position as the rows now allow: fewer rows (a search) can leave the last scroll
  // event's position past the end until the next one arrives.
  const top = Math.max(0, Math.min(view.top, rows.length * rowHeight - view.height));
  const start = Math.max(0, Math.floor(top / rowHeight) - OVERSCAN_ROWS);
  const end = Math.min(rows.length, Math.ceil((top + view.height) / rowHeight) + OVERSCAN_ROWS);
  const focusedIndex = focused === null ? -1 : treeRowIndex(rows, focused);
  // The tree is one Tab stop: the focused row, else the first row in view.
  const tabStop = focusedIndex >= 0 ? focusedIndex : Math.min(rows.length - 1, Math.floor(top / rowHeight));
  const focusedParent = focusedIndex >= 0 ? (rows[focusedIndex]!.ancestors.at(-1) ?? null) : null;
  // The rows in the DOM: those near the viewport, and the focused row wherever it is, so scrolling
  // it out of view keeps the keyboard focus.
  const rendered: number[] = [];
  for (let i = start; i < end; i++) rendered.push(i);
  if (focusedIndex >= 0 && (focusedIndex < start || focusedIndex >= end)) rendered.push(focusedIndex);
  const rootName = basenameOf(root);

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col", hidden && "hidden")}
      data-file-explorer={root}
      onKeyDown={(event) => {
        const mod = IS_MAC ? event.metaKey : event.ctrlKey;
        // code, not key: a Korean input source turns the F key into a jamo.
        if (!mod || event.altKey || event.shiftKey || event.code !== "KeyF") return;
        event.preventDefault();
        focusSearch();
      }}
    >
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 px-2",
          sheet ? "h-10 min-h-10 border-b border-border/60" : "mb-1 h-9 min-h-9",
        )}
      >
        <ToolbarButton label={dirs.pending ? "Refreshing" : "Refresh"} ariaLabel="Refresh files" onClick={dirs.refresh}>
          <RefreshIcon refreshing={dirs.pending} />
        </ToolbarButton>
        <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
          <InputGroupInput
            ref={searchRef}
            type="search"
            name="project-files-search"
            size="sm"
            value={query}
            aria-label={`Search ${rootName} files`}
            placeholder="Search files"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setQuery("");
              event.currentTarget.blur();
            }}
          />
        </InputGroup>
        {canExpandAll ? (
          <ToolbarButton
            label={expandAll || allExpanded ? "Collapse all folders" : "Expand all folders"}
            onClick={() => {
              const open = !(expandAll || allExpanded);
              setExpandAll(open);
              setExpanded(open ? addAll(expanded, expandable) : new Set());
            }}
          >
            {allExpanded ? <ChevronsDownUpIcon className="size-3.5" /> : <ChevronsUpDownIcon className="size-3.5" />}
          </ToolbarButton>
        ) : null}
      </div>
      {dirs.error ? (
        <button
          type="button"
          onClick={dirs.refresh}
          className="p-4 text-left text-xs leading-relaxed text-destructive-foreground wrap-anywhere"
        >
          {dirs.error} Click to try again
        </button>
      ) : null}
      {dirs.ignoreUnknown.length ? (
        // Git gave no answer for these folders (it timed out or failed), so their ignored rows are
        // not dimmed. Said once here rather than left out quietly; a refresh asks again.
        <p
          className="truncate px-3 pb-1 text-xs text-muted-foreground"
          title={dirs.ignoreUnknown.map((p) => p || rootName).join("\n")}
        >
          Could not check ignore status: {dirs.ignoreUnknown.map((p) => p || rootName).join(", ")}
        </p>
      ) : null}
      {!dirs.ready && !dirs.error ? (
        <div role="status" className={rows.length > 0 ? "sr-only" : "px-3 py-1 text-xs text-muted-foreground"}>
          Loading files
        </div>
      ) : null}
      {noMatches ? (
        dirs.ready && !dirs.pending && !dirs.error ? (
          <div role="status" className="px-3 py-4 text-xs text-muted-foreground">
            No matching files
          </div>
        ) : null
      ) : (
        <div
          ref={scrollRef}
          className="group/tree min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
          style={{
            paddingLeft: geometry.paddingInline - geometry.itemMarginX,
            paddingRight: Math.max(0, geometry.paddingInline - geometry.itemMarginX - view.gutter),
          }}
        >
          <div
            ref={treeRef}
            role="tree"
            aria-label={`${rootName} files`}
            className="relative w-full font-sans text-xs text-foreground [overflow-anchor:none]"
            style={{ height: rows.length * rowHeight }}
            onKeyDown={onTreeKeyDown}
          >
            {rendered.map((i) => {
              const row = rows[i]!;
              return (
                <TreeRowButton
                  // A flattened row keeps its first folder as key, so the button and its focus stay
                  // while the chain grows.
                  key={row.segments?.[0]?.path ?? row.path}
                  row={row}
                  geometry={geometry}
                  top={i * rowHeight}
                  selected={i === markedIndex}
                  tabbable={i === tabStop}
                  focusedParent={focusedParent}
                  onClick={() => activate(row)}
                  onFocus={() => setFocused(row.path)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolbarButton(props: { label: string; ariaLabel?: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button type="button" variant="ghost" size="icon-xs" aria-label={props.ariaLabel ?? props.label} onClick={props.onClick} />}
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** Pierre's chevron, pointing down; a closed folder turns it to point right. */
function Chevron({ open, geometry }: { open: boolean; geometry: TreeGeometry }) {
  const nudge = geometry.iconNudge;
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width={geometry.iconWidth}
      height={geometry.iconWidth}
      style={{
        color: TREE_MUTED_COLOR,
        transform: open ? `translate(0, ${nudge}px)` : `rotate(-90deg) translate(${-nudge / 2}px, ${nudge / 2}px)`,
      }}
    >
      <use href="#file-tree-icon-chevron" />
    </svg>
  );
}

function TreeRowButton(props: {
  row: TreeRow;
  geometry: TreeGeometry;
  top: number;
  selected: boolean;
  tabbable: boolean;
  focusedParent: string | null;
  onClick: () => void;
  onFocus: () => void;
}) {
  const { row, geometry: g } = props;
  const icon = row.kind === "file" ? resolveFileIcon(row.name) : null;
  const style: CSSProperties = {
    top: props.top,
    left: g.itemMarginX,
    right: g.itemMarginX,
    height: g.rowHeight,
    lineHeight: `${g.rowHeight}px`,
    paddingInline: g.itemPaddingX,
    gap: g.itemRowGap,
    ["--tree-focus-ring" as string]: FOCUS_RING,
  };
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.kind === "directory" ? row.expanded : undefined}
      aria-selected={props.selected}
      aria-label={row.name}
      tabIndex={props.tabbable ? 0 : -1}
      data-item-path={row.path}
      className={cn(
        "absolute flex cursor-pointer items-center rounded-md text-start outline-none select-none",
        props.selected
          ? "bg-[color-mix(in_srgb,currentColor_12%,transparent)]"
          : "hover:bg-[color-mix(in_srgb,currentColor_7%,transparent)]",
        "focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--tree-focus-ring)",
        row.match && "font-semibold",
      )}
      style={style}
      onClick={props.onClick}
      onFocus={props.onFocus}
    >
      {row.depth > 0 ? (
        <span aria-hidden className="flex h-full shrink-0 items-center" style={{ paddingLeft: g.iconWidth / 2 - 0.5 }}>
          {row.ancestors.map((ancestor, level) => (
            <span
              key={ancestor}
              className={cn(
                "inline-block h-full translate-x-[-0.25px] transition-opacity duration-150",
                ancestor === props.focusedParent ? "opacity-100" : "opacity-0 group-hover/tree:opacity-75",
              )}
              style={{
                borderLeft: `1px solid ${GUIDE_COLOR}`,
                marginRight: g.levelGap - 1,
                marginLeft: level > 0 ? g.itemRowGap + g.iconWidth / 2 - 0.5 : 0,
              }}
            />
          ))}
        </span>
      ) : null}
      <span
        aria-hidden
        className={cn("flex shrink-0 items-center justify-center", row.ignored && "opacity-50")}
        style={{ width: g.iconWidth }}
      >
        {icon ? (
          <svg viewBox="0 0 16 16" width={g.iconWidth} height={g.iconWidth} style={{ color: treeIconColor(icon), fill: "currentColor" }}>
            <use href={`#${icon.name}`} />
          </svg>
        ) : (
          <Chevron open={row.expanded} geometry={g} />
        )}
      </span>
      <span className="min-w-0 truncate" style={row.ignored ? { color: IGNORED_COLOR } : undefined}>
        {row.name}
      </span>
      {row.loading ? (
        <span className="flex min-w-0 flex-1 justify-end" title="Loading">
          <svg aria-hidden viewBox="0 0 16 16" width={g.iconWidth} height={g.iconWidth} className="opacity-60 motion-safe:animate-spin" style={{ color: TREE_MUTED_COLOR }}>
            <use href="#t3-tree-icon-loading" />
          </svg>
        </span>
      ) : null}
    </button>
  );
}
