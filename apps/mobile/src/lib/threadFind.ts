// Find in the open conversation (DESIGN.md 6u), the parts that need no React Native. The server
// finds the matches over the whole thread (thread.search); the steps between its answer and the
// timeline (which item to show, when older rows must be asked for) are the web's own
// (apps/web/src/components/chat/threadFind.logic.ts) and the rules for the count, the starting
// place and the painted pieces of a text are here.
import { findOccurrences, formatFindCount, hasSearchText } from "../../../../packages/shared/src/threadSearch.ts";

export { entryIdForItem, findStep, itemOrder, type FindStep } from "../../../web/src/components/chat/threadFind.logic.ts";

/** What the find bar says beside the buttons. */
export type FindStatus = "idle" | "searching" | "error";

/** The count text: "3/12", "Searching", "Not found", or nothing before a query. */
export function findLabel(query: string, status: FindStatus, index: number, total: number): string {
  if (!hasSearchText(query)) return "";
  if (status === "searching") return "Searching";
  if (status === "error") return "Not found";
  return formatFindCount(index, total);
}

/** A bar with nothing found says so under the count (the web's bar shows it in the input's color). */
export function findHasNoResult(query: string, status: FindStatus, total: number): boolean {
  return hasSearchText(query) && status === "idle" && total === 0;
}

/** The buttons step only over a finished search with matches. */
export function findStepDisabled(status: FindStatus, total: number): boolean {
  return total === 0 || status !== "idle";
}

/**
 * The reader's place for a find that starts without a hint: the lowest message row on screen as
 * its place in the thread, or null when the list sits at its end (the find then starts at the
 * newest occurrence). `visibleEntryIds` are the rows on screen, `byEntry` each row's place.
 */
export function findAnchor(
  visibleEntryIds: readonly string[],
  atEnd: boolean,
  byEntry: ReadonlyMap<string, number>,
): number | null {
  if (atEnd) return null;
  let anchor: number | null = null;
  for (const id of visibleEntryIds) {
    const at = byEntry.get(id);
    if (at !== undefined && (anchor === null || at > anchor)) anchor = at;
  }
  return anchor;
}

/** One piece of a text: painted when `hit`, the strongest paint when it is the `active` occurrence. */
export interface Segment {
  text: string;
  hit: boolean;
  active: boolean;
}

/**
 * `text` cut at the query's occurrences. The text's occurrences are numbered from `first` (the
 * rendered text of a message comes in several pieces, each carrying on the count); the one equal to
 * `active` is the active piece. A text without a hit comes back as one plain piece.
 */
export function highlightSegments(text: string, query: string, first: number, active: number | null): Segment[] {
  const at = findOccurrences(text, query);
  if (at.length === 0) return [{ text, hit: false, active: false }];
  const out: Segment[] = [];
  const length = query.length;
  let from = 0;
  at.forEach((start, k) => {
    if (start > from) out.push({ text: text.slice(from, start), hit: false, active: false });
    out.push({ text: text.slice(start, start + length), hit: true, active: first + k === active });
    from = start + length;
  });
  if (from < text.length) out.push({ text: text.slice(from), hit: false, active: false });
  return out;
}

/** How many times the query occurs in `text`. */
export function occurrencesIn(text: string, query: string): number {
  return findOccurrences(text, query).length;
}

/** The occurrence to make active when a message draws fewer matches than the server counted (markdown syntax splits some). */
export function clampActive(active: number | null, drawn: number): number | null {
  if (active === null || drawn <= 0) return null;
  return Math.min(Math.max(active, 0), drawn - 1);
}

/** What the list shows now, for a find that starts at the reader's place (findAnchor). */
export interface FindVisible {
  /** The timeline rows on screen. */
  ids: string[];
  /** The newest row is on screen. */
  atEnd: boolean;
}

/** The occurrence the timeline shows: the `occurrence`th one in entry `entryId`. `seq` changes with every step. */
export interface TimelineFindTarget {
  readonly entryId: string;
  readonly occurrence: number;
  readonly seq: number;
}

/** What the timeline gets while find is open: the query to paint and the step to show. */
export interface TimelineFind {
  readonly query: string;
  readonly target: TimelineFindTarget | null;
}
