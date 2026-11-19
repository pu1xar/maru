// Live-process registrations: `<config dir>/sessions/<pid>.json`. Claude Code writes one per
// running process and deletes it on exit; a crashed process leaves its file behind, so a
// registration counts only while its pid is alive.
import { execFileSync } from "node:child_process";
import type { Owner, UnifiedStatus } from "@maru/shared";

export interface Registration {
  pid: number;
  sessionId: string | null;
  /** Raw status: busy, shell, idle, waiting, or absent right after registration. */
  status: string | null;
  entrypoint: string | null;
  /** `<tmux session>:@<window id>.%<pane id>`, written once at startup. */
  tmux: string | null;
  cwd: string | null;
  /** ms since epoch, from statusUpdatedAt or updatedAt. */
  updatedAt: number | null;
  /** Process start time as `ps -o lstart=` prints it, e.g. "Sun Nov 15 09:48:07 2026". */
  procStart: string | null;
}

/** Parse a registration file. `filePid` (the file name) is used when the body has no pid. */
export function parseRegistration(text: string, filePid: number): Registration | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const pid = Number.isInteger(r.pid) && (r.pid as number) > 0 ? (r.pid as number) : filePid;
  const updated = typeof r.statusUpdatedAt === "number" ? r.statusUpdatedAt : r.updatedAt;
  return {
    pid,
    sessionId: typeof r.sessionId === "string" ? r.sessionId : null,
    status: typeof r.status === "string" ? r.status : null,
    entrypoint: typeof r.entrypoint === "string" ? r.entrypoint : null,
    tmux: typeof r.tmux === "string" ? r.tmux : null,
    cwd: typeof r.cwd === "string" ? r.cwd : null,
    updatedAt: typeof updated === "number" ? updated : null,
    procStart: typeof r.procStart === "string" ? r.procStart : null,
  };
}

/** `per:@4.%4` -> `%4`. The pane id is the part tmux keeps stable while the pane lives. */
export function tmuxPaneOf(tmux: string | null | undefined): string | null {
  if (!tmux) return null;
  const m = /(%\d+)$/.exec(tmux);
  return m ? (m[1] ?? null) : null;
}

/** Signal 0 checks existence only. EPERM means the process exists under another user. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Start time of a running process as `ps -o lstart=` prints it in UTC, or null when ps cannot
 * tell. Claude Code records `procStart` in UTC; ps prints local time unless TZ says otherwise.
 */
export function processStartOf(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, TZ: "UTC" },
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

const squash = (s: string) => s.trim().replace(/\s+/g, " ");

/**
 * A registration is live while its pid runs and that pid still belongs to the process that
 * wrote the file. A crash leaves the file behind, and the OS can hand the pid to an unrelated
 * process later; comparing the recorded start time with the running process tells them apart.
 * When either start time is unknown, the pid check alone decides.
 */
export function isRegistrationLive(
  reg: Registration,
  startOf: (pid: number) => string | null = processStartOf,
): boolean {
  if (!isPidAlive(reg.pid)) return false;
  if (!reg.procStart) return true;
  const actual = startOf(reg.pid);
  if (actual === null) return true;
  return squash(actual) === squash(reg.procStart);
}

/** `known` is false for a status value this mapping has not seen; it maps to open-idle. */
export function mapStatus(raw: string | null): { status: UnifiedStatus; known: boolean } {
  switch (raw) {
    case "busy":
    // `shell`: a command is executing. Not seen in our measurements; the official VS Code
    // extension bundle handles it next to busy, idle and waiting.
    case "shell":
      return { status: "running", known: true };
    case "waiting":
      return { status: "waiting-input", known: true };
    case "idle":
    case null:
      return { status: "open-idle", known: true };
    default:
      return { status: "open-idle", known: false };
  }
}

const PRIORITY: Record<UnifiedStatus, number> = {
  running: 3,
  "waiting-input": 2,
  "open-idle": 1,
  error: 0,
  closed: 0,
};

export interface Hold {
  status: UnifiedStatus;
  owner: Owner;
  pid: number | null;
  tmuxPane: string | null;
}

/**
 * Combine the live registrations of one session. Several processes can hold one session (two
 * resumes run side by side without a lock).
 * - status: the most active one (running, then waiting-input, then open-idle)
 * - owner: ui when any holder is a process this server started, else terminal
 * - pid, tmuxPane: from the holder that decided the owner, the most active and most recently
 *   updated one among them
 */
export function resolveHold(live: Registration[], ownPids: Set<number>): Hold {
  if (live.length === 0) return { status: "closed", owner: "none", pid: null, tmuxPane: null };
  let status: UnifiedStatus = "open-idle";
  for (const reg of live) {
    const s = mapStatus(reg.status).status;
    if (PRIORITY[s] > PRIORITY[status]) status = s;
  }
  const own = live.filter((reg) => ownPids.has(reg.pid));
  const owner: Owner = own.length > 0 ? "ui" : "terminal";
  const pool = own.length > 0 ? own : live;
  let rep = pool[0] as Registration;
  for (const reg of pool.slice(1)) {
    const a = PRIORITY[mapStatus(reg.status).status];
    const b = PRIORITY[mapStatus(rep.status).status];
    if (a > b || (a === b && (reg.updatedAt ?? 0) > (rep.updatedAt ?? 0))) rep = reg;
  }
  return { status, owner, pid: rep.pid, tmuxPane: tmuxPaneOf(rep.tmux) };
}
