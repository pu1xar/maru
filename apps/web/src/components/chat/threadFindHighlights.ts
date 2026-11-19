// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/threadFindHighlights.ts (collectThreadFindRanges, the fold
// reveal and the painter).
// Local changes: matching is @maru/shared findOccurrences (the server's rule, DESIGN.md 6u); the
// block tags are listed here; one function paints the drawn rows and returns the active range, and
// the caller repaints on its own triggers (a MutationObserver in useFindHighlights).
import { findOccurrences } from "@maru/shared";
import { useEffect, useRef } from "react";

const HIGHLIGHT_NAME = "maru-thread-find";
const ACTIVE_HIGHLIGHT_NAME = "maru-thread-find-active";
const TEXT_SELECTOR = "[data-thread-find-text]";
const IGNORE_SELECTOR = "[data-thread-find-ignore]";
/** Elements that end a run of text: an occurrence never spans two of them. */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "details", "div", "dl", "dt", "figcaption", "figure",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
  "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

export interface FindRange {
  readonly rowId: string;
  readonly occurrence: number;
  readonly range: Range;
}

/** The query's occurrences in the searchable text under `container`, per timeline row, in reading order. */
export function collectFindRanges(container: HTMLElement, query: string): FindRange[] {
  const ranges: FindRange[] = [];
  if (query.trim() === "") return ranges;
  const occurrenceByRow = new Map<string, number>();
  const scopes = container.matches(TEXT_SELECTOR) ? [container] : [...container.querySelectorAll<HTMLElement>(TEXT_SELECTOR)];
  for (const scope of scopes) {
    if (scope !== container && scope.parentElement?.closest(TEXT_SELECTOR)) continue;
    const rowId = scope.closest("[data-timeline-row-id]")?.getAttribute("data-timeline-row-id");
    if (!rowId) continue;
    let text = "";
    let nodes: { node: Node; start: number; end: number }[] = [];
    const flush = () => {
      let startIndex = 0;
      let endIndex = 0;
      for (const offset of findOccurrences(text, query)) {
        const end = offset + query.length;
        while (startIndex < nodes.length && nodes[startIndex]!.end <= offset) startIndex++;
        if (endIndex < startIndex) endIndex = startIndex;
        while (endIndex < nodes.length && nodes[endIndex]!.end < end) endIndex++;
        const a = nodes[startIndex];
        const b = nodes[endIndex];
        if (!a || !b) continue;
        const range = container.ownerDocument.createRange();
        range.setStart(a.node, offset - a.start);
        range.setEnd(b.node, Math.min(end - b.start, (b.node.nodeValue ?? "").length));
        const occurrence = occurrenceByRow.get(rowId) ?? 0;
        ranges.push({ rowId, occurrence, range });
        occurrenceByRow.set(rowId, occurrence + 1);
      }
      text = "";
      nodes = [];
    };
    const visit = (node: Node, inPre: boolean) => {
      const element = node.nodeType === 1 ? (node as Element) : null;
      if (element?.matches("svg")) return;
      if (element?.matches(`${IGNORE_SELECTOR}, [role="toolbar"], button`)) {
        flush();
        return;
      }
      const tag = element?.tagName.toLowerCase() ?? "";
      const block = BLOCK_TAGS.has(tag);
      if (block) flush();
      if (node.nodeType === 3) {
        const value = node.nodeValue ?? "";
        const start = text.length;
        // Line breaks inside a paragraph read as spaces; a <pre> keeps them (same length either way).
        text += inPre ? value : value.replace(/[\r\n]/g, " ");
        nodes.push({ node, start, end: text.length });
      }
      for (const child of node.childNodes) visit(child, inPre || tag === "pre");
      if (block) flush();
    };
    visit(scope, false);
    flush();
  }
  return ranges;
}

const FOLD_SELECTOR = "[hidden], [data-thread-find-fold]";

/** The folds (a closed <details>, a clipped box) that hide a range, innermost first. */
function foldsHiding(range: Range, container: HTMLElement): Element[] {
  const folds: Element[] = [];
  for (
    let fold = range.startContainer.parentElement?.closest(FOLD_SELECTOR);
    fold && container.contains(fold);
    fold = fold.parentElement?.closest(FOLD_SELECTOR)
  ) {
    if (fold.hasAttribute("hidden") || range.getBoundingClientRect().bottom > fold.getBoundingClientRect().bottom) folds.push(fold);
  }
  return folds;
}

/** Asks the folds hiding a range to open (`beforematch`, as the browser's own find does). True when one was asked. */
export function revealFolded(range: Range, container: HTMLElement): boolean {
  const folds = foldsHiding(range, container);
  for (const fold of folds) fold.dispatchEvent(new Event("beforematch"));
  return folds.length > 0;
}

/** Whether the page can paint highlights (the CSS Custom Highlight API). */
function canHighlight(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

export function clearFindHighlights(): void {
  if (!canHighlight()) return;
  CSS.highlights.delete(HIGHLIGHT_NAME);
  CSS.highlights.delete(ACTIVE_HIGHLIGHT_NAME);
}

/**
 * Paints every occurrence in the drawn rows and the active one apart. Returns the active range
 * (the `occurrence`th in row `activeRowId`, else that row's last), or null when the row is not
 * drawn or holds no occurrence.
 */
export function paintFindHighlights(
  container: HTMLElement,
  query: string,
  active: { rowId: string; occurrence: number } | null,
): Range | null {
  const ranges = collectFindRanges(container, query);
  let selected: Range | null = null;
  if (active) {
    const inRow = ranges.filter((r) => r.rowId === active.rowId);
    selected = (inRow[active.occurrence] ?? inRow.at(-1))?.range ?? null;
  }
  if (!canHighlight()) return selected;
  const all = new Highlight();
  for (const r of ranges) if (r.range !== selected) all.add(r.range);
  CSS.highlights.set(HIGHLIGHT_NAME, all);
  const current = new Highlight();
  if (selected) current.add(selected);
  CSS.highlights.set(ACTIVE_HIGHLIGHT_NAME, current);
  return selected;
}

/**
 * Keeps the highlights of `query` on the rows drawn under `container` while it is set: painted now
 * and again a frame after the searchable text changes (rows mount as the list scrolls).
 */
export function useFindHighlights(
  container: HTMLElement | null,
  query: string,
  active: { rowId: string; occurrence: number } | null,
): void {
  const activeRef = useRef(active);
  activeRef.current = active;
  const repaintRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!container || query.trim() === "") {
      clearFindHighlights();
      repaintRef.current = null;
      return;
    }
    const repaint = () => paintFindHighlights(container, query, activeRef.current);
    repaintRef.current = repaint;
    let frame: number | null = null;
    const observer = new MutationObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        repaint();
      });
    });
    observer.observe(container, { subtree: true, childList: true, characterData: true });
    repaint();
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      repaintRef.current = null;
      clearFindHighlights();
    };
  }, [container, query]);
  useEffect(() => {
    repaintRef.current?.();
  }, [active?.rowId, active?.occurrence]);
}
