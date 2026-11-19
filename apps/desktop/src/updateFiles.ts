// What the updater keeps in userData/updates (DESIGN.md 2e): one folder per version, named by the
// version. The folder of the build that is running holds the update file that build was installed
// from, which the next update's differential download takes its blocks from (deltaDownload.ts).
// The folder of the build being fetched holds its partial file, which a later attempt resumes.
import fs from "node:fs";
import path from "node:path";

/** Removes every folder in `dir` whose name is not in `keep`; files beside the folders (swap.sh, swap.log) stay. */
export function pruneUpdates(dir: string, keep: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && !keep.includes(e.name)) fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
  }
}

/**
 * The finished update file of the running build (`<dir>/<version>/*<ext>`, never a `.partial`), or
 * null. It is a source of blocks only: each block is checked against the signed block map before
 * it is used, so a baseline that changed on disk costs bytes, not safety.
 */
export function findBaseline(dir: string, runningVersion: string, ext: string): string | null {
  const from = path.join(dir, runningVersion);
  let names: string[];
  try {
    names = fs.readdirSync(from);
  } catch {
    return null;
  }
  const name = names.find((n) => n.endsWith(ext));
  return name ? path.join(from, name) : null;
}
