// The version this server runs (DESIGN.md 2c), sent in the /ws hello and /healthz: a release's
// from its .release.json (scripts/release.sh writes it), else the checkout's HEAD with "-dev".
import fs from "node:fs";
import path from "node:path";
import { gitVersion } from "../../../../packages/shared/src/gitVersion.ts";

/** `root` is the release (or checkout) root: the folder holding apps/ and .release.json. */
export function serverVersion(root: string): string | null {
  return releaseVersion(root) ?? gitVersion(root, "HEAD", { dev: true });
}

function releaseVersion(root: string): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(root, ".release.json"), "utf8")) as { version?: unknown };
    return typeof meta.version === "string" && meta.version ? meta.version : null;
  } catch {
    return null;
  }
}
