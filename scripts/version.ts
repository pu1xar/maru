// maru's version of a commit (packages/shared/src/version.ts, DESIGN.md 2c):
//   node scripts/version.ts [--repo <dir>] [<commit-ish>]     prints 0.1.N (default: HEAD)
// --repo names the checkout git asks; the default is the one this script is in. release.sh runs the
// copy inside a release clone, which has no .git, with --repo set to the checkout it exported from,
// so the series is the released commit's own.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitVersion } from "../packages/shared/src/gitVersion.ts";

let repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let ref = "HEAD";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--repo" && argv[i + 1]) repo = path.resolve(argv[++i]!);
  else if (!a.startsWith("-")) ref = a;
  else {
    console.error(`version: unknown argument ${a}`);
    process.exit(2);
  }
}
const version = gitVersion(repo, ref);
if (!version) {
  console.error(`version: no commit ${ref} in a repository whose top level is ${repo}`);
  process.exit(1);
}
console.log(version);
