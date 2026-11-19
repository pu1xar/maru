// Whether the packages npm installed (node_modules/.package-lock.json, npm's hidden lockfile) are
// the ones a package-lock.json asks for, so release.sh (export_commit) can clone that node_modules
// into a release instead of installing:
//   node scripts/installed-deps.ts <node_modules/.package-lock.json> <package-lock.json>
// Exit 0 when they match; exit 1 with the reason on stdout when they differ or a file is missing.
//
// A lockfile tracks what is committed, not what is installed: a merge or a pull changes
// package-lock.json and leaves node_modules as it was. The hidden lockfile is what npm last
// installed. It leaves out the root entry ("") and the optional packages this platform skipped
// (other OSes' builds), so those two are the only entries the comparison lets it miss.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

type Packages = Record<string, { optional?: boolean; devOptional?: boolean } & Record<string, unknown>>;

/** null when `installed` holds what `wanted` asks for, else the first reason it does not. */
export function npmInstalledMismatch(wanted: Packages, installed: Packages): string | null {
  for (const [name, entry] of Object.entries(installed)) {
    if (name === "") continue;
    const want = wanted[name];
    if (!want) return `${name} is installed but not in package-lock.json`;
    if (JSON.stringify(want) !== JSON.stringify(entry)) return `${name} is installed at a different version or source`;
  }
  for (const [name, entry] of Object.entries(wanted)) {
    if (name === "" || name in installed) continue;
    if (entry.optional || entry.devOptional) continue;
    return `${name} is in package-lock.json but not installed`;
  }
  return null;
}

function packagesOf(file: string): Packages | string {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return `${file} is missing`;
  }
  const parsed = JSON.parse(text) as { packages?: Packages };
  return parsed.packages ?? `${file} has no packages`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [installedFile, wantedFile] = process.argv.slice(2);
  if (!installedFile || !wantedFile) {
    process.stdout.write("usage: installed-deps.ts <node_modules/.package-lock.json> <package-lock.json>\n");
    process.exit(2);
  }
  const installed = packagesOf(installedFile);
  const wanted = packagesOf(wantedFile);
  const reason =
    typeof installed === "string" ? installed : typeof wanted === "string" ? wanted : npmInstalledMismatch(wanted, installed);
  if (reason) {
    process.stdout.write(`${reason}\n`);
    process.exit(1);
  }
}
