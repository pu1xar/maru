// maru's version (version.ts) read from git, for the tools that run next to a checkout: the server
// outside a release, the web build, the Android app's config and OTA export, scripts/version.ts
// (release.sh, build-apk.sh). Node only, so the package index leaves it out of the web bundle.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { formatVersion } from "./version.ts";

/**
 * The commit count of `ref` in the repository whose top level is `root`. Null when `root` is not
 * the top level of a repository (a release clone or the APK build folder: git would otherwise
 * answer for whatever repository encloses it) or when git does not know the ref.
 */
export function gitCount(root: string, ref = "HEAD"): number | null {
  const git = (args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    if (fs.realpathSync(git(["rev-parse", "--show-toplevel"])) !== fs.realpathSync(root)) return null;
    const n = Number(git(["rev-list", "--count", "--end-of-options", ref]));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** The version of a commit ("0.1.N", or "0.1.N-dev" with dev), or null (gitCount). */
export function gitVersion(root: string, ref = "HEAD", opts: { dev?: boolean } = {}): string | null {
  const n = gitCount(root, ref);
  return n === null ? null : formatVersion(n, { dev: opts.dev });
}

/**
 * The version a build made from the checkout at `root` carries: env MARU_VERSION, which release.sh
 * and build-apk.sh set for their build steps, else the checkout's HEAD with "-dev", else null.
 */
export function buildVersion(root: string): string | null {
  return process.env.MARU_VERSION || gitVersion(root, "HEAD", { dev: true });
}
