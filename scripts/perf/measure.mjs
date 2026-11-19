// Idle render cost of the maru web page, measured in headless Chromium over CDP against an
// isolated server (scratch HOME/state, synthetic transcripts). It never touches the live
// services or real sessions.
//
// Run (from the repo root, Node 26, apps/web built with `pnpm --filter @maru/web build`):
//   node scripts/perf/measure.mjs                      # all scenarios, all variants, 10 s windows
//   node scripts/perf/measure.mjs --scenarios a,c      # a subset
//   node scripts/perf/measure.mjs --secs 20 --variants base,anim-all,backdrop
//   node scripts/perf/measure.mjs --diag               # also dump timers / mutations / animations
//   node scripts/perf/measure.mjs --out result.json    # also write the raw numbers
//   node scripts/perf/measure.mjs --dpr 2              # Retina-like device pixel ratio (default 1)
//   node scripts/perf/measure.mjs --shots dir          # also save one screenshot per scenario
// Env: PERF_CHROMIUM (browser binary; default is Playwright's cached Chrome for Testing),
//      PERF_WEB_PORT (default 18780), PERF_CDP_PORT (default 18782).
//
// Scenarios
//   a  no session open (first screen)           b  a finished session open
//   c  a running session open (open tool call, subagent, 1 running dot in the sidebar)
//   d  a finished session open, 5 running sessions in the sidebar (status dots only)
//   e  same as c, plus one transcript line appended per second (live events)
// Variants turn one suspect off at a time by injecting CSS (or a script, for timers).
// Numbers per second of wall time: main-thread task/script/layout/style time (ms per s, so
// 10 = 1% of one core), layout and style recalc counts, trace event counts, and process CPU
// from `ps` cputime deltas (percent of one core), per Chromium process role.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFixture, appendAssistantLine } from "./fixture.mjs";
import { Cdp, chromiumProcs, cleanup, killScratchTmux, cpuDelta, sleep, start, startChromium, startServer } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);
const SECS = Number(opt("secs", "10"));
const TRACE_SECS = Number(opt("trace-secs", "5"));
const WEB_PORT = Number(process.env.PERF_WEB_PORT || 18780);
const CDP_PORT = Number(process.env.PERF_CDP_PORT || 18782);
const wantScenarios = opt("scenarios", "a,b,c,d,e").split(",");
const wantVariants = opt("variants", "")?.split(",").filter(Boolean);

const SCENARIOS = {
  a: { desc: "no session open", chosen: [], open: null },
  b: { desc: "finished session open", chosen: ["done"], open: "done" },
  c: { desc: "running session open", chosen: ["done", "run0"], open: "run0" },
  d: { desc: "finished open, 5 running in sidebar", chosen: ["done", "run0", "run1", "run2", "run3", "run4"], open: "done" },
  e: { desc: "running open + 1 line/s appended", chosen: ["done", "run0"], open: "run0", stream: true },
};

const NO_ANIM = (sel) => `${sel}{animation:none !important;}`;
const VARIANTS = [
  { id: "base", css: "" },
  { id: "anim-all", css: "*,*::before,*::after{animation:none !important;}" },
  { id: "backdrop", css: "*,*::before,*::after{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}" },
  { id: "skeleton", sel: '[class*="animate-skeleton"]', css: NO_ANIM('[class*="animate-skeleton"]') },
  { id: "status-pulse", sel: '[class*="animate-status-pulse"]', css: NO_ANIM('[class*="animate-status-pulse"]') },
  { id: "status-ping", sel: '[class*="animate-status-ping"]', css: NO_ANIM('[class*="animate-status-ping"]') },
  { id: "tool-shine", sel: ".live-tool-shine", css: NO_ANIM(".live-tool-shine") },
  { id: "activity-focus", sel: '[class*="live-activity-focus"]', css: NO_ANIM('[class*="live-activity-focus"]') },
  // Cheaper shapes of the same shine, to price the options (same look, fewer steps or slower).
  { id: "shine-steps10", sel: ".live-tool-shine", css: ".live-tool-shine{animation-timing-function:steps(10) !important;}" },
  { id: "shine-steps5", sel: ".live-tool-shine", css: ".live-tool-shine{animation-timing-function:steps(5) !important;}" },
  { id: "shine-4s", sel: ".live-tool-shine", css: ".live-tool-shine{animation-duration:4.4s !important;}" },
  { id: "spin", sel: '[class*="animate-spin"]', css: NO_ANIM('[class*="animate-spin"]') },
  { id: "ping", sel: '[class*="animate-ping"]', css: NO_ANIM('[class*="animate-ping"]') },
  { id: "all-off", css: "*,*::before,*::after{animation:none !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}" },
  { id: "timers-off", script: "window.setInterval=function(){return 0};" },
  { id: "base-again", css: "" },
];

// Page-side instrumentation for --diag: who fires timers and rAF, what mutates the DOM.
const DIAG_SCRIPT = `(() => {
  const P = (window.__perf = { timers: {}, raf: 0, muts: {}, mutTotal: 0 });
  const where = () => { const s = (new Error().stack || '').split('\\n').slice(3, 6).map((l) => l.replace(/^\\s*at /, '').replace(/https?:\\/\\/[^/]+/, '')).join(' < '); return s.slice(0, 200); };
  const wrap = (name, orig) => function (cb, delay, ...rest) {
    if (typeof cb !== 'function') return orig.call(this, cb, delay, ...rest);
    const key = name + ' ' + (delay ?? 0) + 'ms ' + where();
    const t = (P.timers[key] ||= { made: 0, fired: 0 }); t.made++;
    return orig.call(this, function () { t.fired++; return cb.apply(this, arguments); }, delay, ...rest);
  };
  window.setInterval = wrap('setInterval', window.setInterval);
  const rAF = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) { P.raf++; return rAF.call(this, cb); };
  const desc = (n) => { const e = n.nodeType === 1 ? n : n.parentElement; if (!e) return '?'; return e.tagName.toLowerCase() + '.' + String(e.className?.baseVal ?? e.className ?? '').slice(0, 50).replace(/\\s+/g, '.'); };
  const mo = new MutationObserver((list) => { for (const m of list) { P.mutTotal++; const k = m.type + (m.attributeName ? ':' + m.attributeName : '') + ' ' + desc(m.target); P.muts[k] = (P.muts[k] || 0) + 1; } });
  const go = () => mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  if (document.documentElement) go(); else document.addEventListener('DOMContentLoaded', go);
})();`;

const TRACE_NAMES = ["Paint", "PrePaint", "Layerize", "CompositeLayers", "UpdateLayoutTree", "Layout", "TimerFire", "FireAnimationFrame", "BeginMainThreadFrame", "DrawFrame", "ActivateLayerTree", "Commit"];

async function metrics(cdp) {
  const r = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(r.metrics.map((m) => [m.name, m.value]));
}

async function trace(cdp, secs) {
  const events = [];
  cdp.on("Tracing.dataCollected", (p) => events.push(...p.value));
  const done = new Promise((res) => cdp.on("Tracing.tracingComplete", res));
  await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline.frame,cc,viz,benchmark", transferMode: "ReportEvents" });
  await sleep(secs * 1000);
  await cdp.send("Tracing.end");
  await done;
  cdp.off("Tracing.dataCollected");
  cdp.off("Tracing.tracingComplete");
  const counts = {};
  for (const e of events) if (e.ph !== "M" && e.ph !== "E" && e.ph !== "e" && e.ph !== "F") counts[e.name] = (counts[e.name] ?? 0) + 1;
  const out = Object.fromEntries(TRACE_NAMES.map((n) => [n, +((counts[n] ?? 0) / secs).toFixed(2)]));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n, c]) => `${n}:${(c / secs).toFixed(1)}`);
  return { perSec: out, top };
}

async function sample(cdp, chromePid, secs) {
  const m0 = await metrics(cdp);
  const p0 = chromiumProcs(chromePid);
  const t0 = Date.now();
  await sleep(secs * 1000);
  const m1 = await metrics(cdp);
  const p1 = chromiumProcs(chromePid);
  const dt = (Date.now() - t0) / 1000;
  const d = (k) => (m1[k] - m0[k]) / dt;
  const cpu = cpuDelta(p0, p1);
  const pct = Object.fromEntries(Object.entries(cpu.byRole).map(([k, v]) => [k, +((v / dt) * 100).toFixed(1)]));
  return {
    taskMsPerS: +(d("TaskDuration") * 1000).toFixed(1),
    scriptMsPerS: +(d("ScriptDuration") * 1000).toFixed(1),
    layoutMsPerS: +(d("LayoutDuration") * 1000).toFixed(1),
    styleMsPerS: +(d("RecalcStyleDuration") * 1000).toFixed(1),
    layoutPerS: +d("LayoutCount").toFixed(2),
    stylePerS: +d("RecalcStyleCount").toFixed(2),
    cpuPct: pct,
    rssMb: Object.fromEntries(Object.entries(cpu.rss).map(([k, v]) => [k, Math.round(v / 1024)])),
  };
}

const ANIM_LIST = `JSON.stringify(document.getAnimations().map((a) => { const e = a.effect && a.effect.target; return (a.animationName || a.transitionProperty || a.constructor.name) + '|' + a.playState + '|' + (e ? e.tagName.toLowerCase() + '.' + String(e.className?.baseVal ?? e.className ?? '').slice(0, 40).replace(/\\s+/g, '.') : '?'); }))`;

function summarizeAnimations(list) {
  const by = {};
  for (const s of list) { const [name, state] = s.split("|"); const k = `${name}/${state}`; by[k] = (by[k] ?? 0) + 1; }
  return by;
}

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return res.status;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mp-"));
  const procs = [];
  const results = { meta: { secs: SECS, traceSecs: TRACE_SECS, node: process.version, platform: `${os.platform()} ${os.arch()}` }, scenarios: {} };
  try {
    const sleepers = [0, 1, 2, 3, 4].map(() => start("sleep", ["100000"]));
    procs.push(...sleepers);
    const home = path.join(root, "home");
    const fx = buildFixture({
      home,
      sessions: [{ title: "Done", turns: 40 }, ...[0, 1, 2, 3, 4].map((i) => ({ title: `Run${i}`, turns: 40, running: true }))],
      pids: sleepers.map((s) => s.pid),
    });
    const sess = { done: fx.sessions[0], run0: fx.sessions[1], run1: fx.sessions[2], run2: fx.sessions[3], run3: fx.sessions[4], run4: fx.sessions[5] };
    const server = await startServer({ root, port: WEB_PORT, claudeDir: fx.dir });
    const chrome = await startChromium({ root, cdpPort: CDP_PORT });
    const cdp = await Cdp.open(CDP_PORT);
    await cdp.send("Page.enable");
    await cdp.send("Performance.enable");
    await cdp.send("Runtime.enable");
    const dpr = Number(opt("dpr", "1"));
    if (dpr !== 1) await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: dpr, mobile: false });
    results.meta.dpr = dpr;
    results.meta.userAgent = await cdp.eval("navigator.userAgent");
    const base = `http://127.0.0.1:${WEB_PORT}`;

    const navigate = async (sc) => {
      const url = sc.open ? `${base}/?s=${encodeURIComponent(sess[sc.open].key)}` : `${base}/`;
      await cdp.send("Page.navigate", { url });
      await sleep(4000);
    };
    let n = 0;
    for (const id of wantScenarios) {
      const sc = SCENARIOS[id];
      // The sidebar shows exactly the chosen sessions.
      for (const [k, s] of Object.entries(sess)) await api("PUT", `${base}/api/session-chosen`, { provider: "claude", id: s.sessionId, chosen: sc.chosen.includes(k) });
      await sleep(500);
      let streamTimer = null;
      if (sc.stream) streamTimer = setInterval(() => appendAssistantLine(sess.run0, ++n), 1000);
      console.error(`== scenario ${id}: ${sc.desc}`);
      const res = { desc: sc.desc, variants: {} };
      results.scenarios[id] = res;
      await navigate(sc);
      if (opt("shots", "")) {
        fs.mkdirSync(opt("shots", ""), { recursive: true });
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(path.join(opt("shots", ""), `scenario-${id}.png`), Buffer.from(shot.data, "base64"));
      }
      res.animations = summarizeAnimations(JSON.parse(await cdp.eval(ANIM_LIST)));
      res.dom = await cdp.eval("({ nodes: document.getElementsByTagName('*').length, sessionsInSidebar: document.querySelectorAll('[data-sidebar=menu-button]').length })");
      for (const v of VARIANTS) {
        if (wantVariants.length && !wantVariants.includes(v.id)) continue;
        if (v.sel && !(await cdp.eval(`!!document.querySelector(${JSON.stringify(v.sel)})`))) { res.variants[v.id] = { absent: true }; continue; }
        let scriptId = null;
        if (v.script) {
          scriptId = (await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: v.script })).identifier;
          await navigate(sc);
        }
        await cdp.eval(`(() => { document.getElementById('perf-variant')?.remove(); const s = document.createElement('style'); s.id = 'perf-variant'; s.textContent = ${JSON.stringify(v.css ?? "")}; document.head.appendChild(s); })()`);
        await sleep(2000);
        const w = await sample(cdp, chrome.child.pid, SECS);
        if (v.id === "base" || v.id === "all-off") w.trace = await trace(cdp, TRACE_SECS);
        res.variants[v.id] = w;
        console.error(`   ${v.id.padEnd(15)} task ${w.taskMsPerS}ms/s script ${w.scriptMsPerS} style ${w.styleMsPerS} layout ${w.layoutMsPerS} cpu ${JSON.stringify(w.cpuPct)}`);
        if (scriptId) { await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId }); await navigate(sc); }
      }
      if (flag("diag")) {
        const sid = (await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: DIAG_SCRIPT })).identifier;
        await navigate(sc);
        await cdp.eval("window.__perf && (Object.values(window.__perf.timers).forEach((t) => (t.fired = 0)), window.__perf.muts = {}, window.__perf.mutTotal = 0, window.__perf.raf = 0)");
        await sleep(SECS * 1000);
        const d = JSON.parse(await cdp.eval("JSON.stringify(window.__perf)"));
        const top = (o, f) => Object.entries(o).sort((a, b) => f(b[1]) - f(a[1])).slice(0, 8);
        res.diag = {
          timersFiredPerS: top(d.timers, (t) => t.fired).map(([k, t]) => `${(t.fired / SECS).toFixed(2)}/s (made ${t.made}) ${k}`),
          rafCallsPerS: +(d.raf / SECS).toFixed(2),
          mutationsPerS: +(d.mutTotal / SECS).toFixed(2),
          topMutations: top(d.muts, (c) => c).map(([k, c]) => `${(c / SECS).toFixed(2)}/s ${k}`),
        };
        await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: sid });
      }
      if (streamTimer) clearInterval(streamTimer);
    }
    results.meta.serverLogTail = server.log().slice(-300);
    cdp.close();
    if (opt("out", "")) fs.writeFileSync(opt("out", ""), JSON.stringify(results, null, 1));
    console.log(JSON.stringify(results, null, 1));
  } finally {
    killScratchTmux(root);
    await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await main();
