// node-pty, loaded on the first attached view (a native addon: a server that never opens a shell
// view never loads it, and a load failure fails that view only).
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { IPty, IPtyForkOptions } from "node-pty";

export type { IPty };

export interface PtySpawner {
  (file: string, args: string[], options: IPtyForkOptions): IPty;
}

let loaded: typeof import("node-pty") | null = null;

/**
 * node-pty's spawn. Its prebuilt macOS binaries come with a `spawn-helper` that it executes for
 * every pty, and a package manager that unpacks the tarball can leave that file without its execute
 * bit (pnpm 9 did here: posix_spawnp failed). So the helper is made executable once before the first
 * spawn, as T3 Code does (NodePtyAdapter.ts ensureNodePtySpawnHelperExecutable).
 */
export function nodePtySpawn(): PtySpawner {
  if (!loaded) {
    const require = createRequire(import.meta.url);
    const main = require.resolve("node-pty");
    makeHelperExecutable(path.resolve(path.dirname(main), ".."));
    loaded = require("node-pty") as typeof import("node-pty");
  }
  const pty = loaded;
  return (file, args, options) => pty.spawn(file, args, options);
}

export function makeHelperExecutable(packageRoot: string): void {
  if (process.platform === "win32") return;
  for (const dir of ["build/Release", "build/Debug", `prebuilds/${process.platform}-${process.arch}`]) {
    const helper = path.join(packageRoot, dir, "spawn-helper");
    try {
      const mode = fs.statSync(helper).mode;
      if ((mode & 0o111) !== 0o111) fs.chmodSync(helper, 0o755);
    } catch {
      // not in this layout
    }
  }
}
