// Whether an account is signed in, asked of the provider's own CLI. The token files and the
// keychain are not read here: the CLI answers for its own login.
//   claude auth status   JSON on stdout, `loggedIn` true or false (exit 0 or 1)
//   codex login status   one text line: "Logged in using ..." (exit 0) or "Not logged in" (exit 1)
import { execFile } from "node:child_process";
import fs from "node:fs";
import type { AccountLoginStatus, ProviderId } from "@maru/shared";

export interface CliResult {
  /** Exit code; null when the process was killed or never ran. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The program was not found. */
  missing: boolean;
  timedOut: boolean;
}

export type CliRunner = (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<CliResult>;

const TIMEOUT_MS = 15_000;

export const runCli: CliRunner = (bin, args, env) =>
  new Promise((resolve) => {
    execFile(bin, args, { env, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      if (!e) return resolve({ code: 0, stdout, stderr, missing: false, timedOut: false });
      if (e.code === "ENOENT") return resolve({ code: null, stdout, stderr, missing: true, timedOut: false });
      resolve({ code: typeof e.code === "number" ? e.code : null, stdout, stderr, missing: false, timedOut: e.killed === true });
    });
  });

/** `claude auth status`: a JSON object with a boolean `loggedIn`, else the plain "Not logged in" line. */
export function parseClaudeStatus(r: Pick<CliResult, "code" | "stdout">): AccountLoginStatus {
  const text = r.stdout.trim();
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v === "object" && v !== null && typeof (v as { loggedIn?: unknown }).loggedIn === "boolean") {
      return (v as { loggedIn: boolean }).loggedIn ? "signed-in" : "not-signed-in";
    }
  } catch {
    // not JSON: the text form below
  }
  if (/^Not logged in/i.test(text)) return "not-signed-in";
  return "unknown";
}

/** `codex login status`: its line may follow a warning line, so every line is looked at. */
export function parseCodexStatus(r: Pick<CliResult, "code" | "stdout" | "stderr">): AccountLoginStatus {
  const lines = `${r.stdout}\n${r.stderr}`.split("\n").map((l) => l.trim());
  if (lines.some((l) => /^Not logged in/i.test(l))) return "not-signed-in";
  if (r.code === 0 && lines.some((l) => /^Logged in/i.test(l))) return "signed-in";
  return "unknown";
}

export interface StatusDeps {
  run?: CliRunner;
  /** The Claude Code CLI path (config.ts CLAUDE_BIN) and the codex program name. */
  claudeBin: string;
  codexBin?: string;
  env?: NodeJS.ProcessEnv;
  dirExists?: (p: string) => boolean;
}

/**
 * The login status of one account. A folder that does not exist yet is "not-signed-in" without
 * running anything: the CLI would create it (and its own files) just to answer.
 */
export async function accountLoginStatus(provider: ProviderId, dir: string, deps: StatusDeps): Promise<AccountLoginStatus> {
  const exists = deps.dirExists ?? ((p: string) => fs.existsSync(p));
  if (!exists(dir)) return "not-signed-in";
  const run = deps.run ?? runCli;
  const base = deps.env ?? process.env;
  if (provider === "claude") {
    const r = await run(deps.claudeBin, ["auth", "status"], { ...base, CLAUDE_CONFIG_DIR: dir });
    if (r.missing) return "cli-missing";
    if (r.timedOut) return "unknown";
    return parseClaudeStatus(r);
  }
  const r = await run(deps.codexBin ?? "codex", ["login", "status"], { ...base, CODEX_HOME: dir });
  if (r.missing) return "cli-missing";
  if (r.timedOut) return "unknown";
  return parseCodexStatus(r);
}
