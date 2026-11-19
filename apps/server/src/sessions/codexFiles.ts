// A Codex thread as session management sees it: its row in `<home>/state_5.sqlite`, its rollout
// file, and every subagent thread under it.
//
// The daemon's thread/delete removes a thread together with its subagent threads: their rows,
// spawn edges and rollout files, with a thread/deleted notification for each (measured with
// codex-cli 0.169.0 on throwaway threads). Everything that removes or moves a thread therefore
// works on the family: the thread and all of its descendants.
//
// The daemon is the writer when it answers for the home (thread/delete). Direct writes to the state
// database happen only where the daemon has no method (putting a thread back, adding one to another
// home) or cannot act (no daemon for the home, or a thread it cannot find and has not loaded), the
// same rule rename.ts follows.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { RpcError, connect, controlSocketExists, controlSocketPath } from "../codex/rpc.ts";
import type { CodexRpc } from "../codex/rpc.ts";
import { STATE_DB_FILE, subagentParent } from "../codex/source.ts";
import { appendLines, lstatOrNull } from "./fsUtil.ts";

export const SESSION_INDEX_FILE = "session_index.jsonl";
/** A direct write waits this long for the state database lock, as the dashboard's Python sqlite3 did. */
export const DB_BUSY_WAIT_MS = 5000;

/**
 * A state database value as JSON can hold it: integers past 2^53 and blobs are tagged so a row
 * written back is the row that was read.
 */
export type JsonCell = string | number | null | { $bigint: string } | { $blob: string };
export type JsonRow = Record<string, JsonCell>;

export function encodeCell(v: SQLOutputValue): JsonCell {
  if (typeof v === "bigint") {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : { $bigint: String(v) };
  }
  if (v instanceof Uint8Array) return { $blob: Buffer.from(v).toString("base64") };
  return v;
}

/** Integers bind as BigInt so they are stored as INTEGER, never as a REAL. */
export function decodeCell(v: JsonCell | undefined): SQLInputValue {
  if (v === undefined) return null;
  if (v !== null && typeof v === "object") {
    if ("$bigint" in v) return BigInt(v.$bigint);
    return Buffer.from(v.$blob, "base64");
  }
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  return v;
}

function encodeRow(row: Record<string, SQLOutputValue>): JsonRow {
  const out: JsonRow = {};
  for (const [k, v] of Object.entries(row)) out[k] = encodeCell(v);
  return out;
}

export interface FamilyThread {
  id: string;
  rolloutPath: string | null;
  /** Every column as read. */
  row: JsonRow;
}

export interface ThreadFamily {
  rootId: string;
  /** The root first, then its descendants, parents before children. */
  threads: FamilyThread[];
  /** Rows of thread_dynamic_tools and thread_spawn_edges that name a family thread. */
  dynamicTools: JsonRow[];
  spawnEdges: JsonRow[];
}

export function stateDbPath(home: string): string {
  return path.join(home, STATE_DB_FILE);
}

/**
 * `p` relative to the home, or null when it lies outside. Codex records rollout paths with the
 * home resolved (a symlinked CODEX_HOME shows up as its target), so both spellings count.
 */
export function relativeToHome(home: string, p: string): string | null {
  const roots = [path.resolve(home)];
  try {
    roots.push(fs.realpathSync(home));
  } catch {
    // a missing home: only the spelling given
  }
  for (const root of roots) {
    if (p.startsWith(root + path.sep)) return p.slice(root.length + 1);
  }
  return null;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function readRows(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): Array<Record<string, SQLOutputValue>> {
  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  return stmt.all(...params);
}

/**
 * The thread and its descendants, read-only. Children come from thread_spawn_edges and from the
 * parent id a subagent's `source` names, whichever records them. null when the database or the
 * root row is missing.
 */
export function readFamily(home: string, rootId: string): ThreadFamily | null {
  const file = stateDbPath(home);
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const root = readRows(db, "SELECT * FROM threads WHERE id = ?", rootId)[0];
    if (!root) return null;
    const edges = hasTable(db, "thread_spawn_edges");
    const tools = hasTable(db, "thread_dynamic_tools");
    const threads: FamilyThread[] = [];
    const seen = new Set<string>();
    const queue: Array<Record<string, SQLOutputValue>> = [root];
    while (queue.length > 0) {
      const row = queue.shift()!;
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      threads.push({ id, rolloutPath: typeof row.rollout_path === "string" && row.rollout_path !== "" ? row.rollout_path : null, row: encodeRow(row) });
      const childIds = new Set<string>();
      if (edges) {
        for (const e of readRows(db, "SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ?", id)) {
          childIds.add(String(e.child_thread_id));
        }
      }
      for (const r of readRows(db, "SELECT id, source FROM threads WHERE instr(source, ?) > 0", id)) {
        if (subagentParent(typeof r.source === "string" ? r.source : null) === id) childIds.add(String(r.id));
      }
      for (const c of childIds) {
        if (seen.has(c)) continue;
        const child = readRows(db, "SELECT * FROM threads WHERE id = ?", c)[0];
        if (child) queue.push(child);
      }
    }
    const ids = threads.map((t) => t.id);
    const marks = ids.map(() => "?").join(",");
    return {
      rootId,
      threads,
      dynamicTools: tools ? readRows(db, `SELECT * FROM thread_dynamic_tools WHERE thread_id IN (${marks})`, ...ids).map(encodeRow) : [],
      spawnEdges: edges
        ? readRows(db, `SELECT * FROM thread_spawn_edges WHERE child_thread_id IN (${marks}) OR parent_thread_id IN (${marks})`, ...ids, ...ids).map(encodeRow)
        : [],
    };
  } finally {
    db.close();
  }
}

/** Ids among `ids` that have a row in the home's state database. */
export function presentIds(home: string, ids: string[]): Set<string> {
  const file = stateDbPath(home);
  const out = new Set<string>();
  if (!fs.existsSync(file) || ids.length === 0) return out;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT id FROM threads WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids);
    for (const r of rows) out.add(String(r.id));
  } finally {
    db.close();
  }
  return out;
}

const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/**
 * Rollout files under `<home>/sessions/` that no thread row references and whose thread id (the
 * first UUID in the file name) has no row, grouped by that id. A stray rollout of a thread that
 * still has a row (an older file after a fork) is not an orphan; it becomes one only once the
 * thread is gone. null when the home has no state database: without the rows every rollout
 * would look orphaned.
 */
export function orphanRollouts(home: string): Map<string, string[]> | null {
  const file = stateDbPath(home);
  if (!fs.existsSync(file)) return null;
  const ids = new Set<string>();
  const referenced = new Set<string>();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const r of db.prepare("SELECT id, rollout_path FROM threads").all()) {
      ids.add(String(r.id));
      if (typeof r.rollout_path === "string") referenced.add(r.rollout_path);
    }
  } finally {
    db.close();
  }
  const out = new Map<string, string[]>();
  // Rows hold resolved paths; a file counts as referenced under either spelling.
  const sessions = path.join(home, "sessions");
  let resolved: string;
  try {
    resolved = fs.realpathSync(sessions);
  } catch {
    return out;
  }
  const stack = [sessions];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      if (referenced.has(p) || referenced.has(resolved + p.slice(sessions.length))) continue;
      const m = UUID_ANY.exec(e.name);
      if (!m || ids.has(m[0])) continue;
      const list = out.get(m[0]) ?? [];
      list.push(p);
      out.set(m[0], list);
    }
  }
  return out;
}

/** Columns of a table in an open database. */
function columnsOf(db: DatabaseSync, table: string): Set<string> {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name)));
}

function insertRow(db: DatabaseSync, table: string, cols: Set<string>, row: JsonRow, override: JsonRow = {}): void {
  const merged = { ...row, ...override };
  const names = Object.keys(merged).filter((c) => cols.has(c));
  if (names.length === 0) return;
  db.prepare(`INSERT INTO ${table} (${names.map((c) => `"${c}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...names.map((c) => decodeCell(merged[c])));
}

/**
 * Write a family's rows into a home's state database in one transaction. Only the columns both
 * sides know are written: two homes run different codex versions and their `threads` tables differ
 * (measured: ~/.codex has 3 columns ~/.codex-other lacks), so a column the target lacks is left
 * out and a column the row lacks takes the target's default. `rolloutPath` gives each thread's
 * rollout path in the target. An id that already exists fails the whole write.
 */
export function insertFamilyRows(home: string, family: ThreadFamily, rolloutPath: (t: FamilyThread) => string | null, threadOverride: JsonRow = {}): void {
  const db = new DatabaseSync(stateDbPath(home), { timeout: DB_BUSY_WAIT_MS });
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const threadCols = columnsOf(db, "threads");
      for (const t of family.threads) {
        const p = rolloutPath(t);
        insertRow(db, "threads", threadCols, t.row, { ...threadOverride, ...(p !== null ? { rollout_path: p } : {}) });
      }
      if (hasTable(db, "thread_dynamic_tools")) {
        const cols = columnsOf(db, "thread_dynamic_tools");
        for (const r of family.dynamicTools) insertRow(db, "thread_dynamic_tools", cols, r);
      }
      if (hasTable(db, "thread_spawn_edges")) {
        const cols = columnsOf(db, "thread_spawn_edges");
        const ids = new Set(family.threads.map((t) => t.id));
        for (const r of family.spawnEdges) {
          // An edge to a thread outside the family stays out: it would point at nothing here.
          if (!ids.has(String(r.parent_thread_id)) || !ids.has(String(r.child_thread_id))) continue;
          const exists = db.prepare("SELECT 1 FROM thread_spawn_edges WHERE child_thread_id = ?").get(decodeCell(r.child_thread_id));
          if (!exists) insertRow(db, "thread_spawn_edges", cols, r);
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.close();
  }
}

/** Delete the rows of these threads (and their tools and spawn edges) in one transaction. */
export function deleteRows(home: string, ids: string[]): void {
  if (ids.length === 0) return;
  const db = new DatabaseSync(stateDbPath(home), { timeout: DB_BUSY_WAIT_MS });
  try {
    const marks = ids.map(() => "?").join(",");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (hasTable(db, "thread_dynamic_tools")) db.prepare(`DELETE FROM thread_dynamic_tools WHERE thread_id IN (${marks})`).run(...ids);
      if (hasTable(db, "thread_spawn_edges")) {
        db.prepare(`DELETE FROM thread_spawn_edges WHERE child_thread_id IN (${marks}) OR parent_thread_id IN (${marks})`).run(...ids, ...ids);
      }
      db.prepare(`DELETE FROM threads WHERE id IN (${marks})`).run(...ids);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.close();
  }
}

/** The thread_name records thread/name/set appends, for threads that carry a name. */
export function appendSessionIndex(home: string, family: ThreadFamily): void {
  const recs = family.threads
    .filter((t) => typeof t.row.name === "string" && t.row.name !== "")
    .map((t) => ({ id: t.id, thread_name: t.row.name, updated_at: new Date().toISOString() }));
  if (recs.length > 0) appendLines(path.join(home, SESSION_INDEX_FILE), recs);
}

// ---- daemon ----

/** The home's daemon, connected and initialized; null when none answers (no socket, or a socket file with nothing behind it). */
export async function daemonFor(home: string): Promise<CodexRpc | null> {
  if (!controlSocketExists(controlSocketPath(home))) return null;
  try {
    return await connect(home);
  } catch {
    return null;
  }
}

/** Ids the daemon has loaded, read to the last page. */
export async function loadedIds(rpc: CodexRpc): Promise<Set<string>> {
  const out = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: { data: string[]; nextCursor: string | null } = await rpc.request("thread/loaded/list", { cursor });
    for (const id of page.data) out.add(id);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/** A refused or failed step; `status` is the HTTP status. */
export class CodexStepError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CodexStepError";
    this.status = status;
  }
}

/**
 * Remove the family from its home. With a daemon: thread/delete on the root, then on any family
 * thread still listed in the database. A thread the daemon cannot find and has not loaded (an
 * archived one, a row without its rollout) is removed directly, as is the whole family when no
 * daemon answers: rows in one transaction, then the rollout files. A daemon that has the thread
 * loaded and refuses is not bypassed. Returns how the root was removed.
 */
export async function removeFamily(home: string, family: ThreadFamily, rpc: CodexRpc | null): Promise<"daemon" | "direct"> {
  const ids = family.threads.map((t) => t.id);
  let how: "daemon" | "direct" = "direct";
  if (rpc !== null) {
    let loaded: Set<string> | null = null;
    for (const id of ids) {
      if (!presentIds(home, [id]).has(id)) continue;
      try {
        await rpc.request("thread/delete", { threadId: id });
        if (id === family.rootId) how = "daemon";
      } catch (err) {
        if (!(err instanceof RpcError)) throw new CodexStepError(502, `Codex daemon communication failed: ${messageOf(err)}`);
        loaded ??= await loadedIds(rpc).catch((e: unknown) => {
          throw new CodexStepError(502, `Codex daemon communication failed: ${messageOf(e)}`);
        });
        if (loaded.has(id)) throw new CodexStepError(502, `Codex daemon refused to delete the thread: ${err.message}`);
        // Not found and not loaded: removed directly below.
      }
    }
  }
  const left = [...presentIds(home, ids)];
  deleteRows(home, left);
  for (const t of family.threads) {
    if (t.rolloutPath !== null && lstatOrNull(t.rolloutPath) !== null) fs.unlinkSync(t.rolloutPath);
  }
  return how;
}

/**
 * Why the family must not change now, or null. A thread the daemon has loaded, or a rollout a
 * codex process has open (the daemon itself and a standalone TUI both show up in lsof), belongs
 * to someone else.
 */
export async function familyOpenProblem(family: ThreadFamily, rpc: CodexRpc | null, openFiles: Set<string>): Promise<string | null> {
  if (rpc !== null) {
    let loaded: Set<string>;
    try {
      loaded = await loadedIds(rpc);
    } catch (err) {
      throw new CodexStepError(502, `Codex daemon communication failed: ${messageOf(err)}`);
    }
    const hit = family.threads.find((t) => loaded.has(t.id));
    if (hit) {
      return hit.id === family.rootId
        ? "The Codex daemon has this thread loaded. Close the client using it, then try again"
        : `The Codex daemon has a subagent thread of this thread (${hit.id}) loaded`;
    }
  }
  const open = family.threads.find((t) => t.rolloutPath !== null && openFiles.has(t.rolloutPath));
  if (open) return "A running codex process has this thread's rollout open. Try again after it exits";
  return null;
}

/**
 * Paths of the .jsonl files that processes named codex* have open, from `lsof -c codex -Fn`.
 * Every .jsonl counts, so a rollout under archived_sessions/ is seen as well.
 */
export function codexOpenJsonl(): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    execFile("lsof", ["-c", "codex", "-Fn"], { maxBuffer: Infinity }, (err, stdout) => {
      // lsof exits 1 when no process matches. An exit status is no failure; a spawn error or a
      // signal (code not a number) is.
      if (err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code !== "number") {
        reject(err);
        return;
      }
      const out = new Set<string>();
      for (const line of stdout.split("\n")) {
        if (line.startsWith("n") && line.endsWith(".jsonl")) out.add(line.slice(1));
      }
      resolve(out);
    });
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
