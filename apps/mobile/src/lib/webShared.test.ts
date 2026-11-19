// The app bundles part of the web's source (metro.config.js watchFolders: apps/web/src): the
// session grouping, the thread reducer and the timeline rules. Metro resolves packages only from
// this app's node_modules, and tsc here type-checks those files under this app's settings. So
// every web file the app reaches, directly or through other web files, may import only relative
// files and @maru/shared: no path alias (`~/`), no npm package, no React or DOM component file.
// A web change that breaks this fails here instead of in the release's OTA export.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appSrc = path.resolve(here, "..");
const webSrc = path.resolve(here, "../../../web/src");
const IMPORT = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : /\.tsx?$/.test(d.name) ? [p] : [];
  });
}

function resolve(from: string, spec: string): string | null {
  const p = path.resolve(path.dirname(from), spec);
  for (const c of [p, `${p}.ts`, `${p}.tsx`, path.join(p, "index.ts")]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
}

test("the web files the app bundles are pure: relative imports and @maru/shared only", () => {
  const reached = new Set<string>();
  const problems: string[] = [];
  const queue = files(appSrc);
  const seen = new Set<string>();
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const inWeb = file.startsWith(webSrc + path.sep);
    if (inWeb) reached.add(file);
    const text = fs.readFileSync(file, "utf8");
    if (inWeb && file.endsWith(".tsx")) problems.push(`${path.relative(webSrc, file)}: a component file`);
    if (inWeb && /\b(window|document|localStorage|sessionStorage|navigator|globalThis|CSS)\./.test(text)) problems.push(`${path.relative(webSrc, file)}: uses the DOM or a global`);
    // Loads the static import pattern below does not follow.
    if (inWeb && /\b(require\s*\(|import\s*\()/.test(text)) problems.push(`${path.relative(webSrc, file)}: a dynamic import or require`);
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1]!;
      if (spec.startsWith(".")) {
        const target = resolve(file, spec);
        if (!target) problems.push(`${path.relative(appSrc, file)}: cannot resolve ${spec}`);
        else queue.push(target);
        continue;
      }
      if (!inWeb || spec === "@maru/shared") continue;
      problems.push(`${path.relative(webSrc, file)}: imports ${spec}`);
    }
  }
  assert.deepEqual(problems, []);
  // The denominator: how many web files the app pulls in. A big jump means a new dependency chain.
  assert.ok(reached.size > 20, `reached ${reached.size} web files`);
  console.log(`web files bundled by the app: ${reached.size}`);
});
