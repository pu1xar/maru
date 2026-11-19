import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExpoConfig } from "expo/config";
import { loadBuildEnv } from "../../packages/shared/src/buildEnv.ts";
import { buildVersion } from "../../packages/shared/src/gitVersion.ts";
import { themeColors } from "../../packages/shared/src/themeColors.ts";
import { parseVersion, VERSION_SERIES } from "../../packages/shared/src/version.ts";
import { isReleasesRepo } from "../../packages/shared/src/releasesRepo.ts";

// maru Android app (DESIGN.md 2d). Native settings live here; a change to anything that reaches the
// native project changes the fingerprint runtime version, and phones then need a new APK
// (scripts/build-apk.sh). JavaScript changes reach phones as signed OTA updates instead.

// The deployment's own values (the update URL, the Android package id) come from the environment,
// or from the build settings file (~/.config/maru/build.env, build.env.example lists the names).
loadBuildEnv();
// The app's JavaScript reads the font CDN as EXPO_PUBLIC_MARU_FONT_CDN, which Metro inlines into the
// bundle (src/lib/appFonts.logic.ts); the one name in build.env is MARU_FONT_CDN.
if (process.env.MARU_FONT_CDN && process.env.EXPO_PUBLIC_MARU_FONT_CDN === undefined) {
  process.env.EXPO_PUBLIC_MARU_FONT_CDN = process.env.MARU_FONT_CDN;
}

// expo-updates reads the update URL natively, so it is fixed per build. A build with
// MARU_UPDATES_URL asks that server for OTA updates (a test build points it at another one); a
// build without it has OTA updates off (`updates.enabled` false), takes no update token and
// carries no update certificate. The fingerprint leaves the URL out (fingerprint.config.js), so
// builds that ask different servers take the same OTA updates.
const updatesUrl = process.env.MARU_UPDATES_URL || null;

// The certificate that holds the public key of the OTA signing key (MARU_UPDATES_CERT, a path
// relative to this folder or absolute; default certs/certificate.pem). The APK embeds it, so it is
// a native input (fingerprint.config.js adds the file). Absent, updates are not code signed.
const updatesCertFile = path.resolve(__dirname, process.env.MARU_UPDATES_CERT || "certs/certificate.pem");
const updatesCert = fs.existsSync(updatesCertFile) ? `./${path.relative(__dirname, updatesCertFile)}` : null;

// The Android application id. It names the app on the phone and in Firebase (FCM-SETUP.md): a
// change makes another app, so a deployment keeps its value.
const androidPackage = process.env.MARU_ANDROID_PACKAGE || "dev.maru.app";

// The text of Android's camera permission prompt (expo-camera). It is a native resource, so changing it
// changes the fingerprint and needs a new APK; a deployment keeps its value once phones have the app.
const cameraPermissionText = process.env.MARU_CAMERA_PERMISSION_TEXT || "Camera access is needed to scan the pairing QR code";

// OTA requests carry this Mac's update token (apps/server/src/mobile/updateToken.ts), fixed at
// build time: expo-updates launches only updates fetched with its build-time request headers, so
// a per-device header set at pairing would leave the APK's own bundle unlaunchable (measured).
// The value is part of the fingerprint, so a new token needs a new APK. build-apk.sh creates it.
// A build with OTA updates off needs none.
const updateTokenFile = process.env.MARU_UPDATE_TOKEN_FILE || path.join(os.homedir(), ".config", "maru", "mobile-update-token");
let updateToken: string | null = null;
if (updatesUrl) {
  if (!fs.existsSync(updateTokenFile)) {
    throw new Error(`no OTA update token at ${updateTokenFile} (apps/mobile/scripts/build-apk.sh creates it)`);
  }
  updateToken = fs.readFileSync(updateTokenFile, "utf8").trim();
}

// maru's version (DESIGN.md 2c) as the APK's versionName, and its commit count as the versionCode,
// which grows with every commit as Android asks of an upgrade. build-apk.sh and release.sh give it
// in MARU_VERSION (the build folder and a release clone have no git); a working tree reads git.
// The fingerprint leaves both out (ExpoConfigVersions in fingerprint.config.js), so a new version
// keeps the runtime version and the OTA updates flowing.
const version = buildVersion(path.resolve(__dirname, "../.."));

// A public build (a GitHub Actions release) takes new versions from GitHub Releases instead of an
// update server: MARU_RELEASES_REPO=<owner>/<repo> goes into the app config as extra.maruReleasesRepo,
// and the app offers that repository's newest release APK (src/lib/useRelease.ts). Without the
// variable the key is left out altogether, so the config, and with it the fingerprint, is the one
// the build had before this setting existed.
const releasesRepo = process.env.MARU_RELEASES_REPO || null;
if (releasesRepo !== null && !isReleasesRepo(releasesRepo)) {
  throw new Error(`MARU_RELEASES_REPO must be <owner>/<repo>, got ${JSON.stringify(releasesRepo)}`);
}

// Push notifications through FCM (DESIGN.md 2d, apps/mobile/FCM-SETUP.md). The Firebase app config
// stays outside the repository, on this Mac. Without the file the APK builds with pushes off: no
// Firebase setup in the native project, and `extra.maruPush` false, which the app reads from the
// APK's own config (src/lib/push.ts) before it asks for a token. The file and the flag are native
// inputs: adding or removing the file changes the runtime version, so phones need a new APK.
const googleServicesFile =
  process.env.MARU_GOOGLE_SERVICES_FILE || path.join(os.homedir(), ".config", "maru", "firebase", "google-services.json");
const push = fs.existsSync(googleServicesFile);

// Native colors come from the one color source (DESIGN.md 7d), so a change to it reaches the next
// APK: the window and splash background is the dark canvas, the launcher icon's flat background is
// the dark sidebar level (the amber and cream mark sits on it; pure black would lose the icon's
// edge on an AMOLED home screen), and the notification accent is the dark theme's primary.
const splashBackground = themeColors.dark.background;
// The icon is the mark as the web's sidebar shows it (DESIGN.md 7c): the dark sidebar's surface
// behind the lines in the dark theme's text color.
const iconBackground = themeColors.dark.sidebar;
const notificationColor = themeColors.dark.primary;

const config: ExpoConfig = {
  name: "maru",
  slug: "maru",
  scheme: "maru",
  version: version ?? `${VERSION_SERIES}.0`,
  platforms: ["android"],
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  backgroundColor: splashBackground,
  // The maru mark (DESIGN.md 7c). Launcher icons are native resources: a new icon reaches phones
  // only with a new APK, and the files are part of the fingerprint. `icon` is the 72dp viewport
  // as one square; Expo uses it for the pre-Android 8 launcher icons.
  icon: "./assets/icon/icon.png",
  runtimeVersion: { policy: "fingerprint" },
  updates: updatesUrl
    ? {
        url: updatesUrl,
        // Checks on every launch in the background; a downloaded update starts on the next launch
        // or when the user taps the reload banner (src/updates/UpdateBanner.tsx).
        checkAutomatically: "ON_LOAD",
        fallbackToCacheTimeout: 0,
        // Every update must carry a signature made with the private key that stays on the Mac
        // (~/.config/maru/updates-signing). This certificate holds its public key. With no
        // certificate file the build asks for unsigned updates.
        ...(updatesCert
          ? { codeSigningCertificate: updatesCert, codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" } }
          : {}),
        requestHeaders: { Authorization: `Bearer ${updateToken}` },
      }
    : { enabled: false },
  android: {
    package: androidPackage,
    versionCode: (version ? parseVersion(version)?.count : undefined) ?? 1,
    // 108dp layers drawn inside the 66dp safe zone. The background is one flat color.
    adaptiveIcon: {
      foregroundImage: "./assets/icon/adaptive-foreground.png",
      backgroundColor: iconBackground,
      monochromeImage: "./assets/icon/adaptive-monochrome.png",
    },
    // Keeps app data (the update token in expo-updates' preferences) out of device backups.
    allowBackup: false,
    softwareKeyboardLayoutMode: "resize",
    ...(push ? { googleServicesFile } : {}),
  },
  extra: { maruPush: push, ...(releasesRepo ? { maruReleasesRepo: releasesRepo } : {}) },
  plugins: [
    // Notification channel, permission and the small icon (white mark, alpha only). Present in every
    // APK; without google-services.json no FCM token can be had and the app leaves pushes off.
    ["expo-notifications", { icon: "./assets/icon/notification.png", color: notificationColor }],
    [
      "expo-camera",
      {
        cameraPermission: cameraPermissionText,
        recordAudioAndroid: false,
        barcodeScannerEnabled: true,
      },
    ],
    // The clip button's gallery and camera pick (DESIGN.md 6n). Android's photo picker needs no
    // storage permission and the camera permission comes with expo-camera above; no recording.
    ["expo-image-picker", { microphonePermission: false }],
    // The system document picker hands over each file, so it needs no permission.
    "expo-document-picker",
    ["expo-secure-store", { configureAndroidBackup: false }],
    "./plugins/withLoopbackCleartext.js",
  ],
};

export default config;
