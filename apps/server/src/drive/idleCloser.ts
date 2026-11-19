import type { SessionIndex } from "../index/store.ts";

/**
 * Ends Claude processes this server started once nobody needs them (user decision 2026-11-15,
 * DESIGN.md M2). Viewing a session never starts a process; a process starts only for a message.
 * A process stays while:
 *   - its turn runs or waits for an answer (index status running or waiting-input, or questions
 *     pending in this server),
 *   - a background subagent or workflow of the session still runs,
 *   - any browser shows the session or one of its subagent threads.
 * When none of these has held for `idleMs` (30 minutes), the process is closed; the next message
 * resumes the session in a new one. Claude Desktop closes right after each turn and VS Code when
 * the chat tab closes; T3 Code closes after 30 idle minutes. This follows VS Code while a session
 * is on screen and T3 Code once it is not.
 */
export const IDLE_CLOSE_MS = 30 * 60 * 1000;

/** How often the runs are checked. A check interval, not a limit. */
export const IDLE_SWEEP_MS = 60 * 1000;

export interface IdleCloserDeps {
  runs: { liveKeys(): string[]; pendingOf(key: string): unknown[]; close(key: string): Promise<void> };
  index: Pick<SessionIndex, "get">;
  /** A browser holds the session's thread or one of its subagent threads. */
  isViewed: (key: string) => boolean;
  /** Background subagents and workflows of the session that still run. */
  runningAgents: (key: string) => number;
  idleMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export class IdleCloser {
  private deps: IdleCloserDeps;
  private lastNeeded = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: IdleCloserDeps) {
    this.deps = deps;
  }

  start(everyMs = IDLE_SWEEP_MS): void {
    this.timer = setInterval(() => void this.sweep(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Why the run is still needed, or null when it is idle. */
  neededBy(key: string): string | null {
    const s = this.deps.index.get(key);
    if (s?.status === "running" || s?.status === "waiting-input") return s.status;
    // Tasks the session host reports as running after the turn ended (ClaudeRuns.annotate).
    if ((s?.backgroundTasks ?? 0) > 0) return "background";
    if (this.deps.runs.pendingOf(key).length > 0) return "question";
    if (this.deps.isViewed(key)) return "viewed";
    let agents = 0;
    try {
      agents = this.deps.runningAgents(key);
    } catch {
      // A session whose files cannot be read keeps its process; the next sweep tries again.
      return "agents unknown";
    }
    if (agents > 0) return "agents";
    return null;
  }

  /** Close the runs that have not been needed for `idleMs`. Returns the keys it closed. */
  async sweep(): Promise<string[]> {
    const now = (this.deps.now ?? Date.now)();
    const idleMs = this.deps.idleMs ?? IDLE_CLOSE_MS;
    const live = new Set(this.deps.runs.liveKeys());
    for (const key of [...this.lastNeeded.keys()]) if (!live.has(key)) this.lastNeeded.delete(key);
    const closed: string[] = [];
    for (const key of live) {
      // A run first seen here counts as needed now, so a new one gets the full idle time.
      if (this.neededBy(key) !== null || !this.lastNeeded.has(key)) {
        this.lastNeeded.set(key, now);
        continue;
      }
      if (now - this.lastNeeded.get(key)! < idleMs) continue;
      this.lastNeeded.delete(key);
      try {
        await this.deps.runs.close(key);
        closed.push(key);
        this.deps.log?.(`idle close ${key}: not needed for ${Math.round(idleMs / 60000)} min`);
      } catch (err) {
        this.deps.log?.(`idle close ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return closed;
  }
}
