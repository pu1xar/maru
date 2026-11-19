// The split view's layout (DESIGN.md 6k): conversations side by side like tmux panes. A layout is a
// binary tree, or empty. A split node puts two children side by side ("row") or one above the
// other ("column") and gives the first child `ratio` of the room; a leaf is one pane that shows one
// session, or nothing yet. Everything here is pure, so the component layer (components/split/) only
// stores the value and draws what these functions compute.
//
// A pane shows a session, a shell terminal (DESIGN.md 6s, by the shell's id), or nothing yet.
//
// One session shows in at most one pane, and so does one shell. Opening a session that a pane already shows focuses that
// pane, and dropping it somewhere else moves that pane. So a pane's view mode (chat or terminal) is
// the session's own mode (lib/viewMode.ts) and the layout does not store one.

import { isShellId } from "@maru/shared";

export type SplitDir = "row" | "column";
export type Edge = "left" | "right" | "top" | "bottom";
export type Direction = "left" | "right" | "up" | "down";
/** Where a drop on a pane goes: one of its edges (a new pane there) or the pane itself. */
export type DropZone = Edge | "center";

export interface PaneLeaf {
  kind: "pane";
  id: string;
  /** SessionSummary.key (`provider:account:id`), or null for an empty pane or a shell pane. */
  sessionKey: string | null;
  /** The id of the shell terminal (`sh-...`) the pane shows, or null. A pane never has both this and `sessionKey`. */
  shellId: string | null;
}

/** What a pane can show. */
export type PaneContent = { type: "session"; key: string } | { type: "shell"; id: string };

export type PaneKind = "session" | "shell" | "empty";

export function paneKind(p: Pick<PaneLeaf, "sessionKey" | "shellId">): PaneKind {
  return p.sessionKey !== null ? "session" : p.shellId !== null ? "shell" : "empty";
}

export function contentOf(p: Pick<PaneLeaf, "sessionKey" | "shellId">): PaneContent | null {
  return p.sessionKey !== null ? { type: "session", key: p.sessionKey } : p.shellId !== null ? { type: "shell", id: p.shellId } : null;
}

const sessionContent = (key: string | null): PaneContent | null => (key === null ? null : { type: "session", key });

function sameContent(a: PaneContent | null, b: PaneContent | null): boolean {
  if (a === null || b === null) return a === b;
  return a.type === "session" ? b.type === "session" && a.key === b.key : b.type === "shell" && a.id === b.id;
}

function withContent(leaf: PaneLeaf, content: PaneContent | null): PaneLeaf {
  return { ...leaf, sessionKey: content?.type === "session" ? content.key : null, shellId: content?.type === "shell" ? content.id : null };
}

export interface PaneSplit {
  kind: "split";
  id: string;
  dir: SplitDir;
  /** Share of the room (after the gap) that `a` gets, RATIO_MIN..RATIO_MAX. */
  ratio: number;
  /** Left (row) or top (column) child. */
  a: PaneNode;
  b: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface PaneLayout {
  /** null: no pane yet. */
  root: PaneNode | null;
  /** The focused pane: where a session picked in the sidebar opens and where keys act. null only without panes. */
  focused: string | null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type NewId = () => string;

/** Ratios stay inside this band so neither child of a split can vanish. */
export const RATIO_MIN = 0.02;
export const RATIO_MAX = 1 - RATIO_MIN;

export const EMPTY_LAYOUT: PaneLayout = { root: null, focused: null };

export function newPaneId(): string {
  return `p${Math.random().toString(36).slice(2, 10)}`;
}

function leafOf(content: PaneContent | null, newId: NewId): PaneLeaf {
  return withContent({ kind: "pane", id: newId(), sessionKey: null, shellId: null }, content);
}

/** Panes in reading order (left before right, top before bottom). */
export function panesOf(node: PaneNode | null): PaneLeaf[] {
  if (node === null) return [];
  if (node.kind === "pane") return [node];
  return [...panesOf(node.a), ...panesOf(node.b)];
}

export function findPane(layout: PaneLayout, id: string): PaneLeaf | null {
  return panesOf(layout.root).find((p) => p.id === id) ?? null;
}

export function paneOfSession(layout: PaneLayout, sessionKey: string): PaneLeaf | null {
  return panesOf(layout.root).find((p) => p.sessionKey === sessionKey) ?? null;
}

export function paneOfShell(layout: PaneLayout, shellId: string): PaneLeaf | null {
  return panesOf(layout.root).find((p) => p.shellId === shellId) ?? null;
}

/** The pane that shows `content`. */
export function paneOfContent(layout: PaneLayout, content: PaneContent): PaneLeaf | null {
  return content.type === "session" ? paneOfSession(layout, content.key) : paneOfShell(layout, content.id);
}

export function focusedPane(layout: PaneLayout): PaneLeaf | null {
  return (layout.focused === null ? null : findPane(layout, layout.focused)) ?? panesOf(layout.root)[0] ?? null;
}

function mapNode(node: PaneNode, id: string, fn: (n: PaneNode) => PaneNode): PaneNode {
  if (node.id === id) return fn(node);
  if (node.kind === "pane") return node;
  const a = mapNode(node.a, id, fn);
  const b = mapNode(node.b, id, fn);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** The tree without node `id`: its parent split gives way to the sibling. null when `id` is the root. */
function removeNode(node: PaneNode, id: string): PaneNode | null {
  if (node.id === id) return null;
  if (node.kind === "pane") return node;
  if (node.a.id === id) return node.b;
  if (node.b.id === id) return node.a;
  const a = removeNode(node.a, id);
  const b = removeNode(node.b, id);
  return a === node.a && b === node.b ? node : { ...node, a: a!, b: b! };
}

function siblingOf(node: PaneNode, id: string): PaneNode | null {
  if (node.kind === "pane") return null;
  if (node.a.id === id) return node.b;
  if (node.b.id === id) return node.a;
  return siblingOf(node.a, id) ?? siblingOf(node.b, id);
}

/** The split direction an edge divides along: left and right put panes side by side. */
function dirOfEdge(edge: Edge): SplitDir {
  return edge === "left" || edge === "right" ? "row" : "column";
}

/** A node's cells in `dir`: a split of that direction gives way to its children, anything else is one cell. */
function cellsOf(node: PaneNode, dir: SplitDir): PaneNode[] {
  return node.kind === "split" && node.dir === dir ? [...cellsOf(node.a, dir), ...cellsOf(node.b, dir)] : [node];
}

/**
 * The line pane `targetId` sits in for splits along `dir`: the chain of same-direction splits above
 * it. `top` is the chain's highest node (the target itself when its parent runs the other way) and
 * `cells` are the nodes laid side by side (or one above the other) in it.
 */
function lineOf(root: PaneNode, targetId: string, dir: SplitDir): { top: PaneNode; cells: PaneNode[] } | null {
  const path: PaneNode[] = [];
  const walk = (node: PaneNode): boolean => {
    path.push(node);
    if (node.id === targetId) return true;
    if (node.kind === "split" && (walk(node.a) || walk(node.b))) return true;
    path.pop();
    return false;
  };
  if (!walk(root)) return null;
  let i = path.length - 1;
  while (i > 0) {
    const parent = path[i - 1]!;
    if (parent.kind !== "split" || parent.dir !== dir) break;
    i--;
  }
  const top = path[i]!;
  return { top, cells: cellsOf(top, dir) };
}

/** `cells` as a chain leaning to the second side, so every cell gets an equal share: split(1/n, c0, split(1/(n-1), c1, ...)). */
function evenChain(cells: PaneNode[], dir: SplitDir, newId: NewId): PaneNode {
  if (cells.length === 1) return cells[0]!;
  const ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, 1 / cells.length));
  const id = newId();
  return { kind: "split", id, dir, ratio, a: cells[0]!, b: evenChain(cells.slice(1), dir, newId) };
}

/**
 * Puts `leaf` at `edge` of node `targetId` and shares the whole line it joins equally (VS Code's
 * `splitSizing: "distribute"`): a pane that is alone in its direction halves, three panes side by
 * side become four of one share each.
 */
function insertAt(root: PaneNode, targetId: string, edge: Edge, leaf: PaneLeaf, newId: NewId): PaneNode {
  const dir = dirOfEdge(edge);
  const line = lineOf(root, targetId, dir);
  if (!line) return root;
  const at = line.cells.findIndex((c) => c.id === targetId);
  const cells = [...line.cells];
  cells.splice(edge === "left" || edge === "top" ? at : at + 1, 0, leaf);
  const chain = evenChain(cells, dir, newId);
  return mapNode(root, line.top.id, () => chain);
}

export function focusPane(layout: PaneLayout, id: string): PaneLayout {
  if (layout.focused === id || !findPane(layout, id)) return layout;
  return { ...layout, focused: id };
}

/**
 * Splits pane `paneId` at `edge`: a new pane takes that side, the line it joins is shared equally, and it gets focus.
 * The new pane shows `sessionKey`. A session another pane already shows moves there with its pane
 * (as if that pane were dragged), and splitting a pane with its own session changes nothing.
 */
export function splitPane(
  layout: PaneLayout,
  paneId: string,
  edge: Edge,
  sessionKey: string | null = null,
  newId: NewId = newPaneId,
): PaneLayout {
  return splitPaneWith(layout, paneId, edge, sessionContent(sessionKey), newId);
}

/** `splitPane` for any content: a session or a shell another pane shows moves there with its pane. */
export function splitPaneWith(layout: PaneLayout, paneId: string, edge: Edge, content: PaneContent | null, newId: NewId = newPaneId): PaneLayout {
  const target = findPane(layout, paneId);
  if (!target || layout.root === null) return layout;
  const shown = content === null ? null : paneOfContent(layout, content);
  if (shown) return shown.id === paneId ? layout : movePane(layout, shown.id, paneId, edge, newId);
  const leaf = leafOf(content, newId);
  return { root: insertAt(layout.root, paneId, edge, leaf, newId), focused: leaf.id };
}

/**
 * Closes pane `paneId`; the sibling takes its room. A closed focused pane hands focus to the pane
 * of the sibling side nearest to where it was. Closing the last pane leaves the view empty.
 */
export function closePane(layout: PaneLayout, paneId: string): PaneLayout {
  if (!findPane(layout, paneId) || layout.root === null) return layout;
  if (layout.root.kind === "pane") return EMPTY_LAYOUT;
  const sibling = siblingOf(layout.root, paneId)!;
  const root = removeNode(layout.root, paneId)!;
  if (layout.focused !== paneId) return { root, focused: layout.focused };
  return { root, focused: nearestPaneIn(layout.root, sibling, paneId) };
}

/** What closing a pane by hand leaves for "reopen closed pane" (a tab keeps a stack of these in memory). */
export interface ClosedPane {
  content: PaneContent;
  /** The pane next to it when it closed (the nearest pane of its sibling), or null when it was the only pane. */
  siblingId: string | null;
  /** Which side of that pane it sat on. */
  edge: Edge | null;
}

/**
 * The record of closing pane `paneId`, or null for a pane that shows nothing (there is nothing to
 * bring back). Take it before `closePane`.
 */
export function closedPaneOf(layout: PaneLayout, paneId: string): ClosedPane | null {
  const pane = findPane(layout, paneId);
  const content = pane ? contentOf(pane) : null;
  if (!pane || !content || layout.root === null) return null;
  if (layout.root.kind === "pane") return { content, siblingId: null, edge: null };
  const sibling = siblingOf(layout.root, paneId)!;
  const parent = findParent(layout.root, paneId)!;
  const wasFirst = parent.a.id === paneId;
  const edge: Edge = parent.dir === "row" ? (wasFirst ? "left" : "right") : wasFirst ? "top" : "bottom";
  return { content, siblingId: nearestPaneIn(layout.root, sibling, paneId), edge };
}

function findParent(node: PaneNode, id: string): PaneSplit | null {
  if (node.kind === "pane") return null;
  if (node.a.id === id || node.b.id === id) return node;
  return findParent(node.a, id) ?? findParent(node.b, id);
}

export type ReopenOutcome = "reopened" | "focused" | "noRoom" | "nothing";

/**
 * Brings back the most recent closed pane of `stack` (the last item). A record whose content is
 * gone (`exists` false) is dropped and the next is tried. Content that another pane shows now only
 * focuses that pane. Otherwise the pane returns beside the pane it left (the focused pane when that
 * one is gone), on the side it was, and the line is shared equally (`insertAt`); `fits` says
 * whether that line has room, and a record that does not fit stays on the stack.
 */
export function reopenClosedPane(
  layout: PaneLayout,
  stack: readonly ClosedPane[],
  exists: (content: PaneContent) => boolean,
  fits: (layout: PaneLayout, targetId: string, edge: Edge) => boolean,
  newId: NewId = newPaneId,
): { layout: PaneLayout; stack: ClosedPane[]; outcome: ReopenOutcome } {
  const rest = [...stack];
  while (rest.length > 0) {
    const rec = rest[rest.length - 1]!;
    if (!exists(rec.content)) {
      rest.pop();
      continue;
    }
    const shown = paneOfContent(layout, rec.content);
    if (shown) {
      rest.pop();
      return { layout: focusPane(layout, shown.id), stack: rest, outcome: "focused" };
    }
    if (layout.root === null) {
      rest.pop();
      const leaf = leafOf(rec.content, newId);
      return { layout: { root: leaf, focused: leaf.id }, stack: rest, outcome: "reopened" };
    }
    const target = (rec.siblingId ? findPane(layout, rec.siblingId) : null) ?? focusedPane(layout)!;
    const edge = rec.edge ?? "right";
    if (!fits(layout, target.id, edge)) return { layout, stack: rest, outcome: "noRoom" };
    rest.pop();
    return { layout: splitPaneWith(layout, target.id, edge, rec.content, newId), stack: rest, outcome: "reopened" };
  }
  return { layout, stack: rest, outcome: "nothing" };
}

/** The pane of `within` nearest to pane `fromId`'s middle (in `root`'s unit geometry). */
function nearestPaneIn(root: PaneNode, within: PaneNode, fromId: string): string {
  const rects = unitRects(root);
  const from = rects.get(fromId)!;
  const center = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  let best: { id: string; d: number } | null = null;
  for (const p of panesOf(within)) {
    const d = distanceToRect(center, rects.get(p.id)!);
    if (!best || d < best.d - EPS) best = { id: p.id, d };
  }
  return best!.id;
}

/**
 * Moves pane `paneId` to `edge` of pane `targetId`: it leaves its place (its sibling takes the room,
 * as on close) and joins the target's line, which is shared equally. The pane keeps its id, so its view stays mounted.
 */
export function movePane(layout: PaneLayout, paneId: string, targetId: string, edge: Edge, newId: NewId = newPaneId): PaneLayout {
  const moving = findPane(layout, paneId);
  if (!moving || paneId === targetId || !findPane(layout, targetId) || layout.root === null) return layout;
  const without = removeNode(layout.root, paneId)!;
  return { root: insertAt(without, targetId, edge, moving, newId), focused: paneId };
}

/** Swaps the places of panes `a` and `b`; `a` gets focus. Ratios stay with the places. */
export function swapPanes(layout: PaneLayout, a: string, b: string): PaneLayout {
  const pa = findPane(layout, a);
  const pb = findPane(layout, b);
  if (!pa || !pb || a === b || layout.root === null) return layout.focused === a || !pa ? layout : { ...layout, focused: a };
  const swap = (node: PaneNode): PaneNode => {
    if (node.kind === "pane") return node.id === a ? pb : node.id === b ? pa : node;
    const na = swap(node.a);
    const nb = swap(node.b);
    return na === node.a && nb === node.b ? node : { ...node, a: na, b: nb };
  };
  return { root: swap(layout.root), focused: a };
}

/**
 * Gives every cell of the line split `splitId` belongs to an equal share (a double click on a
 * divider). Each split of the line keeps its place and id and gets the ratio of the cells on its
 * first side to the cells under it, so a line of two is 0.5 and a line of four is 1/4, 1/3, 1/2.
 */
export function equalizeLine(layout: PaneLayout, splitId: string): PaneLayout {
  if (layout.root === null) return layout;
  const node = findNode(layout.root, splitId);
  if (!node || node.kind !== "split") return layout;
  const line = lineOf(layout.root, splitId, node.dir);
  if (!line) return layout;
  const dir = node.dir;
  const fix = (n: PaneNode): PaneNode => {
    if (n.kind !== "split" || n.dir !== dir) return n;
    const a = fix(n.a);
    const b = fix(n.b);
    const na = cellsOf(n.a, dir).length;
    const nb = cellsOf(n.b, dir).length;
    const ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, na / (na + nb)));
    return ratio === n.ratio && a === n.a && b === n.b ? n : { ...n, ratio, a, b };
  };
  const root = mapNode(layout.root, line.top.id, fix);
  return root === layout.root ? layout : { ...layout, root };
}

function findNode(node: PaneNode, id: string): PaneNode | null {
  if (node.id === id) return node;
  return node.kind === "split" ? (findNode(node.a, id) ?? findNode(node.b, id)) : null;
}

/** Sets a split's ratio, kept inside RATIO_MIN..RATIO_MAX. */
export function setRatio(layout: PaneLayout, splitId: string, ratio: number): PaneLayout {
  if (!Number.isFinite(ratio) || layout.root === null) return layout;
  const r = Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio));
  const root = mapNode(layout.root, splitId, (n) => (n.kind === "split" && n.ratio !== r ? { ...n, ratio: r } : n));
  return root === layout.root ? layout : { ...layout, root };
}

/**
 * Shows `sessionKey` in pane `paneId` and focuses it. A session another pane already shows swaps
 * places with this pane instead, so neither session leaves the view.
 */
export function assignSession(layout: PaneLayout, paneId: string, sessionKey: string | null): PaneLayout {
  return assignContent(layout, paneId, sessionContent(sessionKey));
}

/** `assignSession` for any content. A shell it replaces keeps running; only the pane lets go of it. */
export function assignContent(layout: PaneLayout, paneId: string, content: PaneContent | null): PaneLayout {
  const target = findPane(layout, paneId);
  if (!target || layout.root === null) return layout;
  if (sameContent(contentOf(target), content)) return focusPane(layout, paneId);
  const shown = content === null ? null : paneOfContent(layout, content);
  if (shown) return swapPanes(layout, shown.id, paneId);
  return { root: mapNode(layout.root, paneId, (n) => withContent(n as PaneLeaf, content)), focused: paneId };
}

/**
 * Opens a session the way a click in the sidebar does: focus the pane that shows it, or show it in
 * the focused pane. In an empty view it becomes the first pane.
 */
export function openSession(layout: PaneLayout, sessionKey: string, newId: NewId = newPaneId): PaneLayout {
  const shown = paneOfSession(layout, sessionKey);
  if (shown) return focusPane(layout, shown.id);
  const focused = focusedPane(layout);
  if (!focused) {
    const leaf = leafOf({ type: "session", key: sessionKey }, newId);
    return { root: leaf, focused: leaf.id };
  }
  // A shell pane is not replaced by a session opened from elsewhere (dashboard, settings, /fork): the session gets a pane beside it.
  if (paneKind(focused) === "shell") return splitPaneWith(layout, focused.id, "right", { type: "session", key: sessionKey }, newId);
  return assignSession(layout, focused.id, sessionKey);
}

/**
 * Opens a shell in a pane of its own (the terminal screen's "분할 보기에 열기"): the pane that
 * already shows it takes focus; an empty view gets it as the first pane; an empty focused pane
 * takes it; otherwise the focused pane splits to the right and the new pane shows it. A pane that
 * shows a session or another shell is not replaced.
 */
export function openShellPane(layout: PaneLayout, shellId: string, newId: NewId = newPaneId): PaneLayout {
  const shown = paneOfShell(layout, shellId);
  if (shown) return focusPane(layout, shown.id);
  const content: PaneContent = { type: "shell", id: shellId };
  const focused = focusedPane(layout);
  if (!focused) {
    const leaf = leafOf(content, newId);
    return { root: leaf, focused: leaf.id };
  }
  if (paneKind(focused) === "empty") return assignContent(layout, focused.id, content);
  return splitPaneWith(layout, focused.id, "right", content, newId);
}

/**
 * A session dragged from the sidebar and dropped on pane `paneId` (null: the empty view). An edge
 * splits the pane there; the middle shows the session in that pane. A session another pane already
 * shows drags that pane along (dropPane).
 */
export function dropSession(
  layout: PaneLayout,
  sessionKey: string,
  paneId: string | null,
  zone: DropZone,
  newId: NewId = newPaneId,
): PaneLayout {
  return dropContent(layout, { type: "session", key: sessionKey }, paneId, zone, newId);
}

/**
 * A shell dropped on pane `paneId` (null: the empty view), as `dropSession` does for a session: an
 * edge splits the pane there, the middle shows the shell in that pane (the pane's session or shell
 * stays alive, only the pane lets go of it), and a shell another pane shows drags that pane along.
 */
export function dropShell(layout: PaneLayout, shellId: string, paneId: string | null, zone: DropZone, newId: NewId = newPaneId): PaneLayout {
  return dropContent(layout, { type: "shell", id: shellId }, paneId, zone, newId);
}

function dropContent(layout: PaneLayout, content: PaneContent, paneId: string | null, zone: DropZone, newId: NewId): PaneLayout {
  if (paneId === null || layout.root === null) {
    if (layout.root !== null) return layout;
    const leaf = leafOf(content, newId);
    return { root: leaf, focused: leaf.id };
  }
  const shown = paneOfContent(layout, content);
  if (shown) return dropPane(layout, shown.id, paneId, zone, newId);
  if (zone === "center") return assignContent(layout, paneId, content);
  return splitPaneWith(layout, paneId, zone, content, newId);
}

/** A pane dragged by its header and dropped on pane `targetId`: an edge moves it there, the middle swaps the two. */
export function dropPane(layout: PaneLayout, paneId: string, targetId: string, zone: DropZone, newId: NewId = newPaneId): PaneLayout {
  if (paneId === targetId) return focusPane(layout, paneId);
  return zone === "center" ? swapPanes(layout, paneId, targetId) : movePane(layout, paneId, targetId, zone, newId);
}

/**
 * Follows sessions that changed keys and drops panes whose session is gone. `resolve` returns the
 * key a pane's session has now (the same key when nothing changed), null when it is gone, or
 * undefined when that is not known yet (the pane stays as it is). A pane whose new key another pane
 * already shows closes.
 */
export function reconcileSessions(layout: PaneLayout, resolve: (key: string) => string | null | undefined): PaneLayout {
  let next = layout;
  for (const pane of panesOf(layout.root)) {
    if (pane.sessionKey === null) continue;
    const now = resolve(pane.sessionKey);
    if (now === undefined || now === pane.sessionKey) continue;
    const other = now === null ? null : paneOfSession(next, now);
    if (now === null || (other && other.id !== pane.id)) {
      next = closePane(next, pane.id);
    } else if (next.root) {
      next = { ...next, root: mapNode(next.root, pane.id, (n) => ({ ...(n as PaneLeaf), sessionKey: now })) };
    }
  }
  return next;
}

/** Closes the panes whose shell is not in `alive` (a shell that ended is no longer listed). */
export function reconcileShells(layout: PaneLayout, alive: ReadonlySet<string>): PaneLayout {
  let next = layout;
  for (const pane of panesOf(layout.root)) {
    if (pane.shellId !== null && !alive.has(pane.shellId)) next = closePane(next, pane.id);
  }
  return next;
}

/** Closes the pane that shows shell `shellId` (the shell itself keeps running unless it ended). */
export function closeShellPane(layout: PaneLayout, shellId: string): PaneLayout {
  const pane = paneOfShell(layout, shellId);
  return pane ? closePane(layout, pane.id) : layout;
}

// ---- Geometry in unit space (the whole view is 1 x 1), for keyboard focus moves ----

const EPS = 1e-9;

export function unitRects(root: PaneNode | null): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const walk = (node: PaneNode, r: Rect) => {
    if (node.kind === "pane") {
      out.set(node.id, r);
      return;
    }
    if (node.dir === "row") {
      const w = r.w * node.ratio;
      walk(node.a, { x: r.x, y: r.y, w, h: r.h });
      walk(node.b, { x: r.x + w, y: r.y, w: r.w - w, h: r.h });
    } else {
      const h = r.h * node.ratio;
      walk(node.a, { x: r.x, y: r.y, w: r.w, h });
      walk(node.b, { x: r.x, y: r.y + h, w: r.w, h: r.h - h });
    }
  };
  if (root) walk(root, { x: 0, y: 0, w: 1, h: 1 });
  return out;
}

function distanceToRect(p: { x: number; y: number }, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

/**
 * The pane next to the focused one in `dir`, or null at the view's edge (no wrap-around, as in
 * iTerm). Among the panes that touch that side, the one beside the focused pane's middle wins, so
 * moving back returns to where focus came from in a symmetric layout.
 */
export function neighborPane(layout: PaneLayout, dir: Direction): string | null {
  const focused = focusedPane(layout);
  if (!focused) return null;
  const rects = unitRects(layout.root);
  const from = rects.get(focused.id)!;
  const horizontal = dir === "left" || dir === "right";
  const mid = horizontal ? from.y + from.h / 2 : from.x + from.w / 2;
  let best: { id: string; gap: number; holdsMid: boolean; shared: number; pos: number } | null = null;
  for (const [id, r] of rects) {
    if (id === focused.id) continue;
    const gap =
      dir === "right" ? r.x - (from.x + from.w)
      : dir === "left" ? from.x - (r.x + r.w)
      : dir === "down" ? r.y - (from.y + from.h)
      : from.y - (r.y + r.h);
    if (gap < -EPS) continue;
    const shared = horizontal
      ? overlap(r.y, r.y + r.h, from.y, from.y + from.h)
      : overlap(r.x, r.x + r.w, from.x, from.x + from.w);
    if (shared <= EPS) continue;
    const holdsMid = horizontal
      ? r.y - EPS <= mid && mid <= r.y + r.h + EPS
      : r.x - EPS <= mid && mid <= r.x + r.w + EPS;
    const cand = { id, gap, holdsMid, shared, pos: horizontal ? r.y : r.x };
    const better =
      !best ||
      cand.gap < best.gap - EPS ||
      (Math.abs(cand.gap - best.gap) <= EPS &&
        (cand.holdsMid !== best.holdsMid
          ? cand.holdsMid
          : Math.abs(cand.shared - best.shared) > EPS
            ? cand.shared > best.shared
            : cand.pos < best.pos));
    if (better) best = cand;
  }
  return best?.id ?? null;
}

export function moveFocus(layout: PaneLayout, dir: Direction): PaneLayout {
  const id = neighborPane(layout, dir);
  return id ? focusPane(layout, id) : layout;
}

/** Focus the next (+1) or previous (-1) pane in reading order, wrapping around (iTerm's ⌘] and ⌘[). */
export function cycleFocus(layout: PaneLayout, delta: 1 | -1): PaneLayout {
  const list = panesOf(layout.root);
  if (list.length === 0) return layout;
  const i = list.findIndex((p) => p.id === layout.focused);
  const next = list[(Math.max(0, i) + delta + list.length) % list.length]!;
  return focusPane(layout, next.id);
}

// ---- Geometry in pixels ----

export interface FrameOptions {
  /** Smallest pane, so a conversation is not squeezed. */
  minWidth: number;
  minHeight: number;
  /** Space between two panes (the divider line). */
  gap: number;
}

export interface DividerFrame {
  splitId: string;
  dir: SplitDir;
  /** The gap between the split's children. */
  rect: Rect;
  /** Where the split's room starts on its axis (x for row, y for column) and its size after the gap. */
  start: number;
  room: number;
  /** Bounds for the first child's size on that axis while dragging. min > max means no room to drag. */
  min: number;
  max: number;
}

export interface Frames {
  panes: Map<string, Rect>;
  dividers: DividerFrame[];
}

/** The smallest size a subtree can take without a pane going under the minimum. */
export function minSizeOf(node: PaneNode, opts: FrameOptions): { w: number; h: number } {
  if (node.kind === "pane") return { w: opts.minWidth, h: opts.minHeight };
  const a = minSizeOf(node.a, opts);
  const b = minSizeOf(node.b, opts);
  return node.dir === "row"
    ? { w: a.w + opts.gap + b.w, h: Math.max(a.h, b.h) }
    : { w: Math.max(a.w, b.w), h: a.h + opts.gap + b.h };
}

/**
 * Pixel rectangles of every pane and divider in a `width` x `height` view. A stored ratio is kept
 * where both sides stay at or above their minimum; otherwise the first side moves just enough. When
 * the view is smaller than the layout's minimum the ratios apply as they are, and panes go under the
 * minimum until the view grows again.
 */
export function computeFrames(root: PaneNode | null, width: number, height: number, opts: FrameOptions): Frames {
  const panes = new Map<string, Rect>();
  const dividers: DividerFrame[] = [];
  const walk = (node: PaneNode, r: Rect) => {
    if (node.kind === "pane") {
      panes.set(node.id, r);
      return;
    }
    const row = node.dir === "row";
    const room = Math.max(0, (row ? r.w : r.h) - opts.gap);
    const aMinSize = minSizeOf(node.a, opts);
    const bMinSize = minSizeOf(node.b, opts);
    const aMin = row ? aMinSize.w : aMinSize.h;
    const bMin = row ? bMinSize.w : bMinSize.h;
    let size = Math.round(room * node.ratio);
    if (room >= aMin + bMin) size = Math.min(room - bMin, Math.max(aMin, size));
    const divider = { splitId: node.id, dir: node.dir, start: row ? r.x : r.y, room, min: aMin, max: room - bMin };
    if (row) {
      walk(node.a, { x: r.x, y: r.y, w: size, h: r.h });
      walk(node.b, { x: r.x + size + opts.gap, y: r.y, w: room - size, h: r.h });
      dividers.push({ ...divider, rect: { x: r.x + size, y: r.y, w: opts.gap, h: r.h } });
    } else {
      walk(node.a, { x: r.x, y: r.y, w: r.w, h: size });
      walk(node.b, { x: r.x, y: r.y + size + opts.gap, w: r.w, h: room - size });
      dividers.push({ ...divider, rect: { x: r.x, y: r.y + size, w: r.w, h: opts.gap } });
    }
  };
  if (root) walk(root, { x: 0, y: 0, w: width, h: height });
  return { panes, dividers };
}

/** The ratio a divider drag to `pos` (on the split's axis, in the frames' space) asks for. */
export function ratioForDrag(d: DividerFrame, pos: number): number {
  if (d.room <= 0) return 0.5;
  const size = d.min <= d.max ? Math.min(d.max, Math.max(d.min, pos - d.start)) : pos - d.start;
  return size / d.room;
}

/** Where a new pane at `edge` of a pane goes, and whether the line it joins has room for it. */
export interface InsertPlan {
  /** Pixel rectangle of the whole line that is shared out (its top node's frame). */
  line: Rect;
  /** Cells in the line before the insert. */
  count: number;
  /** Position the new cell takes, 0..count. */
  index: number;
  /** Equal size of each cell along the split axis once the new one is in, gaps excluded. */
  share: number;
  /** The smallest size any cell, the new one included, may take along that axis. */
  needed: number;
  /** share >= needed. */
  fits: boolean;
}

function unionRect(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Plans putting a new pane at `edge` of pane `paneId`: the line the pane sits in (same-direction
 * splits above it) is shared equally, so the check is on the line's size, not on the one pane's.
 * `moving` is a pane that leaves its place first (a pane drag), so its place does not count and the
 * line is measured after the others close up. null when the pane or its frame is unknown.
 */
export function planInsert(
  layout: PaneLayout,
  frames: Frames,
  paneId: string,
  edge: Edge,
  opts: FrameOptions,
  moving?: string,
): InsertPlan | null {
  let root = layout.root;
  let panes = frames.panes;
  if (root === null || paneId === moving) return null;
  if (moving !== undefined && findPane(layout, moving)) {
    root = removeNode(root, moving);
    if (root === null) return null;
    const whole = unionRect([...frames.panes.values()]);
    if (!whole) return null;
    panes = computeFrames(root, whole.w, whole.h, opts).panes;
  }
  const dir = dirOfEdge(edge);
  const line = lineOf(root, paneId, dir);
  if (!line) return null;
  const rect = unionRect(panesOf(line.top).map((p) => panes.get(p.id)).filter((r): r is Rect => r !== undefined));
  if (!rect) return null;
  const row = dir === "row";
  const count = line.cells.length;
  const at = line.cells.findIndex((c) => c.id === paneId);
  const index = edge === "left" || edge === "top" ? at : at + 1;
  const share = ((row ? rect.w : rect.h) - count * opts.gap) / (count + 1);
  const newMin = row ? opts.minWidth : opts.minHeight;
  const needed = Math.max(newMin, ...line.cells.map((c) => (row ? minSizeOf(c, opts).w : minSizeOf(c, opts).h)));
  return { line: rect, count, index, share, needed, fits: share >= needed };
}

/** Whether a new pane fits at `edge` of pane `paneId` once its line is shared equally (see `planInsert`). */
export function canInsertAt(layout: PaneLayout, frames: Frames, paneId: string, edge: Edge, opts: FrameOptions, moving?: string): boolean {
  return planInsert(layout, frames, paneId, edge, opts, moving)?.fits ?? false;
}

/** The room the new pane takes in its line (an equal share), for the drop preview. null when it does not fit. */
export function insertPreview(layout: PaneLayout, frames: Frames, paneId: string, edge: Edge, opts: FrameOptions, moving?: string): Rect | null {
  const plan = planInsert(layout, frames, paneId, edge, opts, moving);
  if (!plan?.fits) return null;
  const { line, index, share } = plan;
  return dirOfEdge(edge) === "row"
    ? { x: line.x + index * (share + opts.gap), y: line.y, w: share, h: line.h }
    : { x: line.x, y: line.y + index * (share + opts.gap), w: line.w, h: share };
}

/** `pointerZoneAt`, with an edge that `allow` refuses (no room for another pane) giving null. */
export function dropZoneAt(r: Rect, x: number, y: number, allow: (edge: Edge) => boolean): DropZone | null {
  const zone = pointerZoneAt(r, x, y);
  return zone === null || zone === "center" || allow(zone) ? zone : null;
}

/**
 * Which zone of pane rect `r` the point is in: the outer quarter toward the nearest edge is that
 * edge, the middle is the pane itself. null outside the pane. An edge is returned whether or not
 * a pane would fit there (`canInsertAt` decides that).
 */
export function pointerZoneAt(r: Rect, x: number, y: number): DropZone | null {
  if (x < r.x || y < r.y || x > r.x + r.w || y > r.y + r.h) return null;
  const fx = (x - r.x) / r.w;
  const fy = (y - r.y) / r.h;
  const edges: Array<[Edge, number]> = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ];
  edges.sort((p, q) => p[1] - q[1]);
  const [edge, d] = edges[0]!;
  return d >= 0.25 ? "center" : edge;
}

// ---- Storage ----

export const LAYOUT_VERSION = 1;

export function serializeLayout(layout: PaneLayout): string {
  return JSON.stringify({ v: LAYOUT_VERSION, root: layout.root, focused: layout.focused });
}

/** A stored pane that had content and lost it on reading (a repeat of a session or shell, or a bad shell id): it is left out. */
const DROPPED = Symbol("dropped");

function parseNode(raw: unknown, ids: Set<string>, sessions: Set<string>, shells: Set<string>): PaneNode | typeof DROPPED | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  if (typeof n.id !== "string" || n.id === "" || ids.has(n.id)) return null;
  ids.add(n.id);
  if (n.kind === "pane") {
    if (n.sessionKey !== null && typeof n.sessionKey !== "string") return null;
    let sessionKey = n.sessionKey as string | null;
    // A session shows once; a stored duplicate keeps the first pane and empties the later one.
    if (sessionKey !== null) {
      if (sessions.has(sessionKey)) sessionKey = null;
      else sessions.add(sessionKey);
    }
    // A value from before shell panes has no `shellId` and reads as none. A stored shell id that is
    // not a shell's, that sits in a pane with a session, or that an earlier pane shows is dropped.
    let shellId: string | null = null;
    if (sessionKey === null && isShellId(n.shellId) && !shells.has(n.shellId)) {
      shellId = n.shellId;
      shells.add(shellId);
    }
    // A pane that had something and has nothing now closes (the sibling takes its room) instead of staying empty.
    const hadContent = typeof n.sessionKey === "string" || (n.shellId !== undefined && n.shellId !== null);
    if (hadContent && sessionKey === null && shellId === null) return DROPPED;
    return { kind: "pane", id: n.id, sessionKey, shellId };
  }
  if (n.kind !== "split") return null;
  if (n.dir !== "row" && n.dir !== "column") return null;
  if (typeof n.ratio !== "number" || !(n.ratio > 0 && n.ratio < 1)) return null;
  const a = parseNode(n.a, ids, sessions, shells);
  const b = a && parseNode(n.b, ids, sessions, shells);
  if (!a || !b) return null;
  if (a === DROPPED) return b;
  if (b === DROPPED) return a;
  return { kind: "split", id: n.id, dir: n.dir, ratio: Math.min(RATIO_MAX, Math.max(RATIO_MIN, n.ratio)), a, b };
}

/** A stored layout, or null when the value is missing, from another version, or broken. */
export function parseLayout(text: string | null): PaneLayout | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (v.v !== LAYOUT_VERSION) return null;
  return parseLayoutBody(v);
}

/** The `root` and `focused` of a stored layout (the part a tab of lib/paneTabs.ts shares with the single layout's record). */
export function parseLayoutBody(v: Record<string, unknown>): PaneLayout | null {
  if (v.root === null) return EMPTY_LAYOUT;
  const root = parseNode(v.root, new Set(), new Set(), new Set());
  if (root === DROPPED) return EMPTY_LAYOUT;
  if (!root) return null;
  const list = panesOf(root);
  const focused = typeof v.focused === "string" && list.some((p) => p.id === v.focused) ? v.focused : list[0]!.id;
  return { root, focused };
}

/** A compact text form of the tree for logs and measurements: `row(0.50,[a:key],column(0.30,[b],[c]))`. */
export function describeLayout(node: PaneNode | null, label: (p: PaneLeaf) => string = (p) => p.sessionKey ?? p.shellId ?? "-"): string {
  if (node === null) return "empty";
  if (node.kind === "pane") return `[${label(node)}]`;
  return `${node.dir}(${node.ratio.toFixed(2)},${describeLayout(node.a, label)},${describeLayout(node.b, label)})`;
}
