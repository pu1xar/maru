// The client's trash (DESIGN.md 6, 삭제): `<root>/<key>/` holds a deleted session's data next to
// a meta.json that says where each piece came from, so an entry describes itself and moves as one
// folder. The root is `~/.config/maru/trash` (config.ts TRASH_DIR).
//
// Claude entry:  transcript.jsonl, subtrees/<i>/, sessions/<i>.json, session-env/<i>/,
//                file-history/<i>/
// Codex entry:   rollouts/<i>.jsonl (hard links made before the thread was removed) and the
//                thread rows (the thread and its subagent threads) inside meta.json
//
// Codex threads in the trash are out of the home entirely, rows and rollouts, so `archived = 1`
// keeps meaning "보관" only (DESIGN.md 6, 보관). Restoring writes the rows back directly: the
// daemon has no method that adds a thread, and it reads a restored row and rollout as any other
// (measured: thread/read and thread/list return the thread again).
import fs from "node:fs";
import path from "node:path";
import type { ProviderId, TrashItem, TrashList } from "@maru/shared";
import type { ClaudeAccount, CodexAccount } from "../config.ts";
import { SESSION_ID, findTranscript } from "./claudeFiles.ts";
import type { RegFile, Subtree } from "./claudeFiles.ts";
import { deleteRows, insertFamilyRows, presentIds, relativeToHome, stateDbPath } from "./codexFiles.ts";
import type { JsonRow, ThreadFamily } from "./codexFiles.ts";
import { errorMessage, linkOrCopy, lstatOrNull, moveSync, readDirOrEmpty, treeStats } from "./fsUtil.ts";

export const META_FILE = "meta.json";
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__(claude|codex)-[A-Za-z0-9._-]+$/;

/** A refused or failed trash step; `status` is the HTTP status. */
export class TrashError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TrashError";
    this.status = status;
  }
}

interface BaseMeta {
  version: 1;
  provider: ProviderId;
  account: string;
  id: string;
  name: string | null;
  sizeBytes: number;
  /** ms since epoch */
  deletedAt: number;
}

export interface ClaudeMeta extends BaseMeta {
  provider: "claude";
  claude: {
    configDir: string;
    enc: string;
    /** Entry-relative path of the transcript. */
    transcript: string;
    subtrees: Array<{ configDir: string; enc: string; path: string }>;
    registrations: Array<{ configDir: string; name: string; path: string }>;
    sessionEnv: Array<{ configDir: string; path: string }>;
    /** Absent in entries made before file-history was kept. */
    fileHistory: Array<{ configDir: string; path: string }>;
  };
}

export interface CodexMeta extends BaseMeta {
  provider: "codex";
  codex: {
    home: string;
    threads: Array<{ id: string; rolloutPath: string | null; file: string | null; row: JsonRow }>;
    dynamicTools: JsonRow[];
    spawnEdges: JsonRow[];
  };
}

export type TrashMeta = ClaudeMeta | CodexMeta;

export interface ClaudePieces {
  account: ClaudeAccount;
  id: string;
  name: string | null;
  sizeBytes: number;
  transcript: string;
  subtrees: Subtree[];
  registrations: RegFile[];
  sessionEnv: Array<{ account: ClaudeAccount; dir: string }>;
  fileHistory: Array<{ account: ClaudeAccount; dir: string }>;
}

export interface CodexPieces {
  account: CodexAccount;
  id: string;
  name: string | null;
  sizeBytes: number;
  family: ThreadFamily;
  /** ms since epoch; default now. An entry carried over from the dashboard keeps its own time. */
  deletedAt?: number;
}

/** What a restore put back, for the index refresh. */
export type Restored =
  | { provider: "claude"; account: string; id: string; transcript: string }
  | { provider: "codex"; account: string; id: string; ids: string[] };

export interface TrashDeps {
  root: string;
  claudeAccounts: ClaudeAccount[];
  codexAccounts: CodexAccount[];
  now?: () => number;
}

export class TrashStore {
  readonly root: string;
  private deps: TrashDeps;

  constructor(deps: TrashDeps) {
    this.deps = deps;
    this.root = deps.root;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // ---- list ----

  list(): TrashList {
    const items: TrashItem[] = [];
    const unreadable: TrashList["unreadable"] = [];
    for (const d of readDirOrEmpty(this.root)) {
      if (d.name.startsWith(".")) continue;
      if (!d.isDirectory()) {
        unreadable.push({ key: d.name, error: "Not a folder" });
        continue;
      }
      let meta: TrashMeta;
      try {
        meta = this.readMeta(d.name);
      } catch (err) {
        unreadable.push({ key: d.name, error: errorMessage(err) });
        continue;
      }
      items.push({
        key: d.name,
        provider: meta.provider,
        account: meta.account,
        id: meta.id,
        name: meta.name,
        sizeBytes: meta.sizeBytes,
        deletedAt: meta.deletedAt,
        threads: meta.provider === "codex" ? meta.codex.threads.length : 1,
        problem: this.problemOf(d.name, meta),
      });
    }
    items.sort((a, b) => b.deletedAt - a.deletedAt);
    return { items, totalBytes: items.reduce((n, i) => n + i.sizeBytes, 0), unreadable };
  }

  /** Why a restore would be refused regardless of what sits at the target, or null. */
  private problemOf(key: string, meta: TrashMeta): string | null {
    const entry = this.entryDir(key);
    if (meta.provider === "claude") {
      if (!this.deps.claudeAccounts.some((a) => a.dir === meta.claude.configDir)) return `Claude account not in the settings: ${meta.claude.configDir}`;
      if (lstatOrNull(path.join(entry, meta.claude.transcript)) === null) return "The archived copy has no transcript";
      return null;
    }
    if (!this.deps.codexAccounts.some((a) => a.home === meta.codex.home)) return `Codex home not in the settings: ${meta.codex.home}`;
    if (!fs.existsSync(stateDbPath(meta.codex.home))) return "Codex state DB not found";
    const missing = meta.codex.threads.filter((t) => t.file !== null && lstatOrNull(path.join(entry, t.file)) === null);
    return missing.length > 0 ? `${missing.length} rollout ${missing.length === 1 ? "file is" : "files are"} missing from the archived copy` : null;
  }

  // ---- put ----

  /** A fresh entry dir for the session; a second deletion of one id gets its own key. */
  private newEntry(provider: ProviderId, account: string, id: string): { key: string; dir: string } {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    let key = `${id}__${provider}-${account}`;
    for (let n = 2; lstatOrNull(this.entryDir(key)) !== null; n++) key = `${id}__${provider}-${account}-${n}`;
    const dir = this.entryDir(key);
    fs.mkdirSync(dir);
    return { key, dir };
  }

  /**
   * Move a Claude session's pieces into a new entry: the meta first, then each piece. A failure
   * puts back what was moved and leaves no entry.
   */
  putClaude(p: ClaudePieces): string {
    const { key, dir } = this.newEntry("claude", p.account.id, p.id);
    const meta: ClaudeMeta = {
      version: 1,
      provider: "claude",
      account: p.account.id,
      id: p.id,
      name: p.name,
      sizeBytes: p.sizeBytes,
      deletedAt: this.now(),
      claude: {
        configDir: p.account.dir,
        enc: path.basename(path.dirname(p.transcript)),
        transcript: "transcript.jsonl",
        subtrees: p.subtrees.map((s, i) => ({ configDir: s.account.dir, enc: s.enc, path: `subtrees/${i}` })),
        registrations: p.registrations.map((r, i) => ({ configDir: r.account.dir, name: path.basename(r.file), path: `sessions/${i}.json` })),
        sessionEnv: p.sessionEnv.map((s, i) => ({ configDir: s.account.dir, path: `session-env/${i}` })),
        fileHistory: p.fileHistory.map((s, i) => ({ configDir: s.account.dir, path: `file-history/${i}` })),
      },
    };
    const moves: Array<[string, string]> = [[p.transcript, meta.claude.transcript]];
    p.subtrees.forEach((s, i) => moves.push([s.dir, meta.claude.subtrees[i]!.path]));
    p.registrations.forEach((r, i) => moves.push([r.file, meta.claude.registrations[i]!.path]));
    p.sessionEnv.forEach((s, i) => moves.push([s.dir, meta.claude.sessionEnv[i]!.path]));
    p.fileHistory.forEach((s, i) => moves.push([s.dir, meta.claude.fileHistory[i]!.path]));
    try {
      writeMeta(dir, meta);
      moveAll(moves.map(([from, rel]) => [from, path.join(dir, rel)]));
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new TrashError(500, `Could not move to the trash: ${errorMessage(err)}`);
    }
    return key;
  }

  /**
   * Keep a Codex family before it is removed: hard links to the rollouts and the rows in meta.json.
   * The caller removes the family from its home next and calls discard() if that fails.
   */
  keepCodex(p: CodexPieces): { key: string; discard: () => void } {
    const { key, dir } = this.newEntry("codex", p.account.id, p.id);
    const meta: CodexMeta = {
      version: 1,
      provider: "codex",
      account: p.account.id,
      id: p.id,
      name: p.name,
      sizeBytes: p.sizeBytes,
      deletedAt: p.deletedAt ?? this.now(),
      codex: {
        home: p.account.home,
        threads: [],
        dynamicTools: p.family.dynamicTools,
        spawnEdges: p.family.spawnEdges,
      },
    };
    try {
      p.family.threads.forEach((t, i) => {
        let file: string | null = null;
        if (t.rolloutPath !== null && lstatOrNull(t.rolloutPath) !== null) {
          file = `rollouts/${i}.jsonl`;
          linkOrCopy(t.rolloutPath, path.join(dir, file));
        }
        meta.codex.threads.push({ id: t.id, rolloutPath: t.rolloutPath, file, row: t.row });
      });
      writeMeta(dir, meta);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new TrashError(500, `Could not save to the trash: ${errorMessage(err)}`);
    }
    return { key, discard: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  // ---- restore and purge ----

  restore(key: string): Restored {
    const meta = this.readMeta(this.checkKey(key));
    const entry = this.entryDir(key);
    const problem = this.problemOf(key, meta);
    if (problem !== null) throw new TrashError(409, problem);
    const restored = meta.provider === "claude" ? this.restoreClaude(entry, meta) : this.restoreCodex(entry, meta);
    fs.rmSync(entry, { recursive: true, force: true });
    return restored;
  }

  private restoreClaude(entry: string, meta: ClaudeMeta): Restored {
    const c = meta.claude;
    const account = this.deps.claudeAccounts.find((a) => a.dir === c.configDir)!;
    if (findTranscript(c.configDir, meta.id) !== null) {
      throw new TrashError(409, `Account ${account.id} already has this session's transcript`);
    }
    const transcript = path.join(c.configDir, "projects", c.enc, `${meta.id}.jsonl`);
    const moves: Array<[string, string]> = [];
    for (const s of c.subtrees) {
      const from = path.join(entry, s.path);
      if (lstatOrNull(from) === null) continue;
      const to = path.join(s.configDir, "projects", s.enc, meta.id);
      if (lstatOrNull(to) !== null) throw new TrashError(409, `A folder already exists at the subtree location: ${to}`);
      moves.push([from, to]);
    }
    // A registration, session-env or file-history dir whose place is taken stays behind and goes with the entry:
    // the registration is a dead process's, and a name in use belongs to a live one.
    for (const r of c.registrations) {
      const from = path.join(entry, r.path);
      const to = path.join(r.configDir, "sessions", r.name);
      if (lstatOrNull(from) !== null && lstatOrNull(to) === null) moves.push([from, to]);
    }
    for (const s of c.sessionEnv) {
      const from = path.join(entry, s.path);
      const to = path.join(s.configDir, "session-env", meta.id);
      if (lstatOrNull(from) !== null && lstatOrNull(to) === null) moves.push([from, to]);
    }
    for (const s of c.fileHistory) {
      const from = path.join(entry, s.path);
      const to = path.join(s.configDir, "file-history", meta.id);
      if (lstatOrNull(from) !== null && lstatOrNull(to) === null) moves.push([from, to]);
    }
    // The transcript goes last, so the index sees the session once its pieces are back.
    moves.push([path.join(entry, c.transcript), transcript]);
    try {
      moveAll(moves);
    } catch (err) {
      throw new TrashError(500, `Could not restore: ${errorMessage(err)}`);
    }
    return { provider: "claude", account: account.id, id: meta.id, transcript };
  }

  private restoreCodex(entry: string, meta: CodexMeta): Restored {
    const c = meta.codex;
    const account = this.deps.codexAccounts.find((a) => a.home === c.home)!;
    const ids = c.threads.map((t) => t.id);
    const present = presentIds(c.home, ids);
    if (present.size > 0) throw new TrashError(409, `${account.id} already has the same thread: ${[...present].join(", ")}`);
    const moves: Array<[string, string]> = [];
    for (const t of c.threads) {
      if (t.file === null || t.rolloutPath === null) continue;
      if (lstatOrNull(t.rolloutPath) !== null) throw new TrashError(409, `A file already exists at the rollout location: ${t.rolloutPath}`);
      moves.push([path.join(entry, t.file), t.rolloutPath]);
    }
    const family: ThreadFamily = {
      rootId: meta.id,
      threads: c.threads.map((t) => ({ id: t.id, rolloutPath: t.rolloutPath, row: t.row })),
      dynamicTools: c.dynamicTools,
      spawnEdges: c.spawnEdges,
    };
    // Rows first: until the rollouts are back the daemon cannot open the thread, and nothing
    // rebuilds a row from a rollout in between.
    try {
      insertFamilyRows(c.home, family, (t) => t.rolloutPath);
    } catch (err) {
      throw new TrashError(409, `Could not restore the thread record: ${errorMessage(err)}`);
    }
    try {
      moveAll(moves);
    } catch (err) {
      deleteRows(c.home, ids);
      throw new TrashError(500, `Could not restore the rollout: ${errorMessage(err)}`);
    }
    return { provider: "codex", account: account.id, id: meta.id, ids };
  }

  purge(key: string): { freedBytes: number; provider: ProviderId; id: string } {
    const meta = this.readMeta(this.checkKey(key));
    const entry = this.entryDir(key);
    const freedBytes = treeStats(entry).bytes;
    fs.rmSync(entry, { recursive: true, force: true });
    return { freedBytes, provider: meta.provider, id: meta.id };
  }

  // ---- entries ----

  entryDir(key: string): string {
    return path.join(this.root, key);
  }

  private checkKey(key: unknown): string {
    if (typeof key !== "string" || !KEY.test(key)) throw new TrashError(400, "Not a valid trash key");
    const st = lstatOrNull(this.entryDir(key));
    if (st === null || !st.isDirectory()) throw new TrashError(404, `Not in the trash: ${key}`);
    return key;
  }

  /** Read and check an entry's meta.json. Every path it names must stay inside the entry. */
  readMeta(key: string): TrashMeta {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(this.entryDir(key), META_FILE), "utf8"));
    } catch (err) {
      throw new TrashError(422, `Could not read meta.json: ${errorMessage(err)}`);
    }
    return checkMeta(raw);
  }
}

export function writeMeta(dir: string, meta: TrashMeta): void {
  const tmp = path.join(dir, `.${META_FILE}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 1));
  fs.renameSync(tmp, path.join(dir, META_FILE));
}

/** Run the moves in order; on a failure move the done ones back (best effort) and rethrow. */
function moveAll(moves: Array<[string, string]>): void {
  const done: Array<[string, string]> = [];
  try {
    for (const [from, to] of moves) {
      moveSync(from, to);
      done.push([from, to]);
    }
  } catch (err) {
    for (const [from, to] of done.reverse()) {
      try {
        moveSync(to, from);
      } catch {
        // left where it is; the error below names the step that failed
      }
    }
    throw err;
  }
}

function fail(msg: string): never {
  throw new TrashError(422, `meta.json is invalid: ${msg}`);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A relative path that stays inside the entry. */
function rel(v: unknown, what: string): string {
  if (typeof v !== "string" || v === "" || path.isAbsolute(v)) fail(`${what}: not a relative path`);
  const n = path.normalize(v);
  if (n.startsWith("..") || n.split(path.sep).includes("..")) fail(`${what}: points outside the entry`);
  return n;
}

function abs(v: unknown, what: string): string {
  if (typeof v !== "string" || !path.isAbsolute(v)) fail(`${what}: not an absolute path`);
  return path.normalize(v);
}

function segment(v: unknown, what: string): string {
  if (typeof v !== "string" || v === "" || v === "." || v === ".." || v.includes("/")) fail(`${what}: not a folder name`);
  return v;
}

export function checkMeta(raw: unknown): TrashMeta {
  if (!isObj(raw)) fail("not an object");
  if (raw.version !== 1) fail(`version ${String(raw.version)}`);
  if (typeof raw.id !== "string" || !SESSION_ID.test(raw.id)) fail("id");
  if (typeof raw.account !== "string") fail("account");
  const base = {
    version: 1 as const,
    account: raw.account,
    id: raw.id,
    name: typeof raw.name === "string" && raw.name !== "" ? raw.name : null,
    sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : 0,
    deletedAt: typeof raw.deletedAt === "number" ? raw.deletedAt : 0,
  };
  if (raw.provider === "claude") {
    const c = raw.claude;
    if (!isObj(c)) fail("claude");
    const list = (v: unknown, what: string): Record<string, unknown>[] => {
      if (!Array.isArray(v) || !v.every(isObj)) fail(what);
      return v as Record<string, unknown>[];
    };
    return {
      ...base,
      provider: "claude",
      claude: {
        configDir: abs(c.configDir, "configDir"),
        enc: segment(c.enc, "enc"),
        transcript: rel(c.transcript, "transcript"),
        subtrees: list(c.subtrees, "subtrees").map((s) => ({ configDir: abs(s.configDir, "subtree configDir"), enc: segment(s.enc, "subtree enc"), path: rel(s.path, "subtree path") })),
        registrations: list(c.registrations, "registrations").map((r) => {
          const name = segment(r.name, "registration name");
          if (!/^\d+\.json$/.test(name)) fail("registration name");
          return { configDir: abs(r.configDir, "registration configDir"), name, path: rel(r.path, "registration path") };
        }),
        sessionEnv: list(c.sessionEnv, "sessionEnv").map((s) => ({ configDir: abs(s.configDir, "sessionEnv configDir"), path: rel(s.path, "sessionEnv path") })),
        fileHistory: list(c.fileHistory ?? [], "fileHistory").map((s) => ({ configDir: abs(s.configDir, "fileHistory configDir"), path: rel(s.path, "fileHistory path") })),
      },
    };
  }
  if (raw.provider === "codex") {
    const c = raw.codex;
    if (!isObj(c) || !Array.isArray(c.threads) || c.threads.length === 0) fail("codex");
    const rows = (v: unknown, what: string): JsonRow[] => {
      if (!Array.isArray(v) || !v.every(isObj)) fail(what);
      return v as JsonRow[];
    };
    const home = abs(c.home, "home");
    const threads = (c.threads as unknown[]).map((t) => {
      if (!isObj(t) || typeof t.id !== "string" || !SESSION_ID.test(t.id) || !isObj(t.row)) fail("threads");
      const rolloutPath = t.rolloutPath === null ? null : abs(t.rolloutPath, "rolloutPath");
      if (rolloutPath !== null && relativeToHome(home, rolloutPath) === null) fail("rolloutPath: outside home");
      return { id: t.id, rolloutPath, file: t.file === null ? null : rel(t.file, "rollout file"), row: t.row as JsonRow };
    });
    if (threads[0]!.id !== raw.id) fail("first thread differs from id");
    return { ...base, provider: "codex", codex: { home, threads, dynamicTools: rows(c.dynamicTools, "dynamicTools"), spawnEdges: rows(c.spawnEdges, "spawnEdges") } };
  }
  return fail("provider");
}
