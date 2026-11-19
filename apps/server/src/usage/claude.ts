// Claude usage per config dir: the OAuth usage endpoint behind one cache (DESIGN.md 6a).
//
// The endpoint answers each account only a few times in a short span and then answers 429 with
// retry-after 300 (measured). Every reader in this server (the UI, /api/data for the menu bar
// app, the machine API) goes through this cache, so the endpoint sees one
// read per account per TTL (60 s, env USAGE_CLAUDE_RATE_CACHE_TTL in seconds, the dashboard's
// variable).
//
// Outcomes of a read, as in the dashboard:
//   200        the windows; kept as the account's last good read
//   403        free: the account has no subscription that exposes usage (the last good read is dropped)
//   429        the last good read when there is one, otherwise rate_limited. The cache also holds
//              off reading until retry-after has passed (the dashboard re-read after the TTL).
//   other HTTP the last good read when there is one, otherwise error "HTTP <code>"
//   network    the last good read when there is one, otherwise an error kept for 10 s
//   no token   auth_missing, read again on the next request (the poller waits one TTL)
//   expired    expired, when every stored access token is past its expiresAt; loginRequired when a
//              login marker exists for the account (usage/loginMarker.ts)
//   off        the usage setting `claudeUsage` is false: no token is read and no request is sent

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loginMarked } from "./loginMarker.ts";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Fallback when `claude --version` cannot be read (the dashboard's value). */
const FALLBACK_CLI_VERSION = "2.1.183";
/** The earlier dashboard: `security` and `claude --version` subprocesses. */
const SUBPROCESS_TIMEOUT_MS = 5_000;
/** The earlier dashboard: urlopen timeout of the usage request. */
const FETCH_TIMEOUT_MS = 10_000;
/** The earlier dashboard: a network error without a last good read is read again after this long. */
const ERROR_RETRY_MS = 10_000;
/** The earlier dashboard: str(e)[:80] */
const ERROR_TEXT_MAX = 80;

export interface ClaudeWindow {
  /** `utilization`, already a percentage. */
  util: number | null;
  /** `resets_at` as the endpoint sent it (ISO 8601). */
  resetsAt: string | null;
}

export type ClaudeOk = {
  kind: "ok";
  fiveHour: ClaudeWindow | null;
  sevenDay: ClaudeWindow | null;
  /** When the read finished, ISO 8601 UTC. */
  capturedAt: string;
};

export type ClaudeRate =
  | ClaudeOk
  | { kind: "free" }
  | { kind: "expired"; loginRequired?: true }
  | { kind: "auth_missing" }
  | { kind: "off" }
  | { kind: "rate_limited" }
  | { kind: "error"; error: string };

export interface ClaudeEntry {
  rate: ClaudeRate;
  /** When the read started, ms. */
  at: number;
  /** Requests take the cached rate until then. */
  freshUntil: number;
  /** The poller reads again from then. */
  dueAt: number;
}

/** Keychain service holding a config dir's OAuth credentials (verified mapping, user rule "Usage 읽기"). */
export function keychainService(configDir: string): string {
  const hash = crypto.createHash("sha256").update(path.resolve(configDir)).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/** Claude Code 2.1.325 accepts this shape for the keychain account and falls back otherwise. */
const KEYCHAIN_ACCOUNT_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * The keychain account Claude Code reads and writes its credentials under: `$USER`, else the
 * login name (2.1.325 bundle). One service can hold items under several accounts; on 2026-11-16
 * `~/.claude` had a second item under "unknown" with emptied tokens, left by a measurement run
 * started with a bare env, and a lookup by service alone returned that one.
 */
export function keychainAccount(env: NodeJS.ProcessEnv = process.env): string {
  let name: string;
  try {
    name = env.USER || os.userInfo().username;
  } catch {
    name = "claude-code-user";
  }
  return KEYCHAIN_ACCOUNT_RE.test(name) ? name : "claude-code-user";
}

/** `security find-generic-password -a <account> -s <service> -w`; null when there is no such entry. */
export function readKeychain(service: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-a", keychainAccount(), "-s", service, "-w"],
      { timeout: SUBPROCESS_TIMEOUT_MS },
      (err, stdout) => resolve(err ? null : String(stdout).trim()),
    );
  });
}

let cliVersion: Promise<string> | null = null;

/** Installed Claude Code version for the User-Agent, read once. */
export function claudeCliVersion(): Promise<string> {
  cliVersion ??= new Promise((resolve) => {
    execFile("claude", ["--version"], { timeout: SUBPROCESS_TIMEOUT_MS }, (err, stdout) => {
      const m = err ? null : /(\d+\.\d+\.\d+)/.exec(String(stdout));
      resolve(m?.[1] ?? FALLBACK_CLI_VERSION);
    });
  });
  return cliVersion;
}

interface Candidate {
  token: string | null;
  expiresAt: number;
}

/** The keychain value may be the oauth object itself; `.credentials.json` holds it under claudeAiOauth. */
function oauthOf(raw: unknown, topLevelToo: boolean): Candidate | null {
  if (!isRecord(raw)) return null;
  const oa = isRecord(raw.claudeAiOauth) ? raw.claudeAiOauth : topLevelToo ? raw : {};
  const token = typeof oa.accessToken === "string" && oa.accessToken ? oa.accessToken : null;
  const expiresAt = typeof oa.expiresAt === "number" ? oa.expiresAt : 0;
  return { token, expiresAt };
}

/**
 * The access token for a config dir: the keychain entry first, then `<dir>/.credentials.json`.
 * The first one whose expiresAt is ahead wins. Without one, the keychain token is returned as
 * expired; null when there is no token at all.
 */
export async function readClaudeToken(
  configDir: string,
  keychain: (service: string) => Promise<string | null>,
  nowMs: number,
): Promise<{ token: string; expired: boolean } | null> {
  const cands: Candidate[] = [];
  const raw = await keychain(keychainService(configDir));
  if (raw) {
    const c = oauthOf(parseJson(raw), true);
    if (c) cands.push(c);
  }
  try {
    const c = oauthOf(JSON.parse(await fs.promises.readFile(path.join(configDir, ".credentials.json"), "utf8")), false);
    if (c) cands.push(c);
  } catch {
    // no credentials file
  }
  const valid = cands.find((c) => c.token && c.expiresAt > nowMs);
  if (valid?.token) return { token: valid.token, expired: false };
  const first = cands[0];
  if (first?.token) return { token: first.token, expired: true };
  return null;
}

export interface ClaudeProfile {
  email: string | null;
  /** organizationType, e.g. "claude_max", "claude_team". */
  plan: string | null;
}

/** Email and plan from `<dir>/.claude.json` `oauthAccount`. */
export async function readClaudeProfile(configDir: string): Promise<ClaudeProfile> {
  try {
    const j = JSON.parse(await fs.promises.readFile(path.join(configDir, ".claude.json"), "utf8")) as unknown;
    let oa = isRecord(j) ? j.oauthAccount : undefined;
    if (typeof oa === "string") oa = parseJson(oa);
    if (!isRecord(oa)) return { email: null, plan: null };
    return {
      email: typeof oa.emailAddress === "string" ? oa.emailAddress : null,
      plan: typeof oa.organizationType === "string" ? oa.organizationType : null,
    };
  } catch {
    return { email: null, plan: null };
  }
}

export interface ClaudeUsageOptions {
  /**
   * Whether this process may read the account's Claude Code login at all (config `claudeUsage`).
   * Default true; false answers every read with `off` before any keychain or credentials file is touched.
   */
  enabled?: boolean;
  /** Whether the account's login has to be renewed: the `Login required` mark. Default: a login marker exists (loginMarker.ts). */
  loginRequired?: (configDir: string) => boolean;
  /** Cache TTL, ms. Default: env USAGE_CLAUDE_RATE_CACHE_TTL (seconds) or 60 s. */
  ttlMs?: number;
  /** Default: env MARU_CLAUDE_USAGE_URL (an isolated test instance points it at a stand-in), else the endpoint. */
  url?: string;
  readKeychain?: (service: string) => Promise<string | null>;
  /** Claude Code version for the User-Agent. */
  cliVersion?: () => Promise<string>;
  now?: () => number;
  /**
   * The last good read kept on disk (usage_history), for a config dir this process has not read
   * yet: a 429 or an error right after a restart shows those numbers (marked stale when old)
   * instead of none. Asked once per dir.
   */
  seed?: (configDir: string) => ClaudeOk | null;
}

export class ClaudeUsage {
  readonly ttlMs: number;
  private readonly enabled: boolean;
  private readonly loginRequired: (configDir: string) => boolean;
  private readonly url: string;
  private readonly keychain: (service: string) => Promise<string | null>;
  private readonly cliVersion: () => Promise<string>;
  private readonly now: () => number;
  private readonly seed: (configDir: string) => ClaudeOk | null;
  /** Dirs whose seed was asked for (once each; a 403 afterwards must not bring old numbers back). */
  private readonly seeded = new Set<string>();
  private readonly entries = new Map<string, ClaudeEntry>();
  private readonly lastGood = new Map<string, ClaudeOk>();
  /** 429 retry-after: no read before this time, ms. */
  private readonly blockedUntil = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<ClaudeRate>>();
  /** Requests sent to the endpoint, by config dir. */
  readonly fetches = new Map<string, number>();

  constructor(opts: ClaudeUsageOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.loginRequired = opts.loginRequired ?? ((dir) => loginMarked(dir));
    this.ttlMs = opts.ttlMs ?? envSeconds("USAGE_CLAUDE_RATE_CACHE_TTL", 60) * 1000;
    this.url = opts.url ?? (process.env.MARU_CLAUDE_USAGE_URL || CLAUDE_USAGE_URL);
    this.keychain = opts.readKeychain ?? readKeychain;
    this.cliVersion = opts.cliVersion ?? claudeCliVersion;
    this.now = opts.now ?? Date.now;
    this.seed = opts.seed ?? (() => null);
  }

  peek(configDir: string): ClaudeEntry | undefined {
    return this.entries.get(configDir);
  }

  /** When the poller should read this dir next, ms. */
  dueAt(configDir: string): number {
    const e = this.entries.get(configDir);
    if (!e) return this.now();
    return Math.max(e.dueAt, this.blockedUntil.get(configDir) ?? 0);
  }

  /**
   * The cached rate while it is fresh; otherwise one read of the endpoint, shared by everyone
   * who asks meanwhile. `force` skips the freshness check (machine API `?refresh=1`) but still
   * waits out a 429 retry-after.
   */
  get(configDir: string, force = false): Promise<ClaudeRate> {
    const now = this.now();
    const e = this.entries.get(configDir);
    if (e && !force && now < e.freshUntil) return Promise.resolve(e.rate);
    if (e && now < (this.blockedUntil.get(configDir) ?? 0)) return Promise.resolve(e.rate);
    const running = this.inflight.get(configDir);
    if (running) return running;
    const p = this.read(configDir).finally(() => this.inflight.delete(configDir));
    this.inflight.set(configDir, p);
    return p;
  }

  private store(configDir: string, rate: ClaudeRate, at: number, freshForMs = this.ttlMs): ClaudeRate {
    this.entries.set(configDir, {
      rate,
      at,
      freshUntil: at + freshForMs,
      dueAt: at + (freshForMs > 0 ? freshForMs : this.ttlMs),
    });
    return rate;
  }

  private keepLastGood(configDir: string, otherwise: ClaudeRate, at: number, freshForMs = this.ttlMs): ClaudeRate {
    if (!this.lastGood.has(configDir) && !this.seeded.has(configDir)) {
      this.seeded.add(configDir);
      const kept = this.seed(configDir);
      if (kept) this.lastGood.set(configDir, kept);
    }
    const lg = this.lastGood.get(configDir);
    if (lg) return this.store(configDir, lg, at);
    return this.store(configDir, otherwise, at, freshForMs);
  }

  private async read(configDir: string): Promise<ClaudeRate> {
    const at = this.now();
    if (!this.enabled) return this.store(configDir, { kind: "off" }, at);
    const tok = await readClaudeToken(configDir, this.keychain, at);
    if (!tok) return this.store(configDir, { kind: "auth_missing" }, at, 0);
    if (tok.expired) {
      const dead = this.loginRequired(configDir);
      return this.store(configDir, dead ? { kind: "expired", loginRequired: true } : { kind: "expired" }, at);
    }

    let res: Response;
    let body: unknown;
    try {
      this.fetches.set(configDir, (this.fetches.get(configDir) ?? 0) + 1);
      res = await fetch(this.url, {
        headers: {
          Authorization: `Bearer ${tok.token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": `claude-code/${await this.cliVersion()}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      body = res.status >= 400 ? (await res.arrayBuffer(), null) : await res.json();
    } catch (err) {
      // Network, timeout, or a body that is no JSON: show the last good read through the blip.
      // fetch reports "fetch failed" and keeps the reason (refused, DNS, TLS) in `cause`.
      const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
      const text = `${err instanceof Error ? err.message : String(err)}${cause}`.slice(0, ERROR_TEXT_MAX);
      return this.keepLastGood(configDir, { kind: "error", error: text }, at, Math.min(this.ttlMs, ERROR_RETRY_MS));
    }

    if (res.status === 403) {
      // The live 403 is the free / no-subscription signal; local plan metadata can stay
      // "claude_max" after a subscription ends. The last good read belongs to the ended
      // subscription, so a later blip shows the error instead of those numbers (and the FREE
      // mark stays). The dashboard kept it and flipped back to the old numbers.
      this.lastGood.delete(configDir);
      this.seeded.add(configDir);
      return this.store(configDir, { kind: "free" }, at);
    }
    if (res.status === 429) {
      const wait = retryAfterMs(res.headers.get("retry-after"), this.now());
      if (wait !== null) this.blockedUntil.set(configDir, this.now() + wait);
      return this.keepLastGood(configDir, { kind: "rate_limited" }, at);
    }
    if (res.status >= 400) return this.keepLastGood(configDir, { kind: "error", error: `HTTP ${res.status}` }, at);

    const j = isRecord(body) ? body : {};
    const ok: ClaudeOk = {
      kind: "ok",
      // five_hour comes only on plans with a 5h limit (Max has none); seven_day on every plan.
      fiveHour: windowOf(j.five_hour),
      sevenDay: windowOf(j.seven_day),
      capturedAt: isoUtc(this.now()),
    };
    this.lastGood.set(configDir, ok);
    return this.store(configDir, ok, at);
  }
}

function windowOf(o: unknown): ClaudeWindow | null {
  if (!isRecord(o) || Object.keys(o).length === 0) return null;
  return {
    util: typeof o.utilization === "number" ? o.utilization : null,
    resetsAt: typeof o.resets_at === "string" && o.resets_at ? o.resets_at : null,
  };
}

/** Retry-After as delta seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const date = Date.parse(v);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

/** ISO 8601 UTC with "+00:00", the offset form Python's isoformat() writes. */
export function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace("Z", "+00:00");
}

/** ms since epoch of an ISO 8601 string; null when absent or unreadable. */
export function isoMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** The earlier dashboard `_env_float`: a number from the environment, the default when unset or unreadable. */
export function envSeconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
