// Exports the app's JavaScript as one signed OTA update (Expo Updates protocol 1, DESIGN.md 2d).
//
//   node apps/mobile/scripts/ota-export.mts --out <dir> [--previous <dir>] [--key <pem>]
//
// release.sh runs it inside each release clone with --out <clone>/apps/mobile/dist-ota, so the web
// server running that release serves exactly this update (apps/server/src/mobile/ota.ts).
//   1. `expo export --platform android` (Hermes bundle and assets)
//   2. the runtime version: the native fingerprint, the same value build-apk.sh builds into an APK.
//      An APK with another value never gets this update; it needs a new APK.
//   3. the manifest, with asset URLs relative to the update URL (`/ota/assets/<key>`), so one
//      signed manifest serves the production server and a test server alike
//   4. the signature over the manifest bytes, made here with the private key that stays on this Mac
//      (~/.config/maru/updates-signing/private-key.pem, or --key), and checked against the
//      certificate the APK carries (certs/certificate.pem, or MARU_UPDATES_CERT) before anything is written
// The update id comes from the content: an unchanged app gives the same id, and with --previous
// (the running release's dist-ota) the same createdAt and signature too, so phones download
// nothing new.
// The manifest's extra.maruVersion is the maru version (MARU_VERSION from release.sh, else git,
// DESIGN.md 2c), which the app shows. It stays out of the bundle and of the id, so a new version
// alone is no new update: an unchanged app keeps the version of the release that first exported it.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBuildEnv } from "../../../packages/shared/src/buildEnv.ts";
import { buildVersion } from "../../../packages/shared/src/gitVersion.ts";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface UpdateFile {
  format: 1;
  platform: "android";
  id: string;
  runtimeVersion: string;
  createdAt: string;
  manifest: string;
  signature: string;
  assets: Record<string, { file: string; contentType: string }>;
  /** The manifest's extra.maruVersion, for the server's 기기 tab and the app's settings sheet. */
  version?: string | null;
}

interface ManifestAsset {
  hash: string;
  key: string;
  contentType: string;
  fileExtension: string;
  url: string;
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2", json: "application/json",
  mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4", html: "text/html", txt: "text/plain",
};

export function describeFile(bytes: Buffer, ext: string, contentType: string): ManifestAsset {
  const key = crypto.createHash("md5").update(bytes).digest("hex");
  return {
    hash: crypto.createHash("sha256").update(bytes).digest("base64url"),
    key,
    contentType,
    fileExtension: `.${ext}`,
    url: `/ota/assets/${key}`,
  };
}

/** A UUID from the content, so the same export always gets the same id. */
export function contentId(runtimeVersion: string, launch: ManifestAsset, assets: ManifestAsset[]): string {
  const h = crypto.createHash("sha256").update(runtimeVersion).update("\n").update(launch.hash);
  for (const a of [...assets].sort((x, y) => x.key.localeCompare(y.key))) h.update("\n").update(a.hash);
  const b = h.digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** The `expo-signature` value for a manifest body (RSA PKCS#1 v1.5, SHA-256). */
export function signManifest(manifest: string, privateKeyPem: string): string {
  const sig = crypto.sign("sha256", Buffer.from(manifest, "utf8"), privateKeyPem).toString("base64");
  return `sig="${sig}", keyid="main", alg="rsa-v1_5-sha256"`;
}

/** Checks a signature with the certificate the APK carries (or a bare public key, in tests). */
export function verifyManifest(manifest: string, signature: string, certificateOrPublicKeyPem: string): boolean {
  const sig = /sig="([^"]+)"/.exec(signature)?.[1];
  if (!sig) return false;
  const key = crypto.createPublicKey(certificateOrPublicKeyPem);
  return crypto.verify("sha256", Buffer.from(manifest, "utf8"), key, Buffer.from(sig, "base64"));
}

interface Args {
  out: string;
  previous: string | null;
  key: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: "",
    previous: null,
    key: process.env.MARU_UPDATES_KEY || path.join(os.homedir(), ".config", "maru", "updates-signing", "private-key.pem"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--out" && v) (args.out = path.resolve(v)), i++;
    else if (a === "--previous" && v) (args.previous = path.resolve(v)), i++;
    else if (a === "--key" && v) (args.key = path.resolve(v)), i++;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.out) throw new Error("--out <dir> is required");
  return args;
}

function run(cmd: string, argv: string[]): string {
  return execFileSync(cmd, argv, {
    cwd: APP,
    encoding: "utf8",
    env: {
      ...process.env,
      // The app's JavaScript reads the font CDN under this name (Metro inlines EXPO_PUBLIC_ variables).
      ...(process.env.MARU_FONT_CDN && process.env.EXPO_PUBLIC_MARU_FONT_CDN === undefined
        ? { EXPO_PUBLIC_MARU_FONT_CDN: process.env.MARU_FONT_CDN }
        : {}),
      CI: "1",
      EXPO_NO_TELEMETRY: "1",
      EXPO_NO_GIT_STATUS: "1",
    },
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 1024 * 1024 * 1024,
  });
}

function main(): void {
  // The build settings (MARU_ANDROID_PACKAGE, MARU_UPDATES_URL, MARU_FONT_CDN; build.env.example):
  // expo and its child processes inherit them, and the runtime version below depends on them.
  loadBuildEnv();
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  if (!fs.existsSync(args.key)) throw new Error(`no signing key at ${args.key}`);
  const certFile = path.resolve(APP, process.env.MARU_UPDATES_CERT || path.join("certs", "certificate.pem"));
  if (!fs.existsSync(certFile)) throw new Error(`no update certificate at ${certFile} (MARU_UPDATES_CERT, build.env.example): updates are signed against it`);
  const certificate = fs.readFileSync(certFile, "utf8");

  const work = `${args.out}.work`;
  fs.rmSync(work, { recursive: true, force: true });
  const exportDir = path.join(work, "export");
  run("npx", ["--no-install", "expo", "export", "--platform", "android", "--output-dir", exportDir]);
  const meta = JSON.parse(fs.readFileSync(path.join(exportDir, "metadata.json"), "utf8")) as {
    fileMetadata: { android: { bundle: string; assets: Array<{ path: string; ext: string }> } };
  };
  const runtimeVersion = (JSON.parse(run("npx", ["--no-install", "expo-updates", "runtimeversion:resolve", "--platform", "android", "--workflow", "managed"])) as { runtimeVersion: string }).runtimeVersion;
  if (!runtimeVersion) throw new Error("expo-updates gave no runtime version");

  const filesDir = path.join(work, "files");
  fs.mkdirSync(filesDir, { recursive: true });
  const files: UpdateFile["assets"] = {};
  const take = (rel: string, ext: string, contentType: string): ManifestAsset => {
    const bytes = fs.readFileSync(path.join(exportDir, rel));
    const asset = describeFile(bytes, ext, contentType);
    const name = `${asset.key}.${ext}`;
    fs.writeFileSync(path.join(filesDir, name), bytes);
    files[asset.key] = { file: `files/${name}`, contentType };
    return asset;
  };
  const launchAsset = take(meta.fileMetadata.android.bundle, "bundle", "application/javascript");
  const assets = meta.fileMetadata.android.assets.map((a) => take(a.path, a.ext, CONTENT_TYPES[a.ext] ?? "application/octet-stream"));
  const id = contentId(runtimeVersion, launchAsset, assets);

  const prevFile = args.previous ? path.join(args.previous, "update.json") : null;
  const prev = prevFile && fs.existsSync(prevFile) ? (JSON.parse(fs.readFileSync(prevFile, "utf8")) as UpdateFile) : null;
  let update: UpdateFile;
  if (prev && prev.id === id && verifyManifest(prev.manifest, prev.signature, certificate)) {
    update = { ...prev, assets: files };
    console.log(`ota-export: unchanged since the previous release, keeping update ${id} (${prev.createdAt})`);
  } else {
    const createdAt = new Date().toISOString();
    const version = buildVersion(path.resolve(APP, "../.."));
    const extra = version ? { maruVersion: version } : {};
    const manifest = JSON.stringify({ id, createdAt, runtimeVersion, launchAsset, assets, metadata: {}, extra });
    const signature = signManifest(manifest, fs.readFileSync(args.key, "utf8"));
    update = { format: 1, platform: "android", id, runtimeVersion, createdAt, manifest, signature, assets: files, version };
  }
  if (!verifyManifest(update.manifest, update.signature, certificate)) {
    throw new Error(`the signature does not verify with the update certificate ${certFile}: the key and the APK's certificate differ`);
  }
  fs.writeFileSync(path.join(work, "update.json"), `${JSON.stringify(update, null, 1)}\n`);
  fs.rmSync(exportDir, { recursive: true });
  fs.rmSync(args.out, { recursive: true, force: true });
  fs.renameSync(work, args.out);
  const bytes = Object.values(files).reduce((n, f) => n + fs.statSync(path.join(args.out, f.file)).size, 0);
  console.log(`ota-export: update ${id} (maru ${update.version ?? "-"}), runtime ${runtimeVersion}, ${Object.keys(files).length} files, ${bytes} bytes, ${Date.now() - t0} ms -> ${args.out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
