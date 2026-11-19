// The shell update's trust check (DESIGN.md 2e). The server hands out manifest.json as release.sh
// signed it on the Mac (RSASSA-PKCS1-v1_5 SHA-256, the same key as the Android OTA), and the app
// verifies it with the certificate built into it before it reads a field. The installer it then
// downloads must match the signed SHA-256. So neither a changed file on the server nor anything
// between the server and the app can make the app run a build the key did not sign. A file's block
// map (the differential update) is listed in the manifest with its own SHA-256, so it is signed too.
import crypto from "node:crypto";
import { parseVersion } from "@maru/shared";
import type { DesktopArch, DesktopArtifact, DesktopPlatform, DesktopUpdateManifest } from "@maru/shared";

export class ManifestError extends Error {}

const PLATFORMS = new Set(["darwin", "win32"]);
const ARCHES = new Set(["arm64", "x64"]);
const FORMATS = new Set(["zip", "dmg", "nsis"]);

/** The manifest when `signature` is the key's over exactly `text`; throws otherwise. */
export function verifyManifest(text: string, signature: string, certificatePem: string): DesktopUpdateManifest {
  let ok = false;
  try {
    ok = crypto.verify("sha256", Buffer.from(text, "utf8"), crypto.createPublicKey(certificatePem), Buffer.from(signature, "base64"));
  } catch (e) {
    throw new ManifestError(`Could not verify the signature: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!ok) throw new ManifestError("The update signature does not match");
  let m: DesktopUpdateManifest;
  try {
    m = JSON.parse(text) as DesktopUpdateManifest;
  } catch {
    throw new ManifestError("The signed manifest is not JSON");
  }
  if (m.format !== 1 || m.type !== "maru-desktop-update") throw new ManifestError("Not a desktop update manifest");
  if (!parseVersion(m.version) || parseVersion(m.version)!.dev) throw new ManifestError(`Not a release version: ${m.version}`);
  if (!Array.isArray(m.artifacts)) throw new ManifestError("The manifest has no file list");
  for (const a of m.artifacts) {
    const good = typeof a.file === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a.file) && PLATFORMS.has(a.platform) && ARCHES.has(a.arch)
      && FORMATS.has(a.format) && Number.isSafeInteger(a.size) && a.size > 0 && /^[0-9a-f]{64}$/.test(a.sha256);
    const map = a.blockmap;
    const goodMap = map === undefined || (typeof map.file === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(map.file) && map.file !== a.file
      && Number.isSafeInteger(map.size) && map.size > 0 && /^[0-9a-f]{64}$/.test(map.sha256));
    if (!good || !goodMap) throw new ManifestError(`A file entry in the manifest is invalid: ${JSON.stringify(a)}`);
  }
  return m;
}

/** The file this computer updates from: the Mac app's zip, or the Windows installer. */
export function updateArtifact(m: DesktopUpdateManifest, platform: string, arch: string): DesktopArtifact | null {
  const format = platform === "darwin" ? "zip" : platform === "win32" ? "nsis" : null;
  if (!format) return null;
  return m.artifacts.find((a) => a.platform === (platform as DesktopPlatform) && a.arch === (arch as DesktopArch) && a.format === format) ?? null;
}

/**
 * Whether `candidate` is a later shell than `current`. Versions compare by series, then by the
 * commit count (which never goes back, DESIGN.md 2c). A rolled back server offers an older build,
 * which the app leaves alone, as the phone does with an older OTA update.
 */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  const [am, an] = a.series.split(".").map(Number) as [number, number];
  const [bm, bn] = b.series.split(".").map(Number) as [number, number];
  if (am !== bm) return am > bm;
  if (an !== bn) return an > bn;
  return a.count > b.count;
}
