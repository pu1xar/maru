// `node scripts/host-fingerprint.ts [root] [--list]` (fingerprint.ts). Prints one line, the
// fingerprint of the session host code under `root` (default: the release this file is in).
//   --list   also every file and package with its hash, the builtins, and what was not followed
// Exit 0: printed. Exit 2: printed, but some imports could not be followed (listed on stderr), so
// the value may miss a change; treat it as different. Exit 1: failed.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { hostFingerprint } from "./fingerprint.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

if (!("SourceTextModule" in vm)) {
  // V8's module parser needs this flag; run again with it.
  const r = spawnSync(process.execPath, ["--experimental-vm-modules", "--no-warnings", process.argv[1]!, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const args = process.argv.slice(2);
const list = args.includes("--list");
const rootArg = args.find((a) => !a.startsWith("--"));
const root = path.resolve(rootArg ?? path.join(here, "..", "..", "..", ".."));

try {
  const fp = hostFingerprint(root);
  console.log(fp.value);
  if (list) {
    console.log(`root ${fp.root}`);
    for (const e of fp.entries) console.log(`${e.kind} ${e.id} ${e.sha256}${e.files !== undefined ? ` (${e.files} files)` : ""}`);
    console.log(`builtins ${fp.builtins.join(" ")}`);
    console.log(`unfollowed ${fp.unfollowed.length}`);
  }
  for (const u of fp.unfollowed) console.error(`not followed: ${u}`);
  process.exit(fp.unfollowed.length ? 2 : 0);
} catch (err) {
  console.error(`host fingerprint failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
