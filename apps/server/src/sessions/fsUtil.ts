// File system helpers shared by the session management modules (rename, delete and the trash,
// account moves, rehome). Every call is synchronous: a management step checks who holds a session
// and then moves its files without an await in between, so a resume started by this server cannot
// slip into the gap (the driver checks and claims a session the same way).
import fs from "node:fs";
import path from "node:path";
import { isNotFound } from "../claude/meta.ts";

/**
 * Append compact JSON lines. When the file's last line lacks its newline (a writer that died
 * mid-line), a newline goes first so the new lines stay whole.
 */
export function appendLines(file: string, records: object[]): void {
  let text = records.map((r) => JSON.stringify(r) + "\n").join("");
  if (!endsWithNewline(file)) text = "\n" + text;
  fs.appendFileSync(file, text);
}

/** True for a missing or empty file too: nothing to finish then. */
function endsWithNewline(file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (err) {
    if (isNotFound(err)) return true;
    throw err;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

/** lstat, or null when nothing is at `p`. */
export function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Directory entries, or [] when the directory does not exist. */
export function readDirOrEmpty(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

export interface TreeStats {
  /** Every entry that is not a directory (files and symlinks), counted with its own size. */
  files: number;
  bytes: number;
  /** Latest mtime among the entries and the root, ms. */
  mtimeMs: number;
}

/** Files and bytes under `p` (recursive for a directory, never through a symlink). */
export function treeStats(p: string): TreeStats {
  const out: TreeStats = { files: 0, bytes: 0, mtimeMs: 0 };
  const root = lstatOrNull(p);
  if (root === null) return out;
  out.mtimeMs = root.mtimeMs;
  if (!root.isDirectory()) {
    out.files = 1;
    out.bytes = root.size;
    return out;
  }
  const stack = [p];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const e of readDirOrEmpty(dir)) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      const st = lstatOrNull(full);
      if (st === null) continue;
      out.files++;
      out.bytes += st.size;
      if (st.mtimeMs > out.mtimeMs) out.mtimeMs = st.mtimeMs;
    }
  }
  return out;
}

/**
 * Move a file or directory tree. A rename when both sides share a volume; across volumes a copy
 * that keeps timestamps and modes, then the source is removed. Never replaces an existing `dst`.
 */
export function moveSync(src: string, dst: string): void {
  if (lstatOrNull(dst) !== null) throw new Error(`Path already exists: ${dst}`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  fs.rmSync(src, { recursive: true, force: true });
}

/**
 * A second name for a file's data: a hard link on the same volume (no copy, and the data stays
 * when the original name is removed), otherwise a copy.
 */
export function linkOrCopy(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.linkSync(src, dst);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "EPERM" && code !== "EMLINK") throw err;
  }
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
}

/** True when `child` is `parent` or lies inside it, compared after resolving symlinks. */
export function isInside(parent: string, child: string): boolean {
  let p: string;
  let c: string;
  try {
    p = fs.realpathSync(parent);
    c = fs.realpathSync(child);
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
  return c === p || c.startsWith(p + path.sep);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
