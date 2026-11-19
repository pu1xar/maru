import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderId } from "@maru/shared";
import { assignmentKey } from "@maru/shared";

interface NameRow {
  name: string;
  /** Provider-side user names that mean "nobody renamed it elsewhere since". */
  accepted: string[];
  namedAt: number;
}

/**
 * The names the user gave sessions in maru (DESIGN.md 6, 이름 변경). The list, the conversation
 * head, search and every other place that shows a session read the name from here first; the
 * provider's own name (Claude custom-title, Codex thread name) is shown only when no row stands.
 *
 * Keyed by `provider:id` without the account, so a session moved between accounts keeps its name.
 * Kept in state.sqlite so a restart of this server does not lose it.
 *
 * A row also records which provider-side names it was written next to (`accepted`). The provider
 * name seen later is compared with them: a different non-empty name was typed somewhere else
 * (the CLI's /rename) after this row, so the newer one wins and the row goes (`resolve`).
 */
export class SessionNameStore {
  private db: DatabaseSync;
  private rows = new Map<string, NameRow>();
  private listeners = new Set<(keys: string[]) => void>();

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS session_names (
        session_key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider_names TEXT NOT NULL,
        named_at INTEGER NOT NULL
      );
    `);
    for (const row of this.db.prepare("SELECT session_key, name, provider_names, named_at FROM session_names").all()) {
      try {
        const accepted = JSON.parse(String(row.provider_names)) as unknown;
        this.rows.set(String(row.session_key), {
          name: String(row.name),
          accepted: Array.isArray(accepted) ? accepted.filter((x): x is string => typeof x === "string") : [],
          namedAt: Number(row.named_at),
        });
      } catch {
        // A row this code cannot read is left out.
      }
    }
  }

  close(): void {
    this.db.close();
  }

  onChange(fn: (keys: string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  keys(): string[] {
    return [...this.rows.keys()];
  }

  /** The stored name, or null. Does not look at the provider's name (see `resolve`). */
  get(provider: ProviderId, sessionId: string): { name: string; namedAt: number } | null {
    const r = this.rows.get(assignmentKey(provider, sessionId));
    return r ? { name: r.name, namedAt: r.namedAt } : null;
  }

  /**
   * Stores `name`. `accepted` lists the provider-side names that do not count as a rename made
   * elsewhere: the one the provider shows now and, when maru wrote the name there too, the name
   * it wrote.
   */
  set(provider: ProviderId, sessionId: string, name: string, accepted: ReadonlyArray<string | null>): void {
    if (provider !== "claude" && provider !== "codex") throw new Error("bad provider");
    if (!sessionId) throw new Error("session id required");
    const trimmed = name.trim();
    if (trimmed === "") throw new Error("name is empty");
    const key = assignmentKey(provider, sessionId);
    const row: NameRow = {
      name: trimmed,
      accepted: [...new Set(accepted.filter((x): x is string => x !== null && x !== ""))],
      namedAt: Date.now(),
    };
    this.db
      .prepare("INSERT OR REPLACE INTO session_names (session_key, name, provider_names, named_at) VALUES (?, ?, ?, ?)")
      .run(key, row.name, JSON.stringify(row.accepted), row.namedAt);
    this.rows.set(key, row);
    for (const fn of this.listeners) fn([key]);
  }

  /**
   * The user name to show for a session whose provider-side user name is `providerName` (null when
   * it has none). maru's own name wins until the provider shows a name that is neither one this row
   * was written next to nor the row's own name; that name is newer, so the row is dropped and the
   * provider name returned. An absent provider name says nothing and leaves the row standing.
   */
  resolve(provider: ProviderId, sessionId: string, providerName: string | null): string | null {
    const key = assignmentKey(provider, sessionId);
    const row = this.rows.get(key);
    if (!row) return providerName;
    if (providerName === null || providerName === row.name || row.accepted.includes(providerName)) return row.name;
    this.db.prepare("DELETE FROM session_names WHERE session_key = ?").run(key);
    this.rows.delete(key);
    return providerName;
  }

  /** Drop the names of sessions that exist nowhere any more (sessions/presence.ts). Returns how many went. */
  forget(keys: Iterable<string>): number {
    let n = 0;
    for (const key of new Set(keys)) {
      if (!this.rows.has(key)) continue;
      this.db.prepare("DELETE FROM session_names WHERE session_key = ?").run(key);
      this.rows.delete(key);
      n++;
    }
    return n;
  }
}
