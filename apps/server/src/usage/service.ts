// Usage service (DESIGN.md 6a): polls every account into one cache and serves it to
//   - the UI: GET /api/usage and the /ws `usage` message (UsageSnapshot, packages/shared/src/usage.ts)
//   - menu bar apps: GET /api/data, the fields of the earlier dashboard's payload such an app reads
//   - other local tools: GET /api/v1/claude/accounts/{id}/usage, the earlier dashboard's machine API unchanged
//   - the dashboard: GET /api/usage/history, how each window moved over the last 7 days (history.ts)
//
// Each account is read again when its cache entry falls due (claude.ts, codex.ts), so an idle
// account stays current too. Requests read the same cache, so the endpoints see one call per
// account per TTL (plus the machine API's `?refresh=1`).
//
// FREE is judged on every refresh, as load_claude_account and
// load_codex_account did on every /api/data:
//   Claude  a read with a window: not free. 403: free. Otherwise a profile plan "free": free.
//   Codex   a live read (daemon or usage endpoint): free exactly when its plan is "free".
// Anything else keeps the stored mark.

import type http from "node:http";
import type {
  AccountUsage, IndexEvent, ProviderId, SessionSummary, UsageMessage, UsageSnapshot, UsageWindow,
} from "@maru/shared";
import type { ClaudeAccount, CodexAccount } from "../config.ts";
import { ClaudeUsage, isoMs, isoUtc, readClaudeProfile } from "./claude.ts";
import type { ClaudeProfile, ClaudeRate, ClaudeUsageOptions, ClaudeWindow } from "./claude.ts";
import { CodexUsage, homeHeldOpen, readCodexAuth } from "./codex.ts";
import type { CodexAuthInfo, CodexRate, CodexUsageOptions, CodexWindow } from "./codex.ts";
import { FreeStore } from "./freeStore.ts";
import { HISTORY_SPAN_MS, UsageHistoryStore } from "./history.ts";

/** The session index, for the active flag. */
export interface SessionFeed {
  snapshot(): SessionSummary[];
  subscribe(listener: (e: IndexEvent) => void): () => void;
}

export interface UsageServiceOptions {
  claudeAccounts: ClaudeAccount[];
  codexAccounts: CodexAccount[];
  /** sqlite file for the FREE marks and the history (the server's STATE_FILE); ":memory:" in tests. */
  stateFile: string;
  sessions?: SessionFeed;
  claude?: ClaudeUsageOptions;
  codex?: Omit<CodexUsageOptions, "onUpdate">;
  /** A codex process holds a rollout of this home open (default: lsof, as the dashboard did). */
  codexHeldOpen?: (home: string, nowMs: number) => Promise<boolean>;
  now?: () => number;
}

type Account =
  | { provider: "claude"; id: string; dir: string }
  | { provider: "codex"; id: string; home: string };

/** The part of the earlier dashboard's `/api/data` payload that a menu bar app decodes and shows. */
export interface DashboardData {
  /** Local time, "YYYY-MM-DD HH:MM:SS". */
  ts: string;
  claude: DashboardAccount[];
  codex: DashboardAccount[];
}

export interface DashboardAccount {
  id: string;
  label: string;
  free: boolean;
  active: boolean;
  rate: DashboardClaudeRate | DashboardCodexRate | null;
}

export interface DashboardClaudeRate {
  five_hour: { util: number | null; reset_s: number | null } | null;
  seven_day: { util: number | null; reset_s: number | null } | null;
}

export interface DashboardCodexRate {
  windows: { used_percent: number; window_minutes: number | null; reset_at: number | null }[];
}

const MACHINE_PATH = /^\/api\/v1\/claude\/accounts\/([^/]+)\/usage$/;
const CLAUDE_WINDOW_MINUTES = { five_hour: 300, seven_day: 10080 } as const;

export class UsageService {
  private readonly accounts: Account[];
  private readonly claude: ClaudeUsage;
  private readonly codex: CodexUsage;
  private readonly free: FreeStore;
  private readonly history: UsageHistoryStore;
  private readonly activity: Activity;
  private readonly now: () => number;
  private readonly profiles = new Map<string, ClaudeProfile | CodexAuthInfo>();
  /** JSON of the AccountUsage last pushed, by account. */
  private readonly published = new Map<string, string>();
  private readonly listeners = new Set<(data: string) => void>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly codexHeldOpen: (home: string, nowMs: number) => Promise<boolean>;
  /** Codex accounts whose rollout a codex process holds open, from the last refresh. */
  private readonly heldOpen = new Map<string, boolean>();
  private started = false;
  private running = false;
  private stopping: Promise<void> | null = null;
  /** The FREE store is closed; no more writes. */
  private closed = false;
  private lastError: string | null = null;

  constructor(opts: UsageServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.codexHeldOpen = opts.codexHeldOpen ?? homeHeldOpen;
    this.accounts = [
      ...opts.claudeAccounts.map((a): Account => ({ provider: "claude", id: a.id, dir: a.dir })),
      ...opts.codexAccounts.map((a): Account => ({ provider: "codex", id: a.id, home: a.home })),
    ];
    this.history = new UsageHistoryStore(opts.stateFile);
    // After a restart the endpoint may answer 429 for minutes; the last kept reading fills in.
    const claudeIdByDir = new Map(opts.claudeAccounts.map((a) => [a.dir, a.id]));
    this.claude = new ClaudeUsage({
      now: this.now,
      seed: (dir) => {
        const id = claudeIdByDir.get(dir);
        const kept = id ? this.history.lastClaudeReading(id) : null;
        if (!kept) return null;
        const win = (w: { used: number; resetsAt: number | null }) => ({ util: w.used, resetsAt: w.resetsAt === null ? null : isoUtc(w.resetsAt) });
        return { kind: "ok", fiveHour: kept.fiveHour ? win(kept.fiveHour) : null, sevenDay: win(kept.sevenDay), capturedAt: isoUtc(kept.at) };
      },
      ...opts.claude,
    });
    this.codex = new CodexUsage(opts.codexAccounts, {
      now: this.now,
      ...opts.codex,
      onUpdate: (id) => this.publishId(id),
    });
    this.free = new FreeStore(opts.stateFile);
    this.activity = new Activity(opts.sessions, (_provider, account) => this.publishId(account));
  }

  /**
   * Keep every account polled. Claude accounts start at once; Codex accounts after each home's
   * first daemon connection attempt, so their first read can use the daemon.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.running = true;
    for (const a of this.accounts) if (a.provider === "claude") this.tick(a);
    await this.codex.start();
    for (const a of this.accounts) if (a.provider === "codex") this.tick(a);
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.running = false;
      for (const t of this.timers.values()) clearTimeout(t);
      this.timers.clear();
      this.listeners.clear();
      this.activity.close();
      await this.codex.stop();
      this.closed = true;
      this.free.close();
      this.history.close();
    })();
    return this.stopping;
  }

  /** Every account, refreshed where its cache entry has expired. */
  async snapshot(): Promise<UsageSnapshot> {
    await Promise.all(this.accounts.map((a) => this.refresh(a)));
    return this.build();
  }

  /** `/api/data` for menu bar apps. */
  async dashboard(): Promise<DashboardData> {
    await Promise.all(this.accounts.map((a) => this.refresh(a)));
    const now = this.now();
    const row = (a: Account): DashboardAccount => ({
      id: a.id,
      label: a.id,
      free: !this.closed && this.free.has(a.id),
      active: this.isActive(a),
      rate: a.provider === "claude" ? dashboardClaudeRate(this.claude.peek(a.dir)?.rate, now) : dashboardCodexRate(this.codex.peek(a.id)?.rate),
    });
    return {
      ts: localTimestamp(now),
      claude: this.accounts.filter((a) => a.provider === "claude").map(row),
      codex: this.accounts.filter((a) => a.provider === "codex").map(row),
    };
  }

  /**
   * The earlier dashboard's machine API: one exact Claude account, never another one in its
   * place. 404 for an unknown account, 503 when its usage is unavailable.
   */
  async claudeMachine(accountId: string, force: boolean): Promise<{ status: number; body: unknown }> {
    const a = this.accounts.find((x) => x.provider === "claude" && x.id === accountId);
    if (!a || a.provider !== "claude") {
      return {
        status: 404,
        body: { error: { code: "account_not_found", message: `Unknown Claude account: ${accountId}` } },
      };
    }
    await this.refresh(a, force);
    const rate = this.claude.peek(a.dir)?.rate;
    const unavailable = !rate ? "error" : rate.kind === "ok" ? null : rate.kind;
    const ok = rate?.kind === "ok" ? rate : null;
    const sevenDay = ok?.sevenDay ?? null;
    // seven_day comes on every subscription plan; five_hour only on plans with a 5h limit (Max
    // has none), and a missing five_hour is sent as null.
    if (unavailable || !ok || !sevenDay || sevenDay.util == null) {
      return {
        status: 503,
        body: {
          api_version: "v1",
          provider: "claude",
          account_id: accountId,
          error: { code: "usage_unavailable", reason: unavailable ?? "window_missing", message: `Usage is unavailable for ${accountId}` },
        },
      };
    }
    const window = (w: ClaudeWindow) => ({ used_percent: w.util, resets_at: w.resetsAt });
    return {
      status: 200,
      body: {
        api_version: "v1",
        provider: "claude",
        account_id: accountId,
        captured_at: ok.capturedAt,
        source: "anthropic_oauth",
        windows: {
          five_hour: ok.fiveHour && ok.fiveHour.util != null ? window(ok.fiveHour) : null,
          seven_day: window(sevenDay),
        },
      },
    };
  }

  /**
   * Send the snapshot to a /ws client now and after every change. Returns the unsubscribe.
   * `send` gets the serialized UsageMessage.
   */
  attach(send: (data: string) => void): () => void {
    let open = true;
    const join = () => {
      if (!open) return;
      send(JSON.stringify(this.message()));
      this.listeners.add(send);
    };
    this.snapshot().then(join, (err: unknown) => {
      // Whatever the cache holds goes out, and later changes still reach this client.
      this.noteError(err);
      join();
    });
    return () => {
      open = false;
      this.listeners.delete(send);
    };
  }

  /** Answer the usage routes. Returns false for any other request. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
    if (req.method !== "GET") return false;
    const p = url.pathname;
    let work: (() => Promise<{ status: number; body: unknown }>) | null = null;
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, must-revalidate",
    };
    if (p === "/api/usage") {
      work = async () => ({ status: 200, body: await this.snapshot() });
    } else if (p === "/api/usage/history") {
      work = async () => {
        const now = this.now();
        return { status: 200, body: this.history.read(now - HISTORY_SPAN_MS, now) };
      };
    } else if (p === "/api/data") {
      headers.pragma = "no-cache";
      work = async () => ({ status: 200, body: await this.dashboard() });
    } else {
      const m = MACHINE_PATH.exec(p);
      if (m) {
        const id = decodeSegment(m[1]!);
        const force = url.searchParams.get("refresh") === "1";
        work = () => this.claudeMachine(id, force);
      }
    }
    if (!work) return false;
    work().then(
      ({ status, body }) => res.writeHead(status, headers).end(JSON.stringify(body)),
      (err: unknown) => {
        this.noteError(err);
        console.error("usage api error", err);
        res.writeHead(500, headers).end(JSON.stringify({ error: "internal error" }));
      },
    );
    return true;
  }

  stats(): {
    claudeFetches: Record<string, number>;
    codexReads: Record<string, unknown>;
    codexDaemonErrors: Record<string, string | null>;
    free: string[];
    history: { rows: number; oldest: number | null; written: Record<string, number> };
    lastError: string | null;
  } {
    return {
      claudeFetches: Object.fromEntries(this.accounts.flatMap((a) => (a.provider === "claude" ? [[a.id, this.claude.fetches.get(a.dir) ?? 0]] : []))),
      codexReads: Object.fromEntries(this.codex.reads),
      codexDaemonErrors: Object.fromEntries(this.accounts.flatMap((a) => (a.provider === "codex" ? [[a.id, this.codex.lastDaemonError(a.id)]] : []))),
      free: this.free.list(),
      history: { ...this.history.size(), written: Object.fromEntries(this.history.written) },
      lastError: this.lastError,
    };
  }

  // ---- polling ----

  private tick(a: Account): void {
    this.timers.delete(a.id);
    if (!this.running) return;
    const wait = this.dueAt(a) - this.now();
    if (wait > 0) {
      this.schedule(a, wait);
      return;
    }
    this.refresh(a).then(
      () => this.afterRefresh(a),
      (err: unknown) => {
        this.noteError(err);
        this.afterRefresh(a);
      },
    );
  }

  private afterRefresh(a: Account): void {
    if (!this.running) return;
    const wait = this.dueAt(a) - this.now();
    const ttl = a.provider === "claude" ? this.claude.ttlMs : this.codex.ttlMs;
    if (wait > 0) this.schedule(a, wait);
    else if (ttl > 0) this.schedule(a, ttl);
    // TTL 0 turns the cache off: requests read on demand, as the dashboard did, and nothing polls.
  }

  private schedule(a: Account, ms: number): void {
    clearTimeout(this.timers.get(a.id));
    const t = setTimeout(() => this.tick(a), ms);
    t.unref();
    this.timers.set(a.id, t);
  }

  private dueAt(a: Account): number {
    return a.provider === "claude" ? this.claude.dueAt(a.dir) : this.codex.dueAt(a.id);
  }

  /** Read the account when its entry has expired (or `force`), judge FREE, push a change. */
  private async refresh(a: Account, force = false): Promise<void> {
    if (a.provider === "claude") {
      const rate = await this.claude.get(a.dir, force);
      const profile = await readClaudeProfile(a.dir);
      this.profiles.set(a.id, profile);
      const verdict = claudeFreeVerdict(rate, profile.plan);
      if (verdict !== null && !this.closed) this.free.set(a.id, verdict);
    } else {
      const rate = await this.codex.get(a.id, force);
      // auth.json is opened only while Codex usage is on.
      this.profiles.set(a.id, this.codex.enabled ? await readCodexAuth(a.home) : { email: null, plan: null });
      this.heldOpen.set(a.id, await this.codexHeldOpen(a.home, this.now()));
      if (rate.kind === "live" && !this.closed) this.free.set(a.id, rate.plan === "free");
    }
    this.publish(a);
  }

  /** Claude: a running session. Codex: a thread some process holds, or a rollout a codex process has open. */
  private isActive(a: Account): boolean {
    return this.activity.isActive(a.provider, a.id) || (a.provider === "codex" && this.heldOpen.get(a.id) === true);
  }

  // ---- building and pushing ----

  private build(): UsageSnapshot {
    return { accounts: this.accounts.map((a) => this.usageOf(a)), generatedAt: this.now() };
  }

  private message(): UsageMessage {
    return { type: "usage", snapshot: this.build() };
  }

  private publishId(accountId: string): void {
    const a = this.accounts.find((x) => x.id === accountId);
    if (a) this.publish(a);
  }

  private publish(a: Account): void {
    if (this.closed) return;
    const usage = this.usageOf(a);
    try {
      this.history.record(usage, this.now());
    } catch (err) {
      // The gauges go on without the history row.
      this.noteError(err);
    }
    const json = JSON.stringify(usage);
    if (this.published.get(a.id) === json) return;
    this.published.set(a.id, json);
    if (!this.listeners.size) return;
    const data = JSON.stringify(this.message());
    for (const send of this.listeners) send(data);
  }

  private usageOf(a: Account): AccountUsage {
    const profile = this.profiles.get(a.id);
    const base: AccountUsage = {
      provider: a.provider,
      account: a.id,
      email: profile?.email ?? null,
      plan: profile?.plan ?? null,
      free: !this.closed && this.free.has(a.id),
      active: this.isActive(a),
      status: "no_data",
      error: null,
      windows: [],
      source: null,
      stale: false,
      capturedAt: null,
    };
    if (a.provider === "claude") {
      const rate = this.claude.peek(a.dir)?.rate;
      return rate ? { ...base, ...claudeUsage(rate) } : base;
    }
    const rate = this.codex.peek(a.id)?.rate;
    if (!rate) return base;
    const u = codexUsage(rate);
    return { ...base, ...u, plan: u.plan ?? base.plan };
  }

  private noteError(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
  }
}

function claudeFreeVerdict(rate: ClaudeRate, plan: string | null): boolean | null {
  // A good read means a subscription. Max plans send no five_hour, so seven_day alone counts.
  if (rate.kind === "ok" && (rate.fiveHour || rate.sevenDay)) return false;
  if (rate.kind === "free") return true;
  if ((plan ?? "").replaceAll("claude_", "").toLowerCase() === "free") return true;
  return null;
}

/** A login marker exists for the account: only a new login helps. */
export const LOGIN_REQUIRED_TEXT = "Login required";

export function claudeUsage(rate: ClaudeRate): Partial<AccountUsage> {
  if (rate.kind === "ok") {
    const windows: UsageWindow[] = [];
    const add = (id: keyof typeof CLAUDE_WINDOW_MINUTES, w: ClaudeWindow | null) => {
      if (w) windows.push({ id, minutes: CLAUDE_WINDOW_MINUTES[id], usedPercent: w.util, resetsAt: isoMs(w.resetsAt) });
    };
    add("five_hour", rate.fiveHour);
    add("seven_day", rate.sevenDay);
    return { status: "ok", windows, source: "anthropic_oauth", capturedAt: isoMs(rate.capturedAt) };
  }
  if (rate.kind === "error") return { status: "error", error: rate.error };
  // The footer and settings show `error` before the status text.
  if (rate.kind === "expired" && rate.loginRequired) return { status: "expired", error: LOGIN_REQUIRED_TEXT };
  return { status: rate.kind };
}

function codexWindows(windows: CodexWindow[]): UsageWindow[] {
  return windows.map((w) => ({
    id: w.id,
    minutes: w.minutes,
    usedPercent: w.usedPercent,
    resetsAt: w.resetAt === null ? null : w.resetAt * 1000,
  }));
}

function codexUsage(rate: CodexRate): Partial<AccountUsage> {
  switch (rate.kind) {
    case "live":
      return { status: "ok", windows: codexWindows(rate.windows), source: rate.source, plan: rate.plan, capturedAt: rate.capturedAt };
    case "rollout":
      return {
        status: "ok", windows: codexWindows(rate.windows), source: "codex_rollout", plan: rate.plan,
        stale: rate.stale, capturedAt: rate.capturedAt,
      };
    case "expired":
      return { status: "expired" };
    case "off":
      return { status: "off" };
    case "none":
      return { status: "no_data" };
  }
}

function dashboardClaudeRate(rate: ClaudeRate | undefined, now: number): DashboardClaudeRate | null {
  if (!rate || rate.kind !== "ok") return null;
  const w = (x: ClaudeWindow | null) => {
    if (!x) return null;
    const t = isoMs(x.resetsAt);
    return { util: x.util, reset_s: t === null ? null : (t - now) / 1000 };
  };
  return { five_hour: w(rate.fiveHour), seven_day: w(rate.sevenDay) };
}

function dashboardCodexRate(rate: CodexRate | undefined): DashboardCodexRate | null {
  if (!rate || rate.kind === "none" || rate.kind === "off") return null;
  if (rate.kind === "expired") return { windows: [] };
  return { windows: rate.windows.map((w) => ({ used_percent: w.usedPercent, window_minutes: w.minutes, reset_at: w.resetAt })) };
}

/** The earlier dashboard: datetime.now().strftime("%Y-%m-%d %H:%M:%S") */
function localTimestamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** urllib.parse.unquote: percent escapes decoded, a malformed one left as it is. */
function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Active accounts from the session index: a Claude session that is running (sessions json
 * busy, the dashboard's test), or a Codex thread some process holds (running, waiting for input,
 * or open and idle). UsageService adds the dashboard's lsof test for Codex homes without a daemon.
 */
class Activity {
  /** Session key -> its account while the session counts as active. */
  private readonly sessions = new Map<string, string>();
  private readonly counts = new Map<string, number>();
  private onChange: (provider: ProviderId, account: string) => void;
  private readonly off: () => void;

  constructor(feed: SessionFeed | undefined, onChange: (provider: ProviderId, account: string) => void) {
    // The sessions already indexed are counted before anyone listens.
    this.onChange = () => {};
    this.off = feed ? feed.subscribe((e) => this.apply(e)) : () => {};
    for (const s of feed?.snapshot() ?? []) this.apply({ type: "upsert", session: s });
    this.onChange = onChange;
  }

  close(): void {
    this.off();
  }

  isActive(provider: ProviderId, account: string): boolean {
    return (this.counts.get(`${provider}:${account}`) ?? 0) > 0;
  }

  private apply(e: IndexEvent): void {
    if (e.type === "remove") {
      const was = this.sessions.get(e.key);
      if (!was) return;
      this.sessions.delete(e.key);
      this.bump(was, -1);
      return;
    }
    const s = e.session;
    const acct = `${s.provider}:${s.account}`;
    // A Claude process this server runs works on while background tasks run after its turn.
    const active = s.provider === "claude"
      ? s.status === "running" || (s.backgroundTasks ?? 0) > 0
      : s.status === "running" || s.status === "waiting-input" || s.status === "open-idle";
    const was = this.sessions.get(s.key);
    if (active === (was !== undefined)) return;
    if (active) {
      this.sessions.set(s.key, acct);
      this.bump(acct, 1);
    } else {
      this.sessions.delete(s.key);
      this.bump(was!, -1);
    }
  }

  private bump(acct: string, delta: number): void {
    const before = this.counts.get(acct) ?? 0;
    const after = before + delta;
    if (after > 0) this.counts.set(acct, after);
    else this.counts.delete(acct);
    if ((before > 0) !== (after > 0)) {
      const i = acct.indexOf(":");
      this.onChange(acct.slice(0, i) as ProviderId, acct.slice(i + 1));
    }
  }
}
