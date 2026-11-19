// This app's maru versions (DESIGN.md 2c), shown under the drawer and in the settings sheet: the
// release whose JavaScript runs, and the installed APK. Read once; a new update restarts the
// JavaScript and with it this module.
import { requireOptionalNativeModule } from "expo";
import * as Updates from "expo-updates";
import { appVersions } from "./lib/appVersion.ts";

export const APP_VERSIONS = appVersions({
  embeddedLaunch: Updates.isEmbeddedLaunch,
  manifest: Updates.manifest,
  // expo-constants' native module: `manifest` is the app config embedded in the APK at build time,
  // also while an OTA update runs (Constants.expoConfig is then the update's).
  apkConfig: requireOptionalNativeModule<{ manifest?: unknown }>("ExponentConstants")?.manifest ?? null,
});

/** "maru 0.1.N", for the drawer's foot and the empty screen. */
export const VERSION_LABEL = `maru ${APP_VERSIONS.running ?? "-"}`;
