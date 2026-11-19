// The drawer's search over every session's conversation (DESIGN.md 6u): the pure parts of the
// list under the session names. The server pages the hits (`GET /api/search`, newest first); the
// list keeps what it has and asks for the next page on "Show more". React Native-free, so a node test
// runs it.
import type { SearchHit, SearchResponse, SessionSummary } from "@maru/shared";
import { hasSearchText } from "../../../../packages/shared/src/threadSearch.ts";

/** Hits per page (a page size: "Show more" brings the rest). */
export const SEARCH_PAGE = 50;
/** How long typing pauses before the search goes out, ms. */
export const SEARCH_DELAY_MS = 300;

/** What the list shows for one query. */
export interface SearchListState {
  query: string;
  hits: SearchHit[];
  sessions: Map<string, SessionSummary>;
  total: number;
}

/**
 * The state after a page of answers. A page at offset 0, or for another query, replaces the list;
 * a later page of the same query goes on after the hits held (the sessions of every page are kept).
 */
export function afterPage(prev: SearchListState | null, res: SearchResponse, offset: number): SearchListState {
  const keep = prev !== null && prev.query === res.query && offset > 0;
  const sessions = new Map(keep ? prev.sessions : []);
  for (const s of res.sessions) sessions.set(s.key, s);
  return { query: res.query, hits: keep ? [...prev.hits, ...res.hits] : res.hits, sessions, total: res.total };
}

/** The query as it goes to the server (surrounding space cut), or null when it has nothing to look for. */
export function searchQueryOf(input: string): string | null {
  return hasSearchText(input) ? input.trim() : null;
}

/** A stable list key for a hit: two hits of one item and one session differ by their place in the list. */
export function hitKey(hit: SearchHit, index: number): string {
  return `${hit.key}:${hit.itemId ?? hit.at ?? ""}:${index}`;
}

/** "User" or "Answer": who wrote the text a hit points at. */
export function hitRoleLabel(role: SearchHit["role"]): string {
  return role === "user" ? "User" : "Answer";
}

/** How many hits the next "Show more" brings at most, or 0 when the list holds them all. */
export function remainingHits(state: SearchListState): number {
  return Math.max(0, state.total - state.hits.length);
}
