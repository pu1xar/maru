// Finds the pid of a Claude Code process this server spawned. The SDK's own spawn keeps the
// child to itself. Its `spawnClaudeCodeProcess` option would hand the child over, but then the
// SDK stops reading the child's stderr and its exit errors lose the stderr tail (sdk.d.ts
// SpawnedProcess), so the driver keeps the SDK's spawn and reads the pid from the CLI's own
// registration `<config dir>/sessions/<pid>.json` (registry.ts): the entry whose sessionId is
// the run's session and whose process is a direct child of this server. The parent check keeps
// a terminal process that holds the same session out of the result.
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isNotFound } from "./meta.ts";
import { isPidAlive, parseRegistration } from "./registry.ts";

const REG_FILE = /^(\d+)\.json$/;

/** Parent pid of a running process, or null when ps cannot tell (the process is gone). */
export function parentPidOf(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "ppid=", "-p", String(pid)], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null);
      const n = Number(stdout.trim());
      resolve(Number.isInteger(n) && n > 0 ? n : null);
    });
  });
}

/**
 * One pass over `sessionsDir`: the pid of a live registration for `sessionId` whose process
 * is a child of `parentPid`, or null.
 */
export async function scanChildRegistration(
  sessionsDir: string,
  sessionId: string,
  parentPid: number,
): Promise<number | null> {
  let names: string[];
  try {
    names = await fsp.readdir(sessionsDir);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  for (const name of names) {
    const m = REG_FILE.exec(name);
    if (!m) continue;
    let text: string;
    try {
      text = await fsp.readFile(path.join(sessionsDir, name), "utf8");
    } catch (err) {
      if (isNotFound(err)) continue;
      throw err;
    }
    // A file caught mid-write fails to parse; the next pass reads it again.
    const reg = parseRegistration(text, Number(m[1]));
    if (reg === null || reg.sessionId !== sessionId || !isPidAlive(reg.pid)) continue;
    if ((await parentPidOf(reg.pid)) === parentPid) return reg.pid;
  }
  return null;
}

/**
 * Re-scan every `intervalMs` until the registration shows up or `signal` aborts (the run
 * ended). `sessionId` is read on every pass because a new session learns its id from the
 * CLI's first message.
 */
export async function waitForChildRegistration(opts: {
  sessionsDir: string;
  sessionId: () => string | null;
  signal: AbortSignal;
  parentPid?: number;
  intervalMs?: number;
}): Promise<number | null> {
  const parentPid = opts.parentPid ?? process.pid;
  const intervalMs = opts.intervalMs ?? 200;
  while (!opts.signal.aborted) {
    const sid = opts.sessionId();
    if (sid !== null) {
      const pid = await scanChildRegistration(opts.sessionsDir, sid, parentPid);
      if (pid !== null) return pid;
    }
    try {
      // An unref'd timer: a lookup for a run nobody closes (a test) does not keep the process up.
      await sleep(intervalMs, undefined, { signal: opts.signal, ref: false });
    } catch {
      break;
    }
  }
  return null;
}
