// Where the pieces of a Claude Code session sit across config dirs (accounts), and who holds it.
//
// A session id is global. Its top-level transcript is `<dir>/projects/<enc>/<id>.jsonl` in one
// account, but its subtree `<dir>/projects/<enc>/<id>/` (subagents, workflows, tool results) can
// be split across project dirs and accounts: a session resumed under another CLAUDE_CONFIG_DIR
// writes its subagent transcripts there. Every lookup here therefore spans all accounts.
//
// Ported from the session management of the dashboard this client replaces (`_claude_subtree_index`,
// `_session_subtree_dirs`, `_claude_session_units`, `_session_unit_paths`, `_claude_orphan_sessions`,
// `_claude_open_pid`, `_is_metadata_stub`, `_transcript_root_cwd`, `_rewrite_cwd_field`).
import fs from "node:fs";
import path from "node:path";
import type { ClaudeAccount } from "../config.ts";
import { isNotFound } from "../claude/meta.ts";
import { isRegistrationLive, parseRegistration } from "../claude/registry.ts";
import type { Registration } from "../claude/registry.ts";
import { lstatOrNull, readDirOrEmpty, treeStats } from "./fsUtil.ts";

/** Claude session ids and Codex thread ids are lowercase UUIDs; nothing else reaches a path or a query. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REG_FILE = /^(\d+)\.json$/;
const AGENT_FILE = /^agent-[0-9a-f]{8,}\.jsonl$/;
export const AGENT_UNIT = /^agent-[0-9a-f]{8,}$/;
export const WORKFLOW_UNIT = /^wf_[0-9a-f]{8}-[0-9a-f]{3,}$/;

/**
 * The top-level transcript `<dir>/projects/<enc>/<id>.jsonl`, as the Claude index sees it: plain
 * project directories, a regular file, and the newest one when an id sits in two of them.
 */
export function findTranscript(accountDir: string, id: string): string | null {
  let best: { file: string; mtimeMs: number } | null = null;
  for (const d of readDirOrEmpty(path.join(accountDir, "projects"))) {
    if (!d.isDirectory()) continue;
    const file = path.join(accountDir, "projects", d.name, `${id}.jsonl`);
    const st = lstatOrNull(file);
    if (st === null || !st.isFile()) continue;
    if (best === null || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
  }
  return best?.file ?? null;
}

/** The account whose config dir holds `file`, or null. */
export function accountOfPath(accounts: ClaudeAccount[], file: string): ClaudeAccount | null {
  return accounts.find((a) => file.startsWith(a.dir + path.sep)) ?? null;
}

// ---- registrations and holders ----

export interface RegFile {
  account: ClaudeAccount;
  /** `<dir>/sessions/<pid>.json` */
  file: string;
  reg: Registration;
  /** `bg` for a windowless `claude --bg` session. */
  kind: string | null;
  jobId: string | null;
}

/** Every parsable registration of every account. An unparsable file is one being written; it is skipped. */
export function readRegistrations(accounts: ClaudeAccount[]): RegFile[] {
  const out: RegFile[] = [];
  for (const account of accounts) {
    const dir = path.join(account.dir, "sessions");
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      if (isNotFound(err)) continue;
      throw err;
    }
    for (const n of names) {
      const m = REG_FILE.exec(n);
      if (!m) continue;
      const file = path.join(dir, n);
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (err) {
        if (isNotFound(err)) continue;
        throw err;
      }
      const reg = parseRegistration(text, Number(m[1]));
      if (reg === null) continue;
      const raw = JSON.parse(text) as Record<string, unknown>;
      out.push({
        account,
        file,
        reg,
        kind: typeof raw.kind === "string" ? raw.kind : null,
        jobId: typeof raw.jobId === "string" ? raw.jobId : null,
      });
    }
  }
  return out;
}

export interface HolderDeps {
  claudeAccounts: ClaudeAccount[];
  /** True while a run of this server holds the Claude session (ClaudeDriver.holds). */
  heldByServer?: (sessionId: string) => boolean;
  /** pids of the Claude processes this server started, so a refusal names the right holder. */
  ownPids?: () => Set<number>;
  /** Default: isRegistrationLive (pid alive and still the process that wrote the file). */
  isRegistrationLive?: (reg: Registration) => boolean;
}

/**
 * server   a run of this server holds the session (also before its process has registered)
 * process  a live process registered the session; `own` when this server started it
 */
export type Holder =
  | { by: "server" }
  | { by: "process"; pid: number; own: boolean; reg: RegFile };

/**
 * Who holds the session open, or null. Registrations of every account count: a session moved to
 * another account can still be open under the old one. Pid liveness decides (with the recorded
 * start time against pid reuse), not the status value: an open TUI between turns reports idle.
 */
export function claudeHolder(deps: HolderDeps, id: string): Holder | null {
  if (deps.heldByServer?.(id)) return { by: "server" };
  const own = deps.ownPids?.() ?? new Set<number>();
  const live = deps.isRegistrationLive ?? ((reg: Registration) => isRegistrationLive(reg));
  for (const r of readRegistrations(deps.claudeAccounts)) {
    if (r.reg.sessionId !== id || !live(r.reg)) continue;
    return { by: "process", pid: r.reg.pid, own: own.has(r.reg.pid), reg: r };
  }
  return null;
}

/** The refusal text for a held session. `then` ends the sentence: what to do once it is closed. */
export function holderMessage(h: Holder, then: string, home: string): string {
  if (h.by === "server") return `This session is run by maru. After the run ends, ${then}`;
  if (h.own) return `This session is run by maru (pid ${h.pid}). After the run ends, ${then}`;
  if (h.reg.kind === "bg") {
    const job = h.reg.jobId ?? (h.reg.reg.sessionId ?? "").slice(0, 8);
    const cfg = h.reg.account.dir.startsWith(home + path.sep) ? `~${h.reg.account.dir.slice(home.length)}` : h.reg.account.dir;
    return `This session is open as a background session (claude --bg, id ${job}, pid ${h.pid}). It has no window, so from a terminal run `
      + `CLAUDE_CONFIG_DIR=${cfg} claude stop ${job} to stop it, then ${then} (the conversation is kept)`;
  }
  return `A Claude process (pid ${h.pid}) has this session open. Exit that process, then ${then}`;
}

/** Registrations of `id` whose process is gone (live ones block every change first). */
export function deadRegistrations(accounts: ClaudeAccount[], id: string): RegFile[] {
  return readRegistrations(accounts).filter((r) => r.reg.sessionId === id);
}

// ---- subtrees ----

export interface Subtree {
  account: ClaudeAccount;
  enc: string;
  /** `<dir>/projects/<enc>/<id>` */
  dir: string;
}

/**
 * Every subtree dir of the session in any account: a real directory (not a symlink) named by the
 * id, directly inside a real project directory of that account.
 */
export function subtreeDirs(accounts: ClaudeAccount[], id: string): Subtree[] {
  if (!SESSION_ID.test(id)) return [];
  const out: Subtree[] = [];
  for (const account of accounts) {
    const projects = path.join(account.dir, "projects");
    for (const d of readDirOrEmpty(projects)) {
      if (!d.isDirectory()) continue;
      const dir = path.join(projects, d.name, id);
      const st = lstatOrNull(dir);
      if (st !== null && st.isDirectory()) out.push({ account, enc: d.name, dir });
    }
  }
  return out;
}

/** `<dir>/session-env/<id>` of every account that has one. */
export function sessionEnvDirs(accounts: ClaudeAccount[], id: string): Array<{ account: ClaudeAccount; dir: string }> {
  if (!SESSION_ID.test(id)) return [];
  const out: Array<{ account: ClaudeAccount; dir: string }> = [];
  for (const account of accounts) {
    const dir = path.join(account.dir, "session-env", id);
    const st = lstatOrNull(dir);
    if (st !== null && st.isDirectory()) out.push({ account, dir });
  }
  return out;
}

/**
 * `<dir>/file-history/<id>` of every account that has one: the pre-edit backups that "되돌리기"
 * (DESIGN.md 6o) restores files from. Claude names the folder by the session id in the account the
 * process ran under, so every account is checked.
 */
export function fileHistoryDirs(accounts: ClaudeAccount[], id: string): Array<{ account: ClaudeAccount; dir: string }> {
  if (!SESSION_ID.test(id)) return [];
  const out: Array<{ account: ClaudeAccount; dir: string }> = [];
  for (const account of accounts) {
    const dir = path.join(account.dir, "file-history", id);
    const st = lstatOrNull(dir);
    if (st !== null && st.isDirectory()) out.push({ account, dir });
  }
  return out;
}

export interface SubtreeScan {
  /** id -> its subtree dirs across accounts */
  dirs: Map<string, Subtree[]>;
  /** Ids that have a top-level transcript in some account. */
  transcripts: Set<string>;
}

/** One pass over every project dir of every account: subtree dirs and transcript ids. */
export function scanProjects(accounts: ClaudeAccount[]): SubtreeScan {
  const dirs = new Map<string, Subtree[]>();
  const transcripts = new Set<string>();
  for (const account of accounts) {
    const projects = path.join(account.dir, "projects");
    for (const d of readDirOrEmpty(projects)) {
      if (!d.isDirectory()) continue;
      for (const e of readDirOrEmpty(path.join(projects, d.name))) {
        if (e.name.endsWith(".jsonl") && (e.isFile() || e.isSymbolicLink())) {
          transcripts.add(e.name.slice(0, -".jsonl".length));
        } else if (e.isDirectory() && SESSION_ID.test(e.name)) {
          const list = dirs.get(e.name) ?? [];
          list.push({ account, enc: d.name, dir: path.join(projects, d.name, e.name) });
          dirs.set(e.name, list);
        }
      }
    }
  }
  return { dirs, transcripts };
}

// ---- units (subagents and workflows inside a subtree) ----

interface WalkEntry {
  abs: string;
  /** Path segments below the subtree dir. */
  parts: string[];
  isDir: boolean;
}

function walk(root: string): WalkEntry[] {
  const out: WalkEntry[] = [];
  const stack: Array<{ dir: string; parts: string[] }> = [{ dir: root, parts: [] }];
  while (stack.length > 0) {
    const { dir, parts } = stack.pop()!;
    for (const e of readDirOrEmpty(dir)) {
      const abs = path.join(dir, e.name);
      const p = [...parts, e.name];
      if (e.isDirectory()) {
        out.push({ abs, parts: p, isDir: true });
        stack.push({ dir: abs, parts: p });
      } else if (e.isFile()) {
        out.push({ abs, parts: p, isDir: false });
      }
    }
  }
  return out;
}

const parentName = (parts: string[]): string | undefined => parts[parts.length - 2];
const inWorkflows = (parts: string[]): boolean => parts.slice(0, -1).includes("workflows");

export interface Unit {
  kind: "subagent" | "workflow";
  unitId: string;
  sizeBytes: number;
  files: number;
  updatedAt: number;
}

export interface UnitScan {
  units: Unit[];
  totalBytes: number;
  unitBytes: number;
  remainderBytes: number;
}

/**
 * The deletable pieces of a session's subtrees, across accounts: each direct subagent
 * (`subagents/agent-<id>.jsonl` and its `.meta.json`, outside any workflows/ segment) and each
 * outermost workflow (`workflows/wf_<id>/`, nested workflows travel with it, plus its
 * `workflows/wf_<id>.json` manifest). The remainder (shared scripts, tool results) has no unit.
 */
export function sessionUnits(subtrees: Subtree[]): UnitScan {
  const subs = new Map<string, Unit>();
  const wfs = new Map<string, Unit>();
  let totalBytes = 0;
  const add = (map: Map<string, Unit>, kind: Unit["kind"], unitId: string, s: { files: number; bytes: number; mtimeMs: number }) => {
    const u = map.get(unitId) ?? { kind, unitId, sizeBytes: 0, files: 0, updatedAt: 0 };
    u.sizeBytes += s.bytes;
    u.files += s.files;
    u.updatedAt = Math.max(u.updatedAt, Math.floor(s.mtimeMs));
    map.set(unitId, u);
  };
  for (const st of subtrees) {
    totalBytes += treeStats(st.dir).bytes;
    const entries = walk(st.dir);
    const wfDirs = entries
      .filter((e) => e.isDir && WORKFLOW_UNIT.test(e.parts.at(-1)!) && parentName(e.parts) === "workflows")
      .sort((a, b) => a.parts.length - b.parts.length);
    const kept: WalkEntry[] = [];
    for (const w of wfDirs) {
      if (kept.some((k) => w.abs.startsWith(k.abs + path.sep))) continue;
      kept.push(w);
    }
    for (const e of entries) {
      const name = e.parts.at(-1)!;
      if (e.isDir || !AGENT_FILE.test(name) || parentName(e.parts) !== "subagents" || inWorkflows(e.parts)) continue;
      const stem = name.slice(0, -".jsonl".length);
      const s = treeStats(e.abs);
      const meta = treeStats(e.abs.slice(0, -".jsonl".length) + ".meta.json");
      add(subs, "subagent", stem, { files: s.files + meta.files, bytes: s.bytes + meta.bytes, mtimeMs: s.mtimeMs });
    }
    for (const w of kept) {
      const id = w.parts.at(-1)!;
      const s = treeStats(w.abs);
      let files = s.files;
      let bytes = s.bytes;
      // The manifest counts here only when no kept dir already holds it.
      for (const e of entries) {
        if (e.isDir || e.parts.at(-1) !== `${id}.json` || parentName(e.parts) !== "workflows") continue;
        if (kept.some((k) => e.abs.startsWith(k.abs + path.sep))) continue;
        const m = treeStats(e.abs);
        files += m.files;
        bytes += m.bytes;
      }
      add(wfs, "workflow", id, { files, bytes, mtimeMs: s.mtimeMs });
    }
  }
  const units = [...subs.values(), ...wfs.values()].sort((a, b) => b.sizeBytes - a.sizeBytes);
  const unitBytes = units.reduce((n, u) => n + u.sizeBytes, 0);
  return { units, totalBytes, unitBytes, remainderBytes: Math.max(0, totalBytes - unitBytes) };
}

/**
 * The paths that make up one unit, across the session's subtrees. The listing and the delete read
 * the same layout, and each path must resolve inside its own subtree dir.
 */
export function unitPaths(subtrees: Subtree[], kind: Unit["kind"], unitId: string): string[] {
  const out: string[] = [];
  for (const st of subtrees) {
    const root = fs.realpathSync(st.dir);
    for (const e of walk(st.dir)) {
      const name = e.parts.at(-1)!;
      let hit = false;
      if (kind === "subagent") {
        hit = !e.isDir && (name === `${unitId}.jsonl` || name === `${unitId}.meta.json`)
          && parentName(e.parts) === "subagents" && !inWorkflows(e.parts);
      } else {
        hit = parentName(e.parts) === "workflows" && (e.isDir ? name === unitId : name === `${unitId}.json`);
      }
      if (!hit) continue;
      const real = fs.realpathSync(e.abs);
      if (real.startsWith(root + path.sep)) out.push(e.abs);
    }
  }
  // A nested dir inside another hit goes with its parent.
  return out.filter((p) => !out.some((q) => q !== p && p.startsWith(q + path.sep)));
}

// ---- transcripts: stubs and cwd ----

/** Claude's `projects/<enc>` name for a cwd: every character outside [A-Za-z0-9] becomes `-`. */
export function cwdToEnc(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * True for a transcript with no conversation (no user or assistant line), the fragment an old
 * process leaves behind when it exits after its session moved and rewrites its title and state.
 * A line that fails to parse counts as conversation, so such a file is never replaced.
 */
export function isMetadataStub(file: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const o = JSON.parse(line) as { type?: unknown };
      if (o.type === "user" || o.type === "assistant") return false;
    } catch {
      return false;
    }
  }
  return true;
}

const CHUNK = 1024 * 1024;

/** Calls `onLine` for every line of a file (without its newline), reading it in chunks. */
function forEachLine(file: string, onLine: (line: string, terminated: boolean) => boolean | void): void {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry: Buffer[] = [];
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n === 0) break;
      pos += n;
      let i = 0;
      while (i < n) {
        const nl = buf.indexOf(10, i);
        if (nl === -1 || nl >= n) {
          carry.push(Buffer.from(buf.subarray(i, n)));
          break;
        }
        carry.push(buf.subarray(i, nl));
        const line = Buffer.concat(carry).toString("utf8");
        carry = [];
        i = nl + 1;
        if (onLine(line, true) === false) return;
      }
    }
    if (carry.length > 0) onLine(Buffer.concat(carry).toString("utf8"), false);
  } finally {
    fs.closeSync(fd);
  }
}

/** The project root the transcript started in: the first absolute top-level `cwd`. */
export function transcriptRootCwd(file: string): string | null {
  let found: string | null = null;
  forEachLine(file, (line) => {
    try {
      const c = (JSON.parse(line) as { cwd?: unknown }).cwd;
      if (typeof c === "string" && c.startsWith("/")) {
        found = c;
        return false;
      }
    } catch {
      // not a JSON line
    }
    return true;
  });
  return found;
}

/**
 * Write `src` to `dst` with every top-level `cwd` equal to `oldRoot` or under it moved to
 * `newRoot`. Other fields (message text, tool input) keep the old path: they are the record of
 * what happened. Lines without such a cwd are copied byte for byte. Returns the rewritten count.
 */
export function copyWithCwd(src: string, dst: string, oldRoot: string, newRoot: string): number {
  const base = oldRoot.replace(/\/+$/, "");
  const prefix = base + "/";
  let changed = 0;
  const out = fs.openSync(dst, "wx", fs.statSync(src).mode & 0o777);
  try {
    forEachLine(src, (line, terminated) => {
      let text = line;
      if (line.includes('"cwd"')) {
        try {
          const o = JSON.parse(line) as Record<string, unknown>;
          const c = o.cwd;
          if (typeof c === "string" && (c === base || c.startsWith(prefix))) {
            o.cwd = newRoot + c.slice(base.length);
            text = JSON.stringify(o);
            changed++;
          }
        } catch {
          // not a JSON line: copied as is
        }
      }
      fs.writeSync(out, terminated ? text + "\n" : text);
    });
  } finally {
    fs.closeSync(out);
  }
  return changed;
}
