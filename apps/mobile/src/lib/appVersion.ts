// Which maru version (DESIGN.md 2c) this app runs, from what expo-updates and the APK know. The
// native values come from ../version.ts; this part is pure so node tests can run it.

export interface VersionSources {
  /** Updates.isEmbeddedLaunch: the JavaScript running is the APK's own bundle. */
  embeddedLaunch: boolean;
  /** Updates.manifest. An OTA update's carries extra.maruVersion (scripts/ota-export.mts). */
  manifest: unknown;
  /**
   * The APK's app config as expo-constants reads it from the APK (a JSON string on Android). Its
   * version is the versionName app.config.ts set at build time.
   */
  apkConfig: unknown;
}

export interface AppVersions {
  /** The JavaScript running: the OTA update's release, or the APK's for its own bundle. */
  running: string | null;
  /** The installed APK's versionName. */
  apk: string | null;
}

export function appVersions(s: VersionSources): AppVersions {
  const apk = stringField(typeof s.apkConfig === "string" ? parse(s.apkConfig) : s.apkConfig, "version");
  if (s.embeddedLaunch) return { running: apk, apk };
  const extra = isRecord(s.manifest) ? s.manifest.extra : null;
  return { running: stringField(extra, "maruVersion"), apk };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function stringField(v: unknown, key: string): string | null {
  const x = isRecord(v) ? v[key] : null;
  return typeof x === "string" && x ? x : null;
}
