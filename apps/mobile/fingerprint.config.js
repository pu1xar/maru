// The runtime version is this fingerprint (app.config.ts runtimeVersion policy). An APK takes only
// OTA updates exported with the same value, so a native change asks for a new APK by itself.
// Skips: Expo's default "balanced" preset, plus
//   ExpoConfigEASProject   updates.url, so the production APK and a test build that asks another
//                          server take the same updates
//   PackageJsonScriptsAll  npm scripts never reach the native project here (the APK is built by
//                          scripts/build-apk.sh, not by `expo run`)
//   GitIgnore              .gitignore decides nothing in a project whose android/ is generated
// Added: the update signing certificate, which the APK embeds. A new certificate needs a new APK.
// And two images prebuild copies into the native resources that Expo does not hash as files: the
// notification small icon (expo-notifications; Expo hashes only the plugin's option string) and
// the adaptive icon's monochrome layer (Expo hashes the foreground and background layers only).
// (google-services.json is hashed by Expo itself, by content under a fixed key, so the value is
// the same in every checkout.)
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SourceSkips } = require("expo/fingerprint");

// The OTA certificate (app.config.ts updatesCert): MARU_UPDATES_CERT from the environment or the
// build settings file (build.env, the one line this reads), default certs/certificate.pem. Not a
// source when the file is absent, as the build then asks for unsigned updates.
function updatesCertPath() {
  let value = process.env.MARU_UPDATES_CERT;
  if (value === undefined) {
    try {
      const file = process.env.MARU_BUILD_ENV || path.join(os.homedir(), ".config", "maru", "build.env");
      const m = /^(?:export\s+)?MARU_UPDATES_CERT\s*=\s*(.*)$/m.exec(fs.readFileSync(file, "utf8"));
      value = m ? m[1].trim().replace(/^(["'])(.*)\1$/, "$2") : undefined;
    } catch {
      // no settings file
    }
  }
  const abs = path.resolve(__dirname, value || "certs/certificate.pem");
  return fs.existsSync(abs) ? path.relative(__dirname, abs) : null;
}
const updatesCert = updatesCertPath();

/** @type {import("expo/fingerprint").Config} */
module.exports = {
  sourceSkips:
    SourceSkips.PackageJsonAndroidAndIosScriptsIfNotContainRun |
    SourceSkips.ExpoConfigVersions |
    SourceSkips.ExpoConfigRuntimeVersionIfString |
    SourceSkips.EasJson |
    SourceSkips.Easignore |
    SourceSkips.AutolinkingConfigPaths |
    SourceSkips.ExpoConfigEASProject |
    SourceSkips.PackageJsonScriptsAll |
    SourceSkips.GitIgnore,
  extraSources: [
    ...(updatesCert ? [{ type: "file", filePath: updatesCert, reasons: ["updatesCodeSigningCertificate"] }] : []),
    { type: "file", filePath: "assets/icon/notification.png", reasons: ["notificationIcon"] },
    { type: "file", filePath: "assets/icon/adaptive-monochrome.png", reasons: ["adaptiveIconMonochrome"] },
  ],
};
