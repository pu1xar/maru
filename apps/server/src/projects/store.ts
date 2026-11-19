import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CreateProject, Project, ProviderId, UpdateProject } from "@maru/shared";
import { assignmentKey } from "@maru/shared";

export type ProjectChange =
  | { kind: "projects" }
  /** Assignments, positions or pins of these `provider:id` keys changed. */
  | { kind: "assignments"; keys: string[] };

export class ProjectError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const NAME_MAX = 100;

const SESSION_KEY = /^(claude|codex):[A-Za-z0-9_-]+$/;

/**
 * User-defined projects, hand-made session assignments and the order of sessions inside a
 * project (DESIGN.md 6c). A session's position is fixed the first time the server sees it (minus
 * its update time, so the order it is first shown in is kept and a newer session lands on top)
 * and changes only when the user places sessions.
 *
 * Pins (고정됨) are a separate order on top of that. A pinned session keeps its project and its
 * position there; the sidebar shows it in both (DESIGN.md 6c).
 */
export class ProjectStore {
  private db: DatabaseSync;
  private listeners = new Set<(c: ProjectChange) => void>();
  private assignments = new Map<string, string>();
  private positions = new Map<string, number>();
  /** `provider:id` -> order inside 고정됨, smaller first. */
  private pins = new Map<string, number>();
  /** `provider:id` -> when the session went to 보관함 (ms). */
  private archived = new Map<string, number>();

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        default_cwd TEXT,
        sort_order INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_projects (
        session_key TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        assigned_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_positions (
        session_key TEXT PRIMARY KEY,
        position REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_pins (
        session_key TEXT PRIMARY KEY,
        position REAL NOT NULL,
        pinned_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_archive (
        session_key TEXT PRIMARY KEY,
        archived_at INTEGER NOT NULL
      );
    `);
    for (const row of this.db.prepare("SELECT session_key, project_id FROM session_projects").all()) {
      this.assignments.set(String(row.session_key), String(row.project_id));
    }
    for (const row of this.db.prepare("SELECT session_key, position FROM session_positions").all()) {
      this.positions.set(String(row.session_key), Number(row.position));
    }
    for (const row of this.db.prepare("SELECT session_key, position FROM session_pins").all()) {
      this.pins.set(String(row.session_key), Number(row.position));
    }
    for (const row of this.db.prepare("SELECT session_key, archived_at FROM session_archive").all()) {
      this.archived.set(String(row.session_key), Number(row.archived_at));
    }
  }

  close(): void {
    this.db.close();
  }

  onChange(fn: (c: ProjectChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(c: ProjectChange): void {
    for (const fn of this.listeners) fn(c);
  }

  list(): Project[] {
    return this.db
      .prepare("SELECT id, name, default_cwd, sort_order, created_at FROM projects ORDER BY sort_order, created_at")
      .all()
      .map(toProject);
  }

  private get(id: string): Project {
    const row = this.db
      .prepare("SELECT id, name, default_cwd, sort_order, created_at FROM projects WHERE id = ?")
      .get(id);
    if (!row) throw new ProjectError(404, `project not found: ${id}`);
    return toProject(row);
  }

  create(input: CreateProject): Project {
    const name = cleanName(input.name);
    const defaultCwd = cleanCwd(input.defaultCwd);
    const next = this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM projects").get();
    const project: Project = {
      id: randomUUID(), name, defaultCwd, sortOrder: Number(next?.n ?? 0), createdAt: Date.now(),
    };
    this.db
      .prepare("INSERT INTO projects (id, name, default_cwd, sort_order, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(project.id, project.name, project.defaultCwd, project.sortOrder, project.createdAt);
    this.emit({ kind: "projects" });
    return project;
  }

  update(id: string, patch: UpdateProject): Project {
    const cur = this.get(id);
    const name = patch.name === undefined ? cur.name : cleanName(patch.name);
    const defaultCwd = patch.defaultCwd === undefined ? cur.defaultCwd : cleanCwd(patch.defaultCwd);
    this.db.prepare("UPDATE projects SET name = ?, default_cwd = ? WHERE id = ?").run(name, defaultCwd, id);
    this.emit({ kind: "projects" });
    return { ...cur, name, defaultCwd };
  }

  /** Delete a project; its sessions go back to 미분류. */
  remove(id: string): void {
    this.get(id);
    const keys = [...this.assignments].filter(([, p]) => p === id).map(([k]) => k);
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);   // cascades to session_projects
    for (const k of keys) this.assignments.delete(k);
    this.emit({ kind: "projects" });
    if (keys.length) this.emit({ kind: "assignments", keys });
  }

  /** Set the order to `ids`; it must name every project exactly once. */
  reorder(ids: string[]): Project[] {
    const current = this.list().map((p) => p.id);
    if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((i) => current.includes(i))) {
      throw new ProjectError(400, "order must list every project exactly once");
    }
    const stmt = this.db.prepare("UPDATE projects SET sort_order = ? WHERE id = ?");
    this.db.exec("BEGIN");
    try {
      ids.forEach((id, i) => stmt.run(i, id));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.emit({ kind: "projects" });
    return this.list();
  }

  /** Put a session into a project, or back to 미분류 with null. */
  assign(provider: ProviderId, sessionId: string, projectId: string | null): void {
    if (provider !== "claude" && provider !== "codex") throw new ProjectError(400, "bad provider");
    if (!sessionId) throw new ProjectError(400, "session id required");
    const key = assignmentKey(provider, sessionId);
    if (projectId === null) {
      if (!this.assignments.has(key)) return;
      this.db.prepare("DELETE FROM session_projects WHERE session_key = ?").run(key);
      this.assignments.delete(key);
    } else {
      this.get(projectId);
      if (this.assignments.get(key) === projectId) return;
      this.db
        .prepare(`INSERT INTO session_projects (session_key, project_id, assigned_at) VALUES (?, ?, ?)
                  ON CONFLICT(session_key) DO UPDATE SET project_id = excluded.project_id, assigned_at = excluded.assigned_at`)
        .run(key, projectId, Date.now());
      this.assignments.set(key, projectId);
    }
    this.emit({ kind: "assignments", keys: [key] });
  }

  projectOf(provider: ProviderId, sessionId: string): string | null {
    return this.assignments.get(assignmentKey(provider, sessionId)) ?? null;
  }

  /** The session's position, fixed now from its update time when it has none yet. */
  ensurePosition(provider: ProviderId, sessionId: string, updatedAt: number): number {
    const key = assignmentKey(provider, sessionId);
    const cur = this.positions.get(key);
    if (cur !== undefined) return cur;
    const position = -updatedAt;
    this.db.prepare("INSERT OR IGNORE INTO session_positions (session_key, position) VALUES (?, ?)").run(key, position);
    this.positions.set(key, position);
    return position;
  }

  /**
   * Put `keys` (`provider:id`) into a project (null = 미분류) in this order, top first. Sessions of
   * the project that are not listed keep their positions. Pins are a separate order and stay.
   * A listed session that was in 보관함 comes out of it: placing it is the way out (a drag from
   * 보관함 onto a Group).
   */
  placeSessions(projectId: string | null, keys: string[]): void {
    checkKeys(keys);
    if (projectId !== null) this.get(projectId);
    const upsertProject = this.db.prepare(`INSERT INTO session_projects (session_key, project_id, assigned_at) VALUES (?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET project_id = excluded.project_id, assigned_at = excluded.assigned_at`);
    const unassign = this.db.prepare("DELETE FROM session_projects WHERE session_key = ?");
    const setPosition = this.db.prepare(`INSERT INTO session_positions (session_key, position) VALUES (?, ?)
      ON CONFLICT(session_key) DO UPDATE SET position = excluded.position`);
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      keys.forEach((key, i) => {
        if (projectId === null) unassign.run(key);
        else if (this.assignments.get(key) !== projectId) upsertProject.run(key, projectId, now);
        setPosition.run(key, i);
      });
      this.dropArchive(keys);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    keys.forEach((key, i) => {
      if (projectId === null) this.assignments.delete(key);
      else this.assignments.set(key, projectId);
      this.positions.set(key, i);
      this.archived.delete(key);
    });
    this.emit({ kind: "assignments", keys });
  }

  /** The session's place in 고정됨 (smaller first), or null when it is not pinned. */
  pinOf(provider: ProviderId, sessionId: string): number | null {
    return this.pins.get(assignmentKey(provider, sessionId)) ?? null;
  }

  /** Pin a session at the bottom of 고정됨, or unpin it. Its project and position stay as they are. */
  pin(provider: ProviderId, sessionId: string, pinned: boolean): void {
    if (provider !== "claude" && provider !== "codex") throw new ProjectError(400, "bad provider");
    if (typeof sessionId !== "string" || !sessionId) throw new ProjectError(400, "session id required");
    if (typeof pinned !== "boolean") throw new ProjectError(400, "pinned must be a boolean");
    const key = assignmentKey(provider, sessionId);
    if (pinned === this.pins.has(key)) return;
    if (pinned) {
      let last = -1;
      for (const p of this.pins.values()) last = Math.max(last, p);
      const position = last + 1;
      this.db
        .prepare("INSERT INTO session_pins (session_key, position, pinned_at) VALUES (?, ?, ?)")
        .run(key, position, Date.now());
      this.pins.set(key, position);
    } else {
      this.db.prepare("DELETE FROM session_pins WHERE session_key = ?").run(key);
      this.pins.delete(key);
    }
    this.emit({ kind: "assignments", keys: [key] });
  }

  /**
   * Put `keys` (`provider:id`) into 고정됨 in this order, top first; the ones not pinned yet become
   * pinned. Pinned sessions that are not listed keep their places. A listed session that was in
   * 보관함 comes out of it, as in placeSessions.
   */
  pinSessions(keys: string[]): void {
    checkKeys(keys);
    const upsert = this.db.prepare(`INSERT INTO session_pins (session_key, position, pinned_at) VALUES (?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET position = excluded.position`);
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      keys.forEach((key, i) => upsert.run(key, i, now));
      this.dropArchive(keys);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    keys.forEach((key, i) => this.pins.set(key, i));
    for (const key of keys) this.archived.delete(key);
    this.emit({ kind: "assignments", keys });
  }

  /** When the session went to 보관함 (ms), or null when it is not there. */
  archivedOf(provider: ProviderId, sessionId: string): number | null {
    return this.archived.get(assignmentKey(provider, sessionId)) ?? null;
  }

  /**
   * Move a session to 보관함, or take it out (DESIGN.md 6d). Only this row changes: the session's
   * project, position and pin stay, so taking it out puts it back where it was.
   */
  archive(provider: ProviderId, sessionId: string, archived: boolean): void {
    if (provider !== "claude" && provider !== "codex") throw new ProjectError(400, "bad provider");
    if (typeof sessionId !== "string" || !sessionId) throw new ProjectError(400, "session id required");
    if (typeof archived !== "boolean") throw new ProjectError(400, "archived must be a boolean");
    const key = assignmentKey(provider, sessionId);
    if (archived === this.archived.has(key)) return;
    if (archived) {
      const at = Date.now();
      this.db.prepare("INSERT INTO session_archive (session_key, archived_at) VALUES (?, ?)").run(key, at);
      this.archived.set(key, at);
    } else {
      this.db.prepare("DELETE FROM session_archive WHERE session_key = ?").run(key);
      this.archived.delete(key);
    }
    this.emit({ kind: "assignments", keys: [key] });
  }

  /** Deletes the 보관함 rows of `keys`; the caller owns the transaction and the in-memory map. */
  private dropArchive(keys: readonly string[]): void {
    const del = this.db.prepare("DELETE FROM session_archive WHERE session_key = ?");
    for (const key of keys) if (this.archived.has(key)) del.run(key);
  }

  /** Every `provider:id` key with an assignment, a position, a pin or a 보관함 row. */
  keys(): Set<string> {
    return new Set([...this.assignments.keys(), ...this.positions.keys(), ...this.pins.keys(), ...this.archived.keys()]);
  }

  /**
   * Drop the assignment, position, pin and 보관함 row of sessions that exist nowhere any more
   * (sessions/presence.ts). Returns how many rows of each kind went.
   */
  forget(keys: Iterable<string>): { assignments: number; positions: number; pins: number; archived: number } {
    const n = { assignments: 0, positions: 0, pins: 0, archived: 0 };
    const changed: string[] = [];
    const tables = [
      ["assignments", this.assignments, "session_projects"],
      ["positions", this.positions, "session_positions"],
      ["pins", this.pins, "session_pins"],
      ["archived", this.archived, "session_archive"],
    ] as const;
    this.db.exec("BEGIN");
    try {
      for (const key of keys) {
        let had = false;
        for (const [kind, map, table] of tables) {
          if (!map.has(key)) continue;
          this.db.prepare(`DELETE FROM ${table} WHERE session_key = ?`).run(key);
          n[kind]++;
          had = true;
        }
        if (had) changed.push(key);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    for (const key of changed) for (const [, map] of tables) map.delete(key);
    if (changed.length) this.emit({ kind: "assignments", keys: changed });
    return n;
  }
}

/** A non-empty list of distinct `provider:id` keys. */
function checkKeys(keys: unknown): asserts keys is string[] {
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === "string" && SESSION_KEY.test(k))) {
    throw new ProjectError(400, "keys must be provider:id strings");
  }
  if (new Set(keys).size !== keys.length) throw new ProjectError(400, "keys must not repeat");
}

function toProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    defaultCwd: row.default_cwd == null ? null : String(row.default_cwd),
    sortOrder: Number(row.sort_order),
    createdAt: Number(row.created_at),
  };
}

function cleanName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) throw new ProjectError(400, "name required");
  const n = name.trim();
  if (n.length > NAME_MAX) throw new ProjectError(400, `name longer than ${NAME_MAX} characters`);
  return n;
}

/** Absolute existing directory, `~` expanded, or null when cleared. */
function cleanCwd(cwd: unknown): string | null {
  if (cwd === undefined || cwd === null || cwd === "") return null;
  if (typeof cwd !== "string") throw new ProjectError(400, "defaultCwd must be a string");
  let p = cwd.trim();
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) throw new ProjectError(400, "defaultCwd must be an absolute or ~ path");
  p = path.resolve(p);
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    throw new ProjectError(400, `folder does not exist: ${p}`);
  }
  if (!st.isDirectory()) throw new ProjectError(400, `not a folder: ${p}`);
  return p;
}
