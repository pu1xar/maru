// Codex usage per CODEX_HOME (DESIGN.md 5).
//
// Codex usage is read only when the config turns it on (`codexUsage`, default off). Off answers
// every read with `off` before any daemon is contacted, any auth.json is opened or any request
// is sent.
//
// A home whose app-server daemon answers is read with `account/rateLimits/read`, and the
// daemon's `account/rateLimits/updated` notifications are merged in between reads. A home
// without a daemon, or whose daemon read fails, uses the ChatGPT usage endpoint with the access
// token the Codex CLI stored in `<home>/auth.json`, and when that gives nothing (no token, 429,
// 5xx, network), the last rate-limit snapshot written to a session rollout. A 401 or 403 from
// the endpoint means the token expired or the account is inactive.
//
// One read per home per TTL (60 s, env USAGE_CODEX_LIVE_CACHE_TTL in seconds, the dashboard's
// variable). The dashboard's per-session 6h breakdown (inventory #3) is left behind.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CodexAccount } from "../config.ts";
import { CodexRpc } from "../codex/rpc.ts";
import type { GetAccountRateLimitsResponse } from "../codex/protocol/v2/GetAccountRateLimitsResponse.ts";
import type { RateLimitSnapshot } from "../codex/protocol/v2/RateLimitSnapshot.ts";
import type { RateLimitWindow } from "../codex/protocol/v2/RateLimitWindow.ts";
import { envSeconds } from "./claude.ts";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/** The earlier dashboard CODEX_UA */
const CODEX_UA = "codex_cli_rs/0.137.0";
/** The earlier dashboard: urlopen timeout of the usage endpoint; the daemon read gets the same bound. */
const READ_TIMEOUT_MS = 8_000;
/** The earlier dashboard: a rollout snapshot older than this is stale. */
const ROLLOUT_FRESH_MS = 6 * 3600 * 1000;

export interface CodexWindow {
  id: "primary" | "secondary";
  usedPercent: number;
  minutes: number | null;
  /** Epoch seconds, as Codex sends it. */
  resetAt: number | null;
}

export type CodexRate =
  | { kind: "live"; source: "codex_daemon" | "codex_usage_api"; plan: string | null; windows: CodexWindow[]; capturedAt: number }
  | { kind: "expired" }
  | { kind: "rollout"; plan: string | null; windows: CodexWindow[]; stale: boolean; capturedAt: number }
  | { kind: "off" }
  | { kind: "none" };

export interface CodexEntry {
  rate: CodexRate;
  at: number;
  freshUntil: number;
  dueAt: number;
}

export interface CodexAuthInfo {
  email: string | null;
  /** id token `chatgpt_plan_type`. */
  plan: string | null;
}

/** Email and plan from the id token in `<home>/auth.json`. */
export async function readCodexAuth(home: string): Promise<CodexAuthInfo> {
  try {
    const d = JSON.parse(await fs.promises.readFile(path.join(home, "auth.json"), "utf8")) as { tokens?: { id_token?: unknown } };
    const idToken = d.tokens?.id_token;
    if (typeof idToken !== "string") return { email: null, plan: null };
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    return {
      email: typeof payload.email === "string" ? payload.email : null,
      plan: typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : null,
    };
  } catch {
    return { email: null, plan: null };
  }
}

export interface CodexUsageOptions {
  /**
   * Whether this process may read Codex usage at all (config `codexUsage`). Default true; false
   * answers every read with `off` without contacting a daemon, reading auth.json or sending a request.
   */
  enabled?: boolean;
  /** Cache TTL, ms. Default: env USAGE_CODEX_LIVE_CACHE_TTL (seconds) or 60 s. */
  ttlMs?: number;
  /** Default: env MARU_CODEX_USAGE_URL (an isolated test instance points it at a stand-in), else the endpoint. */
  usageUrl?: string;
  /** The daemon client of a home. Default: a CodexRpc of its own per home. */
  rpcFor?: (home: string) => CodexRpc;
  now?: () => number;
  /** A notification changed a cached rate. */
  onUpdate?: (accountId: string) => void;
}

interface HomeState {
  account: CodexAccount;
  rpc: CodexRpc;
  ready: Promise<boolean> | null;
  entry: CodexEntry | null;
  inflight: Promise<CodexRate> | null;
  /** The daemon's last full snapshot, the base its sparse updates merge into. */
  daemon: RateLimitSnapshot | null;
  /** Plan from the rollouts, used while the live read carries none. */
  rolloutPlan: string | null;
  lastDaemonError: string | null;
}

export class CodexUsage {
  readonly ttlMs: number;
  readonly enabled: boolean;
  private readonly usageUrl: string;
  private readonly now: () => number;
  private readonly onUpdate: (accountId: string) => void;
  private readonly homes = new Map<string, HomeState>();
  /** Counters, by account. */
  readonly reads = new Map<string, { daemon: number; usageApi: number; rollout: number; notifications: number }>();

  constructor(accounts: CodexAccount[], opts: CodexUsageOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.ttlMs = opts.ttlMs ?? envSeconds("USAGE_CODEX_LIVE_CACHE_TTL", 60) * 1000;
    this.usageUrl = opts.usageUrl ?? (process.env.MARU_CODEX_USAGE_URL || CODEX_USAGE_URL);
    this.now = opts.now ?? Date.now;
    this.onUpdate = opts.onUpdate ?? (() => {});
    const rpcFor = opts.rpcFor ?? ((home: string) => new CodexRpc(home));
    for (const account of accounts) {
      const rpc = rpcFor(account.home);
      const st: HomeState = {
        account, rpc, ready: null, entry: null, inflight: null, daemon: null, rolloutPlan: null, lastDaemonError: null,
      };
      rpc.on("account/rateLimits/updated", (p) => this.merge(st, p.rateLimits));
      this.homes.set(account.id, st);
      this.reads.set(account.id, { daemon: 0, usageApi: 0, rollout: 0, notifications: 0 });
    }
  }

  /** Connect to every daemon; resolves after each home's first attempt. */
  async start(): Promise<void> {
    if (!this.enabled) return;
    await Promise.all([...this.homes.values()].map((st) => (st.ready ??= st.rpc.start())));
  }

  async stop(): Promise<void> {
    await Promise.all([...this.homes.values()].map((st) => st.rpc.close()));
  }

  peek(accountId: string): CodexEntry | undefined {
    return this.homes.get(accountId)?.entry ?? undefined;
  }

  dueAt(accountId: string): number {
    return this.homes.get(accountId)?.entry?.dueAt ?? this.now();
  }

  lastDaemonError(accountId: string): string | null {
    return this.homes.get(accountId)?.lastDaemonError ?? null;
  }

  get(accountId: string, force = false): Promise<CodexRate> {
    const st = this.homes.get(accountId);
    if (!st) return Promise.resolve({ kind: "none" });
    if (st.entry && !force && this.now() < st.entry.freshUntil) return Promise.resolve(st.entry.rate);
    if (st.inflight) return st.inflight;
    const p = this.read(st).finally(() => (st.inflight = null));
    st.inflight = p;
    return p;
  }

  private async read(st: HomeState): Promise<CodexRate> {
    const at = this.now();
    if (!this.enabled) {
      const rate: CodexRate = { kind: "off" };
      st.entry = { rate, at, freshUntil: at + this.ttlMs, dueAt: at + this.ttlMs };
      return rate;
    }
    const counts = this.reads.get(st.account.id)!;
    // A read before the daemon connection is up (right after start) takes the usage endpoint.
    let rate: CodexRate | null = null;
    if (st.rpc.connected) {
      try {
        counts.daemon++;
        const res = (await st.rpc.request(
          "account/rateLimits/read",
          { excludeResetCreditDetails: true },
          { timeoutMs: READ_TIMEOUT_MS },
        )) as GetAccountRateLimitsResponse;
        st.daemon = res.rateLimits;
        st.lastDaemonError = null;
        rate = this.daemonRate(st);
      } catch (err) {
        st.lastDaemonError = err instanceof Error ? err.message : String(err);
      }
    }
    if (!rate) {
      counts.usageApi++;
      rate = await readUsageEndpoint(st.account.home, this.usageUrl, this.now());
    }
    if (rate?.kind === "live" && rate.plan === null) {
      // the earlier dashboard took `live.plan or <rollout plan>`; the plan decides FREE.
      counts.rollout++;
      const snap = readRolloutSnapshot(st.account.home, this.now());
      st.rolloutPlan = snap.kind === "rollout" ? snap.plan : null;
      rate.plan = st.rolloutPlan;
    }
    if (!rate) {
      counts.rollout++;
      rate = readRolloutSnapshot(st.account.home, this.now());
    }
    st.entry = { rate, at, freshUntil: at + this.ttlMs, dueAt: at + this.ttlMs };
    return rate;
  }

  private daemonRate(st: HomeState): CodexRate {
    const s = st.daemon!;
    const windows: CodexWindow[] = [];
    const add = (id: CodexWindow["id"], w: RateLimitWindow | null) => {
      if (w) windows.push({ id, usedPercent: w.usedPercent, minutes: w.windowDurationMins, resetAt: w.resetsAt });
    };
    add("primary", s.primary);
    add("secondary", s.secondary);
    return { kind: "live", source: "codex_daemon", plan: s.planType ?? st.rolloutPlan, windows, capturedAt: this.now() };
  }

  /**
   * A sparse rolling update: values it carries replace the last read's, null ones keep it
   * (AccountRateLimitsUpdatedNotification). Applied only while the cache holds a daemon read of
   * the same limit.
   */
  private merge(st: HomeState, u: RateLimitSnapshot): void {
    const e = st.entry;
    const base = st.daemon;
    if (!e || !base || e.rate.kind !== "live" || e.rate.source !== "codex_daemon") return;
    if (u.limitId !== null && u.limitId !== base.limitId) return;
    st.daemon = {
      ...base,
      primary: u.primary ?? base.primary,
      secondary: u.secondary ?? base.secondary,
      planType: u.planType ?? base.planType,
    };
    this.reads.get(st.account.id)!.notifications++;
    e.rate = this.daemonRate(st);
    this.onUpdate(st.account.id);
  }
}

/**
 * The earlier dashboard `codex_live_usage`: the ChatGPT usage endpoint (a read-only GET; no quota spent).
 * null when there is nothing to show from it, so the caller falls back to the rollouts.
 */
export async function readUsageEndpoint(home: string, url: string, nowMs: number): Promise<CodexRate | null> {
  let token: unknown;
  let account: unknown;
  try {
    const d = JSON.parse(await fs.promises.readFile(path.join(home, "auth.json"), "utf8")) as { tokens?: Record<string, unknown> };
    token = d.tokens?.access_token;
    account = d.tokens?.account_id;
  } catch {
    return null;
  }
  if (typeof token !== "string" || !token || typeof account !== "string" || !account) return null;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-Id": account,
        "User-Agent": CODEX_UA,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (res.status >= 400) {
      await res.arrayBuffer().catch(() => undefined);
      // 401/403: expired token or an inactive account. 429, 5xx: transient, use the rollouts.
      return res.status === 401 || res.status === 403 ? { kind: "expired" } : null;
    }
    const j: unknown = await res.json();
    if (!isRecord(j)) return null; // the earlier dashboard failed on j.get() and fell back the same way
    const rl = isRecord(j.rate_limit) ? j.rate_limit : {};
    const windows: CodexWindow[] = [];
    const add = (id: CodexWindow["id"], raw: unknown) => {
      if (!isRecord(raw) || typeof raw.used_percent !== "number") return;
      let minutes = typeof raw.window_minutes === "number" ? raw.window_minutes : null;
      if (minutes === null && typeof raw.limit_window_seconds === "number") minutes = Math.trunc(raw.limit_window_seconds / 60);
      windows.push({ id, usedPercent: raw.used_percent, minutes, resetAt: typeof raw.reset_at === "number" ? raw.reset_at : null });
    };
    add("primary", rl.primary_window);
    add("secondary", rl.secondary_window);
    return {
      kind: "live",
      source: "codex_usage_api",
      plan: typeof j.plan_type === "string" ? j.plan_type : null,
      windows,
      capturedAt: nowMs,
    };
  } catch {
    return null; // network, a proxy's page, a body that is no JSON
  }
}

/**
 * The earlier dashboard `codex_rate_limits` (the gauges only): the newest rollout under
 * `<home>/sessions/*\/*\/*\/*.jsonl` whose last token_count event carries rate-limit windows.
 * Stale when that rollout was written 6h ago or earlier.
 */
export function readRolloutSnapshot(home: string, nowMs: number): CodexRate {
  const files: { file: string; mtime: number }[] = [];
  for (const file of rolloutFiles(path.join(home, "sessions"))) {
    try {
      files.push({ file, mtime: fs.statSync(file).mtimeMs });
    } catch {
      // vanished between the listing and the stat
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { file, mtime } of files) {
    const rec = rateRec(lastTokenCount(file));
    if (!rec) continue;
    return { kind: "rollout", plan: rec.plan, windows: rec.windows, stale: nowMs - mtime >= ROLLOUT_FRESH_MS, capturedAt: mtime };
  }
  return { kind: "none" };
}

/** Python glob `sessions/*\/*\/*\/*.jsonl`: three directory levels, names that do not start with a dot. */
function rolloutFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (depth < 3) {
        if (e.isDirectory() || (e.isSymbolicLink() && isDir(p))) walk(p, depth + 1);
      } else if (e.name.endsWith(".jsonl")) {
        out.push(p);
      }
    }
  };
  walk(root, 0);
  return out;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function rateRec(tc: Record<string, unknown> | null): { plan: string | null; windows: CodexWindow[] } | null {
  if (!tc) return null;
  const rl = isRecord(tc.rate_limits) ? tc.rate_limits : {};
  const windows: CodexWindow[] = [];
  const add = (id: CodexWindow["id"], raw: unknown) => {
    if (!isRecord(raw) || typeof raw.used_percent !== "number") return;
    windows.push({
      id,
      usedPercent: raw.used_percent,
      minutes: typeof raw.window_minutes === "number" ? raw.window_minutes : null,
      resetAt: typeof raw.resets_at === "number" ? raw.resets_at : null,
    });
  };
  add("primary", rl.primary);
  add("secondary", rl.secondary);
  if (!windows.length) return null;
  return { plan: typeof rl.plan_type === "string" ? rl.plan_type : null, windows };
}

const TOKEN_COUNT = Buffer.from('"token_count"');
const CHUNK = 64 * 1024;

/**
 * The payload of the last token_count event_msg in a rollout (the earlier dashboard
 * `_codex_last_token_count`). Reads backwards from the end, so a large rollout costs only its
 * tail; the result is the same line a front-to-back scan would keep last.
 */
export function lastTokenCount(file: string): Record<string, unknown> | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    let pos = fs.fstatSync(fd).size;
    // The line being read backwards: chunks right of the read position, in file order. Joined
    // only once its start is found, so a line many chunks long is copied once.
    let pieces: Buffer[] = [];
    const check = (line: Buffer): Record<string, unknown> | null => {
      if (!line.includes(TOKEN_COUNT)) return null;
      let d: unknown;
      try {
        d = JSON.parse(line.toString("utf8"));
      } catch {
        return null;
      }
      if (!isRecord(d) || d.type !== "event_msg" || !isRecord(d.payload) || d.payload.type !== "token_count") return null;
      return d.payload;
    };
    while (pos > 0) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      let end = buf.length;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] !== 0x0a) continue;
        const head = buf.subarray(i + 1, end);
        const hit = check(pieces.length ? Buffer.concat([head, ...pieces]) : head);
        if (hit) return hit;
        pieces = [];
        end = i;
      }
      if (end > 0) pieces.unshift(buf.subarray(0, end));
    }
    return pieces.length ? check(Buffer.concat(pieces)) : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The earlier dashboard `_codex_busy_rollouts` values: lsof result cache and timeout. */
const OPEN_ROLLOUTS_CACHE_MS = 5_000;
const LSOF_TIMEOUT_MS = 4_000;
let openCache: { at: number; files: Set<string> } | null = null;
let openRun: Promise<Set<string>> | null = null;

/**
 * Rollout files a running codex process holds open (the earlier dashboard `_codex_busy_rollouts`). This
 * sees a TUI that runs without a daemon, which the session index shows as closed.
 */
export function openRollouts(nowMs: number): Promise<Set<string>> {
  if (openCache && nowMs - openCache.at < OPEN_ROLLOUTS_CACHE_MS) return Promise.resolve(openCache.files);
  openRun ??= new Promise<Set<string>>((resolve) => {
    execFile("lsof", ["-c", "codex", "-Fn"], { timeout: LSOF_TIMEOUT_MS, maxBuffer: Infinity }, (err, stdout) => {
      const files = new Set<string>();
      // lsof exits 1 when no process matches; any output it gave is still read.
      if (!(err && (err as { killed?: boolean }).killed)) {
        for (const line of String(stdout ?? "").split("\n")) {
          if (line.startsWith("n") && line.includes("/sessions/") && line.endsWith(".jsonl")) files.add(line.slice(1));
        }
      }
      openCache = { at: nowMs, files };
      openRun = null;
      resolve(files);
    });
  });
  return openRun;
}

/** True when a codex process holds a rollout under `<home>/sessions/` open. */
export async function homeHeldOpen(home: string, nowMs: number): Promise<boolean> {
  const prefix = path.join(home, "sessions") + path.sep;
  for (const f of await openRollouts(nowMs)) if (f.startsWith(prefix)) return true;
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
