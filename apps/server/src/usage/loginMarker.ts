// The "Login required" mark of an expired Claude login. A file `<sha8>.json` in the marker folder
// (default ~/.config/maru/claude-login-required, env MARU_LOGIN_MARKER_DIR) says that the account
// with that config dir has to sign in again; <sha8> is the first 8 hex digits of the SHA-256 of
// the config dir's absolute path. Whatever writes the file also removes it once the login works
// again. The usage footer shows the mark while the marker exists and the stored access token is
// expired (usage/claude.ts).

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function loginMarkerDir(): string {
  return process.env.MARU_LOGIN_MARKER_DIR || path.join(os.homedir(), ".config", "maru", "claude-login-required");
}

export function loginMarkerPath(configDir: string, dir = loginMarkerDir()): string {
  const id = crypto.createHash("sha256").update(path.resolve(configDir)).digest("hex").slice(0, 8);
  return path.join(dir, `${id}.json`);
}

/** True when a marker file exists for this config dir. */
export function loginMarked(configDir: string, dir = loginMarkerDir()): boolean {
  return fs.existsSync(loginMarkerPath(configDir, dir));
}
