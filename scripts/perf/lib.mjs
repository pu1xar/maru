// Helpers for scripts/perf/measure.mjs: an isolated maru server on scratch state, headless
// Chromium with its own profile, a minimal CDP client, and per-process CPU from `ps`.
// Only processes started here are ever signalled (by pid, never by name).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import http from "node:http";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, "../..");
// `ws` is an apps/server dependency; resolve it from there.
const require = createRequire(path.join(REPO, "apps/server/package.json"));
const WebSocket = require("ws");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const owned = new Set();
/** Start a child and remember its pid so cleanup() can stop exactly these. */
export function start(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  owned.add(child);
  child.on("exit", () => owned.delete(child));
  return child;
}

/** The server may start a tmux for shell terminals on its scratch socket; stop that one only. */
export function killScratchTmux(root) {
  try { execFileSync("tmux", ["-S", path.join(root, "state", "shell.sock"), "kill-server"], { stdio: "ignore" }); } catch { /* none running */ }
}

export async function cleanup() {
  for (const c of owned) {
    try { c.kill("SIGTERM"); } catch { /* already gone */ }
  }
  await sleep(1500);
  for (const c of owned) {
    try { c.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

export function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

export async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(250);
  }
}

/** The maru server on `port`, state and accounts under `root`. Returns { child, home }. */
export async function startServer({ root, port, claudeDir }) {
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const config = path.join(root, "config.json");
  fs.writeFileSync(config, JSON.stringify({ claudeAccounts: [{ id: "perf", dir: claudeDir }], codexAccounts: [] }));
  const state = path.join(root, "state");
  fs.mkdirSync(state, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: root,
    PORT: String(port),
    MARU_CONFIG: config,
    MARU_STATE: path.join(state, "state.sqlite"),
    MARU_HOST_SOCKET: path.join(root, "h.sock"),
    MARU_SHELL_SOCKET: path.join(state, "shell.sock"),
    MARU_TRASH: path.join(root, "trash"),
  };
  const child = start("node", [path.join(REPO, "apps/server/src/main.ts")], { cwd: REPO, env });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  await waitFor(async () => (await httpGetJson(`http://127.0.0.1:${port}/healthz`)) !== null, 20_000, `server health (log: ${log.slice(-400)})`);
  return { child, home, log: () => log };
}

function chromiumBinary() {
  if (process.env.PERF_CHROMIUM) return process.env.PERF_CHROMIUM;
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort() : [];
  for (const d of dirs.reverse()) {
    for (const [app, bin] of [["Google Chrome for Testing.app", "Google Chrome for Testing"], ["Chromium.app", "Chromium"]]) {
      const p = path.join(cache, d, "chrome-mac-arm64", app, "Contents/MacOS", bin);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error("no Chromium found; set PERF_CHROMIUM to a Chromium or Chrome for Testing binary");
}

/** Headless Chromium (new headless) with a fresh profile; returns { child, port }. */
export async function startChromium({ root, cdpPort, width = 1280, height = 860 }) {
  const profile = path.join(root, "chrome-profile");
  fs.mkdirSync(profile, { recursive: true });
  const child = start(chromiumBinary(), [
    "--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, "--no-first-run", "--no-default-browser-check",
    // Never touch the login Keychain (it pops a "Safe Storage" access dialog on the user's screen).
    "--use-mock-keychain", "--password-store=basic",
    "--disable-extensions", "--mute-audio", "about:blank",
  ]);
  await waitFor(() => httpGetJson(`http://127.0.0.1:${cdpPort}/json/version`), 20_000, "chromium cdp");
  return { child, cdpPort };
}

/** Minimal CDP session on a page target. */
export class Cdp {
  static async open(cdpPort, targetUrlPart = "") {
    const targets = await httpGetJson(`http://127.0.0.1:${cdpPort}/json/list`);
    const t = targets.find((x) => x.type === "page" && x.url.includes(targetUrlPart));
    const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result); }
      } else {
        for (const f of this.listeners.get(m.method) ?? []) f(m.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej, method }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(method, f) { const l = this.listeners.get(method) ?? []; l.push(f); this.listeners.set(method, l); }
  off(method) { this.listeners.delete(method); }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
    return r.result.value;
  }
  close() { this.ws.close(); }
}

/** pid, ppid, cputime seconds, rss KB, command for every process; macOS ps. */
export function psAll() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,time=,rss=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const rows = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+\.\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, ppid, d, h, mi, s, rss, command] = m;
    const sec = Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(s);
    rows.push({ pid: Number(pid), ppid: Number(ppid), cpu: sec, rssKb: Number(rss), command });
  }
  return rows;
}

/** Descendants of `rootPid`, labelled renderer, gpu, network, browser, other. */
export function chromiumProcs(rootPid) {
  const all = psAll();
  const kids = new Map();
  for (const r of all) { const l = kids.get(r.ppid) ?? []; l.push(r); kids.set(r.ppid, l); }
  const out = [];
  const walk = (pid) => {
    const row = all.find((r) => r.pid === pid);
    if (row) {
      const c = row.command;
      const role = pid === rootPid ? "browser" : /--type=renderer/.test(c) ? "renderer" : /--type=gpu-process/.test(c) ? "gpu" : /--type=utility.*network/.test(c) ? "network" : /--type=utility/.test(c) ? "utility" : "other";
      out.push({ ...row, role });
    }
    for (const k of kids.get(pid) ?? []) walk(k.pid);
  };
  walk(rootPid);
  return out;
}

/** CPU seconds per role between two chromiumProcs() snapshots (processes that appeared count from 0). */
export function cpuDelta(a, b) {
  const before = new Map(a.map((p) => [p.pid, p.cpu]));
  const byRole = {};
  const rss = {};
  for (const p of b) {
    const d = p.cpu - (before.get(p.pid) ?? p.cpu);
    byRole[p.role] = (byRole[p.role] ?? 0) + d;
    rss[p.role] = (rss[p.role] ?? 0) + p.rssKb;
  }
  return { byRole, rss };
}
