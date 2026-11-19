import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A Codex thread this server drives, as a restart needs it back (drive/codexRuns.ts). */
export interface HeldThread {
  /** Session key `codex:<account>:<thread id>`: the account names the daemon to ask. */
  key: string;
  /** This server's turns on the thread not seen to end: a running one stays this server's. */
  turns: string[];
  /** A goal set here is active: the turns the daemon starts to pursue it are this server's. */
  goalByUs: boolean;
  heldAt: number;
}

/**
 * The Codex threads this server drives (DESIGN.md 4.2), kept in state.sqlite so a restart of this
 * server (every release deploy) does not hand them to "another client": CodexRuns.restore() takes
 * them up again with their running turn and open questions. A row lives as long as the hold. It
 * goes when CodexRuns lets the thread go, and restore lets go of a thread the daemon has unloaded,
 * cannot read, or runs another client's turn on. A clean stop (closeAll) keeps the rows.
 */
export class CodexHeldStore {
  private db: DatabaseSync;
  private rows = new Map<string, HeldThread>();

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS codex_held (
        thread_key TEXT PRIMARY KEY,
        turns TEXT NOT NULL,
        goal_by_us INTEGER NOT NULL,
        held_at INTEGER NOT NULL
      );
    `);
    for (const row of this.db.prepare("SELECT thread_key, turns, goal_by_us, held_at FROM codex_held").all()) {
      let turns: string[] = [];
      try {
        const parsed: unknown = JSON.parse(String(row.turns));
        if (Array.isArray(parsed)) turns = parsed.filter((x): x is string => typeof x === "string");
      } catch {
        // An unreadable list keeps the hold without turns: a running turn then counts as another client's.
      }
      const key = String(row.thread_key);
      this.rows.set(key, { key, turns, goalByUs: Number(row.goal_by_us) === 1, heldAt: Number(row.held_at) });
    }
  }

  close(): void {
    this.db.close();
  }

  list(): HeldThread[] {
    return [...this.rows.values()].map((r) => ({ ...r, turns: [...r.turns] }));
  }

  /** The thread is this server's from now on, with no turn yet. */
  hold(key: string): void {
    const row: HeldThread = { key, turns: [], goalByUs: false, heldAt: Date.now() };
    this.rows.set(key, row);
    this.write(row);
  }

  addTurn(key: string, turnId: string): void {
    const row = this.rows.get(key);
    if (!row || row.turns.includes(turnId)) return;
    row.turns.push(turnId);
    this.write(row);
  }

  endTurn(key: string, turnId: string): void {
    const row = this.rows.get(key);
    if (!row || !row.turns.includes(turnId)) return;
    row.turns = row.turns.filter((t) => t !== turnId);
    this.write(row);
  }

  setGoal(key: string, on: boolean): void {
    const row = this.rows.get(key);
    if (!row || row.goalByUs === on) return;
    row.goalByUs = on;
    this.write(row);
  }

  drop(key: string): void {
    if (!this.rows.delete(key)) return;
    this.db.prepare("DELETE FROM codex_held WHERE thread_key = ?").run(key);
  }

  private write(row: HeldThread): void {
    this.db
      .prepare("INSERT OR REPLACE INTO codex_held (thread_key, turns, goal_by_us, held_at) VALUES (?, ?, ?, ?)")
      .run(row.key, JSON.stringify(row.turns), row.goalByUs ? 1 : 0, row.heldAt);
  }
}
