import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderId } from "@maru/shared";
import { assignmentKey } from "@maru/shared";

/**
 * The sessions the user chose to see (DESIGN.md 6d). The UI gets only these; the full scan
 * stays on the server to answer "add a session" searches and to keep chosen sessions live.
 * Keyed by `provider:id` without the account, so a choice follows a session moved between
 * accounts.
 *
 * The first list was an earlier dashboard's lock list, imported once per key while both ran. Its
 * import bookkeeping table (dashboard_lock_imports) is dropped on open; the chosen rows stay.
 */
export class ChosenStore {
  private db: DatabaseSync;
  private chosen = new Set<string>();
  private listeners = new Set<(keys: string[]) => void>();

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS chosen_sessions (
        session_key TEXT PRIMARY KEY,
        chosen_at INTEGER NOT NULL
      );
      DROP TABLE IF EXISTS dashboard_lock_imports;
    `);
    // The first build of this store called the table session_locks.
    const legacy = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_locks'").get();
    if (legacy) {
      this.db.exec(`
        INSERT OR IGNORE INTO chosen_sessions (session_key, chosen_at) SELECT session_key, locked_at FROM session_locks;
        DROP TABLE session_locks;
      `);
    }
    for (const row of this.db.prepare("SELECT session_key FROM chosen_sessions").all()) {
      this.chosen.add(String(row.session_key));
    }
  }

  close(): void {
    this.db.close();
  }

  onChange(fn: (keys: string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  has(provider: ProviderId, sessionId: string): boolean {
    return this.chosen.has(assignmentKey(provider, sessionId));
  }

  count(): number {
    return this.chosen.size;
  }

  set(provider: ProviderId, sessionId: string, chosen: boolean): void {
    if (provider !== "claude" && provider !== "codex") throw new Error("bad provider");
    if (!sessionId) throw new Error("session id required");
    const key = assignmentKey(provider, sessionId);
    if (chosen === this.chosen.has(key)) return;
    if (chosen) {
      this.db.prepare("INSERT OR IGNORE INTO chosen_sessions (session_key, chosen_at) VALUES (?, ?)").run(key, Date.now());
      this.chosen.add(key);
    } else {
      this.db.prepare("DELETE FROM chosen_sessions WHERE session_key = ?").run(key);
      this.chosen.delete(key);
    }
    for (const fn of this.listeners) fn([key]);
  }

  keys(): string[] {
    return [...this.chosen];
  }

  /** Drop sessions that exist nowhere any more (sessions/presence.ts). Returns how many went. */
  forget(keys: Iterable<string>): number {
    const gone = [...new Set(keys)].filter((k) => this.chosen.has(k));
    if (gone.length === 0) return 0;
    const del = this.db.prepare("DELETE FROM chosen_sessions WHERE session_key = ?");
    this.db.exec("BEGIN");
    try {
      for (const k of gone) del.run(k);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    for (const k of gone) this.chosen.delete(k);
    for (const fn of this.listeners) fn(gone);
    return gone.length;
  }
}
