import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { ServerMessage, SessionSummary, UsageMessage, UsageSnapshot } from "@maru/shared";
import { SessionIndex } from "../index/store.ts";
import { ProjectStore } from "../projects/store.ts";
import { ChosenStore } from "../state/chosen.ts";
import { VisibleIndex } from "../index/visible.ts";
import { createServer } from "../http/server.ts";
import type { CodexRpc } from "../codex/rpc.ts";
import { keychainService } from "./claude.ts";
import { UsageService } from "./service.ts";

type Reply = { status: number; body: unknown; headers?: Record<string, string> };
type T = { after(fn: () => unknown): void };

/** Fake Claude OAuth usage endpoint: answers by bearer token (one per account). */
async function fakeClaude(t: T) {
  const replies = new Map<string, Reply>();
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const token = String(req.headers.authorization ?? "").replace("Bearer ", "");
    hits.set(token, (hits.get(token) ?? 0) + 1);
    const r = replies.get(token) ?? { status: 500, body: {} };
    res.writeHead(r.status, { "content-type": "application/json", ...r.headers }).end(JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/oauth/usage`, replies, hits };
}

/** Fake ChatGPT usage endpoint for the Codex homes (no daemon in these tests). */
async function fakeCodex(t: T) {
  const state = { reply: { status: 200, body: {} } as Reply, hits: 0 };
  const server = http.createServer((_req, res) => {
    state.hits++;
    res.writeHead(state.reply.status, { "content-type": "application/json" }).end(JSON.stringify(state.reply.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/wham/usage`, state };
}

const noDaemon = (home: string) =>
  ({ home, connected: false, on: () => () => {}, start: async () => false, close: async () => {} }) as unknown as CodexRpc;

const ok = (fiveHour: number | null, sevenDay: number | null): Reply => ({
  status: 200,
  body: {
    five_hour: fiveHour === null ? null : { utilization: fiveHour, resets_at: "2026-07-27T05:00:00+00:00" },
    seven_day: sevenDay === null ? null : { utilization: sevenDay, resets_at: "2026-08-01T00:00:00+00:00" },
  },
});

function session(over: Partial<SessionSummary> & Pick<SessionSummary, "provider" | "account" | "id">): SessionSummary {
  return {
    key: `${over.provider}:${over.account}:${over.id}`, cwd: "/x", name: null, title: null, preview: null,
    status: "closed", owner: "none", pid: null, tmuxPane: null, parentKey: null, updatedAt: 1, createdAt: null,
    sizeBytes: null, entrypoint: null, ...over,
  };
}

/** Two Claude accounts (claude-a token "tok-a", claude-b token "tok-b"), one Codex account. */
async function setup(t: T, opts: { keychain?: (service: string) => Promise<string | null>; heldOpen?: () => boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usv-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirA = path.join(root, ".claude-a");
  const dirB = path.join(root, ".claude-b");
  const codexHome = path.join(root, ".codex-a");
  for (const d of [dirA, dirB, codexHome]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(dirA, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@example.test", organizationType: "claude_max" } }));
  fs.writeFileSync(path.join(dirB, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "b@example.test", organizationType: "claude_team" } }));
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "cx", account_id: "acct" } }));
  const tokens = new Map([[keychainService(dirA), "tok-a"], [keychainService(dirB), "tok-b"]]);
  const claude = await fakeClaude(t);
  const codex = await fakeCodex(t);
  const index = new SessionIndex();
  const clock = { t: Date.parse("2026-07-27T00:00:00Z") };
  const usage = new UsageService({
    claudeAccounts: [{ id: "claude-a", dir: dirA }, { id: "claude-b", dir: dirB }],
    codexAccounts: [{ id: "codex-a", home: codexHome }],
    stateFile: ":memory:",
    sessions: index,
    now: () => clock.t,
    claude: {
      url: claude.url,
      ttlMs: 60_000,
      cliVersion: async () => "1.0.0",
      readKeychain: opts.keychain ?? (async (svc) => {
        const tok = tokens.get(svc);
        return tok ? JSON.stringify({ claudeAiOauth: { accessToken: tok, expiresAt: Date.parse("2100-01-01") } }) : null;
      }),
    },
    codex: { usageUrl: codex.url, ttlMs: 60_000, rpcFor: noDaemon },
    codexHeldOpen: async () => opts.heldOpen?.() ?? false,
  });
  t.after(() => usage.stop());

  const projects = new ProjectStore(":memory:");
  const chosen = new ChosenStore(":memory:");
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const server = createServer({ view: new VisibleIndex(index, chosen), projects, chosen, usage, guard, webDir: "/nonexistent" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => {
    server.close();
    projects.close();
    chosen.close();
  });
  const port = (server.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;
  const get = async (p: string) => {
    const res = await fetch(base + p);
    return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> };
  };
  return { usage, claude, codex, index, clock, get, base, port, dirA, codexHome };
}

test("machine API: only the requested account, in the dashboard's format", async (t) => {
  const s = await setup(t);
  s.claude.replies.set("tok-a", ok(12.0, 34.0));
  s.claude.replies.set("tok-b", ok(99, 99));
  const r = await s.get("/api/v1/claude/accounts/claude-a/usage");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store, must-revalidate");
  assert.match(r.headers.get("content-type") ?? "", /application\/json; charset=utf-8/);
  assert.deepEqual(Object.keys(r.body), ["api_version", "provider", "account_id", "captured_at", "source", "windows"]);
  assert.equal(r.body.api_version, "v1");
  assert.equal(r.body.provider, "claude");
  assert.equal(r.body.account_id, "claude-a");
  assert.equal(r.body.source, "anthropic_oauth");
  assert.match(r.body.captured_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+00:00$/);
  assert.deepEqual(r.body.windows, {
    five_hour: { used_percent: 12.0, resets_at: "2026-07-27T05:00:00+00:00" },
    seven_day: { used_percent: 34.0, resets_at: "2026-08-01T00:00:00+00:00" },
  });
  assert.equal(s.claude.hits.get("tok-b") ?? 0, 0, "the other account is not read for this request");
});

test("machine API: a plan without a five_hour window answers five_hour null", async (t) => {
  const s = await setup(t);
  s.claude.replies.set("tok-a", ok(null, 72.0));
  const r = await s.get("/api/v1/claude/accounts/claude-a/usage");
  assert.equal(r.status, 200);
  assert.equal(r.body.windows.five_hour, null);
  assert.equal(r.body.windows.seven_day.used_percent, 72.0);
});

test("machine API: missing seven_day, free, expired, unknown account", async (t) => {
  const s = await setup(t);
  s.claude.replies.set("tok-a", ok(12.0, null));
  const missing = await s.get("/api/v1/claude/accounts/claude-a/usage");
  assert.equal(missing.status, 503);
  assert.deepEqual(missing.body, {
    api_version: "v1", provider: "claude", account_id: "claude-a",
    error: { code: "usage_unavailable", reason: "window_missing", message: "Usage is unavailable for claude-a" },
  });

  s.claude.replies.set("tok-b", { status: 403, body: {} });
  const free = await s.get("/api/v1/claude/accounts/claude-b/usage");
  assert.equal(free.status, 503);
  assert.equal(free.body.error.reason, "free");

  const unknown = await s.get("/api/v1/claude/accounts/claude-unknown/usage");
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { error: { code: "account_not_found", message: "Unknown Claude account: claude-unknown" } });
});

test("machine API: an expired token is unavailable without a request; refresh=1 reads past the cache", async (t) => {
  const s1 = await setup(t, {
    keychain: async () => JSON.stringify({ claudeAiOauth: { accessToken: "old", expiresAt: 1 } }),
  });
  const r = await s1.get("/api/v1/claude/accounts/claude-a/usage");
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "usage_unavailable");
  assert.equal(r.body.error.reason, "expired");
  assert.equal(s1.claude.hits.size, 0);

  const s2 = await setup(t);
  s2.claude.replies.set("tok-a", ok(1, 2));
  await s2.get("/api/v1/claude/accounts/claude-a/usage");
  await s2.get("/api/v1/claude/accounts/claude-a/usage");
  assert.equal(s2.claude.hits.get("tok-a"), 1, "cached");
  s2.claude.replies.set("tok-a", ok(3, 4));
  const forced = await s2.get("/api/v1/claude/accounts/claude-a/usage?refresh=1");
  assert.equal(s2.claude.hits.get("tok-a"), 2);
  assert.equal(forced.body.windows.seven_day.used_percent, 4);
  const encoded = await s2.get("/api/v1/claude/accounts/claude%2Da/usage");
  assert.equal(encoded.body.account_id, "claude-a", "the id is percent-decoded");
});

test("/api/data carries the fields external readers use, with FREE and active", async (t) => {
  const s = await setup(t);
  s.claude.replies.set("tok-a", ok(null, 49));
  s.claude.replies.set("tok-b", ok(20, 8));
  s.codex.state.reply = {
    status: 200,
    body: { plan_type: "free", rate_limit: { primary_window: { used_percent: 0, window_minutes: 43200, reset_at: 1797341971 } } },
  };
  s.index.apply({ type: "upsert", session: session({ provider: "claude", account: "claude-a", id: "s1", status: "running" }) });
  s.index.apply({ type: "upsert", session: session({ provider: "claude", account: "claude-b", id: "s2", status: "waiting-input" }) });

  const r = await s.get("/api/data");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("pragma"), "no-cache");
  assert.match(r.body.ts, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.deepEqual(Object.keys(r.body), ["ts", "claude", "codex"]);
  const [a, b] = r.body.claude;
  assert.deepEqual(Object.keys(a), ["id", "label", "free", "active", "rate"]);
  assert.deepEqual([a.id, a.label, a.free, a.active], ["claude-a", "claude-a", false, true]);
  assert.equal(a.rate.five_hour, null);
  assert.equal(a.rate.seven_day.util, 49);
  // resets_at 2026-08-01T00:00:00Z, clock 2026-07-27T00:00:00Z
  assert.equal(a.rate.seven_day.reset_s, 5 * 86400);
  assert.equal(b.active, false, "a Claude session waiting for input is not counted, as busy was the dashboard's test");
  assert.equal(b.rate.five_hour.util, 20);
  const [c] = r.body.codex;
  assert.deepEqual([c.id, c.free, c.active], ["codex-a", true, false]);
  assert.deepEqual(c.rate, { windows: [{ used_percent: 0, window_minutes: 43200, reset_at: 1797341971 }] });
  assert.ok(!JSON.stringify(r.body).includes("example.test"), "/api/data leaves the emails out");

  // A session whose turn ended while its background tasks run still works on the account.
  s.index.apply({ type: "upsert", session: session({ provider: "claude", account: "claude-b", id: "s3", status: "open-idle", backgroundTasks: 1 }) });
  const again = await s.get("/api/data");
  assert.equal(again.body.claude[1].active, true);
});

test("FREE is sticky between reads and follows the dashboard's rules", async (t) => {
  const s = await setup(t);
  s.claude.replies.set("tok-a", { status: 403, body: {} });
  s.claude.replies.set("tok-b", ok(1, 1));
  s.codex.state.reply = { status: 200, body: { plan_type: "free", rate_limit: {} } };
  let snap = (await s.get("/api/usage")).body as UsageSnapshot;
  const byId = (x: UsageSnapshot) => Object.fromEntries(x.accounts.map((u) => [u.account, u]));
  assert.equal(byId(snap)["claude-a"]!.free, true, "403 marks free");
  assert.equal(byId(snap)["claude-a"]!.status, "free");
  assert.equal(byId(snap)["claude-b"]!.free, false);
  assert.equal(byId(snap)["codex-a"]!.free, true, "a live Codex plan free marks free");

  // A failed read keeps the mark; a good read clears it.
  s.clock.t += 60_000;
  s.claude.replies.set("tok-a", { status: 500, body: {} });
  snap = (await s.get("/api/usage")).body as UsageSnapshot;
  assert.equal(byId(snap)["claude-a"]!.free, true);
  assert.equal(byId(snap)["claude-a"]!.status, "error");
  s.clock.t += 60_000;
  s.claude.replies.set("tok-a", ok(null, 5));
  s.codex.state.reply = { status: 200, body: { plan_type: "plus", rate_limit: {} } };
  snap = (await s.get("/api/usage")).body as UsageSnapshot;
  assert.equal(byId(snap)["claude-a"]!.free, false, "seven_day alone clears it (Max has no five_hour)");
  assert.equal(byId(snap)["codex-a"]!.free, false);

  // A profile plan "free" marks free when the endpoint gives no window (a fresh service: no last good read).
  const s2 = await setup(t, { keychain: async () => null });
  fs.writeFileSync(path.join(s2.dirA, ".claude.json"), JSON.stringify({ oauthAccount: { organizationType: "claude_free" } }));
  snap = (await s2.get("/api/usage")).body as UsageSnapshot;
  assert.equal(byId(snap)["claude-a"]!.status, "auth_missing");
  assert.equal(byId(snap)["claude-a"]!.free, true);
  assert.equal(byId(snap)["claude-b"]!.free, false, "auth_missing alone leaves the mark as it was");
});

test("/api/usage snapshot shape", async (t) => {
  const s = await setup(t);
  s.claude.replies.set("tok-a", ok(12, 34));
  s.claude.replies.set("tok-b", { status: 429, body: {}, headers: { "retry-after": "300" } });
  s.codex.state.reply = { status: 401, body: {} };
  const snap = (await s.get("/api/usage")).body as UsageSnapshot;
  assert.deepEqual(snap.accounts.map((u) => [u.provider, u.account, u.status]), [
    ["claude", "claude-a", "ok"], ["claude", "claude-b", "rate_limited"], ["codex", "codex-a", "expired"],
  ]);
  const a = snap.accounts[0]!;
  assert.deepEqual(a.windows, [
    { id: "five_hour", minutes: 300, usedPercent: 12, resetsAt: Date.parse("2026-07-27T05:00:00Z") },
    { id: "seven_day", minutes: 10080, usedPercent: 34, resetsAt: Date.parse("2026-08-01T00:00:00Z") },
  ]);
  assert.equal(a.email, "a@example.test");
  assert.equal(a.plan, "claude_max");
  assert.equal(a.source, "anthropic_oauth");
  assert.equal(snap.accounts[2]!.windows.length, 0);
});

test("/ws sends the usage snapshot after hello and pushes changes", async (t) => {
  const s = await setup(t);
  s.claude.replies.set("tok-a", ok(1, 2));
  s.claude.replies.set("tok-b", ok(3, 4));
  s.codex.state.reply = { status: 200, body: { plan_type: "plus", rate_limit: { primary_window: { used_percent: 5, window_minutes: 300 } } } };
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
  t.after(() => ws.close());
  const messages: (ServerMessage | UsageMessage)[] = [];
  ws.on("message", (d) => messages.push(JSON.parse(String(d))));
  const waitUsage = async (n: number) => {
    const end = Date.now() + 5000;
    while (messages.filter((m) => m.type === "usage").length < n) {
      if (Date.now() > end) throw new Error(`waiting for usage message ${n}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return messages.filter((m): m is UsageMessage => m.type === "usage")[n - 1]!;
  };
  const first = await waitUsage(1);
  assert.equal(messages[0]!.type, "hello");
  assert.equal(first.snapshot.accounts.length, 3);

  // The account becomes active: a push without any new read.
  s.index.apply({ type: "upsert", session: session({ provider: "codex", account: "codex-a", id: "th", status: "open-idle" }) });
  const second = await waitUsage(2);
  assert.equal(second.snapshot.accounts.find((u) => u.account === "codex-a")!.active, true);

  // A new read with new numbers: pushed too.
  s.clock.t += 60_000;
  s.claude.replies.set("tok-a", ok(10, 20));
  await s.get("/api/usage");
  const third = await waitUsage(3);
  assert.equal(third.snapshot.accounts[0]!.windows[0]!.usedPercent, 10);
});

test("a Codex home without a daemon is active while a codex process holds one of its rollouts", async (t) => {
  let held = false;
  const s = await setup(t, { heldOpen: () => held });
  s.claude.replies.set("tok-a", ok(1, 1));
  s.claude.replies.set("tok-b", ok(1, 1));
  s.codex.state.reply = { status: 200, body: { plan_type: "plus", rate_limit: {} } };
  assert.equal((await s.get("/api/data")).body.codex[0].active, false);
  held = true;
  assert.equal((await s.get("/api/data")).body.codex[0].active, true);
  // A thread in systemError is not counted as held.
  held = false;
  s.index.apply({ type: "upsert", session: session({ provider: "codex", account: "codex-a", id: "e", status: "error" }) });
  assert.equal((await s.get("/api/data")).body.codex[0].active, false);
});

test("stop is safe to call twice at once", async (t) => {
  const s = await setup(t);
  await Promise.all([s.usage.stop(), s.usage.stop()]);
});

test("polling keeps an idle account current without any request", async (t) => {
  const s = await setup(t);
  s.claude.replies.set("tok-a", ok(1, 1));
  s.claude.replies.set("tok-b", ok(1, 1));
  s.codex.state.reply = { status: 200, body: { plan_type: "plus", rate_limit: {} } };
  await s.usage.start();
  const end = Date.now() + 5000;
  while ((s.claude.hits.get("tok-a") ?? 0) < 1 || (s.claude.hits.get("tok-b") ?? 0) < 1 || s.codex.state.hits < 1) {
    if (Date.now() > end) throw new Error("the first poll did not run");
    await new Promise((r) => setTimeout(r, 5));
  }
  const stats = s.usage.stats();
  assert.deepEqual(stats.claudeFetches, { "claude-a": 1, "claude-b": 1 });
});

test("/api/usage/history: every read that changed a window is kept, the last 7 days answer", async (t) => {
  const s = await setup(t);
  s.claude.replies.set("tok-a", ok(10, 40));
  s.claude.replies.set("tok-b", { status: 403, body: {} });
  s.codex.state.reply = {
    status: 200,
    body: { plan_type: "plus", rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 18000, reset_at: 1785142800 } } },
  };
  await s.get("/api/usage");
  s.clock.t += 61_000;
  s.claude.replies.set("tok-a", ok(10, 41));
  await s.get("/api/usage");
  const r = await s.get("/api/usage/history");
  assert.equal(r.status, 200);
  assert.equal(r.body.to - r.body.from, 7 * 24 * 3600 * 1000);
  const series = (r.body.series as { account: string; window: string; points: { usedPercent: number }[] }[])
    .map((x) => `${x.account}/${x.window}: ${x.points.map((p) => p.usedPercent).join(" ")}`)
    .sort();
  assert.deepEqual(series, ["claude-a/five_hour: 10", "claude-a/seven_day: 40 41", "codex-a/primary: 7"]);
  assert.equal(s.usage.stats().history.rows, 4);
});

test("claudeUsage off: Claude rows say off, no login is read, the machine API reports unavailable; Codex goes on", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usv-off-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, ".claude-a");
  const codexHome = path.join(root, ".codex-a");
  for (const d of [dir, codexHome]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@example.test", organizationType: "claude_max" } }));
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "cx", account_id: "acct" } }));
  const claude = await fakeClaude(t);
  const codex = await fakeCodex(t);
  let keychainReads = 0;
  const usage = new UsageService({
    claudeAccounts: [{ id: "claude-a", dir }],
    codexAccounts: [{ id: "codex-a", home: codexHome }],
    stateFile: ":memory:",
    claude: { enabled: false, url: claude.url, cliVersion: async () => "1.0.0", readKeychain: async () => (keychainReads++, null) },
    codex: { usageUrl: codex.url, ttlMs: 60_000, rpcFor: noDaemon },
    codexHeldOpen: async () => false,
  });
  t.after(() => usage.stop());
  const snap = await usage.snapshot();
  const row = snap.accounts.find((a) => a.account === "claude-a")!;
  assert.equal(row.status, "off");
  assert.deepEqual(row.windows, []);
  assert.equal(row.email, "a@example.test", "the profile in .claude.json is not a login");
  assert.equal(keychainReads, 0);
  assert.equal(claude.hits.size, 0);
  const m = await usage.claudeMachine("claude-a", true);
  assert.equal(m.status, 503);
  assert.equal((m.body as any).error.reason, "off");
  assert.equal(keychainReads, 0);
});

test("codexUsage off: Codex rows say off, auth.json is not opened, no daemon is contacted and no request is sent", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usv-codex-off-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, ".codex-a");
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "cx", account_id: "acct" } }));
  const codex = await fakeCodex(t);
  let rpcStarts = 0;
  const rpcFor = (home: string) => {
    const rpc = noDaemon(home);
    (rpc as unknown as { start: () => Promise<boolean> }).start = async () => (rpcStarts++, false);
    return rpc;
  };
  const usage = new UsageService({
    claudeAccounts: [],
    codexAccounts: [{ id: "codex-a", home: codexHome }],
    stateFile: ":memory:",
    codex: { enabled: false, usageUrl: codex.url, ttlMs: 60_000, rpcFor },
    codexHeldOpen: async () => false,
  });
  t.after(() => usage.stop());
  await usage.start();
  const row = (await usage.snapshot()).accounts.find((a) => a.account === "codex-a")!;
  assert.equal(row.status, "off");
  assert.deepEqual(row.windows, []);
  assert.equal(row.email, null, "no profile is read from auth.json while usage is off");
  assert.equal(codex.state.hits, 0);
  assert.equal(rpcStarts, 0);
  assert.deepEqual((await usage.dashboard()).codex[0]!.rate, null);
});
