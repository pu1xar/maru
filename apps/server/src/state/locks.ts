import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderId } from "@maru/shared";
import { assignmentKey } from "@maru/shared";

/**
 * The hand-set delete locks of earlier builds. A session is locked now because it is in the user's
 * list (DESIGN.md 6, 잠금), so nothing reads this table to decide a lock; `migrateLegacyLocks`
 * (sessions/legacyLocks.ts) carries its rows into the list once, and `retire` renames the table.
 * `set` stays for the retired dashboard import (scripts/import-dashboard-state.ts), whose locks
 * the next server start carries over the same way. Keyed by `provider:id` without the account.
 *
 * The table is `locks`. `session_locks` is a name ChosenStore migrates away, so it stays unused.
 */
export class LockStore {
  private db: DatabaseSync;
  private locked = new Set<string>();
  private listeners = new Set<(keys: string[]) => void>();

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS locks (
        session_key TEXT PRIMARY KEY,
        locked_at INTEGER NOT NULL
      );
    `);
    for (const row of this.db.prepare("SELECT session_key FROM locks").all()) this.locked.add(String(row.session_key));
  }

  close(): void {
    this.db.close();
  }

  onChange(fn: (keys: string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  has(provider: ProviderId, sessionId: string): boolean {
    return this.locked.has(assignmentKey(provider, sessionId));
  }

  keys(): string[] {
    return [...this.locked];
  }

  /** Renames the table (`locks_migrated`, replacing an older copy), so a later start finds none and the rows stay readable. */
  retire(): void {
    this.db.exec("DROP TABLE IF EXISTS locks_migrated; ALTER TABLE locks RENAME TO locks_migrated;");
    this.locked.clear();
  }

  count(): number {
    return this.locked.size;
  }

  set(provider: ProviderId, sessionId: string, locked: boolean): void {
    if (provider !== "claude" && provider !== "codex") throw new Error("bad provider");
    if (!sessionId) throw new Error("session id required");
    const key = assignmentKey(provider, sessionId);
    if (locked === this.locked.has(key)) return;
    if (locked) {
      this.db.prepare("INSERT OR IGNORE INTO locks (session_key, locked_at) VALUES (?, ?)").run(key, Date.now());
      this.locked.add(key);
    } else {
      this.db.prepare("DELETE FROM locks WHERE session_key = ?").run(key);
      this.locked.delete(key);
    }
    for (const fn of this.listeners) fn([key]);
  }
}
