import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The fold key of a sidebar folder the server accepts: a fixed folder, the terminal group
 * (`view:terminal`, its shell rows) or `project:<id>`. */
const FOLD_KEY = /^(pinned|unassigned|archive:open|view:terminal|project:[A-Za-z0-9_-]+)$/;

export class FoldError extends Error {
  status = 400;
}

/**
 * The sidebar folders the user folded (DESIGN.md 6v), shared by every client. A row is one fold key
 * (`pinned`, `unassigned`, `project:<id>`, or `archive:open` while 보관함 is open, which starts
 * folded). Changes arrive one key at a time and the store merges them, so two clients folding
 * different folders never overwrite each other.
 *
 * `live` says which keys still name a folder. A key of a deleted project is dropped (`prune`), so
 * the list follows the folders that exist.
 */
export class FoldedGroupStore {
  private db: DatabaseSync;
  private folded = new Set<string>();
  private listeners = new Set<(keys: string[]) => void>();
  private live: (key: string) => boolean;

  constructor(file: string, live: (key: string) => boolean = () => true) {
    this.live = live;
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS group_folds (
        group_key TEXT PRIMARY KEY,
        folded_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_folds_import (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        done_at INTEGER NOT NULL
      );
    `);
    for (const row of this.db.prepare("SELECT group_key FROM group_folds").all()) this.folded.add(String(row.group_key));
  }

  close(): void {
    this.db.close();
  }

  onChange(fn: (keys: string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  keys(): string[] {
    return [...this.folded].sort();
  }

  private emit(): void {
    const keys = this.keys();
    for (const fn of this.listeners) fn(keys);
  }

  private markImportDone(): void {
    this.db.prepare("INSERT OR IGNORE INTO group_folds_import (id, done_at) VALUES (1, ?)").run(Date.now());
  }

  /** Folds or unfolds one folder. Returns whether the list changed. */
  set(key: string, folded: boolean): boolean {
    if (typeof key !== "string" || !FOLD_KEY.test(key)) throw new FoldError("bad fold key");
    if (typeof folded !== "boolean") throw new FoldError("folded must be a boolean");
    if (!this.live(key)) throw new FoldError("no such folder");
    // A value the user set exists from here on, so an older client's stored list no longer applies.
    this.markImportDone();
    if (folded === this.folded.has(key)) return false;
    if (folded) {
      this.db.prepare("INSERT OR IGNORE INTO group_folds (group_key, folded_at) VALUES (?, ?)").run(key, Date.now());
      this.folded.add(key);
    } else {
      this.db.prepare("DELETE FROM group_folds WHERE group_key = ?").run(key);
      this.folded.delete(key);
    }
    this.emit();
    return true;
  }

  /**
   * Takes the folds a client kept before the server held them, once: while no import happened and
   * no fold was ever set. Keys that name no folder are left out. Returns whether this call took them.
   */
  importOnce(keys: readonly string[]): boolean {
    if (this.db.prepare("SELECT 1 FROM group_folds_import WHERE id = 1").get()) return false;
    const take = [...new Set(keys)].filter((k) => typeof k === "string" && FOLD_KEY.test(k) && this.live(k));
    this.db.exec("BEGIN");
    try {
      const ins = this.db.prepare("INSERT OR IGNORE INTO group_folds (group_key, folded_at) VALUES (?, ?)");
      for (const k of take) ins.run(k, Date.now());
      this.markImportDone();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    for (const k of take) this.folded.add(k);
    if (take.length > 0) this.emit();
    return true;
  }

  /** Drops keys that name no folder any more (a deleted project). Returns how many went. */
  prune(): number {
    const gone = [...this.folded].filter((k) => !this.live(k));
    if (gone.length === 0) return 0;
    const del = this.db.prepare("DELETE FROM group_folds WHERE group_key = ?");
    for (const k of gone) {
      del.run(k);
      this.folded.delete(k);
    }
    this.emit();
    return gone.length;
  }
}
