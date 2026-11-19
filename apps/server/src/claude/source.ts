// Live index of Claude Code sessions across config dirs (accounts).
//
// A session is a top-level transcript `<dir>/projects/<enc>/<sid>.jsonl`; its summary fields
// come from meta.ts. Its status comes from the live-process registrations in
// `<dir>/sessions/<pid>.json` (registry.ts). Both directories are watched with fs.watch
// (recursive for projects/, FSEvents on macOS); a periodic sweep re-lists sessions/ and
// re-checks pids, because a crashed process leaves its registration behind and no file event
// announces the death.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { sessionKey } from "@maru/shared";
import type { IndexEvent, SessionSource, SessionSummary } from "@maru/shared";
import type { ClaudeAccount } from "../config.ts";
import { isNotFound, newReadCounters, readTranscriptMeta } from "./meta.ts";
import type { MetaCacheEntry, ReadCounters } from "./meta.ts";
import { isRegistrationLive, mapStatus, parseRegistration, resolveHold } from "./registry.ts";
import type { Registration } from "./registry.ts";

export interface ClaudeSourceOptions {
  /** pids of the Claude processes this server started (owner "ui"). */
  ownPids?: () => Set<number>;
  /** Interval of the pid sweep, ms. Default 5000. */
  sweepMs?: number;
  /** File events are collected for this long, then processed together, ms. Default 200. */
  debounceMs?: number;
}

export interface ClaudeSourceStats {
  accounts: {
    total: number;
    /** Account ids whose config dir does not exist. */
    missing: string[];
    projectsDirMissing: string[];
    sessionsDirMissing: string[];
  };
  /**
   * Entries under projects/ at the last full scan of each account. Only `<enc>/<sid>.jsonl`
   * files are indexed; every other kind is counted here.
   */
  projects: {
    projectDirs: number;
    transcripts: number;
    /** `<enc>/<sid>/` trees (subagents, workflows, tool results). */
    skippedSubtreeDirs: number;
    /** Symlinks inside a project dir (memory dirs). */
    skippedSymlinks: number;
    /** Other files inside a project dir. */
    skippedOtherFiles: number;
    /** Entries directly under projects/ that are not plain directories. */
    skippedTopLevel: number;
  };
  /** Sessions currently in the index. */
  indexed: number;
  /** Session ids found at two paths in one account (the newer file wins). */
  duplicateSids: number;
  /** Registrations under sessions/ right now. */
  registrations: {
    files: number;
    live: number;
    dead: number;
    /** Files that failed to parse (the last good read is kept when there is one). */
    unreadable: number;
    /** Live registrations whose status value mapStatus does not know (mapped to open-idle). */
    unknownStatus: number;
    unknownStatusValues: string[];
    /** Live registrations whose session has no transcript yet. */
    liveWithoutTranscript: number;
    keyFilesIgnored: number;
    otherFilesIgnored: number;
  };
  /** Cumulative. vanished: listed by a scan but gone when opened. errors: other I/O errors. */
  reads: ReadCounters & { vanished: number; errors: number };
  watch: { events: number; ignoredEvents: number; rescans: number; errors: number; active: number };
  emitted: { upserts: number; removes: number };
  sweeps: number;
  lastError: string | null;
}

export interface ClaudeSource extends SessionSource {
  stats(): ClaudeSourceStats;
  /**
   * Run the pid sweep now instead of at the next interval: the caller learned something the
   * sweep reads (a driver found the pid of a process it started, so owner becomes "ui").
   */
  resweep(): Promise<void>;
  /**
   * Re-read one transcript now: this server wrote to it (a rename), so the index takes the
   * change without waiting for the file event. Resolves once the change has been emitted.
   */
  reread(accountId: string, file: string): Promise<void>;
}

interface Transcript {
  path: string;
  entry: MetaCacheEntry;
}

interface RegState {
  reg: Registration;
  mtimeMs: number;
  size: number;
  alive: boolean;
}

interface ProjectScanCounts {
  projectDirs: number;
  transcripts: number;
  skippedSubtreeDirs: number;
  skippedSymlinks: number;
  skippedOtherFiles: number;
  skippedTopLevel: number;
}

interface AccountState {
  account: ClaudeAccount;
  projectsDir: string;
  sessionsDir: string;
  /** sid -> transcript */
  transcripts: Map<string, Transcript>;
  /** registration file name (`<pid>.json`) -> state */
  regs: Map<string, RegState>;
  unreadableRegs: Set<string>;
  keyFiles: number;
  otherRegFiles: number;
  projectsWatcher: fs.FSWatcher | null;
  sessionsWatcher: fs.FSWatcher | null;
  pending: Pending;
  scanCounts: ProjectScanCounts;
  /** sids seen at two paths of this account. */
  duplicateSids: Set<string>;
}

interface Pending {
  transcripts: Set<string>;
  projectDirs: Set<string>;
  regFiles: Set<string>;
  rescanProjects: boolean;
  rescanSessions: boolean;
}

const REG_FILE = /^(\d+)\.json$/;
const READ_CONCURRENCY = 8;

function emptyPending(): Pending {
  return {
    transcripts: new Set(),
    projectDirs: new Set(),
    regFiles: new Set(),
    rescanProjects: false,
    rescanSessions: false,
  };
}

function emptyScanCounts(): ProjectScanCounts {
  return {
    projectDirs: 0,
    transcripts: 0,
    skippedSubtreeDirs: 0,
    skippedSymlinks: 0,
    skippedOtherFiles: 0,
    skippedTopLevel: 0,
  };
}

export function createClaudeSource(accounts: ClaudeAccount[], opts: ClaudeSourceOptions = {}): ClaudeSource {
  const ownPids = opts.ownPids ?? (() => new Set<number>());
  const sweepMs = opts.sweepMs ?? 5000;
  const debounceMs = opts.debounceMs ?? 200;

  const states: AccountState[] = accounts.map((account) => ({
    account,
    projectsDir: path.join(account.dir, "projects"),
    sessionsDir: path.join(account.dir, "sessions"),
    transcripts: new Map(),
    regs: new Map(),
    unreadableRegs: new Set(),
    keyFiles: 0,
    otherRegFiles: 0,
    projectsWatcher: null,
    sessionsWatcher: null,
    pending: emptyPending(),
    scanCounts: emptyScanCounts(),
    duplicateSids: new Set(),
  }));

  const counters = { ...newReadCounters(), vanished: 0, errors: 0 };
  const watchCounts = { events: 0, ignoredEvents: 0, rescans: 0, errors: 0 };
  const emitted = { upserts: 0, removes: 0 };
  let sweeps = 0;
  let lastError: string | null = null;

  /** key -> JSON of the last summary sent, so unchanged sessions are not sent again. */
  const lastSent = new Map<string, string>();
  let emit: ((e: IndexEvent) => void) | null = null;
  let started = false;
  let stopped = false;
  let flushTimer: NodeJS.Timeout | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  /** Every scan, flush and sweep runs on this chain, one at a time. */
  let chain: Promise<void> = Promise.resolve();

  function enqueue(job: () => Promise<void>): Promise<void> {
    chain = chain.then(job).catch((err: unknown) => {
      counters.errors++;
      lastError = err instanceof Error ? err.message : String(err);
    });
    return chain;
  }

  function noteError(err: unknown): void {
    counters.errors++;
    lastError = err instanceof Error ? err.message : String(err);
  }

  // ---- transcripts ----

  /** Read one transcript path into the index. Returns the sid it touched, or null. */
  async function refreshTranscript(st: AccountState, file: string, fromScan: boolean): Promise<string | null> {
    const sid = path.basename(file, ".jsonl");
    const current = st.transcripts.get(sid);
    const prev = current?.path === file ? current.entry : undefined;
    let entry: MetaCacheEntry | null;
    try {
      entry = await readTranscriptMeta(file, prev, counters);
    } catch (err) {
      noteError(err);
      return null;
    }
    if (entry === null) {
      if (fromScan) counters.vanished++;
      if (current?.path === file) {
        st.transcripts.delete(sid);
        return sid;
      }
      return null;
    }
    if (current && current.path !== file) {
      // The same sid at two paths of one account. Keep the newer file while the other exists.
      st.duplicateSids.add(sid);
      const otherExists = await exists(current.path);
      if (otherExists && current.entry.mtimeMs >= entry.mtimeMs) return null;
    }
    st.transcripts.set(sid, { path: file, entry });
    return sid;
  }

  /** Full listing of projects/: add new transcripts, re-read changed ones, drop missing ones. */
  async function scanProjects(st: AccountState): Promise<Set<string>> {
    const affected = new Set<string>();
    const counts = emptyScanCounts();
    const found: string[] = [];
    let top: fs.Dirent[];
    try {
      top = await fsp.readdir(st.projectsDir, { withFileTypes: true });
    } catch (err) {
      if (!isNotFound(err)) noteError(err);
      top = [];
    }
    for (const d of top) {
      if (!d.isDirectory()) {
        counts.skippedTopLevel++;
        continue;
      }
      counts.projectDirs++;
      const dir = path.join(st.projectsDir, d.name);
      found.push(...(await listProjectDir(dir, counts)));
    }
    counts.transcripts = found.length;
    st.scanCounts = counts;
    const foundSet = new Set(found);
    for (const [sid, t] of st.transcripts) {
      if (!foundSet.has(t.path)) {
        st.transcripts.delete(sid);
        affected.add(sid);
      }
    }
    await mapPool(found, READ_CONCURRENCY, async (file) => {
      const sid = await refreshTranscript(st, file, true);
      if (sid !== null) affected.add(sid);
    });
    return affected;
  }

  /** Transcript paths directly inside one project dir; other entries are counted. */
  async function listProjectDir(dir: string, counts: ProjectScanCounts | null): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (!isNotFound(err)) noteError(err);
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jsonl")) out.push(path.join(dir, e.name));
      else if (counts === null) continue;
      else if (e.isSymbolicLink()) counts.skippedSymlinks++;
      else if (e.isDirectory()) counts.skippedSubtreeDirs++;
      else counts.skippedOtherFiles++;
    }
    return out;
  }

  /** A project dir was created, removed or renamed: reconcile the transcripts under it. */
  async function scanProjectDir(st: AccountState, dir: string): Promise<Set<string>> {
    const affected = new Set<string>();
    const files = new Set(await listProjectDir(dir, null));
    for (const [sid, t] of st.transcripts) {
      if (path.dirname(t.path) === dir && !files.has(t.path)) {
        st.transcripts.delete(sid);
        affected.add(sid);
      }
    }
    for (const file of files) {
      const sid = await refreshTranscript(st, file, false);
      if (sid !== null) affected.add(sid);
    }
    return affected;
  }

  // ---- registrations ----

  /** Read one registration file. Returns the sids whose holders changed. */
  async function refreshReg(st: AccountState, name: string): Promise<Set<string>> {
    const affected = new Set<string>();
    const m = REG_FILE.exec(name);
    if (!m) return affected;
    const file = path.join(st.sessionsDir, name);
    const old = st.regs.get(name);
    if (old?.reg.sessionId) affected.add(old.reg.sessionId);
    let text: string;
    let mtimeMs: number;
    let size: number;
    try {
      const s = await fsp.stat(file);
      if (old && old.mtimeMs === s.mtimeMs && old.size === s.size) {
        affected.clear();
        return affected;
      }
      text = await fsp.readFile(file, "utf8");
      mtimeMs = s.mtimeMs;
      size = s.size;
    } catch (err) {
      if (!isNotFound(err)) noteError(err);
      st.regs.delete(name);
      st.unreadableRegs.delete(name);
      return affected;
    }
    const reg = parseRegistration(text, Number(m[1]));
    if (reg === null) {
      // Usually a write in progress. Keep the last good read; the next event or sweep retries.
      st.unreadableRegs.add(name);
      affected.clear();
      return affected;
    }
    st.unreadableRegs.delete(name);
    st.regs.set(name, { reg, mtimeMs, size, alive: isRegistrationLive(reg) });
    if (reg.sessionId) affected.add(reg.sessionId);
    return affected;
  }

  /** Full listing of sessions/. */
  async function scanSessions(st: AccountState): Promise<Set<string>> {
    const affected = new Set<string>();
    let names: string[];
    try {
      names = await fsp.readdir(st.sessionsDir);
    } catch (err) {
      if (!isNotFound(err)) noteError(err);
      names = [];
    }
    let keyFiles = 0;
    let other = 0;
    const regNames = new Set<string>();
    for (const n of names) {
      if (REG_FILE.test(n)) regNames.add(n);
      else if (n.endsWith(".key")) keyFiles++;
      else other++;
    }
    st.keyFiles = keyFiles;
    st.otherRegFiles = other;
    for (const [name, rs] of st.regs) {
      if (!regNames.has(name)) {
        st.regs.delete(name);
        if (rs.reg.sessionId) affected.add(rs.reg.sessionId);
      }
    }
    for (const name of st.unreadableRegs) if (!regNames.has(name)) st.unreadableRegs.delete(name);
    for (const name of regNames) for (const sid of await refreshReg(st, name)) affected.add(sid);
    return affected;
  }

  /** Re-check every registered pid. Returns the sids whose holder died or came back. */
  function checkLiveness(st: AccountState): Set<string> {
    const affected = new Set<string>();
    for (const rs of st.regs.values()) {
      const alive = isRegistrationLive(rs.reg);
      if (alive !== rs.alive) {
        rs.alive = alive;
        if (rs.reg.sessionId) affected.add(rs.reg.sessionId);
      }
    }
    return affected;
  }

  // ---- summaries ----

  function summarize(st: AccountState, sid: string, t: Transcript, own: Set<number>): SessionSummary {
    const live: Registration[] = [];
    for (const rs of st.regs.values()) if (rs.alive && rs.reg.sessionId === sid) live.push(rs.reg);
    const hold = resolveHold(live, own);
    const m = t.entry.meta;
    return {
      key: sessionKey("claude", st.account.id, sid),
      provider: "claude",
      account: st.account.id,
      id: sid,
      cwd: m.cwd,
      name: m.name,
      title: m.title,
      preview: m.preview,
      status: hold.status,
      owner: hold.owner,
      pid: hold.pid,
      tmuxPane: hold.tmuxPane,
      parentKey: null,
      updatedAt: m.updatedAt,
      createdAt: m.createdAt,
      sizeBytes: m.sizeBytes,
      entrypoint: m.entrypoint,
    };
  }

  /** Send an upsert or remove for each sid whose summary differs from the last one sent. */
  function publish(st: AccountState, sids: Iterable<string>): void {
    if (stopped || emit === null) return;
    const own = ownPids();
    for (const sid of sids) {
      const key = sessionKey("claude", st.account.id, sid);
      const t = st.transcripts.get(sid);
      if (!t) {
        if (lastSent.delete(key)) {
          emitted.removes++;
          emit({ type: "remove", key });
        }
        continue;
      }
      const summary = summarize(st, sid, t, own);
      const json = JSON.stringify(summary);
      if (lastSent.get(key) === json) continue;
      lastSent.set(key, json);
      emitted.upserts++;
      emit({ type: "upsert", session: summary });
    }
  }

  function sidsWithRegs(st: AccountState): Set<string> {
    const out = new Set<string>();
    for (const rs of st.regs.values()) if (rs.reg.sessionId) out.add(rs.reg.sessionId);
    return out;
  }

  // ---- watching ----

  function schedule(): void {
    if (flushTimer !== null || stopped) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void enqueue(flush);
    }, debounceMs);
  }

  function onProjectsEvent(st: AccountState, filename: string | null): void {
    watchCounts.events++;
    if (!filename) {
      st.pending.rescanProjects = true;
      schedule();
      return;
    }
    const parts = filename.split(path.sep).filter((p) => p !== "");
    if (parts.length === 2 && parts[1]!.endsWith(".jsonl")) {
      st.pending.transcripts.add(path.join(st.projectsDir, parts[0]!, parts[1]!));
    } else if (parts.length === 1) {
      st.pending.projectDirs.add(path.join(st.projectsDir, parts[0]!));
    } else if (parts.length === 0) {
      st.pending.rescanProjects = true;
    } else {
      // Deeper paths: subagent and workflow trees, memory dirs.
      watchCounts.ignoredEvents++;
      return;
    }
    schedule();
  }

  function onSessionsEvent(st: AccountState, filename: string | null): void {
    watchCounts.events++;
    if (!filename) {
      st.pending.rescanSessions = true;
    } else if (REG_FILE.test(filename)) {
      st.pending.regFiles.add(filename);
    } else {
      watchCounts.ignoredEvents++;
      return;
    }
    schedule();
  }

  /** Start any watcher whose directory exists and is not watched yet. Returns true if one started. */
  function ensureWatchers(st: AccountState): { projects: boolean; sessions: boolean } {
    const started = { projects: false, sessions: false };
    if (st.projectsWatcher === null && fs.existsSync(st.projectsDir)) {
      st.projectsWatcher = watch(st.projectsDir, true, (f) => onProjectsEvent(st, f), () => {
        st.projectsWatcher = null;
      });
      started.projects = st.projectsWatcher !== null;
    }
    if (st.sessionsWatcher === null && fs.existsSync(st.sessionsDir)) {
      st.sessionsWatcher = watch(st.sessionsDir, false, (f) => onSessionsEvent(st, f), () => {
        st.sessionsWatcher = null;
      });
      started.sessions = st.sessionsWatcher !== null;
    }
    return started;
  }

  function watch(
    dir: string,
    recursive: boolean,
    onEvent: (filename: string | null) => void,
    onClosed: () => void,
  ): fs.FSWatcher | null {
    try {
      const w = fs.watch(dir, { recursive }, (_type, filename) => onEvent(filename));
      w.on("error", (err) => {
        watchCounts.errors++;
        lastError = `watch ${dir}: ${err.message}`;
        w.close();
        // The sweep starts a new watcher (and rescans) once the directory is back.
        onClosed();
      });
      return w;
    } catch (err) {
      watchCounts.errors++;
      lastError = `watch ${dir}: ${err instanceof Error ? err.message : String(err)}`;
      return null;
    }
  }

  async function flush(): Promise<void> {
    if (stopped) return;
    for (const st of states) {
      const p = st.pending;
      st.pending = emptyPending();
      const affected = new Set<string>();
      if (p.rescanProjects) {
        watchCounts.rescans++;
        for (const sid of await scanProjects(st)) affected.add(sid);
      } else {
        for (const dir of p.projectDirs) for (const sid of await scanProjectDir(st, dir)) affected.add(sid);
        for (const file of p.transcripts) {
          const sid = await refreshTranscript(st, file, false);
          if (sid !== null) affected.add(sid);
        }
      }
      if (p.rescanSessions) {
        watchCounts.rescans++;
        for (const sid of await scanSessions(st)) affected.add(sid);
      } else {
        for (const name of p.regFiles) for (const sid of await refreshReg(st, name)) affected.add(sid);
      }
      publish(st, affected);
    }
  }

  async function sweep(): Promise<void> {
    if (stopped) return;
    sweeps++;
    for (const st of states) {
      const affected = new Set<string>();
      const fresh = ensureWatchers(st);
      if (fresh.projects) {
        watchCounts.rescans++;
        for (const sid of await scanProjects(st)) affected.add(sid);
      }
      for (const sid of await scanSessions(st)) affected.add(sid);
      for (const sid of checkLiveness(st)) affected.add(sid);
      // ownPids() may have changed since the last sweep; publish() skips unchanged summaries.
      for (const sid of sidsWithRegs(st)) affected.add(sid);
      publish(st, affected);
    }
  }

  return {
    provider: "claude",

    async start(sink: (e: IndexEvent) => void): Promise<void> {
      if (started) throw new Error("claude source already started");
      started = true;
      emit = sink;
      // Watch first, so changes made during the initial scan are queued behind it.
      for (const st of states) ensureWatchers(st);
      await enqueue(async () => {
        for (const st of states) {
          await scanSessions(st);
          checkLiveness(st);
          await scanProjects(st);
          publish(st, st.transcripts.keys());
        }
      });
      if (!stopped) {
        sweepTimer = setInterval(() => void enqueue(sweep), sweepMs);
      }
    },

    resweep(): Promise<void> {
      return started && !stopped ? enqueue(sweep) : Promise.resolve();
    },

    reread(accountId: string, file: string): Promise<void> {
      const st = states.find((s) => s.account.id === accountId);
      if (!st || !started || stopped) return Promise.resolve();
      return enqueue(async () => {
        const sid = await refreshTranscript(st, file, false);
        if (sid !== null) publish(st, [sid]);
      });
    },

    async stop(): Promise<void> {
      stopped = true;
      if (flushTimer !== null) clearTimeout(flushTimer);
      if (sweepTimer !== null) clearInterval(sweepTimer);
      flushTimer = null;
      sweepTimer = null;
      for (const st of states) {
        st.projectsWatcher?.close();
        st.sessionsWatcher?.close();
        st.projectsWatcher = null;
        st.sessionsWatcher = null;
      }
      await chain;
    },

    stats(): ClaudeSourceStats {
      const projects = emptyScanCounts();
      const regs = {
        files: 0,
        live: 0,
        dead: 0,
        unreadable: 0,
        unknownStatus: 0,
        unknownStatusValues: [] as string[],
        liveWithoutTranscript: 0,
        keyFilesIgnored: 0,
        otherFilesIgnored: 0,
      };
      const unknownValues = new Set<string>();
      const missing: string[] = [];
      const projectsDirMissing: string[] = [];
      const sessionsDirMissing: string[] = [];
      let indexed = 0;
      let duplicateSids = 0;
      let activeWatchers = 0;
      for (const st of states) {
        if (!fs.existsSync(st.account.dir)) missing.push(st.account.id);
        else {
          if (!fs.existsSync(st.projectsDir)) projectsDirMissing.push(st.account.id);
          if (!fs.existsSync(st.sessionsDir)) sessionsDirMissing.push(st.account.id);
        }
        for (const k of Object.keys(projects) as (keyof ProjectScanCounts)[]) projects[k] += st.scanCounts[k];
        indexed += st.transcripts.size;
        duplicateSids += st.duplicateSids.size;
        if (st.projectsWatcher) activeWatchers++;
        if (st.sessionsWatcher) activeWatchers++;
        const regNames = new Set([...st.regs.keys(), ...st.unreadableRegs]);
        regs.files += regNames.size;
        regs.unreadable += st.unreadableRegs.size;
        regs.keyFilesIgnored += st.keyFiles;
        regs.otherFilesIgnored += st.otherRegFiles;
        for (const rs of st.regs.values()) {
          if (!rs.alive) {
            regs.dead++;
            continue;
          }
          regs.live++;
          const mapped = mapStatus(rs.reg.status);
          if (!mapped.known) {
            regs.unknownStatus++;
            unknownValues.add(String(rs.reg.status));
          }
          if (!rs.reg.sessionId || !st.transcripts.has(rs.reg.sessionId)) regs.liveWithoutTranscript++;
        }
      }
      regs.unknownStatusValues = [...unknownValues].sort();
      return {
        accounts: { total: states.length, missing, projectsDirMissing, sessionsDirMissing },
        projects,
        indexed,
        duplicateSids,
        registrations: regs,
        reads: { ...counters },
        watch: { ...watchCounts, active: activeWatchers },
        emitted: { ...emitted },
        sweeps,
        lastError,
      };
    },
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Run `fn` over `items` with at most `n` in flight (bounds open file handles, drops nothing). */
async function mapPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
