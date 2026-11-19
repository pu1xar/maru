// Regenerates ./protocol from the installed codex CLI (`codex app-server generate-ts`).
//
// The generator writes extension-less relative imports ("./Thread", "./v2"). The server
// type-checks under `moduleResolution: nodenext`, which requires explicit extensions, so
// every relative specifier is rewritten to the file it resolves to ("./Thread.ts",
// "./v2/index.ts"). The generated files hold types only; code imports them with
// `import type`, so Node's type stripping never loads them at runtime.
//
// Run from anywhere after upgrading codex:  node apps/server/src/codex/gen-protocol.ts

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const OUT = path.join(HERE, "protocol");
const TMP = path.join(HERE, ".protocol-tmp");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listTsFiles(p));
    else if (ent.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(`${base}.ts`)) return `${spec}.ts`;
  if (fs.existsSync(path.join(base, "index.ts"))) return `${spec}/index.ts`;
  return null;
}

const version = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
fs.rmSync(TMP, { recursive: true, force: true });
execFileSync("codex", ["app-server", "generate-ts", "--out", TMP], { stdio: "inherit" });

const files = listTsFiles(TMP);
let rewritten = 0;
const unresolved: string[] = [];
const otherFiles: string[] = [];
for (const dirent of fs.readdirSync(TMP, { recursive: true, withFileTypes: true })) {
  if (dirent.isFile() && !dirent.name.endsWith(".ts")) otherFiles.push(path.join(dirent.parentPath, dirent.name));
}
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const next = src.replace(/from "(\.{1,2}\/[^"]+)"/g, (whole, spec: string) => {
    if (spec.endsWith(".ts")) return whole;
    const resolved = resolveSpecifier(file, spec);
    if (!resolved) {
      unresolved.push(`${path.relative(TMP, file)}: ${spec}`);
      return whole;
    }
    rewritten++;
    return `from "${resolved}"`;
  });
  if (next !== src) fs.writeFileSync(file, next);
}

if (unresolved.length > 0) {
  console.error(`unresolved relative imports (${unresolved.length}):\n${unresolved.join("\n")}`);
  console.error(`left the generated files in ${TMP}`);
  process.exit(1);
}

fs.writeFileSync(path.join(TMP, "CODEX_VERSION"), `${version}\n`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.renameSync(TMP, OUT);
console.log(
  `${version}: ${files.length} .ts files, ${rewritten} relative imports rewritten, ` +
    `${otherFiles.length} non-.ts files${otherFiles.length ? ` (${otherFiles.join(", ")})` : ""}`,
);
