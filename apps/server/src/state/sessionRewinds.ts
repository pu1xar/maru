import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assignmentKey } from "@maru/shared";
import type { RewindMarker } from "../claude/rewindScan.ts";

/**
 * Conversation rewinds of Claude sessions that wait for the session's next message (DESIGN.md
 * 6o). The CLI writes nothing when a resume is cut short (resumeSessionAt), so until the next
 * message reaches the transcript this marker is the only record of where the conversation stands:
 * the thread view hides what came after the kept line, and the next process resumes up to it.
 *
 * Keyed by `claude:<session id>` without the account, so a marker follows a session moved between
 * accounts (and its last line's uuid survives a rehome rewriting the lines). In state.sqlite so a
 * restart of this server keeps it. A marker whose session went on (a run opener after its last
 * line) is stale and is dropped when read (rewindScan.ts markerActive).
 */
export class SessionRewindStore {
  private db: DatabaseSync;
  private rows = new Map<string, RewindMarker>();
  private listeners = new Set<(sessionId: string) => void>();

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS session_rewinds (
        session_key TEXT PRIMARY KEY,
        marker TEXT NOT NULL,
        set_at INTEGER NOT NULL
      );
    `);
    for (const row of this.db.prepare("SELECT session_key, marker FROM session_rewinds").all()) {
      try {
        const m = JSON.parse(String(row.marker)) as RewindMarker;
        if (typeof m.atUuid === "string" && typeof m.keepUuid === "string" && typeof m.lastUuid === "string") this.rows.set(String(row.session_key), m);
      } catch {
        // A row this code cannot read is left out.
      }
    }
  }

  close(): void {
    this.db.close();
  }

  get(sessionId: string): RewindMarker | null {
    return this.rows.get(assignmentKey("claude", sessionId)) ?? null;
  }

  set(sessionId: string, marker: RewindMarker): void {
    const key = assignmentKey("claude", sessionId);
    this.db.prepare("INSERT OR REPLACE INTO session_rewinds (session_key, marker, set_at) VALUES (?, ?, ?)").run(key, JSON.stringify(marker), Date.now());
    this.rows.set(key, marker);
    this.emit(sessionId);
  }

  /** Drops the marker only when it is still the one made at `createdAt` (another may have replaced it). */
  clearIf(sessionId: string, createdAt: number): void {
    if (this.get(sessionId)?.createdAt === createdAt) this.clear(sessionId);
  }

  clear(sessionId: string): void {
    const key = assignmentKey("claude", sessionId);
    if (!this.rows.has(key)) return;
    this.db.prepare("DELETE FROM session_rewinds WHERE session_key = ?").run(key);
    this.rows.delete(key);
    this.emit(sessionId);
  }

  /** `listener(sessionId)` after a set or clear. Returns the unsubscribe. */
  onChange(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(sessionId: string): void {
    for (const l of [...this.listeners]) {
      try {
        l(sessionId);
      } catch (err) {
        console.error("session rewinds: listener threw", err);
      }
    }
  }
}
