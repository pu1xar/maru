// Searching conversations (DESIGN.md 6u). A find in one thread asks the server, which searches the
// thread's whole projection (also the rows the client has not received yet) and answers with the
// matching items in order. The client then walks them one occurrence at a time, growing its window
// to an item it does not hold yet (`thread.loadOlder` `until`). A search over every session
// (`/api/search`) answers with hits that open a session and its find at the hit.
//
// Matching is the same everywhere: the query as typed, case folded with toLowerCase (Korean and
// other caseless scripts match as they are), occurrences counted without overlap, as a browser's
// find counts them. A query of only whitespace matches nothing.
import type { OrchestrationV2ProjectedTurnItem } from "./turnItems.ts";

/** Who wrote a searchable text: the user, the model, or a Claude local command's output (`/context`). */
export type SearchRole = "user" | "assistant" | "notice";

/** One searchable text of a thread, in thread order. */
export interface SearchDoc {
  /** The projected item's id. */
  id: string;
  role: SearchRole;
  text: string;
  /** The item's time (started, else updated), ISO. */
  at: string | null;
}

/** True when the query has something to look for. */
export function hasSearchText(query: string): boolean {
  return query.trim() !== "";
}

/**
 * Start offsets of the query's occurrences in `text`, case folded, without overlap. The offsets
 * are in `text` itself even where folding changes a character's length (a dotted capital I).
 */
export function findOccurrences(text: string, query: string): number[] {
  if (!hasSearchText(query) || text.length === 0) return [];
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const out: number[] = [];
  if (lower.length === text.length) {
    for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) out.push(at);
    return out;
  }
  // Folding changed lengths: fold per code unit and keep where each folded unit came from.
  let folded = "";
  const from: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = text[i]!.toLowerCase();
    folded += f;
    for (let k = 0; k < f.length; k++) from.push(i);
  }
  for (let at = folded.indexOf(q); at >= 0; at = folded.indexOf(q, at + q.length)) out.push(from[at]!);
  return out;
}

/** How many times the query occurs in `text` (findOccurrences without the offsets). */
export function countOccurrences(text: string, query: string): number {
  if (!hasSearchText(query) || text.length === 0) return 0;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  let n = 0;
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) n++;
  return n;
}

/**
 * The searchable text of a projected row, or null for a row a find does not look into: user and
 * assistant messages, and a Claude local command's output, which the timeline draws as an answer.
 */
export function searchDocOf(row: OrchestrationV2ProjectedTurnItem): SearchDoc | null {
  const item = row.item;
  const at = item.startedAt ?? item.updatedAt ?? null;
  if (item.type === "user_message") return { id: item.id, role: "user", text: item.text, at };
  if (item.type === "assistant_message") return { id: item.id, role: "assistant", text: item.text, at };
  if (item.type === "system_notice" && row.x?.noticeKind === "command_output") return { id: item.id, role: "notice", text: item.message, at };
  return null;
}

export function searchDocsOf(rows: readonly OrchestrationV2ProjectedTurnItem[]): SearchDoc[] {
  const out: SearchDoc[] = [];
  for (const row of rows) {
    const doc = searchDocOf(row);
    if (doc && doc.text.length > 0) out.push(doc);
  }
  return out;
}

// ---- find in one thread ----

/** One item of a thread that holds the query, `count` times. */
export interface ThreadSearchMatch {
  /** The item id without the result's `idPrefix`. */
  id: string;
  count: number;
  role: SearchRole;
  at: string | null;
}

/** The answer to `thread.search`: every matching item of the thread, oldest first. */
export interface ThreadSearchResult {
  threadId: string;
  reqId: string;
  query: string;
  /** Every match id starts with this (a thread's item ids share the thread id); the ids are sent without it. */
  idPrefix: string;
  matches: ThreadSearchMatch[];
  /** Occurrences over all matches. */
  total: number;
  /** Items the search looked into (the denominator of `matches`). */
  searched: number;
  /** Set when the search failed; `matches` is then empty. */
  error?: string;
}

/** The matches of `docs`, oldest first, and the occurrences over all of them. */
export function searchDocs(docs: readonly SearchDoc[], query: string): { matches: Array<ThreadSearchMatch & { id: string }>; total: number } {
  const matches: ThreadSearchMatch[] = [];
  let total = 0;
  if (!hasSearchText(query)) return { matches, total };
  for (const d of docs) {
    const count = countOccurrences(d.text, query);
    if (count === 0) continue;
    matches.push({ id: d.id, count, role: d.role, at: d.at });
    total += count;
  }
  return { matches, total };
}

/** The longest prefix every id starts with. */
export function idPrefixOf(ids: readonly string[]): string {
  if (ids.length === 0) return "";
  let prefix = ids[0]!;
  for (const id of ids) {
    let n = 0;
    while (n < prefix.length && n < id.length && prefix.charCodeAt(n) === id.charCodeAt(n)) n++;
    prefix = prefix.slice(0, n);
    if (prefix === "") break;
  }
  return prefix;
}

/** A search result as it goes on the wire: the match ids without their common prefix. */
export function threadSearchResult(
  threadId: string, reqId: string, query: string, docs: readonly SearchDoc[],
): ThreadSearchResult {
  const { matches, total } = searchDocs(docs, query);
  // A thread's item ids start with its id, so the prefix is at most that and every id keeps its own part.
  const idPrefix = idPrefixOf([threadId, ...matches.map((m) => m.id)]);
  return {
    threadId, reqId, query, idPrefix, total, searched: docs.length,
    matches: matches.map((m) => ({ ...m, id: m.id.slice(idPrefix.length) })),
  };
}

/** One occurrence the find can step to: the `occurrence`th time the query occurs in item `itemId`. */
export interface FindTarget {
  itemId: string;
  occurrence: number;
  role: SearchRole;
  at: string | null;
}

/** Every occurrence of a result, in thread order. */
export function findTargets(result: Pick<ThreadSearchResult, "idPrefix" | "matches">): FindTarget[] {
  const out: FindTarget[] = [];
  for (const m of result.matches) {
    const itemId = result.idPrefix + m.id;
    for (let k = 0; k < m.count; k++) out.push({ itemId, occurrence: k, role: m.role, at: m.at });
  }
  return out;
}

/** The next index after stepping `delta` from `index` among `total`, wrapping at both ends. */
export function stepFindIndex(index: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  const i = Number.isFinite(index) ? Math.min(Math.max(Math.trunc(index), 0), total - 1) : 0;
  return (((i + delta) % total) + total) % total;
}

/** "3/12", or "0/0" without matches. */
export function formatFindCount(index: number, total: number): string {
  if (total <= 0) return "0/0";
  return `${Math.min(Math.max(Math.trunc(index), 0), total - 1) + 1}/${total}`;
}

/**
 * Where a new find starts: the newest occurrence at or above the reader's place. `orderOf` gives a
 * held item's place in the thread (undefined for an item the client does not hold, which is older
 * than every held one), `anchor` the place of the lowest row on screen (null: the reader is at the
 * end). Without such an occurrence, the oldest one.
 */
export function initialFindIndex(
  targets: readonly FindTarget[],
  orderOf: (itemId: string) => number | undefined,
  anchor: number | null,
): number {
  if (targets.length === 0) return 0;
  if (anchor === null) return targets.length - 1;
  for (let i = targets.length - 1; i >= 0; i--) {
    const at = orderOf(targets[i]!.itemId);
    if (at === undefined || at <= anchor) return i;
  }
  return 0;
}

/** Where a find opened from a hit of the search over every session (SearchHit) starts. */
export interface FindHint {
  /** The hit's item id, when the index knows it. */
  itemId: string | null;
  role: SearchRole;
  at: string | null;
}

/**
 * The occurrence a hint points at: the first one of the same item, else the same role's nearest in
 * time, else the newest. -1 without targets.
 */
export function hintedFindIndex(targets: readonly FindTarget[], hint: FindHint): number {
  if (targets.length === 0) return -1;
  if (hint.itemId) {
    const i = targets.findIndex((t) => t.itemId === hint.itemId);
    if (i >= 0) return i;
  }
  const want = hint.at ? Date.parse(hint.at) : Number.NaN;
  if (Number.isFinite(want)) {
    let best = -1;
    let bestGap = Infinity;
    targets.forEach((t, i) => {
      if (t.role !== hint.role || t.occurrence !== 0 || !t.at) return;
      const gap = Math.abs(Date.parse(t.at) - want);
      if (gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    });
    if (best >= 0) return best;
  }
  return targets.length - 1;
}

// ---- search over every session ----

/** Text around an occurrence for a result list: `before` + `match` + `after`, one line. */
export interface SearchSnippet {
  before: string;
  match: string;
  after: string;
}

/**
 * The words around an occurrence, on one line (line breaks become spaces), `radius` characters to
 * each side, cut at a space when one is near. A list shows a line; the whole text is in the thread.
 */
export function snippetAt(text: string, offset: number, length: number, radius = 60): SearchSnippet {
  const flat = (s: string) => s.replace(/\s+/g, " ");
  let start = Math.max(0, offset - radius);
  let end = Math.min(text.length, offset + length + radius);
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space >= 0 && space < offset) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > offset + length) end = space;
  }
  return {
    before: (start > 0 ? "..." : "") + flat(text.slice(start, offset)).trimStart(),
    match: flat(text.slice(offset, offset + length)),
    after: flat(text.slice(offset + length, end)).trimEnd() + (end < text.length ? "..." : ""),
  };
}

/** One occurrence in a session (GET /api/search). */
export interface SearchHit {
  /** The session key. */
  key: string;
  /** The item id the find opens at; null when the index cannot name it (an older Codex record). */
  itemId: string | null;
  role: SearchRole;
  at: string | null;
  /** Occurrences in this text; the snippet shows the first. */
  count: number;
  snippet: SearchSnippet;
}

/**
 * GET /api/search?q=&offset=&limit=: hits over every session, newest first, `limit` from `offset`.
 * The sessions are `SessionSummary`s for the hits' keys (the list may not hold them).
 */
export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  sessions: import("./index.ts").SessionSummary[];
  /** Hits over every session (every page). */
  total: number;
  offset: number;
  /** The denominator: sessions and texts the index looked into, and transcripts it left out. */
  searchedSessions: number;
  searchedTexts: number;
  /** Transcript files the index read but whose session the server does not list (counted, not searched). */
  unlistedFiles: number;
  /** ms the index took to catch up with the files before searching, and to search. */
  refreshMs: number;
  searchMs: number;
}
