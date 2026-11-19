// The user's server settings: ~/.config/maru/config.json (env MARU_CONFIG names another file).
//
//   {
//     "claudeAccounts": [{ "id": "claude", "dir": "~/.claude" }],
//     "codexAccounts": [{ "id": "codex", "home": "~/.codex" }],
//     "claudeUsage": false,
//     "codexUsage": false,
//     "claudeBin": "~/.local/bin/claude"
//   }
//
// Every field is optional and `~` stands for the home folder. Without the file, or without an
// account list, the accounts are found by looking for ~/.claude and ~/.codex. A file that is not
// valid JSON or not this shape is an error with its reason: the server does not start on settings
// it could not read. Pure functions here; config.ts reads the real file once at start.
import fs from "node:fs";
import path from "node:path";

export interface ClaudeAccount {
  id: string;
  /** CLAUDE_CONFIG_DIR */
  dir: string;
}

export interface CodexAccount {
  id: string;
  /** CODEX_HOME */
  home: string;
}

export interface UserConfig {
  claudeAccounts: ClaudeAccount[];
  codexAccounts: CodexAccount[];
  /** Read Claude's rate-limit usage with Claude Code's stored login (usage/claude.ts). */
  claudeUsage: boolean;
  /** Read Codex's rate-limit usage with the Codex CLI's stored login and daemon (usage/codex.ts). */
  codexUsage: boolean;
  /** The Claude Code CLI the server runs sessions with; null: found on PATH (resolveClaudeBin). */
  claudeBin: string | null;
}

export class ConfigError extends Error {}

const KEYS = ["claudeAccounts", "codexAccounts", "claudeUsage", "codexUsage", "claudeBin"] as const;
/** An account id appears in session keys (`claude:<id>:<session>`) and in the UI, so it carries no `:` or `/`. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function configFile(env: NodeJS.ProcessEnv, home: string): string {
  return env.MARU_CONFIG ? path.resolve(env.MARU_CONFIG) : path.join(home, ".config", "maru", "config.json");
}

/** `~` and `~/x` as the home folder; any other value must already be absolute. */
export function expandHome(value: string, home: string): string | null {
  const v = value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
  return path.isAbsolute(v) ? path.resolve(v) : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function accountList<T extends { id: string }>(
  raw: unknown,
  field: string,
  pathKey: "dir" | "home",
  home: string,
): T[] {
  if (!Array.isArray(raw)) throw new ConfigError(`"${field}" must be an array of { "id": ..., "${pathKey}": ... }`);
  return raw.map((item, i) => {
    const at = `${field}[${i}]`;
    if (!isRecord(item)) throw new ConfigError(`${at} must be an object with "id" and "${pathKey}"`);
    for (const k of Object.keys(item)) {
      if (k !== "id" && k !== pathKey) throw new ConfigError(`${at} has an unknown field "${k}" (known: id, ${pathKey})`);
    }
    const { id, [pathKey]: where } = item;
    if (typeof id !== "string" || !ID_RE.test(id)) {
      throw new ConfigError(`${at}.id must be letters, digits, ".", "_" or "-" (got ${JSON.stringify(id)})`);
    }
    if (typeof where !== "string" || where === "") throw new ConfigError(`${at}.${pathKey} must be a folder path`);
    const abs = expandHome(where, home);
    if (abs === null) throw new ConfigError(`${at}.${pathKey} must be absolute or start with ~ (got ${JSON.stringify(where)})`);
    return { id, [pathKey]: abs } as unknown as T;
  });
}

/** Settings from the file's text. `source` names the file in error messages. */
export function parseUserConfig(text: string, home: string, source: string): UserConfig {
  const fail = (msg: string): never => {
    throw new ConfigError(`${source}: ${msg}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return fail(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isRecord(raw)) return fail("the top level must be a JSON object");
  for (const k of Object.keys(raw)) {
    if (!(KEYS as readonly string[]).includes(k)) return fail(`unknown field "${k}" (known: ${KEYS.join(", ")})`);
  }
  try {
    const cfg: Partial<UserConfig> = {};
    if (raw.claudeAccounts !== undefined) cfg.claudeAccounts = accountList<ClaudeAccount>(raw.claudeAccounts, "claudeAccounts", "dir", home);
    if (raw.codexAccounts !== undefined) cfg.codexAccounts = accountList<CodexAccount>(raw.codexAccounts, "codexAccounts", "home", home);
    for (const flag of ["claudeUsage", "codexUsage"] as const) {
      const v = raw[flag];
      if (v !== undefined && typeof v !== "boolean") throw new ConfigError(`"${flag}" must be true or false`);
      if (v !== undefined) cfg[flag] = v;
    }
    if (raw.claudeBin !== undefined) {
      if (typeof raw.claudeBin !== "string" || raw.claudeBin === "") throw new ConfigError('"claudeBin" must be the path of the claude executable');
      const abs = expandHome(raw.claudeBin, home);
      if (abs === null) throw new ConfigError(`"claudeBin" must be absolute or start with ~ (got ${JSON.stringify(raw.claudeBin)})`);
      cfg.claudeBin = abs;
    }
    return completeUserConfig(cfg, home);
  } catch (err) {
    if (err instanceof ConfigError) return fail(err.message);
    throw err;
  }
}

/** The settings with their defaults, accounts found on disk where the list is absent. */
export function completeUserConfig(
  cfg: Partial<UserConfig>,
  home: string,
  exists: (p: string) => boolean = fs.existsSync,
): UserConfig {
  const claudeAccounts = cfg.claudeAccounts ?? (exists(path.join(home, ".claude")) ? [{ id: "claude", dir: path.join(home, ".claude") }] : []);
  const codexAccounts = cfg.codexAccounts ?? (exists(path.join(home, ".codex")) ? [{ id: "codex", home: path.join(home, ".codex") }] : []);
  const seenIds = new Set<string>();
  const seenDirs = new Map<string, string>();
  for (const a of [...claudeAccounts.map((x) => ({ id: x.id, where: x.dir })), ...codexAccounts.map((x) => ({ id: x.id, where: x.home }))]) {
    // Usage, names and the free marks are keyed by the id alone, across both providers.
    if (seenIds.has(a.id)) throw new ConfigError(`account id "${a.id}" is used twice (ids are unique across Claude and Codex accounts)`);
    seenIds.add(a.id);
    const other = seenDirs.get(a.where);
    if (other !== undefined) throw new ConfigError(`accounts "${other}" and "${a.id}" share the folder ${a.where}`);
    seenDirs.set(a.where, a.id);
  }
  return {
    claudeAccounts,
    codexAccounts,
    claudeUsage: cfg.claudeUsage ?? false,
    codexUsage: cfg.codexUsage ?? false,
    claudeBin: cfg.claudeBin ?? null,
  };
}

/**
 * The Claude Code CLI to run: the configured path, else the first `claude` on PATH, else
 * ~/.local/bin/claude (where Claude Code's installer puts it).
 */
export function resolveClaudeBin(
  configured: string | null,
  home: string,
  pathEnv: string | undefined = process.env.PATH,
  isFile: (p: string) => boolean = (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
): string {
  if (configured) return configured;
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (dir && path.isAbsolute(dir) && isFile(path.join(dir, "claude"))) return path.join(dir, "claude");
  }
  return path.join(home, ".local", "bin", "claude");
}

/**
 * The Codex CLI to run: the first `codex` on the server's PATH as an absolute path (the same one
 * for the status check and the sign-in line, whatever a login shell's own PATH order is), else
 * the bare name.
 */
export function resolveCodexBin(
  pathEnv: string | undefined = process.env.PATH,
  isFile: (p: string) => boolean = (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
): string {
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (dir && path.isAbsolute(dir) && isFile(path.join(dir, "codex"))) return path.join(dir, "codex");
  }
  return "codex";
}

export interface LoadedConfig {
  config: UserConfig;
  /** The file read, null when there is none (accounts found on disk). */
  file: string | null;
  /** Whether the file writes each account list; a list it leaves out is the one found on disk. */
  explicit: { claudeAccounts: boolean; codexAccounts: boolean };
}

/** Reads the settings file; a missing file is the all-default settings, an unreadable or invalid one throws ConfigError. */
export function loadUserConfig(env: NodeJS.ProcessEnv, home: string): LoadedConfig {
  const file = configFile(env, home);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // A path named by MARU_CONFIG that is missing is a mistake, not "no settings".
      if (env.MARU_CONFIG) throw new ConfigError(`${file}: MARU_CONFIG names a file that does not exist`);
      return { config: completeUserConfig({}, home), file: null, explicit: { claudeAccounts: false, codexAccounts: false } };
    }
    throw new ConfigError(`${file}: cannot be read (${err instanceof Error ? err.message : String(err)})`);
  }
  const config = parseUserConfig(text, home, file);
  const raw = JSON.parse(text) as Record<string, unknown>;
  return { config, file, explicit: { claudeAccounts: raw.claudeAccounts !== undefined, codexAccounts: raw.codexAccounts !== undefined } };
}

/** `~/x` for a path under the home folder, so a written file reads the way a person would write it. */
export function tildify(abs: string, home: string): string {
  if (abs === home) return "~";
  return abs.startsWith(home + path.sep) ? `~/${abs.slice(home.length + 1)}` : abs;
}

/** A change the edit functions refuse, with the HTTP status the accounts routes answer it with. */
export class ConfigEditError extends ConfigError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The text is written next to the file and renamed over it, so a reader sees the old file or the new one, never half. */
export function writeFileAtomic(file: string, text: string): void {
  // A config file that is a symlink stays one: the target is replaced.
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    // no file yet
  }
  // The file is owner-only whatever mode the old one had; the folder is created as 0700.
  const mode = 0o600;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export type AccountProvider = "claude" | "codex";

/**
 * Reads the file as written (or `{}` when there is none), lets `change` edit that object, checks
 * the result as a whole (parseUserConfig: unique ids, folders and shapes), and writes it atomically.
 * Fields `change` leaves alone keep their value and their place; an account list the file leaves
 * out is first filled with the accounts found on disk (a new file gets both lists), so the
 * accounts that worked before the edit still work after it. Returns the settings now in the file.
 */
export function editUserConfig(
  env: NodeJS.ProcessEnv,
  home: string,
  provider: AccountProvider | null,
  change: (raw: Record<string, unknown>, current: UserConfig) => void,
): UserConfig {
  const file = configFile(env, home);
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError(`${file}: cannot be read (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const current = parseUserConfig(text ?? "{}", home, file);
  const raw = (text === null ? {} : JSON.parse(text)) as Record<string, unknown>;
  const seed = (field: "claudeAccounts" | "codexAccounts") => {
    if (raw[field] !== undefined) return;
    raw[field] = field === "claudeAccounts"
      ? current.claudeAccounts.map((a) => ({ id: a.id, dir: tildify(a.dir, home) }))
      : current.codexAccounts.map((a) => ({ id: a.id, home: tildify(a.home, home) }));
  };
  if (text === null) {
    seed("claudeAccounts");
    seed("codexAccounts");
  } else if (provider === "claude") seed("claudeAccounts");
  else if (provider === "codex") seed("codexAccounts");
  change(raw, current);
  const next = `${JSON.stringify(raw, null, 2)}\n`;
  const result = parseUserConfig(next, home, file);
  writeFileAtomic(file, next);
  return result;
}

/** Adds an account to the file. `where` is the CLAUDE_CONFIG_DIR or CODEX_HOME (`~` allowed). */
export function addAccountToFile(env: NodeJS.ProcessEnv, home: string, provider: AccountProvider, id: string, where: string): UserConfig {
  if (!ID_RE.test(id)) throw new ConfigEditError(400, `The id must be letters, digits, ".", "_" or "-", starting with a letter or digit`);
  const abs = expandHome(where.trim(), home);
  if (abs === null) throw new ConfigEditError(400, "The folder must be absolute or start with ~");
  if (/[\x00-\x1f\x7f]/.test(abs)) throw new ConfigEditError(400, "The folder contains control characters");
  const field = provider === "claude" ? "claudeAccounts" : "codexAccounts";
  const key = provider === "claude" ? "dir" : "home";
  return editUserConfig(env, home, provider, (raw, current) => {
    if ([...current.claudeAccounts, ...current.codexAccounts].some((a) => a.id === id)) {
      throw new ConfigEditError(409, `An account named "${id}" exists already`);
    }
    for (const a of [...current.claudeAccounts.map((x) => ({ id: x.id, where: x.dir })), ...current.codexAccounts.map((x) => ({ id: x.id, where: x.home }))]) {
      if (a.where === abs) throw new ConfigEditError(409, `The folder is the account "${a.id}" already`);
    }
    (raw[field] as unknown[]).push({ id, [key]: tildify(abs, home) });
  });
}

/** Takes an account out of the file; its folder and its login stay where they are. */
export function removeAccountFromFile(env: NodeJS.ProcessEnv, home: string, id: string): UserConfig {
  const current = loadUserConfig(env, home).config;
  const provider: AccountProvider | null = current.claudeAccounts.some((a) => a.id === id) ? "claude" : current.codexAccounts.some((a) => a.id === id) ? "codex" : null;
  if (provider === null) throw new ConfigEditError(404, `No account named "${id}"`);
  const field = provider === "claude" ? "claudeAccounts" : "codexAccounts";
  return editUserConfig(env, home, provider, (raw) => {
    raw[field] = (raw[field] as { id: string }[]).filter((a) => a.id !== id);
  });
}

/** Sets `claudeUsage` or `codexUsage` in the file, creating the file when there is none (the found accounts are written with it). */
export function setUsageFlagInFile(env: NodeJS.ProcessEnv, home: string, flag: "claudeUsage" | "codexUsage", enabled: boolean): UserConfig {
  return editUserConfig(env, home, null, (raw) => {
    raw[flag] = enabled;
  });
}

export function setClaudeUsageInFile(env: NodeJS.ProcessEnv, home: string, enabled: boolean): UserConfig {
  return setUsageFlagInFile(env, home, "claudeUsage", enabled);
}

export function setCodexUsageInFile(env: NodeJS.ProcessEnv, home: string, enabled: boolean): UserConfig {
  return setUsageFlagInFile(env, home, "codexUsage", enabled);
}
