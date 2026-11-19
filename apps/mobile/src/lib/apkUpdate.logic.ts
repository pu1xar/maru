// Whether this installed app can still take the server's OTA update, and if not, which APK to
// install (DESIGN.md 2d). The server hands an app an OTA update only when the app's runtime version
// (the native fingerprint) equals the update's, and answers 204 "nothing new" otherwise, which
// expo-updates reports as "up to date". So the app compares the runtimes itself, from the server's
// GET /api/device/app. React Native-free.
import type { MobileApkInfo, MobileAppInfo } from "@maru/shared";

export type InstallStatus =
  /** The server's answer or this app's runtime is not known yet. */
  | { kind: "unknown" }
  /** The OTA update (or, with none, the built APK) has this app's runtime: OTA reaches it. */
  | { kind: "ok" }
  /** A newer native build exists and its APK is on the server. */
  | { kind: "install"; apk: MobileApkInfo }
  /** A newer native build is needed and the server has no APK of it. */
  | { kind: "no-apk" };

/**
 * `runtimeVersion`: this app's (`Updates.runtimeVersion`). The runtime the server moved to is its
 * OTA update's; a server with no update falls back to its newest APK's. An APK of another runtime
 * than that target would not fix the mismatch, so it is not offered.
 */
export function installStatus(app: MobileAppInfo | null, runtimeVersion: string | null): InstallStatus {
  if (!app || !runtimeVersion) return { kind: "unknown" };
  const target = app.update?.runtimeVersion ?? app.apk?.runtimeVersion ?? null;
  if (!target || target === runtimeVersion) return { kind: "ok" };
  return app.apk && app.apk.runtimeVersion === target ? { kind: "install", apk: app.apk } : { kind: "no-apk" };
}

/** The headline of the notice: shown in the drawer and under Check for update. */
export const INSTALL_HEADLINE = "A new app version needs a new install";

/** One line under the headline: what will be downloaded. */
export function installDetail(s: InstallStatus): string | null {
  if (s.kind === "install") {
    const v = s.apk.version ? `maru ${s.apk.version}` : "The new APK";
    return `${v}, ${formatMegabytes(s.apk.size)}. Download it, then open the file to install`;
  }
  if (s.kind === "no-apk") return "No APK for it has been built on the server yet";
  return null;
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
