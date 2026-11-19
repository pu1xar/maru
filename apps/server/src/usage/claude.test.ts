import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loginMarkerPath } from "./loginMarker.ts";
import { ClaudeUsage, keychainAccount, keychainService, readClaudeProfile, readClaudeToken, retryAfterMs } from "./claude.ts";

/** A stand-in for the OAuth usage endpoint. `reply` decides each answer; `requests` records them. */
async function fakeEndpoint(t: { after(fn: () => unknown): void }) {
  const requests: http.IncomingHttpHeaders[] = [];
  let reply: (res: http.ServerResponse) => void = (res) => res.writeHead(500).end();
  const server = http.createServer((req, res) => {
    requests.push(req.headers);
    reply(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => new Promise((r) => server.close(r)));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/oauth/usage`,
    requests,
    set(fn: (res: http.ServerResponse) => void) {
      reply = fn;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => (res: http.ServerResponse) =>
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

const FAR = Date.parse("2100-01-01T00:00:00Z");
const keychainWith = (expiresAt = FAR) => async () => JSON.stringify({ claudeAiOauth: { accessToken: "tok-1", expiresAt } });

function clock(start = Date.parse("2026-11-15T00:00:00Z")) {
  const c = { t: start, now: () => c.t };
  return c;
}

const MAX_BODY = { five_hour: null, seven_day: { utilization: 49.0, resets_at: "2026-11-19T10:00:00.101341+00:00" } };

test("keychain service name matches the dashboard's sha256(abspath)[:8]", () => {
  // Values computed independently with the same formula.
  assert.equal(keychainService("/tmp/claude-test"), "Claude Code-credentials-9adeedd0");
  assert.equal(keychainService("/Users/someone/.claude-work/"), "Claude Code-credentials-18cc900a");
});

test("a read is cached for the TTL, then read again; the request carries the OAuth headers", async (t) => {
  const ep = await fakeEndpoint(t);
  ep.set(json(200, MAX_BODY));
  const c = clock();
  const u = new ClaudeUsage({ url: ep.url, ttlMs: 60_000, readKeychain: keychainWith(), cliVersion: async () => "2.1.325", now: c.now });

  const r1 = await u.get("/acct");
  assert.equal(r1.kind, "ok");
  assert.ok(r1.kind === "ok");
  assert.equal(r1.fiveHour, null, "Max plans send five_hour null");
  assert.deepEqual(r1.sevenDay, { util: 49, resetsAt: "2026-11-19T10:00:00.101341+00:00" });
  assert.equal(ep.requests.length, 1);
  const h = ep.requests[0]!;
  assert.equal(h.authorization, "Bearer tok-1");
  assert.equal(h["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(h["user-agent"], "claude-code/2.1.325");

  c.t += 59_000;
  await u.get("/acct");
  assert.equal(ep.requests.length, 1, "fresh for the TTL");
  c.t += 1_000;
  await u.get("/acct");
  assert.equal(ep.requests.length, 2, "read again once the TTL passed");
  assert.equal(u.dueAt("/acct"), c.t + 60_000);
});

test("concurrent requests share one read", async (t) => {
  const ep = await fakeEndpoint(t);
  ep.set((res) => setTimeout(() => json(200, MAX_BODY)(res), 30));
  const u = new ClaudeUsage({ url: ep.url, readKeychain: keychainWith(), cliVersion: async () => "1.0.0" });
  const all = await Promise.all([u.get("/a"), u.get("/a"), u.get("/a", true)]);
  assert.equal(ep.requests.length, 1);
  assert.ok(all.every((r) => r.kind === "ok"));
});

test("403 is free whatever the body says, and drops the last good read", async (t) => {
  const ep = await fakeEndpoint(t);
  const u = new ClaudeUsage({ url: ep.url, readKeychain: keychainWith(), cliVersion: async () => "1.0.0" });
  ep.set(json(200, MAX_BODY));
  await u.get("/a");
  ep.set(json(403, { error: { message: "anything" } }));
  assert.deepEqual(await u.get("/a", true), { kind: "free" });
  // A blip after the 403 shows the error, not the numbers of the ended subscription.
  ep.set(json(500, {}));
  assert.deepEqual(await u.get("/a", true), { kind: "error", error: "HTTP 500" });
});

test("a network error names its cause", async (t) => {
  const ep = await fakeEndpoint(t);
  const url = ep.url;
  await ep.close();
  const u = new ClaudeUsage({ url, readKeychain: keychainWith(), cliVersion: async () => "1.0.0" });
  const r = await u.get("/a");
  assert.ok(r.kind === "error");
  assert.match(r.error, /^fetch failed: .+/);
});

test("429 keeps the last good read and holds off until retry-after has passed", async (t) => {
  const ep = await fakeEndpoint(t);
  const c = clock();
  const u = new ClaudeUsage({ url: ep.url, ttlMs: 60_000, readKeychain: keychainWith(), cliVersion: async () => "1.0.0", now: c.now });
  ep.set(json(200, MAX_BODY));
  const good = await u.get("/a");
  c.t += 60_000;
  ep.set(json(429, { error: "rate" }, { "retry-after": "300" }));
  assert.deepEqual(await u.get("/a"), good, "the last good read stands in");
  assert.equal(ep.requests.length, 2);

  c.t += 60_000;
  await u.get("/a");
  await u.get("/a", true);
  assert.equal(ep.requests.length, 2, "no read inside retry-after, forced or not");
  assert.equal(u.dueAt("/a"), Date.parse("2026-11-15T00:00:00Z") + 60_000 + 300_000);

  c.t += 240_000;
  ep.set(json(200, { ...MAX_BODY, seven_day: { utilization: 50, resets_at: null } }));
  const after = await u.get("/a");
  assert.equal(ep.requests.length, 3);
  assert.ok(after.kind === "ok" && after.sevenDay?.util === 50);
});

test("429 right after a restart shows the reading kept on disk, asked once; a 403 does not bring it back", async (t) => {
  const ep = await fakeEndpoint(t);
  const kept = { kind: "ok" as const, fiveHour: null, sevenDay: { util: 21, resetsAt: "2026-11-20T00:00:00+00:00" }, capturedAt: "2026-11-14T23:00:00+00:00" };
  let asked = 0;
  const u = new ClaudeUsage({ url: ep.url, readKeychain: keychainWith(), cliVersion: async () => "1.0.0", seed: () => (asked++, kept) });
  ep.set(json(429, {}));
  assert.deepEqual(await u.get("/a"), kept, "the kept reading stands in for the 429");
  ep.set(json(403, {}));
  assert.deepEqual(await u.get("/a", true), { kind: "free" });
  ep.set(json(500, {}));
  const after = await u.get("/a", true);
  assert.equal(after.kind, "error", "after a 403 the old numbers stay away");
  assert.equal(asked, 1);
});

test("429 before any good read is rate_limited", async (t) => {
  const ep = await fakeEndpoint(t);
  ep.set(json(429, {}));
  const u = new ClaudeUsage({ url: ep.url, readKeychain: keychainWith(), cliVersion: async () => "1.0.0" });
  assert.deepEqual(await u.get("/a"), { kind: "rate_limited" });
});

test("other HTTP errors keep the last good read, or report the status", async (t) => {
  const ep = await fakeEndpoint(t);
  const c = clock();
  const u = new ClaudeUsage({ url: ep.url, ttlMs: 60_000, readKeychain: keychainWith(), cliVersion: async () => "1.0.0", now: c.now });
  ep.set(json(502, {}));
  assert.deepEqual(await u.get("/a"), { kind: "error", error: "HTTP 502" });
  ep.set(json(200, MAX_BODY));
  const good = await u.get("/a", true);
  ep.set(json(500, {}));
  assert.deepEqual(await u.get("/a", true), good);
});

test("a network error without a good read is kept for 10 s only", async (t) => {
  const ep = await fakeEndpoint(t);
  const url = ep.url;
  await ep.close();
  const c = clock();
  const u = new ClaudeUsage({ url, ttlMs: 60_000, readKeychain: keychainWith(), cliVersion: async () => "1.0.0", now: c.now });
  const r = await u.get("/a");
  assert.equal(r.kind, "error");
  assert.ok(r.kind === "error" && r.error.length <= 80);
  assert.equal(u.peek("/a")!.freshUntil, c.t + 10_000);
  assert.equal(u.dueAt("/a"), c.t + 10_000);
});

test("token states: none is auth_missing (asked again each time), past expiresAt is expired; no request either way", async (t) => {
  const ep = await fakeEndpoint(t);
  let keychainReads = 0;
  const none = new ClaudeUsage({
    url: ep.url, readKeychain: async () => (keychainReads++, null), cliVersion: async () => "1.0.0",
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await none.get(dir), { kind: "auth_missing" });
  assert.deepEqual(await none.get(dir), { kind: "auth_missing" });
  assert.equal(keychainReads, 2);

  const expired = new ClaudeUsage({ url: ep.url, readKeychain: keychainWith(1), cliVersion: async () => "1.0.0" });
  assert.deepEqual(await expired.get(dir), { kind: "expired" });
  assert.equal(ep.requests.length, 0);
});

test("readClaudeToken prefers a valid token, keychain first, then .credentials.json", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = 1_000;
  fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "file", expiresAt: 5_000 } }));
  const kc = (token: string, expiresAt: number) => async () => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } });
  assert.deepEqual(await readClaudeToken(dir, kc("kc", 9_000), now), { token: "kc", expired: false });
  assert.deepEqual(await readClaudeToken(dir, kc("kc", 500), now), { token: "file", expired: false });
  assert.deepEqual(await readClaudeToken(dir, async () => null, now), { token: "file", expired: false });
  fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "file", expiresAt: 10 } }));
  assert.deepEqual(await readClaudeToken(dir, kc("kc", 500), now), { token: "kc", expired: true }, "the first candidate, expired");
  fs.rmSync(path.join(dir, ".credentials.json"));
  assert.equal(await readClaudeToken(dir, async () => "not json", now), null);
  // The keychain value may be the bare oauth object; the credentials file only counts claudeAiOauth.
  assert.deepEqual(await readClaudeToken(dir, async () => JSON.stringify({ accessToken: "bare", expiresAt: 9_000 }), now), { token: "bare", expired: false });
  fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ accessToken: "top", expiresAt: 9_000 }));
  assert.equal(await readClaudeToken(dir, async () => null, now), null);
});

test("readClaudeProfile reads email and organizationType from .claude.json", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await readClaudeProfile(dir), { email: null, plan: null });
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@example.test", organizationType: "claude_max" } }));
  assert.deepEqual(await readClaudeProfile(dir), { email: "a@example.test", plan: "claude_max" });
});

test("retryAfterMs reads delta seconds and HTTP dates", () => {
  assert.equal(retryAfterMs("300", 0), 300_000);
  assert.equal(retryAfterMs(null, 0), null);
  assert.equal(retryAfterMs("soon", 0), null);
  const now = Date.parse("2026-11-15T00:00:00Z");
  assert.equal(retryAfterMs("Sun, 15 Nov 2026 00:01:00 GMT", now), 60_000);
});

test("keychainAccount is the account Claude Code reads its credentials under", () => {
  assert.equal(keychainAccount({ USER: "someone" }), "someone");
  // No USER: the login name, as the CLI does.
  assert.equal(keychainAccount({}), os.userInfo().username);
  // A name the CLI rejects falls back to its fixed account.
  assert.equal(keychainAccount({ USER: "has space" }), "claude-code-user");
});

test("enabled false: off before any keychain, credentials file or request is touched", async (t) => {
  const ep = await fakeEndpoint(t);
  let keychainReads = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A credentials file that would give a valid token, if anything read it.
  fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok-file", expiresAt: FAR } }));
  const off = new ClaudeUsage({
    enabled: false, url: ep.url, readKeychain: async () => (keychainReads++, null), cliVersion: async () => "1.0.0",
    seed: () => assert.fail("no last good read is kept for an account that is off"),
  });
  assert.deepEqual(await off.get(dir), { kind: "off" });
  assert.deepEqual(await off.get(dir, true), { kind: "off" });
  assert.equal(keychainReads, 0);
  assert.equal(ep.requests.length, 0);
  assert.equal(off.fetches.size, 0);
  assert.equal(off.peek(dir)?.rate.kind, "off");
});

test("loginRequired decides the Login required mark of an expired token; without it the mark never shows", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const expiredLogin = JSON.stringify({ claudeAiOauth: { accessToken: "tok-1", refreshToken: "ref-dead", expiresAt: 1 } });
  const plain = new ClaudeUsage({ readKeychain: async () => expiredLogin, cliVersion: async () => "1.0.0", loginRequired: () => false });
  assert.deepEqual(await plain.get(dir), { kind: "expired" });
  const seen: string[] = [];
  const marked = new ClaudeUsage({
    readKeychain: async () => expiredLogin,
    cliVersion: async () => "1.0.0",
    loginRequired: (d) => (seen.push(d), true),
  });
  assert.deepEqual(await marked.get(dir), { kind: "expired", loginRequired: true });
  assert.deepEqual(seen, [dir]);
});

test("by default a login marker file of the account marks an expired token as Login required", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cu-marker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const markers = path.join(root, "markers");
  fs.mkdirSync(markers);
  const prev = process.env.MARU_LOGIN_MARKER_DIR;
  process.env.MARU_LOGIN_MARKER_DIR = markers;
  t.after(() => {
    if (prev === undefined) delete process.env.MARU_LOGIN_MARKER_DIR;
    else process.env.MARU_LOGIN_MARKER_DIR = prev;
  });
  const dir = path.join(root, ".claude-x");
  const expiredLogin = JSON.stringify({ claudeAiOauth: { accessToken: "tok-1", refreshToken: "ref", expiresAt: 1 } });
  const usage = () => new ClaudeUsage({ readKeychain: async () => expiredLogin, cliVersion: async () => "1.0.0" });
  assert.deepEqual(await usage().get(dir), { kind: "expired" });
  fs.writeFileSync(loginMarkerPath(dir, markers), "{}\n");
  assert.deepEqual(await usage().get(dir), { kind: "expired", loginRequired: true });
});
