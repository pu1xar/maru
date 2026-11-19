// Bundles the desktop app's code into dist-electron/ (DESIGN.md 2e), as T3 Code does with its
// pack step: main.cjs and preload.cjs, each one CommonJS file (a sandboxed preload may require only
// electron), and the local screens in pages/. The output holds no version or time, so the same
// source gives the same bytes and the shell's fingerprint (fingerprint.ts) follows the code alone.
//
//   node apps/desktop/scripts/bundle.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { APP_ID } from "./builderConfig.ts";

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_DIR = path.join(APP_DIR, "dist-electron");

async function bundleEntry(entry: string, file: string, external: (string | RegExp)[]): Promise<void> {
  await build({
    configFile: false,
    root: APP_DIR,
    logLevel: "warn",
    // The application id the running app needs (main.ts), the one builderConfig.ts gives the installer.
    define: { __MARU_APP_ID__: JSON.stringify(APP_ID) },
    build: {
      ssr: path.join(APP_DIR, "src", entry),
      outDir: OUT_DIR,
      emptyOutDir: false,
      target: "node22",
      minify: false,
      sourcemap: false,
      copyPublicDir: false,
      rolldownOptions: {
        external,
        output: { format: "cjs", entryFileNames: file, codeSplitting: false },
      },
    },
    ssr: { noExternal: true, target: "node" },
  });
}

export async function bundle(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await bundleEntry("main.ts", "main.cjs", ["electron", /^node:/]);
  await bundleEntry("preload.ts", "preload.cjs", ["electron"]);
  const preload = fs.readFileSync(path.join(OUT_DIR, "preload.cjs"), "utf8");
  const required = [...preload.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  if (required.some((r) => r !== "electron")) throw new Error(`preload.cjs requires more than electron: ${required.join(", ")}`);
  fs.cpSync(path.join(APP_DIR, "src", "pages"), path.join(OUT_DIR, "pages"), { recursive: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundle();
  console.log(`bundle: ${fs.readdirSync(OUT_DIR).join(", ")} in ${OUT_DIR}`);
}
