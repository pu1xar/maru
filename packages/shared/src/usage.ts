// Usage gauges per account (DESIGN.md 6a).
// The server polls every account and keeps one cache; the UI reads it from `GET /api/usage`
// and gets every change over /ws as a `usage` message.

import type { AccountId, ProviderId } from "./index.ts";

/**
 * One rate-limit window.
 * id           Claude "five_hour" or "seven_day"; Codex "primary" or "secondary" (the provider's names)
 * minutes      window length: 300 is 5h, 10080 is 7d, 43200 is a month; null when the source leaves it out
 * usedPercent  already a percentage (0 to 100), as the provider reports it
 * resetsAt     ms since epoch; null when the source leaves it out
 */
export interface UsageWindow {
  id: string;
  minutes: number | null;
  usedPercent: number | null;
  resetsAt: number | null;
}

/**
 * ok            `windows` hold the latest read (or, after a failed read, the last good one)
 * free          the account has no subscription that exposes usage (Claude 403)
 * expired       the access token expired (Claude) or the usage endpoint refused it (Codex 401, 403)
 * auth_missing  no OAuth credentials for this Claude config dir
 * off           usage is switched off in the server's config (`claudeUsage`, `codexUsage`); no login is read
 * rate_limited  the Claude usage endpoint answered 429 before any good read
 * error         another failure before any good read; `error` says what
 * no_data       nothing to show yet (not read yet, or a Codex home with no usage source)
 */
export type UsageStatus = "ok" | "free" | "expired" | "auth_missing" | "off" | "rate_limited" | "error" | "no_data";

/**
 * Where `windows` came from.
 * anthropic_oauth  Claude OAuth usage endpoint
 * codex_daemon     the home's app-server daemon (`account/rateLimits/read` and its updates)
 * codex_usage_api  the ChatGPT usage endpoint, for a home whose daemon is absent or failed
 * codex_rollout    the last rate-limit snapshot in a session rollout, when no live source answered
 */
export type UsageSource = "anthropic_oauth" | "codex_daemon" | "codex_usage_api" | "codex_rollout";

export interface AccountUsage {
  provider: ProviderId;
  account: AccountId;
  /** Login email (Claude `.claude.json`, Codex `auth.json` id token). */
  email: string | null;
  /** Plan as the provider names it (Claude organizationType like "claude_max", Codex "plus", "free"). */
  plan: string | null;
  /**
   * Sticky FREE mark (inventory #4). Set by a Claude 403, a Claude profile plan "free", or a live
   * Codex plan "free"; cleared by a good Claude read or a live Codex plan other than "free".
   * The dashboard hid these accounts unless the user turned "FREE 표시" on.
   */
  free: boolean;
  /** A session of this account is running (Claude busy) or held open by a process (Codex). */
  active: boolean;
  status: UsageStatus;
  /** Set with status "error". */
  error: string | null;
  /** Claude: five_hour (only on plans with a 5h limit), then seven_day. Codex: primary, then secondary. */
  windows: UsageWindow[];
  source: UsageSource | null;
  /** Codex rollout snapshot written more than 6h ago; its reset times have passed. */
  stale: boolean;
  /** When the numbers were read (a rollout snapshot: the rollout's mtime), ms since epoch. */
  capturedAt: number | null;
}

/** `GET /api/usage`, and the body of the /ws `usage` message. Claude accounts first, in config order. */
export interface UsageSnapshot {
  accounts: AccountUsage[];
  generatedAt: number;
}

/** Server -> UI over /ws: the full snapshot right after connect, then again after every change. */
export interface UsageMessage {
  type: "usage";
  snapshot: UsageSnapshot;
}
