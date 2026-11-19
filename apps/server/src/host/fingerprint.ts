// Fingerprint of the code the Claude session host runs (DESIGN.md 2b): a release restarts the host
// only when this value differs between the new release and the release the host runs.
//
// The file set is the host entry's import graph, followed the way Node loads it:
// - a .ts file is type-stripped with Node's own stripTypeScriptTypes (what Node runs), then V8
//   parses it as a module (vm.SourceTextModule) and lists its static imports. `import type` lines
//   vanish in the strip, so a type-only dependency is no host code.
// - a relative import is another file of the graph. A bare import that resolves into the release
//   outside node_modules (a workspace package) is followed into its source too.
// - any other package is hashed whole as name@version plus every file in its folder, without its
//   own node_modules. Its `dependencies` are hashed the same way. `optionalDependencies` are left
//   out: for the Agent SDK they are the per-platform CLI binaries, and the host runs the CLI the
//   web server names (pathToClaudeCodeExecutable), not the bundled one.
// - node: builtins are not files; the count is reported.
// Every path is taken relative to the release root, so two clones of the same code give the same
// value. Dynamic import() and absolute import paths are not followed: they are reported, never
// dropped silently.
//
// vm.SourceTextModule needs `--experimental-vm-modules`; scripts/host-fingerprint.ts adds it.
import crypto from "node:crypto";
import fs from "node:fs";
import { builtinModules, findPackageJSON, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

export const FINGERPRINT_VERSION = "v1";

/** Entry of the host, relative to the release root. */
export const HOST_ENTRY = "apps/server/src/host/main.ts";

export interface FingerprintEntry {
  kind: "file" | "package";
  /** File path relative to the root, or name@version. */
  id: string;
  sha256: string;
  /** Files hashed for a package. */
  files?: number;
}

export interface Fingerprint {
  /** `v1-<sha256>` over every entry. */
  value: string;
  root: string;
  entries: FingerprintEntry[];
  builtins: string[];
  /** Imports that were not followed, as `<file>: <what>`. Empty when the graph is complete. */
  unfollowed: string[];
}

function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

const BUILTINS = new Set(builtinModules);

function isBuiltin(spec: string): boolean {
  return spec.startsWith("node:") || BUILTINS.has(spec) || BUILTINS.has(spec.split("/")[0]!);
}

function moduleRequests(source: string): string[] {
  const SourceTextModule = (vm as unknown as { SourceTextModule?: new (src: string) => { moduleRequests: Array<{ specifier: string }> } }).SourceTextModule;
  if (!SourceTextModule) throw new Error("vm.SourceTextModule is missing: run node with --experimental-vm-modules");
  return new SourceTextModule(source).moduleRequests.map((r) => r.specifier);
}

/** Every file under `dir` except node_modules, sorted, relative to `dir`. */
function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name !== "node_modules") out.push(...walk(dir, r));
    } else if (e.isFile() || e.isSymbolicLink()) {
      out.push(r);
    }
  }
  return out;
}

/** The entry file of a workspace package, from its exports or main. */
function packageEntry(pkgDir: string, pkg: Record<string, unknown>, subpath: string): string | null {
  const exp = pkg.exports as unknown;
  const pick = (v: unknown): string | null => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return pick(o.import ?? o.node ?? o.default);
    }
    return null;
  };
  let target: string | null = null;
  if (exp && typeof exp === "object" && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith("."))) {
    target = pick((exp as Record<string, unknown>)[subpath]);
  } else if (subpath === ".") {
    target = pick(exp) ?? (typeof pkg.main === "string" ? pkg.main : "index.js");
  }
  return target ? path.resolve(pkgDir, target) : null;
}

function packageName(spec: string): { name: string; subpath: string } {
  const parts = spec.split("/");
  const n = spec.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, n).join("/");
  const rest = parts.slice(n).join("/");
  return { name, subpath: rest ? `./${rest}` : "." };
}

export function hostFingerprint(root: string, entry = HOST_ENTRY): Fingerprint {
  const realRoot = fs.realpathSync(root);
  const inRelease = (p: string) => (p === realRoot || p.startsWith(realRoot + path.sep)) && !p.split(path.sep).includes("node_modules");
  const relOf = (p: string) => path.relative(realRoot, p).split(path.sep).join("/");
  const entries = new Map<string, FingerprintEntry>();
  const builtins = new Set<string>();
  const unfollowed: string[] = [];
  const seenPackages = new Set<string>();

  function addPackage(pkgJsonPath: string): void {
    const pkgDir = fs.realpathSync(path.dirname(pkgJsonPath));
    if (seenPackages.has(pkgDir)) return;
    seenPackages.add(pkgDir);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
    const id = `${String(pkg.name)}@${String(pkg.version)}`;
    const files = walk(pkgDir);
    const h = crypto.createHash("sha256");
    for (const f of files) h.update(`${f}\0${sha256(fs.readFileSync(path.join(pkgDir, f)))}\n`);
    entries.set(`package:${id}`, { kind: "package", id, sha256: h.digest("hex"), files: files.length });
    for (const dep of Object.keys((pkg.dependencies ?? {}) as Record<string, string>)) {
      const found = findPackageJSON(dep, pathToFileURL(path.join(pkgDir, "package.json")));
      if (found) addPackage(found);
      else unfollowed.push(`${id}: dependency ${dep} not installed`);
    }
  }

  function visit(file: string): void {
    const real = fs.realpathSync(file);
    const rel = relOf(real);
    if (entries.has(`file:${rel}`)) return;
    const bytes = fs.readFileSync(real);
    entries.set(`file:${rel}`, { kind: "file", id: rel, sha256: sha256(bytes) });
    const ext = path.extname(real);
    if (ext === ".json") return;
    if (ext === ".cjs" || ext === ".cts") {
      unfollowed.push(`${rel}: CommonJS requires are not followed`);
      return;
    }
    const text = bytes.toString("utf8");
    const js = ext === ".ts" || ext === ".mts" ? stripTypeScriptTypes(text, { mode: "strip" }) : text;
    if (/\bimport\s*\(/.test(js)) unfollowed.push(`${rel}: dynamic import() is not followed`);
    for (const spec of moduleRequests(js)) {
      if (isBuiltin(spec)) {
        builtins.add(spec.replace(/^node:/, ""));
      } else if (spec.startsWith("./") || spec.startsWith("../")) {
        visit(path.resolve(path.dirname(real), spec));
      } else if (spec.startsWith("/") || spec.startsWith("file:")) {
        unfollowed.push(`${rel}: absolute import ${spec}`);
      } else {
        const found = findPackageJSON(spec, pathToFileURL(real));
        if (!found) {
          unfollowed.push(`${rel}: package ${spec} not found`);
          continue;
        }
        const pkgDir = fs.realpathSync(path.dirname(found));
        if (inRelease(pkgDir)) {
          const pkg = JSON.parse(fs.readFileSync(found, "utf8")) as Record<string, unknown>;
          const target = packageEntry(pkgDir, pkg, packageName(spec).subpath);
          if (target) visit(target);
          else unfollowed.push(`${rel}: no entry for ${spec}`);
        } else {
          addPackage(found);
        }
      }
    }
  }

  visit(path.join(realRoot, entry));
  const list = [...entries.values()].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  const h = crypto.createHash("sha256");
  for (const e of list) h.update(`${e.kind}\0${e.id}\0${e.sha256}\n`);
  return { value: `${FINGERPRINT_VERSION}-${h.digest("hex")}`, root: realRoot, entries: list, builtins: [...builtins].sort(), unfollowed };
}
