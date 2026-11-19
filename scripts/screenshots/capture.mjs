// README screenshots from an isolated maru instance with made-up sessions.
//
// Run from the repo root (Node 26, dependencies installed, web UI built with `pnpm build:web`):
//   node scripts/screenshots/capture.mjs                 # every shot into docs/assets
//   node scripts/screenshots/capture.mjs --only hero     # some shots (comma separated)
//   node scripts/screenshots/capture.mjs --serve         # boot the instance and wait (Ctrl-C ends it)
//   node scripts/screenshots/capture.mjs --out <dir>     # another output folder (relative to the repo root)
//   node scripts/screenshots/capture.mjs --png           # keep the PNGs instead of converting to WebP
//   --keep leaves the scratch folder in place, --log prints the end of the server log
// The UI shows the version the web build carries, so build from the commit you want to show.
// Env: SHOTS_CHROMIUM or PERF_CHROMIUM (browser binary; default: Playwright's cached Chromium),
//      SHOTS_PORT (server, default 18780), SHOTS_CDP_PORT (default 18786), SHOTS_USAGE_PORT (default 18787).
// Needs tmux on PATH for the shell shot and `cwebp` for the WebP output.
//
// The instance runs on a scratch HOME in the system temp folder, with stand-in `claude` and
// `codex` executables, a stand-in Codex daemon and a stand-in usage endpoint (instance.mjs), and
// the world of world.mjs. Chromium runs headless with its own profile and a mock keychain.
// Every process it starts is stopped by pid at the end, and the scratch folder is removed.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildWorld } from "./world.mjs";
import { instanceEnv, makeRoot, seedUsageHistory, startCodexDaemon, startMaru, startUsageStandIn, writeFakeBins, writeFakeLogins } from "./instance.mjs";
import { Cdp, REPO, cleanup, sleep, start, startChromium } from "../perf/lib.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);
const PORT = Number(process.env.SHOTS_PORT || 18780);
const CDP_PORT = Number(process.env.SHOTS_CDP_PORT || 18786);
const USAGE_PORT = Number(process.env.SHOTS_USAGE_PORT || 18787);
const OUT = path.resolve(REPO, opt("out", "docs/assets"));
if (process.env.SHOTS_CHROMIUM) process.env.PERF_CHROMIUM = process.env.SHOTS_CHROMIUM;

const base = `http://127.0.0.1:${PORT}`;

async function api(method, p, body) {
  const res = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${p}: ${res.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

let scratchRoot = null;

async function boot() {
  const root = makeRoot();
  scratchRoot = root;
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const sleepers = [0, 1].map(() => start("sleep", ["100000"]));
  const world = buildWorld({ home, pids: sleepers.map((s) => s.pid) });
  writeFakeBins(path.join(root, "bin"));
  writeFakeLogins({ claudeDirs: [world.accounts.work, world.accounts.personal], codexHome: world.accounts.codexHome });
  fs.mkdirSync(path.join(home, ".config", "maru"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "maru", "config.json"), JSON.stringify({
    claudeAccounts: [{ id: "claude-work", dir: "~/.claude-work" }, { id: "claude-personal", dir: "~/.claude-personal" }],
    codexAccounts: [{ id: "codex-personal", home: "~/.codex-personal" }],
    claudeUsage: true,
    codexUsage: true,
  }, null, 2));
  const usage = await startUsageStandIn(USAGE_PORT, { "stand-in-.claude-work": [38, 61], "stand-in-.claude-personal": [12, 24] });
  await seedUsageHistory(path.join(home, ".config", "maru", "state.sqlite"), [
    { account: "claude-work", provider: "claude", win: "seven_day", minutes: 10080, now: 61, prevPeak: 82, weekFraction: 0.58, phase: 0 },
    { account: "claude-work", provider: "claude", win: "five_hour", minutes: 300, peak: 70, phase: 0 },
    { account: "claude-personal", provider: "claude", win: "seven_day", minutes: 10080, now: 24, prevPeak: 35, weekFraction: 0.58, phase: 2 },
    { account: "claude-personal", provider: "claude", win: "five_hour", minutes: 300, peak: 30, phase: 2 },
    { account: "codex-personal", provider: "codex", win: "secondary", minutes: 10080, now: 44, prevPeak: 58, weekFraction: 0.45, phase: 5 },
    { account: "codex-personal", provider: "codex", win: "primary", minutes: 300, peak: 45, phase: 5 },
  ]);
  const reset = (h) => Math.floor(Date.now() / 1000 + h * 3600);
  const daemon = await startCodexDaemon({
    home: world.accounts.codexHome,
    threads: world.codex,
    rate: {
      ordinaryUsageAllowed: true,
      rateLimits: {
        limitId: "codex", limitName: null, normalModelSlug: null,
        primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: reset(3.1) },
        secondary: { usedPercent: 44, windowDurationMins: 10080, resetsAt: reset(96) },
        credits: null, individualLimit: null, spendControlReached: null, planType: "pro", rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null,
    },
  });
  const env = instanceEnv({ root, home, port: PORT, usagePort: USAGE_PORT });
  const maru = await startMaru(env);
  return { root, home, world, usage, daemon, maru };
}

/** The sidebar: chosen sessions in three Groups, one pinned, one archived. */
async function arrange(world) {
  const s = world.sessions;
  for (const x of Object.values(s)) await api("PUT", "/api/session-chosen", { provider: x.provider, id: x.id, chosen: true });
  const group = async (name, keys) => {
    const { project } = await api("POST", "/api/projects", { name });
    for (const k of keys) await api("PUT", "/api/session-project", { provider: s[k].provider, id: s[k].id, projectId: project.id });
    await api("PUT", "/api/session-order", { projectId: project.id, keys: keys.map((k) => `${s[k].provider}:${s[k].id}`) });
    return project;
  };
  await group("Storefront", ["checkout", "deps", "cart", "ci", "flaky", "notes"]);
  await group("API", ["ratelimit", "auth"]);
  await group("Side projects", ["contrast", "offline"]);
  await api("PUT", "/api/session-pin", { provider: s.auth.provider, id: s.auth.id, pinned: true });
  await api("PUT", "/api/session-archive", { provider: s.notes.provider, id: s.notes.id, archived: true });
}

const keyOf = (x) => `${x.provider}:${x.account}:${x.id}`;

/**
 * Two shells (tmux on the instance's own socket) with a few commands already run, for the shell
 * and split view shots. Returns their ids.
 */
async function shells(inst) {
  const sock = path.join(inst.home, ".config", "maru", "shell-tmux.sock");
  const make = async (cwd, lines) => {
    const res = await api("POST", "/api/shells", { cwd });
    const id = res.id ?? res.shell?.id;
    await sleep(800);
    for (const line of lines) {
      execFileSync("tmux", ["-S", sock, "send-keys", "-t", id, line, "Enter"]);
      await sleep(400);
    }
    return id;
  };
  const web = await make(inst.world.repos.web, ["clear", "git log --oneline", "git status -sb", "ls src/lib"]);
  const api2 = await make(inst.world.repos.api, ["clear", "git log --oneline", "node --test test/rateLimit.test.ts"]);
  return { web, api: api2 };
}

/** Click the first element whose text starts with `text` (buttons first). */
const clickText = (text) => async (cdp) => {
  await cdp.eval(`(() => {
    const t = ${JSON.stringify(text)};
    const all = [...document.querySelectorAll("button, [role=button], summary, a, div, span")];
    const el = all.find((e) => (e.textContent || "").trim().startsWith(t) && e.offsetParent !== null && (e.tagName === "BUTTON" || e.getAttribute("role") === "button")) ?? all.find((e) => (e.textContent || "").trim().startsWith(t) && e.children.length === 0);
    if (el) el.click();
    return !!el;
  })()`);
  await sleep(900);
};

/** Scroll the conversation so the element whose text starts with `text` sits near the top. */
const scrollToText = (text, offset = 80) => async (cdp) => {
  await cdp.eval(`(() => {
    const t = ${JSON.stringify(text)};
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.nodeValue.trim().startsWith(t)) continue;
      let sc = n.parentElement;
      while (sc && !(sc.scrollHeight > sc.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
      if (!sc) return false;
      const top = n.parentElement.getBoundingClientRect().top - sc.getBoundingClientRect().top;
      sc.scrollTop += top - ${offset};
      return true;
    }
    return false;
  })()`);
  await sleep(1200);
};

const steps = (...fns) => async (cdp) => { for (const f of fns) await f(cdp); };

/** One page in headless Chromium: localStorage set before the app starts, then a PNG. */
// The web UI shortens a home folder to `~` only for `/Users/<name>` (apps/web/src/model.ts
// shortPath). The scratch HOME lives in a temp folder, so the page shows its full path; this
// observer rewrites that prefix to `~` in text and titles, which is what a real home shows.
const tildeScript = (home) => `(() => {
  const homes = ${JSON.stringify([home, home.replace(/^\/private/, "")])};
  const fix = (v) => { for (const h of homes) v = v.split(h).join("~"); return v; };
  const walk = (root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (homes.some((h) => n.nodeValue.includes(h))) n.nodeValue = fix(n.nodeValue);
    if (root.querySelectorAll) for (const el of root.querySelectorAll("[title],[aria-label]")) for (const a of ["title", "aria-label"]) { const v = el.getAttribute(a); if (v && homes.some((h) => v.includes(h))) el.setAttribute(a, fix(v)); }
  };
  const start = () => { walk(document.body); new MutationObserver((list) => { for (const m of list) { if (m.type === "characterData") { if (homes.some((h) => m.target.nodeValue.includes(h))) m.target.nodeValue = fix(m.target.nodeValue); } else for (const n of m.addedNodes) n.nodeType === 3 ? (homes.some((h) => n.nodeValue.includes(h)) && (n.nodeValue = fix(n.nodeValue))) : n.nodeType === 1 && walk(n); } }).observe(document.body, { subtree: true, childList: true, characterData: true }); };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();`;

async function capture(cdp, home, { url, storage = {}, width = 1440, height = 900, scale = 2, settleMs = 3500, prepare }) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  const source = `(() => { try { sessionStorage.clear(); localStorage.clear(); const kv = ${JSON.stringify(storage)}; for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, JSON.stringify(v)); } catch {} })();` + tildeScript(home);
  const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
  await cdp.send("Page.navigate", { url: base + url });
  await sleep(settleMs);
  await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  if (prepare) await prepare(cdp);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  return Buffer.from(shot.data, "base64");
}

/** PNG to WebP (cwebp writes no metadata by default; -metadata none makes it explicit). */
function toWebp(png, out) {
  const tmp = `${out}.tmp.png`;
  fs.writeFileSync(tmp, png);
  execFileSync("cwebp", ["-quiet", "-q", "86", "-m", "6", "-metadata", "none", tmp, "-o", out]);
  fs.rmSync(tmp);
}

/** The shots: file name (without extension) and how to reach the screen. */
function shots(world, shellIds) {
  const s = world.sessions;
  const panel = (x, state) => ({ [`maru_right_panel:${keyOf(x)}`]: state });
  const doc = path.join(world.repos.web, "docs/architecture.md");
  const heroStorage = panel(s.cart, { open: true, tabs: [{ path: doc, kind: "file" }], active: doc, lastFile: doc });
  const hero = { url: `/?s=${s.cart.id}`, storage: heroStorage, prepare: scrollToText("I'll find where the total", 24) };
  const pane = (id, x) => ({ kind: "pane", id, sessionKey: x ? keyOf(x) : null, shellId: null });
  const tabs = {
    v: 1,
    active: "t1",
    tabs: [
      {
        id: "t1", name: "Storefront", focused: "p1",
        root: {
          kind: "split", id: "s0", dir: "row", ratio: 0.5,
          a: { kind: "split", id: "s1", dir: "column", ratio: 0.55, a: pane("p1", s.cart), b: pane("p2", s.checkout) },
          b: { kind: "split", id: "s2", dir: "column", ratio: 0.55, a: pane("p3", s.ratelimit), b: { kind: "pane", id: "p4", sessionKey: null, shellId: shellIds.web } },
        },
      },
      { id: "t2", name: "API", focused: "p5", root: pane("p5", s.auth) },
    ],
  };
  return [
    { name: "hero", ...hero },
    { name: "hero-light", ...hero, storage: { ...heroStorage, maru_theme: "light" } },
    { name: "split-view", url: "/?view=panes", storage: { maru_pane_tabs: tabs, maru_sidebar_open: false }, settleMs: 5000 },
    { name: "terminal-mode", url: `/?s=${s.cart.id}`, storage: { [`maru_view_mode:${keyOf(s.cart)}`]: "terminal" } },
    { name: "subagents", url: `/?s=${s.checkout.id}`, storage: panel(s.checkout, { open: true, tabs: [], active: "@agents" }), prepare: clickText("To-dos") },
    { name: "plan-mermaid", url: `/?s=${s.auth.id}`, prepare: scrollToText("Plan: one middleware chain", 24) },
    { name: "codex", url: `/?s=${s.ratelimit.id}`, prepare: steps(clickText("Changed 2 files"), clickText("acme-api/src/middleware/rateLimit.ts"), scrollToText("There is no middleware yet", 24)) },
    { name: "shell", url: "/?view=terminal", settleMs: 4500 },
    { name: "dashboard", url: "/?view=dashboard" },
    { name: "accounts", url: "/?view=settings&tab=accounts" },
  ];
}

async function shoot(inst, shellIds) {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = await startChromium({ root: inst.root, cdpPort: CDP_PORT });
  const cdp = await Cdp.open(CDP_PORT);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const only = opt("only", "")?.split(",").filter(Boolean) ?? [];
  const done = [];
  for (const sh of shots(inst.world, shellIds)) {
    if (only.length && !only.includes(sh.name)) continue;
    const png = await capture(cdp, inst.home, sh);
    const out = path.join(OUT, `${sh.name}.webp`);
    if (flag("png")) fs.writeFileSync(path.join(OUT, `${sh.name}.png`), png);
    else toWebp(png, out);
    done.push(sh.name);
    console.error(`shot ${sh.name}`);
  }
  cdp.close();
  return { chrome, done };
}

async function main() {
  let inst;
  try {
    inst = await boot();
    console.error(`maru on ${base} (scratch ${inst.root})`);
    await arrange(inst.world);
    const shellIds = await shells(inst);
    if (flag("serve")) {
      await new Promise((resolve) => process.once("SIGINT", resolve));
      return;
    }
    const { done } = await shoot(inst, shellIds);
    console.error(`${done.length} shots written to ${OUT}`);
  } finally {
    if (inst) {
      try { execFileSync("tmux", ["-S", path.join(inst.home, ".config", "maru", "shell-tmux.sock"), "kill-server"], { stdio: "ignore" }); } catch { /* none */ }
      console.error(`daemon calls: ${JSON.stringify([...inst.daemon.calls])}, unknown: ${JSON.stringify([...inst.daemon.unknown])}`);
      await inst.daemon.close();
      inst.usage.close();
      if (flag("log")) console.error(inst.maru.log().slice(-4000));
    }
    await cleanup();
    if (scratchRoot && !flag("keep")) fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

await main();
