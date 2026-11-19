// electron-builder settings for the desktop app (DESIGN.md 2e), after T3 Code's
// build-desktop-artifact.ts reduced to one plain config: the Mac app as zip (what it updates from)
// and dmg (to install), the Windows NSIS installer, the maru:// scheme, the update certificate as an
// extra resource. Part of the shell's fingerprint (fingerprint.ts).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Configuration } from "electron-builder";
import { loadBuildEnv } from "../../../packages/shared/src/buildEnv.ts";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The certificate the Android OTA is verified with (DESIGN.md 2d); the desktop app trusts the same key. */
export const DEFAULT_CERT = path.resolve(APP_DIR, "..", "mobile", "certs", "certificate.pem");

// The application id (Windows AppUserModelID, the Mac bundle id) is the deployment's: MARU_DESKTOP_APP_ID
// from the environment or the build settings file (build.env.example). A change makes another app
// to the OS, so a deployment keeps its value.
loadBuildEnv();
export const APP_ID = process.env.MARU_DESKTOP_APP_ID || "dev.maru.desktop";
export const PRODUCT_NAME = "maru";

/** The Electron the app ships: package.json pins it exactly. */
export const ELECTRON_VERSION = (JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8")) as { devDependencies: Record<string, string> })
  .devDependencies.electron!;

/**
 * The code signing certificate the Mac app is signed with: a self-signed one in this Mac's login
 * Keychain (no Apple Developer ID). An ad-hoc signature's designated requirement is the build's own
 * code hash, so every new build was another app to the Keychain and "maru Safe Storage" asked again
 * after each update (user report 2026-11-18). Signed with one certificate, every build has the same
 * requirement (`identifier "<APP_ID>" and certificate root = H"<its sha1>"`). That fixed the
 * item's access list but not its partition list, which still holds each build's cdhash (the app has
 * no Team ID), so the app no longer keeps secrets in an item of its own (pairingKeychain.ts). Made
 * once with openssl and `security import` (DESIGN.md 2e).
 */
export const LOCAL_SIGNING_NAME = "maru Local Code Signing";

/**
 * The SHA-1 of the local signing identity in the Keychain, or null (not a Mac, not made yet). The
 * certificate is not in the trust settings, so it is looked up without `-v` (valid only), which is
 * also why electron-builder cannot find it by name and the app is signed through `mac.sign` below.
 */
export function localSigningIdentity(): string | null {
  if (process.platform !== "darwin") return null;
  let out: string;
  try {
    out = execFileSync("/usr/bin/security", ["find-identity", "-p", "codesigning"], { encoding: "utf8" });
  } catch {
    return null;
  }
  const m = new RegExp(`\\b([0-9A-F]{40}) "${LOCAL_SIGNING_NAME}"`).exec(out);
  return m ? m[1]! : null;
}

/** @electron/osx-sign's signAsync, from electron-builder's own app-builder-lib (it is not the app's dependency). */
async function osxSign(): Promise<(o: Record<string, unknown>) => Promise<void>> {
  const builder = fs.realpathSync(createRequire(import.meta.url).resolve("electron-builder/package.json"));
  const lib = fs.realpathSync(createRequire(builder).resolve("app-builder-lib/package.json"));
  const mod = (await import(createRequire(lib).resolve("@electron/osx-sign"))) as { signAsync: (o: Record<string, unknown>) => Promise<void> };
  return mod.signAsync;
}

export function builderConfig(opts: { version: string; output: string; certificate: string; signingIdentity?: string | null }): Configuration {
  const signing = opts.signingIdentity ?? null;
  return {
    appId: APP_ID,
    electronVersion: ELECTRON_VERSION,
    productName: PRODUCT_NAME,
    copyright: "pu1xar",
    directories: { app: APP_DIR, output: opts.output, buildResources: path.join(APP_DIR, "resources") },
    // Everything the app runs is bundled into dist-electron (bundle.ts); no node_modules ship.
    files: ["dist-electron/**", "package.json"],
    extraMetadata: { version: opts.version, main: "dist-electron/main.cjs" },
    extraResources: [{ from: opts.certificate, to: "update-certificate.pem" }],
    asar: true,
    npmRebuild: false,
    // Chromium's UI strings for these locales only (T3 keeps en-US alone).
    electronLanguages: ["en", "en-US", "ko"],
    protocols: [{ name: "maru", schemes: ["maru"] }],
    publish: null,
    // Another program of the same user must not run the app's own code to read the token: no
    // ELECTRON_RUN_AS_NODE, no NODE_OPTIONS, no --inspect, the app code only from the checked asar
    // (independent review, 2026-11-16). The token itself sits in the Keychain item that
    // /usr/bin/security made (pairingKeychain.ts), which any program of this user can read through
    // that tool; the fuses keep the app from being turned into one more reader.
    // enableCookieEncryption is off since 2026-11-19: it made Chromium keep "maru Safe Storage" in the
    // login Keychain, an item partitioned by the build's cdhash, so each update asked the user again
    // ("ACL partition mismatch ... asking user about XARA partition" in securityd). The page keeps no
    // secret in cookies (the token is added by the main process, auth.ts), so nothing is lost.
    electronFuses: {
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      onlyLoadAppFromAsar: true,
      enableEmbeddedAsarIntegrityValidation: true,
      enableCookieEncryption: false,
    },
    mac: {
      target: ["zip", "dmg"],
      icon: path.join(APP_DIR, "resources", "icon.png"),
      category: "public.app-category.developer-tools",
      // No Apple Developer ID. "-" lets electron-builder go on to sign without a valid identity; with
      // the local certificate (localSigningIdentity) `sign` signs with it instead, else the build is
      // ad-hoc (which Apple silicon needs to run the app at all) and build.ts says so.
      identity: "-",
      ...(signing
        ? {
            sign: async (o: Record<string, unknown>) => {
              const signAsync = await osxSign();
              await signAsync({ ...o, identity: signing, identityValidation: false });
            },
          }
        : {}),
      hardenedRuntime: false,
      gatekeeperAssess: false,
      artifactName: "maru-${version}-mac-${arch}.${ext}",
    },
    dmg: { artifactName: "maru-${version}-mac-${arch}.${ext}", writeUpdateInfo: false },
    win: {
      target: ["nsis"],
      icon: path.join(APP_DIR, "resources", "icon.png"),
      artifactName: "maru-${version}-win-${arch}.${ext}",
    },
    // One click, per user: no administrator prompt, and the app updates itself by running it with /S.
    // differentialPackage makes electron-builder pack the files one by one (not as one solid stream)
    // with a 1 MB dictionary, so an unchanged file is the same bytes in two builds and the
    // installer's block map (build.ts) matches across them (DESIGN.md 2e, differential update).
    nsis: { oneClick: true, perMachine: false, differentialPackage: true, artifactName: "maru-${version}-win-${arch}.${ext}" },
  };
}
