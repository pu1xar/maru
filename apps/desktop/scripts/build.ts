// Builds the desktop app's installers and the signed manifest the server hands out (DESIGN.md 2e).
//
//   node apps/desktop/scripts/build.ts --out <dir> [--version 0.1.N] [--previous <dir>]
//        [--targets mac-arm64,mac-x64,win-x64] [--key <private pem>] [--cert <certificate pem>]
//
//   1. bundle the code (bundle.ts) and compute the shell's fingerprint (fingerprint.ts)
//   2. with --previous (the running release's build): when its signed manifest has the same
//      fingerprint and holds every target, clone its files into --out and stop. An unchanged shell
//      keeps its version, so installed apps see nothing new
//   3. otherwise electron-builder (builderConfig.ts) per platform: the Mac zip and dmg, the Windows
//      NSIS installer. Everything is built on this Mac; the Windows installer needs no wine
//   4. a block map beside each update file (zip, nsis; blockmap.ts), so an app that has the previous
//      build fetches only the blocks that changed (deltaDownload.ts). The manifest lists its size and SHA-256
//   5. manifest.json (version, fingerprint, files with size and SHA-256), signed with the update key
//      that stays on this Mac (~/.config/maru/updates-signing/private-key.pem, as the Android OTA)
//      and checked against the certificate the app carries before anything is written
// The version is MARU_VERSION (release.sh sets it), else --version, else the checkout's HEAD with
// -dev; an app takes only a release version (0.1.N) as an update.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Arch, Platform, build as electronBuild } from "electron-builder";
import type { DesktopArtifact, DesktopUpdateManifest } from "@maru/shared";
import { buildVersion } from "../../../packages/shared/src/gitVersion.ts";
import { parseVersion } from "../../../packages/shared/src/version.ts";
import { blockMapOfFile, encodeBlockMap } from "../src/blockmap.ts";
import { APP_DIR, bundle } from "./bundle.ts";
import { DEFAULT_CERT, LOCAL_SIGNING_NAME, builderConfig, localSigningIdentity } from "./builderConfig.ts";
import { fingerprint } from "./fingerprint.ts";

const say = (line: string) => console.log(`build-desktop: ${line}`);
const DEFAULT_KEY = path.join(os.homedir(), ".config", "maru", "updates-signing", "private-key.pem");

interface Target {
  platform: DesktopArtifact["platform"];
  arch: DesktopArtifact["arch"];
}

export function parseTargets(text: string): Target[] {
  return text.split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
    const m = /^(mac|win)-(arm64|x64)$/.exec(t);
    if (!m) throw new Error(`unknown target ${t} (mac-arm64, mac-x64, win-x64, win-arm64)`);
    return { platform: m[1] === "mac" ? "darwin" : "win32", arch: m[2] as Target["arch"] };
  });
}

const sha256File = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** The formats an app updates from: they carry a block map, the dmg (only ever downloaded whole) does not. */
const hasBlockmap = (format: DesktopArtifact["format"]) => format === "zip" || format === "nsis";

/** Writes `<file>.blockmap` next to an update file and returns its manifest entry. */
export async function writeBlockmap(dir: string, file: string): Promise<NonNullable<DesktopArtifact["blockmap"]>> {
  const data = encodeBlockMap(await blockMapOfFile(path.join(dir, file)));
  const name = `${file}.blockmap`;
  fs.writeFileSync(path.join(dir, name), data);
  return { file: name, size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
}

/**
 * makensis 3.0.4.1, which electron-builder runs on a Mac, copies each included file's path into a
 * fixed stack buffer: an include path of 264 characters builds, 265 aborts with "stack buffer
 * overflow" in set_file_predefine (measured 2026-11-16 by including one file from folders of each
 * length). The includes are app-builder-lib's NSIS templates, so their length follows the checkout.
 */
const NSIS_PATH_LIMIT = 264;

/** The longest absolute path among app-builder-lib's NSIS templates as this checkout resolves them. */
function nsisIncludePathLength(): number {
  // app-builder-lib is electron-builder's dependency, so it resolves from electron-builder's folder.
  const builder = fs.realpathSync(createRequire(import.meta.url).resolve("electron-builder/package.json"));
  const dir = path.join(path.dirname(createRequire(builder).resolve("app-builder-lib/package.json")), "templates", "nsis");
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  return Math.max(0, ...walk(fs.realpathSync(dir)).filter((f) => /\.nsh$/.test(f)).map((f) => f.length));
}

/** The previous build's files when it is this shell with every target; null otherwise (why is logged). */
export function reusable(prev: string, fp: string, targets: Target[], cert: string): { text: string; sig: string; manifest: DesktopUpdateManifest } | null {
  let text: string;
  let sig: string;
  try {
    text = fs.readFileSync(path.join(prev, "manifest.json"), "utf8");
    sig = fs.readFileSync(path.join(prev, "manifest.json.sig"), "utf8").trim();
  } catch {
    say(`no previous build in ${prev}`);
    return null;
  }
  if (!crypto.verify("sha256", Buffer.from(text), crypto.createPublicKey(cert), Buffer.from(sig, "base64"))) {
    say("the previous manifest does not verify with this certificate; building");
    return null;
  }
  const manifest = JSON.parse(text) as DesktopUpdateManifest;
  if (manifest.fingerprint !== fp) {
    say(`shell changed since ${manifest.version} (${manifest.fingerprint.slice(0, 15)} -> ${fp.slice(0, 15)}); building`);
    return null;
  }
  const missing = targets.filter((t) => !manifest.artifacts.some((a) => a.platform === t.platform && a.arch === t.arch));
  if (missing.length > 0) {
    say(`the previous build lacks ${missing.map((t) => `${t.platform}-${t.arch}`).join(", ")}; building`);
    return null;
  }
  for (const a of manifest.artifacts) {
    const file = path.join(prev, a.file);
    if (!fs.existsSync(file) || fs.statSync(file).size !== a.size || sha256File(file) !== a.sha256) {
      say(`the previous build's ${a.file} is missing or changed; building`);
      return null;
    }
    if (hasBlockmap(a.format) && !a.blockmap) {
      say(`the previous build's ${a.file} has no block map (a build from before the differential update); building`);
      return null;
    }
    if (a.blockmap) {
      const map = path.join(prev, a.blockmap.file);
      if (!fs.existsSync(map) || fs.statSync(map).size !== a.blockmap.size || sha256File(map) !== a.blockmap.sha256) {
        say(`the previous build's ${a.blockmap.file} is missing or changed; building`);
        return null;
      }
    }
  }
  return { text, sig, manifest };
}

async function buildPlatform(targets: Target[], platform: Target["platform"], version: string, tmp: string, cert: string): Promise<void> {
  const archs = targets.filter((t) => t.platform === platform).map((t) => (t.arch === "arm64" ? Arch.arm64 : Arch.x64));
  if (archs.length === 0) return;
  if (platform === "win32") {
    const longest = nsisIncludePathLength();
    if (longest > NSIS_PATH_LIMIT) {
      say(`warning: the longest NSIS include path here is ${longest} characters; electron-builder's macOS makensis (3.0.4.1) `
        + `overflows a stack buffer above ${NSIS_PATH_LIMIT} (measured 2026-11-16: 264 builds, 265 aborts) and may crash. `
        + "Build from a shorter checkout path (the release folder ~/.local/share/maru gives 257)");
    }
  }
  const p = platform === "darwin" ? Platform.MAC : Platform.WINDOWS;
  const formats = platform === "darwin" ? ["zip", "dmg"] : ["nsis"];
  const signingIdentity = platform === "darwin" ? localSigningIdentity() : null;
  if (platform === "darwin") {
    say(signingIdentity
      ? `mac signing: "${LOCAL_SIGNING_NAME}" (${signingIdentity})`
      : `warning: no "${LOCAL_SIGNING_NAME}" in the Keychain, the Mac app is ad-hoc signed and its Keychain item asks again after this update`);
  }
  const t0 = Date.now();
  await electronBuild({
    projectDir: APP_DIR,
    targets: p.createTarget(formats, ...archs),
    config: builderConfig({ version, output: tmp, certificate: cert, signingIdentity }),
    publish: "never",
  });
  say(`${platform} built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

export async function buildDesktop(opts: { out: string; version: string; targets: Target[]; key: string; cert: string; previous: string | null }): Promise<DesktopUpdateManifest> {
  const certPem = fs.readFileSync(opts.cert, "utf8");
  await bundle();
  const fp = fingerprint(APP_DIR, certPem);
  say(`version ${opts.version}, fingerprint ${fp}`);
  fs.rmSync(opts.out, { recursive: true, force: true });
  fs.mkdirSync(opts.out, { recursive: true });

  const prev = opts.previous ? reusable(opts.previous, fp, opts.targets, certPem) : null;
  if (prev) {
    for (const a of prev.manifest.artifacts) {
      for (const f of [a.file, ...(a.blockmap ? [a.blockmap.file] : [])]) execFileSync("cp", ["-c", path.join(opts.previous!, f), path.join(opts.out, f)]);
    }
    fs.writeFileSync(path.join(opts.out, "manifest.json"), prev.text);
    fs.writeFileSync(path.join(opts.out, "manifest.json.sig"), `${prev.sig}\n`);
    say(`unchanged since the previous release: kept ${prev.manifest.version} (${prev.manifest.artifacts.length} files)`);
    return prev.manifest;
  }

  if (parseVersion(opts.version)?.dev !== false) say(`${opts.version} is not a release version: apps will not take this build as an update`);
  const tmp = path.join(opts.out, ".builder");
  await buildPlatform(opts.targets, "darwin", opts.version, tmp, opts.cert);
  await buildPlatform(opts.targets, "win32", opts.version, tmp, opts.cert);

  const artifacts: DesktopArtifact[] = [];
  for (const t of opts.targets) {
    const name = t.platform === "darwin" ? `maru-${opts.version}-mac-${t.arch}` : `maru-${opts.version}-win-${t.arch}`;
    const formats: [DesktopArtifact["format"], string][] = t.platform === "darwin" ? [["zip", "zip"], ["dmg", "dmg"]] : [["nsis", "exe"]];
    for (const [format, ext] of formats) {
      const file = `${name}.${ext}`;
      const from = path.join(tmp, file);
      if (!fs.existsSync(from)) throw new Error(`electron-builder made no ${file} (in ${tmp}: ${fs.readdirSync(tmp).join(", ")})`);
      fs.renameSync(from, path.join(opts.out, file));
      const full = path.join(opts.out, file);
      const artifact: DesktopArtifact = { file, platform: t.platform, arch: t.arch, format, size: fs.statSync(full).size, sha256: sha256File(full) };
      if (hasBlockmap(format)) {
        const t1 = Date.now();
        artifact.blockmap = await writeBlockmap(opts.out, file);
        say(`${artifact.blockmap.file} ${(artifact.blockmap.size / 1e3).toFixed(0)} KB in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
      }
      artifacts.push(artifact);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  const manifest: DesktopUpdateManifest = { format: 1, type: "maru-desktop-update", version: opts.version, fingerprint: fp, builtAt: new Date().toISOString(), artifacts };
  const text = `${JSON.stringify(manifest, null, 1)}\n`;
  const sig = crypto.sign("sha256", Buffer.from(text), crypto.createPrivateKey(fs.readFileSync(opts.key, "utf8"))).toString("base64");
  if (!crypto.verify("sha256", Buffer.from(text), crypto.createPublicKey(certPem), Buffer.from(sig, "base64"))) {
    throw new Error(`the signature does not verify with ${opts.cert}: the key and the certificate the app carries do not match`);
  }
  fs.writeFileSync(path.join(opts.out, "manifest.json"), text);
  fs.writeFileSync(path.join(opts.out, "manifest.json.sig"), `${sig}\n`);
  for (const a of artifacts) say(`${a.file} ${(a.size / 1e6).toFixed(1)} MB`);
  say(`signed manifest for ${opts.version} in ${opts.out}`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = "usage: build.ts --out <dir> [--version 0.1.N] [--previous <dir>] [--targets mac-arm64,win-x64] [--key <pem>] [--cert <pem>]";
  // Every argument is an option with a value; anything else stops the run instead of being ignored.
  const given = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]!;
    if (!["--out", "--version", "--previous", "--targets", "--key", "--cert"].includes(name) || argv[i + 1] === undefined) {
      console.error(`build.ts: unknown option or missing value: ${name}\n${usage}`);
      process.exit(2);
    }
    given.set(name, argv[i + 1]!);
  }
  const arg = (name: string) => given.get(name) ?? null;
  const out = arg("--out");
  if (!out) {
    console.error(usage);
    process.exit(2);
  }
  const version = process.env.MARU_VERSION || arg("--version") || buildVersion(path.resolve(APP_DIR, "..", "..")) || "0.0.0-dev";
  await buildDesktop({
    out: path.resolve(out),
    version,
    targets: parseTargets(arg("--targets") ?? process.env.MARU_DESKTOP_TARGETS ?? "mac-arm64,win-x64"),
    key: arg("--key") ?? DEFAULT_KEY,
    cert: arg("--cert") ?? DEFAULT_CERT,
    previous: arg("--previous"),
  });
}
