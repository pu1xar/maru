// Owner-only permissions for what maru keeps on disk: the state folder (0700), the state database
// with its WAL sidecars and the config file (0600), and the trash and attachments folders (0700).
// The state database holds queued message bodies, device tokens' hashes and session choices, so
// other local users get no read access to any of it.
//
// Folders and files that exist already are narrowed when they are wider than that and belong to
// this user; they are never widened. A database created here starts as an empty 0600 file, so the
// SQLite sidecars (-wal, -shm), which copy the main file's mode, are 0600 as well.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SIDECARS = ["-wal", "-shm", "-journal"] as const;

/** Folders that hold other things than maru's own data; their mode is never touched. */
function isSharedFolder(dir: string, home: string): boolean {
  const abs = path.resolve(dir);
  return abs === path.parse(abs).root || abs === path.resolve(home) || abs === path.resolve(os.tmpdir());
}

function owned(st: fs.Stats): boolean {
  return typeof process.getuid !== "function" || st.uid === process.getuid();
}

/** Creates the folder as 0700 when it is missing, and narrows an existing own folder to 0700. */
export function ensurePrivateDir(dir: string, home = os.homedir()): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if (isSharedFolder(dir, home)) return;
  const st = fs.statSync(dir);
  if (st.isDirectory() && owned(st) && (st.mode & 0o077) !== 0) fs.chmodSync(dir, st.mode & 0o700);
}

/** Narrows an existing own file to 0600 (its owner's bits are kept); a missing file is left missing. */
export function tightenFile(file: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return;
  }
  if (!st.isFile() || !owned(st) || (st.mode & 0o077) === 0) return;
  fs.chmodSync(file, st.mode & FILE_MODE);
}

/** The state database: its folder, the file itself (created as 0600 when missing) and its sidecars. */
export function protectStateFile(file: string, home = os.homedir()): void {
  if (file === ":memory:") return;
  ensurePrivateDir(path.dirname(file), home);
  try {
    fs.closeSync(fs.openSync(file, "wx", FILE_MODE));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  tightenFile(file);
  for (const suffix of SIDECARS) tightenFile(file + suffix);
}

export interface ProtectOptions {
  stateFile: string;
  /** The config file in use, null when there is none. */
  configFile: string | null;
  /** The trash and attachments folders (created when missing). */
  folders: string[];
  home?: string;
}

/** Applies the owner-only modes at server start. */
export function protectPrivateFiles(opts: ProtectOptions): void {
  const home = opts.home ?? os.homedir();
  protectStateFile(opts.stateFile, home);
  if (opts.configFile) tightenFile(opts.configFile);
  for (const dir of opts.folders) ensurePrivateDir(dir, home);
}
