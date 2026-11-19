// The build settings file (~/.config/maru/build.env, env MARU_BUILD_ENV names another path): the
// values that belong to one person's deployment and not to the source (the Android package id, the
// OTA update URL, the font CDN). The tools that build maru read it: the web build (vite.config.ts),
// the Android app's config and OTA export, the desktop build. build-apk.sh reads the same format
// in shell. Node only, so the package index leaves it out of the web bundle.
//
// Format: one `KEY=VALUE` per line, `#` starts a comment line, an `export ` prefix and one pair of
// surrounding quotes are allowed. No shell expansion. A variable already in the environment wins,
// so a one-off build can override the file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function buildEnvFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.MARU_BUILD_ENV || path.join(os.homedir(), ".config", "maru", "build.env");
}

/** The KEY=VALUE pairs of a build.env text; a line that is none of those is an error naming its number. */
export function parseBuildEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) throw new Error(`line ${i + 1} is not KEY=VALUE`);
    let value = m[2]!.trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    out[m[1]!] = value;
  }
  return out;
}

/**
 * Puts the file's values into `env` where `env` has none, and returns the path read (null when
 * there is no file). A malformed file throws: a build must not run on half its settings.
 */
export function loadBuildEnv(env: NodeJS.ProcessEnv = process.env, file = buildEnvFile(env)): string | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let pairs: Record<string, string>;
  try {
    pairs = parseBuildEnv(text);
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const [k, v] of Object.entries(pairs)) if (env[k] === undefined) env[k] = v;
  return file;
}
