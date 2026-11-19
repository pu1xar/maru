import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderId } from "@maru/shared";
import { assignmentKey } from "@maru/shared";

/**
 * What the user chose with /model, /effort, /fast, /permissions or /output-style for a session's
 * next start (DESIGN.md 6m): a closed Claude session, or a Codex thread whose next turn/start this
 * server has not sent yet. A field that is absent was not chosen; effort null is a choice (the
 * model's own effort).
 */
export interface PendingChoice {
  model?: string;
  effort?: string | null;
  fast?: boolean;
  permissionMode?: string;
  outputStyle?: string;
}

/**
 * Keyed by `provider:id` without the account, so a choice follows a session moved between
 * accounts. Kept in state.sqlite so a restart of this server does not lose it.
 */
export class SessionChoiceStore {
  private db: DatabaseSync;
  private rows = new Map<string, PendingChoice>();

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS session_choices (
        session_key TEXT PRIMARY KEY,
        choice TEXT NOT NULL,
        set_at INTEGER NOT NULL
      );
    `);
    for (const row of this.db.prepare("SELECT session_key, choice FROM session_choices").all()) {
      try {
        this.rows.set(String(row.session_key), JSON.parse(String(row.choice)) as PendingChoice);
      } catch {
        // A row this code cannot read is left out.
      }
    }
  }

  close(): void {
    this.db.close();
  }

  get(provider: ProviderId, sessionId: string): PendingChoice | null {
    return this.rows.get(assignmentKey(provider, sessionId)) ?? null;
  }

  /** Merges `patch` into the session's choice. */
  merge(provider: ProviderId, sessionId: string, patch: PendingChoice): PendingChoice {
    const key = assignmentKey(provider, sessionId);
    const next = { ...(this.rows.get(key) ?? {}), ...patch };
    this.db.prepare("INSERT OR REPLACE INTO session_choices (session_key, choice, set_at) VALUES (?, ?, ?)").run(key, JSON.stringify(next), Date.now());
    this.rows.set(key, next);
    return next;
  }

  /** Drops the choice (it was used, or the user changed the running process instead). */
  clear(provider: ProviderId, sessionId: string, fields?: ReadonlyArray<keyof PendingChoice>): void {
    const key = assignmentKey(provider, sessionId);
    const cur = this.rows.get(key);
    if (!cur) return;
    const next: PendingChoice = { ...cur };
    for (const f of fields ?? (Object.keys(cur) as Array<keyof PendingChoice>)) delete next[f];
    if (Object.keys(next).length === 0) {
      this.db.prepare("DELETE FROM session_choices WHERE session_key = ?").run(key);
      this.rows.delete(key);
    } else {
      this.db.prepare("UPDATE session_choices SET choice = ?, set_at = ? WHERE session_key = ?").run(JSON.stringify(next), Date.now(), key);
      this.rows.set(key, next);
    }
  }

  keys(): string[] {
    return [...this.rows.keys()];
  }

  /** Drop the choices of sessions that exist nowhere any more (sessions/presence.ts). Returns how many went. */
  forget(keys: Iterable<string>): number {
    let n = 0;
    for (const key of new Set(keys)) {
      if (!this.rows.has(key)) continue;
      this.db.prepare("DELETE FROM session_choices WHERE session_key = ?").run(key);
      this.rows.delete(key);
      n++;
    }
    return n;
  }
}
