// The prompt cache clock (DESIGN.md 6t): how long the Claude conversation's prompt cache stays
// warm after the last response that used it. The server derives `ThreadPromptCache` from the
// transcript's usage lines; the web draws the remaining time from it.

export const PROMPT_CACHE_TTL_5M_MS = 5 * 60_000;
export const PROMPT_CACHE_TTL_1H_MS = 60 * 60_000;

/** When the latest cache-using response happened (server clock) and how long its cache lives. */
export interface ThreadPromptCache {
  /** ISO time of the response's first transcript line. */
  at: string;
  /** 300000 (five-minute TTL) or 3600000 (one-hour TTL). */
  ttlMs: number;
  /** A compaction came after `at`: the cache does not cover the compacted conversation yet. */
  cold?: true;
}

/**
 * The TTL a response wrote its cache with, from `usage.cache_creation`: tokens under
 * `ephemeral_5m_input_tokens` mean the five-minute TTL (even beside one-hour tokens, the shorter
 * one decides), tokens only under `ephemeral_1h_input_tokens` the one-hour TTL. A response that
 * wrote nothing new (a pure cache read) keeps `previous`, the TTL the conversation was using.
 */
export function promptCacheTtlOf(created: { fiveMinute: number; oneHour: number }, previous: number | null): number | null {
  if (created.fiveMinute > 0) return PROMPT_CACHE_TTL_5M_MS;
  if (created.oneHour > 0) return PROMPT_CACHE_TTL_1H_MS;
  return previous;
}

export type PromptCacheView =
  | { state: "warm"; remainingMs: number; label: string; tooltip: string }
  | { state: "expired"; remainingMs: 0; label: string; tooltip: string };

function ttlWord(ttlMs: number): string {
  return ttlMs >= PROMPT_CACHE_TTL_1H_MS ? "1h" : `${Math.round(ttlMs / 60_000)}m`;
}

/** "4분" for 4 minutes left (rounded up, so a warm cache never reads "0분"); "under 1m" under a minute. */
export function formatCacheRemaining(remainingMs: number): string {
  if (remainingMs < 60_000) return "under 1m";
  return `${Math.ceil(remainingMs / 60_000)}m`;
}

/**
 * What the composer shows for the cache, or null when it shows nothing: no cache information
 * (Codex, a session without a cache-using response), or a turn in progress (each step of the turn
 * renews the cache). `nowMs` is on the server's clock; `atLabel` is the response time as text.
 */
export function promptCacheView(cache: ThreadPromptCache | null | undefined, nowMs: number, running: boolean, atLabel: string): PromptCacheView | null {
  if (cache === null || cache === undefined || running) return null;
  const at = Date.parse(cache.at);
  if (!Number.isFinite(at)) return null;
  const refill = "The next send rewrites the whole conversation into the cache, which is slower and uses more cost and rate limit";
  if (cache.cold === true) {
    return { state: "expired", remainingMs: 0, label: "No cache", tooltip: `Just after compact, the cache does not yet cover the new conversation. ${refill}` };
  }
  const remainingMs = at + cache.ttlMs - nowMs;
  if (remainingMs <= 0) {
    return { state: "expired", remainingMs: 0, label: "Cache expired", tooltip: `Last response ${atLabel}, cache lifetime (${ttlWord(cache.ttlMs)}) has passed. ${refill}` };
  }
  return {
    state: "warm",
    remainingMs,
    label: `Cache ${formatCacheRemaining(remainingMs)}`,
    tooltip: `Last response ${atLabel}, cache lifetime ${ttlWord(cache.ttlMs)}. Sending within the remaining time reads the cache, using less cost and rate limit`,
  };
}
