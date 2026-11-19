import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Accounts judged FREE (no subscription that exposes usage), sticky between reads
 * An earlier dashboard kept the same set in `free-accounts.json`;
 * scripts/migrate-free-accounts.ts carries it over once.
 * Keyed by account label (labels are unique across providers).
 *
 * Every call reads the table, so a write from another process (the migration script while the
 * server runs) counts at once, as the dashboard re-read its file every few seconds.
 */
export class FreeStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS usage_free_accounts (
        account TEXT PRIMARY KEY,
        marked_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  has(account: string): boolean {
    return this.db.prepare("SELECT 1 FROM usage_free_accounts WHERE account = ?").get(account) !== undefined;
  }

  list(): string[] {
    return this.db.prepare("SELECT account FROM usage_free_accounts ORDER BY account").all().map((r) => String(r.account));
  }

  /** Mark or clear an account. Returns true when the mark changed. */
  set(account: string, isFree: boolean): boolean {
    const r = isFree
      ? this.db.prepare("INSERT OR IGNORE INTO usage_free_accounts (account, marked_at) VALUES (?, ?)").run(account, Date.now())
      : this.db.prepare("DELETE FROM usage_free_accounts WHERE account = ?").run(account);
    return Number(r.changes) > 0;
  }
}
