// An isolated maru instance for the README screenshots: scratch HOME (so ~/.config/maru, the
// accounts and the repositories all live in a temp folder), stand-in CLIs, a stand-in Codex
// app-server daemon and a stand-in Claude usage endpoint. Nothing here reads or writes the real
// home folder, the real accounts or a live maru.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { REPO, start, waitFor, httpGetJson } from "../perf/lib.mjs";

const require = createRequire(path.join(REPO, "apps/server/package.json"));
const { WebSocketServer } = require("ws");

/** Stand-in `claude` and `codex` executables: only the read-only commands maru asks of them. */
export function writeFakeBins(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const claude = `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "2.1.0 (Claude Code)" ;;
  "auth status") echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}' ;;
  *) echo "stand-in claude: $*" >&2; exit 1 ;;
esac
`;
  const codex = `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "codex-cli 0.169.0" ;;
  "login status") echo "Logged in using ChatGPT" ;;
  *) echo "stand-in codex: $*" >&2; exit 1 ;;
esac
`;
  fs.writeFileSync(path.join(binDir, "claude"), claude, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "codex"), codex, { mode: 0o755 });
}

/** Stored logins the usage readers look for. The tokens are dummies; only the stand-ins see them. */
export function writeFakeLogins({ claudeDirs, codexHome }) {
  const expiresAt = Date.now() + 7 * 24 * 3600 * 1000;
  for (const dir of claudeDirs) {
    fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: `stand-in-${path.basename(dir)}`, refreshToken: "stand-in", expiresAt, scopes: ["user:inference"], subscriptionType: "max" },
    }));
  }
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const idToken = `${b64({ alg: "none" })}.${b64({ email: "dev@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } })}.x`;
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "stand-in", account_id: "acct-example", id_token: idToken } }));
}

/** The Claude usage endpoint: `byToken` maps a stand-in token to [5-hour %, 7-day %]. */
export async function startUsageStandIn(port, byToken) {
  const server = http.createServer((req, res) => {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const util = byToken[token] ?? [0, 0];
    const reset = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ five_hour: { utilization: util[0], resets_at: reset(2.4) }, seven_day: { utilization: util[1], resets_at: reset(70) } }));
  });
  await new Promise((r, j) => { server.once("error", j); server.listen(port, "127.0.0.1", r); });
  return server;
}

/**
 * A Codex app-server daemon stand-in on `<home>/app-server-control/app-server-control.sock`
 * (a symlink to a socket in a short folder; macOS limits socket paths to 103 bytes). It answers
 * the read calls maru makes: initialize, thread/list, thread/read, thread/turns/list,
 * thread/goal/get, thread/loaded/list and account/rateLimits/read.
 */
export async function startCodexDaemon({ home, threads, rate }) {
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcx"));
  const real = path.join(sockDir, "d.sock");
  const link = path.join(home, "app-server-control", "app-server-control.sock");
  const unknown = new Map();
  const calls = new Map();
  const byId = new Map(threads.map((t) => [t.thread.id, t]));
  const answer = (method, p) => {
    calls.set(method, (calls.get(method) ?? 0) + 1);
    switch (method) {
      case "initialize":
        return { userAgent: "codex-stand-in/0", codexHome: home, platformFamily: "unix", platformOs: "macos" };
      case "thread/list":
        return { data: threads.map((t) => t.thread), nextCursor: null, backwardsCursor: null };
      case "thread/loaded/list":
        return { data: [], nextCursor: null };
      case "thread/read": {
        const t = byId.get(String(p.threadId));
        if (!t) throw Object.assign(new Error(`thread not loaded: ${p.threadId}`), { code: -32600 });
        return { thread: { ...t.thread, turns: p.includeTurns ? t.turns : [] } };
      }
      case "thread/turns/list": {
        const t = byId.get(String(p.threadId));
        if (!t) throw Object.assign(new Error(`thread not loaded: ${p.threadId}`), { code: -32600 });
        const data = p.sortDirection === "asc" ? [...t.turns] : [...t.turns].reverse();
        return { data, nextCursor: null, backwardsCursor: null };
      }
      case "thread/goal/get":
        return { goal: null };
      case "thread/unsubscribe":
        return {};
      case "account/rateLimits/read":
        return rate;
      default:
        unknown.set(method, (unknown.get(method) ?? 0) + 1);
        throw Object.assign(new Error(`unknown method ${method}`), { code: -32601 });
    }
  };
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.id === undefined || typeof msg.method !== "string") return;
      let reply;
      try {
        reply = { id: msg.id, result: answer(msg.method, msg.params ?? {}) };
      } catch (err) {
        reply = { id: msg.id, error: { code: err.code ?? -32603, message: err.message } };
      }
      ws.send(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(real, r));
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(real, link);
  return {
    unknown,
    calls,
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => wss.close(() => r()));
      await new Promise((r) => server.close(() => r()));
      fs.rmSync(sockDir, { recursive: true, force: true });
    },
  };
}

/** Environment for the server and the session host: scratch HOME, stand-in CLIs first on PATH. */
export function instanceEnv({ root, home, port, usagePort }) {
  const nodeDir = path.dirname(process.execPath);
  return {
    PATH: [path.join(root, "bin"), nodeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    HOME: home,
    USER: "dev",
    LANG: "en_US.UTF-8",
    SHELL: "/bin/zsh",
    TMPDIR: root,
    PORT: String(port),
    MARU_CLAUDE_USAGE_URL: `http://127.0.0.1:${usagePort}/api/oauth/usage`,
    MARU_CODEX_USAGE_URL: `http://127.0.0.1:${usagePort}/backend-api/wham/usage`,
  };
}

/** Start the session host, then the server (which serves apps/web/dist), and wait for health. */
export async function startMaru(env) {
  const host = start("node", [path.join(REPO, "apps/server/src/host/main.ts")], { cwd: REPO, env });
  const server = start("node", [path.join(REPO, "apps/server/src/main.ts")], { cwd: REPO, env });
  let log = "";
  const file = path.join(env.TMPDIR, "maru.log");
  for (const c of [host, server]) {
    const add = (d) => { log += d; fs.appendFileSync(file, d); };
    c.stdout.on("data", add);
    c.stderr.on("data", add);
  }
  await waitFor(async () => (await httpGetJson(`http://127.0.0.1:${env.PORT}/healthz`)) !== null, 30_000, "server health");
  return { host, server, log: () => log };
}

/**
 * The scratch root. The Codex control socket sits at
 * `<root>/home/.codex-personal/app-server-control/app-server-control.sock`, and macOS limits a
 * Unix socket path to 103 bytes, so a long system temp folder falls back to /tmp (as the test
 * daemon in apps/server/src/codex/fake-daemon.ts does).
 */
export function makeRoot() {
  const tail = "maru-shots-XXXXXX/home/.codex-personal/app-server-control/app-server-control.sock";
  const tmp = fs.realpathSync(os.tmpdir());
  const parent = path.join(tmp, tail).length <= 103 ? tmp : fs.realpathSync("/tmp");
  return fs.mkdtempSync(path.join(parent, "maru-shots-"));
}

/**
 * Seven days of usage readings in the state file, so the dashboard's trend has a line to draw
 * (the table is the one apps/server/src/usage/history.ts keeps). Each series climbs to `now`,
 * where it meets what the stand-ins answer. 5-hour windows reset every 5 hours.
 */
export async function seedUsageHistory(stateFile, series) {
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const db = new DatabaseSync(stateFile);
  db.exec(`CREATE TABLE IF NOT EXISTS usage_history (
    account TEXT NOT NULL, win TEXT NOT NULL, at INTEGER NOT NULL, provider TEXT NOT NULL,
    minutes INTEGER, used REAL NOT NULL, resets_at INTEGER, PRIMARY KEY (account, win, at)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS usage_history_at ON usage_history (at);`);
  const insert = db.prepare("INSERT OR IGNORE INTO usage_history (account, win, at, provider, minutes, used, resets_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const now = Date.now();
  const H = 3600_000;
  const span = 7 * 24 * H;
  for (const s of series) {
    const weekStart = now - span * s.weekFraction;
    for (let at = now - span + H; at < now - 10 * 60_000; at += 2 * H) {
      const wave = 0.6 + 0.4 * Math.sin((at / H + s.phase) / 3.8);
      if (s.minutes === 10080) {
        if (at < weekStart) {
          // The previous 7-day window, which ended at weekStart.
          const prevStart = weekStart - span;
          const used = s.prevPeak * ((at - prevStart) / span) * (0.97 + 0.03 * wave);
          insert.run(s.account, s.win, at, s.provider, s.minutes, Math.round(used * 10) / 10, weekStart);
          continue;
        }
        const used = Math.min(s.now, s.now * ((at - weekStart) / (now - weekStart)) ** 1.1 * (0.97 + 0.03 * wave));
        insert.run(s.account, s.win, at, s.provider, s.minutes, Math.round(used * 10) / 10, weekStart + span);
      } else {
        const inWindow = (at % (5 * H)) / (5 * H);
        const used = Math.max(1, s.peak * inWindow * wave);
        insert.run(s.account, s.win, at, s.provider, s.minutes, Math.round(used * 10) / 10, at - (at % (5 * H)) + 5 * H);
      }
    }
  }
  db.close();
}
