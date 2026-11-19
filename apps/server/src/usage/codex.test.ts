import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { FakeDaemon, waitFor } from "../codex/fake-daemon.ts";
import type { CodexRpc } from "../codex/rpc.ts";
import { CodexUsage, lastTokenCount, readCodexAuth, readRolloutSnapshot, readUsageEndpoint } from "./codex.ts";

async function fakeUsageApi(t: { after(fn: () => unknown): void }) {
  const requests: http.IncomingHttpHeaders[] = [];
  let reply: (res: http.ServerResponse) => void = (res) => res.writeHead(500).end();
  const server = http.createServer((req, res) => {
    requests.push(req.headers);
    reply(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => new Promise((r) => server.close(r)));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/backend-api/wham/usage`,
    requests,
    set(fn: (res: http.ServerResponse) => void) {
      reply = fn;
    },
  };
}

const json = (status: number, body: unknown) => (res: http.ServerResponse) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

function tmpHome(t: { after(fn: () => unknown): void }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cxu-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeAuth(home: string, plan = "plus"): void {
  const payload = Buffer.from(JSON.stringify({ email: "x@example.test", "https://api.openai.com/auth": { chatgpt_plan_type: plan } })).toString("base64url");
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({
    tokens: { access_token: "acc-tok", account_id: "acct-1", id_token: `h.${payload}.s` },
  }));
}

function tokenCount(primary: number | null, secondary: number | null, plan = "plus"): string {
  const w = (p: number | null, minutes: number) => (p === null ? null : { used_percent: p, window_minutes: minutes, resets_at: 1_800_000_000 });
  return JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: null, rate_limits: { primary: w(primary, 300), secondary: w(secondary, 10080), plan_type: plan } },
  });
}

function writeRollout(home: string, name: string, lines: string[], mtimeMs?: number): string {
  const dir = path.join(home, "sessions", "2026", "11", "15");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

const RATE_READ = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: "codex", limitName: null, normalModelSlug: null,
    primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1794767415 },
    secondary: { usedPercent: 11, windowDurationMins: 10080, resetsAt: 1795317933 },
    credits: null, individualLimit: null, spendControlReached: false, planType: "plus", rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null,
};

test("a home with a daemon reads account/rateLimits/read and merges its updates", async (t) => {
  const daemon = FakeDaemon.create();
  t.after(() => daemon.cleanup());
  daemon.handlers.set("account/rateLimits/read", () => RATE_READ);
  await daemon.listen();
  const api = await fakeUsageApi(t);
  const updates: string[] = [];
  const u = new CodexUsage([{ id: "codex-a", home: daemon.home }], { usageUrl: api.url, onUpdate: (id) => updates.push(id) });
  t.after(() => u.stop());
  await u.start();

  const r = await u.get("codex-a");
  assert.equal(r.kind, "live");
  assert.ok(r.kind === "live");
  assert.equal(r.source, "codex_daemon");
  assert.equal(r.plan, "plus");
  assert.deepEqual(r.windows, [
    { id: "primary", usedPercent: 0, minutes: 300, resetAt: 1794767415 },
    { id: "secondary", usedPercent: 11, minutes: 10080, resetAt: 1795317933 },
  ]);
  assert.deepEqual(daemon.calls("account/rateLimits/read").map((c) => c.params), [{ excludeResetCreditDetails: true }]);
  assert.equal(api.requests.length, 0, "the usage endpoint is left alone while the daemon answers");

  // A sparse update: primary changes, secondary and plan stay.
  daemon.notify("account/rateLimits/updated", {
    rateLimits: { ...RATE_READ.rateLimits, primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1794767999 }, secondary: null, planType: null },
  });
  await waitFor(() => updates.length === 1, "the merged update");
  const merged = u.peek("codex-a")!.rate;
  assert.ok(merged.kind === "live");
  assert.deepEqual(merged.windows.map((w) => [w.id, w.usedPercent]), [["primary", 42], ["secondary", 11]]);
  assert.equal(merged.plan, "plus");

  // An update for another limit is not mixed in.
  daemon.notify("account/rateLimits/updated", { rateLimits: { ...RATE_READ.rateLimits, limitId: "other", primary: { usedPercent: 99, windowDurationMins: 1, resetsAt: 1 } } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(updates.length, 1);
});

test("a daemon error falls back to the usage endpoint", async (t) => {
  const daemon = FakeDaemon.create();
  t.after(() => daemon.cleanup());
  await daemon.listen(); // answers account/rateLimits/read with "unknown method"
  writeAuth(daemon.home);
  const api = await fakeUsageApi(t);
  api.set(json(200, {
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 3, limit_window_seconds: 18000, reset_at: 1794767415 },
      secondary_window: { used_percent: 12, window_minutes: 10080, reset_at: 1795317933 },
    },
  }));
  const u = new CodexUsage([{ id: "codex-a", home: daemon.home }], { usageUrl: api.url });
  t.after(() => u.stop());
  await u.start();
  const r = await u.get("codex-a");
  assert.ok(r.kind === "live");
  assert.equal(r.source, "codex_usage_api");
  assert.deepEqual(r.windows.map((w) => [w.id, w.usedPercent, w.minutes]), [["primary", 3, 300], ["secondary", 12, 10080]]);
  assert.match(u.lastDaemonError("codex-a") ?? "", /unknown method/);
  const h = api.requests[0]!;
  assert.equal(h.authorization, "Bearer acc-tok");
  assert.equal(h["chatgpt-account-id"], "acct-1");
  assert.equal(h["user-agent"], "codex_cli_rs/0.137.0");
});

test("without a daemon: 401/403 is expired, other failures fall back to the newest rollout snapshot", async (t) => {
  const home = tmpHome(t);
  writeAuth(home);
  const api = await fakeUsageApi(t);
  const now = Date.now();

  api.set(json(401, {}));
  assert.deepEqual(await readUsageEndpoint(home, api.url, now), { kind: "expired" });
  api.set(json(403, {}));
  assert.deepEqual(await readUsageEndpoint(home, api.url, now), { kind: "expired" });
  api.set(json(429, {}));
  assert.equal(await readUsageEndpoint(home, api.url, now), null);

  writeRollout(home, "rollout-old.jsonl", [tokenCount(70, 80)], now - 10 * 3600_000);
  writeRollout(home, "rollout-new.jsonl", [tokenCount(5, 6), '{"type":"event_msg","payload":{"type":"agent_message"}}'], now - 3600_000);
  const u = new CodexUsage([{ id: "codex-a", home }], { usageUrl: api.url, rpcFor: () => noDaemon(home) });
  const r = await u.get("codex-a");
  assert.ok(r.kind === "rollout");
  assert.equal(r.stale, false);
  assert.deepEqual(r.windows.map((w) => w.usedPercent), [5, 6]);
  assert.equal(r.plan, "plus");
});

test("a rollout snapshot written 6h ago or earlier is stale; a newer rollout without rate limits is skipped", async (t) => {
  const home = tmpHome(t);
  const now = Date.now();
  writeRollout(home, "a.jsonl", [tokenCount(20, null, "free")], now - 7 * 3600_000);
  // Its last token_count carries no windows, so the older one is used (the dashboard's rule).
  writeRollout(home, "b.jsonl", [tokenCount(1, 1), tokenCount(null, null)], now - 60_000);
  fs.writeFileSync(path.join(home, "sessions", "2026", "11", "15", ".hidden.jsonl"), tokenCount(99, 99));
  const r = readRolloutSnapshot(home, now);
  assert.ok(r.kind === "rollout");
  assert.equal(r.stale, true);
  assert.deepEqual(r.windows, [{ id: "primary", usedPercent: 20, minutes: 300, resetAt: 1_800_000_000 }]);
  assert.equal(r.plan, "free");
  assert.deepEqual(readRolloutSnapshot(tmpHome(t), now), { kind: "none" });
});

test("lastTokenCount reading backwards finds the same line as a forward scan", (t) => {
  const home = tmpHome(t);
  const filler = (n: number) => JSON.stringify({ type: "response_item", payload: { text: "x".repeat(n) } });
  const lines = [
    tokenCount(1, 1),
    filler(70_000), // longer than one read chunk
    tokenCount(2, 2),
    '{"type":"event_msg","payload":{"type":"token_count"', // broken JSON mentioning token_count
    filler(65_530),
    JSON.stringify({ type: "response_item", payload: { note: '"token_count"' } }), // mentions it, not the event
    filler(10),
  ];
  const file = writeRollout(home, "big.jsonl", lines);
  const forward = (() => {
    let last: unknown = null;
    for (const l of fs.readFileSync(file, "utf8").split("\n")) {
      if (!l.includes('"token_count"')) continue;
      try {
        const d = JSON.parse(l);
        if (d.type === "event_msg" && d.payload?.type === "token_count") last = d.payload;
      } catch {
        // skip
      }
    }
    return last;
  })();
  assert.deepEqual(lastTokenCount(file), forward);
  assert.deepEqual((lastTokenCount(file) as { rate_limits: { primary: { used_percent: number } } }).rate_limits.primary.used_percent, 2);

  const noNewline = path.join(home, "sessions", "2026", "11", "15", "tail.jsonl");
  fs.writeFileSync(noNewline, `${filler(5)}\n${tokenCount(7, 7)}`);
  assert.equal((lastTokenCount(noNewline) as { rate_limits: { primary: { used_percent: number } } }).rate_limits.primary.used_percent, 7);
  assert.equal(lastTokenCount(path.join(home, "missing.jsonl")), null);
});

test("a live read without a plan takes the rollout's plan; a body that is no object falls back", async (t) => {
  const home = tmpHome(t);
  writeAuth(home);
  const api = await fakeUsageApi(t);
  const now = Date.now();
  writeRollout(home, "r.jsonl", [tokenCount(9, 9, "free")], now - 60_000);
  api.set(json(200, { rate_limit: { primary_window: { used_percent: 1, window_minutes: 43200, reset_at: 1 } } }));
  const u = new CodexUsage([{ id: "codex-a", home }], { usageUrl: api.url, rpcFor: () => noDaemon(home) });
  const r = await u.get("codex-a");
  assert.ok(r.kind === "live");
  assert.equal(r.plan, "free", "the live plan, else the rollout plan");
  assert.deepEqual(r.windows.map((w) => w.usedPercent), [1], "the windows stay the live ones");

  api.set(json(200, ["not", "an", "object"]));
  assert.equal(await readUsageEndpoint(home, api.url, now), null);
});

test("a daemon update for another limit, or without a matching base, is left out", async (t) => {
  const daemon = FakeDaemon.create();
  t.after(() => daemon.cleanup());
  daemon.handlers.set("account/rateLimits/read", () => ({ ...RATE_READ, rateLimits: { ...RATE_READ.rateLimits, limitId: null } }));
  await daemon.listen();
  const updates: string[] = [];
  const u = new CodexUsage([{ id: "codex-a", home: daemon.home }], { onUpdate: (id) => updates.push(id) });
  t.after(() => u.stop());
  await u.start();
  await u.get("codex-a");
  daemon.notify("account/rateLimits/updated", { rateLimits: { ...RATE_READ.rateLimits, limitId: "other", primary: { usedPercent: 99, windowDurationMins: 1, resetsAt: 1 } } });
  daemon.notify("account/rateLimits/updated", { rateLimits: { ...RATE_READ.rateLimits, limitId: null, primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 2 } } });
  await waitFor(() => updates.length === 1, "the update without a limit id");
  const r = u.peek("codex-a")!.rate;
  assert.ok(r.kind === "live");
  assert.equal(r.windows[0]!.usedPercent, 7);
});

test("lastTokenCount reads a line many chunks long", (t) => {
  const home = tmpHome(t);
  const big = JSON.stringify({ type: "response_item", payload: { text: "y".repeat(400_000) } });
  const file = writeRollout(home, "long.jsonl", [tokenCount(3, 3), big]);
  assert.equal((lastTokenCount(file) as { rate_limits: { primary: { used_percent: number } } }).rate_limits.primary.used_percent, 3);
  const bigTc = JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", pad: "z".repeat(300_000), rate_limits: { primary: { used_percent: 4, window_minutes: 300 } } },
  });
  const file2 = writeRollout(home, "long2.jsonl", [tokenCount(3, 3), bigTc, big]);
  assert.equal((lastTokenCount(file2) as { rate_limits: { primary: { used_percent: number } } }).rate_limits.primary.used_percent, 4);
});

test("no auth.json and no rollout: nothing to show", async (t) => {
  const home = tmpHome(t);
  const api = await fakeUsageApi(t);
  const u = new CodexUsage([{ id: "codex-a", home }], { usageUrl: api.url, rpcFor: () => noDaemon(home) });
  assert.deepEqual(await u.get("codex-a"), { kind: "none" });
  assert.equal(api.requests.length, 0);
});

test("readCodexAuth reads email and plan from the id token", async (t) => {
  const home = tmpHome(t);
  assert.deepEqual(await readCodexAuth(home), { email: null, plan: null });
  writeAuth(home, "free");
  assert.deepEqual(await readCodexAuth(home), { email: "x@example.test", plan: "free" });
});

test("the cache holds a read for the TTL", async (t) => {
  const home = tmpHome(t);
  writeAuth(home);
  const api = await fakeUsageApi(t);
  api.set(json(200, { plan_type: "plus", rate_limit: { primary_window: { used_percent: 1, window_minutes: 300, reset_at: 1 } } }));
  let now = 1_000_000;
  const u = new CodexUsage([{ id: "codex-a", home }], { usageUrl: api.url, ttlMs: 60_000, now: () => now, rpcFor: () => noDaemon(home) });
  await u.get("codex-a");
  now += 59_999;
  await u.get("codex-a");
  assert.equal(api.requests.length, 1);
  now += 1;
  await u.get("codex-a");
  assert.equal(api.requests.length, 2);
  await u.get("codex-a", true);
  assert.equal(api.requests.length, 3);
});

/** A daemon client for a home that has no daemon: it never connects. */
function noDaemon(home: string): CodexRpc {
  const rpc = { home, connected: false, on: () => () => {}, start: async () => false, close: async () => {} };
  return rpc as unknown as CodexRpc;
}
