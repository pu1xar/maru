// Copies a Claude session's transcript up to a line into a new session (DESIGN.md 6q) with the
// SDK's forkSession: new uuids for every line, the parent chain kept, `forkedFrom` on each line
// (the projector shows the fork row from it), no file-history snapshots (a fork starts without
// undo history). No Claude process runs for it and the source transcript is only read.
//
// forkSession finds the account's folder through the CLAUDE_CONFIG_DIR of the process it runs in.
// A process of its own per call keeps that env from touching this server's other work.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ClaudeAccount } from "../config.ts";

const WORKER = fileURLToPath(new URL("./forkWorker.ts", import.meta.url));

/** The new session's id. `upToMessageId` is the last line to keep (inclusive); without it the whole conversation. */
export function forkClaudeTranscript(account: ClaudeAccount, sessionId: string, upToMessageId: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify({ sessionId, ...(upToMessageId ? { upToMessageId } : {}) })], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: account.dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.trim().split("\n").at(-1) ?? "";
      let parsed: { sessionId?: string; error?: string } = {};
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        // No JSON line: the process failed before it could report (stderr says why).
      }
      if (code === 0 && typeof parsed.sessionId === "string") resolve(parsed.sessionId);
      else reject(new Error(parsed.error ?? (err.trim() || `fork worker exited with code ${code}`)));
    });
  });
}
