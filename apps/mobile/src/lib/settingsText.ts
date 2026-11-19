// The words of the settings sheet's rows, in the form the web's Devices page writes them
// (settings/DevicesPanel.tsx and lib/desktopBridge.ts describeDesktopUpdate). React Native-free.
import type { MobileAppInfo } from "@maru/shared";
import { INSTALL_HEADLINE } from "./apkUpdate.logic.ts";
import { formatWhen } from "../../../web/src/components/settings/parts.logic.ts";

export type AppUpdateState =
  | { status: "idle" }
  | { status: "disabled" }
  | { status: "checking" }
  | { status: "up-to-date" }
  /** The server's update has another runtime version than this app: OTA cannot reach it (apkUpdate.logic.ts). */
  | { status: "needs-install" }
  | { status: "downloading" }
  | { status: "restarting" }
  | { status: "error"; message: string };

/** One line for the App row: the version and where the update check stands. */
export function describeAppUpdate(state: AppUpdateState, version: string): string {
  switch (state.status) {
    case "idle":
      return `maru ${version}`;
    case "disabled":
      return `maru ${version}, automatic updates off: this build does not take updates`;
    case "checking":
      return `maru ${version}, checking`;
    case "up-to-date":
      return `maru ${version}, up to date`;
    case "needs-install":
      return `maru ${version}, ${INSTALL_HEADLINE.charAt(0).toLowerCase()}${INSTALL_HEADLINE.slice(1)}`;
    case "downloading":
      return `maru ${version}, downloading`;
    case "restarting":
      return `maru ${version}, downloaded, restarting`;
    case "error":
      return `maru ${version}, check failed: ${state.message}`;
  }
}

/** Whether the update row's button waits (a check or a download is on its way). */
export function updateBusy(state: AppUpdateState): boolean {
  return state.status === "checking" || state.status === "downloading" || state.status === "restarting";
}

/** The Update row's description, as the web's Android app section writes the server's update. */
export function describeServerUpdate(update: MobileAppInfo["update"] | undefined): string {
  if (!update) return "No OTA update";
  return `${update.version ? `${update.version}, ` : ""}${formatWhen(Date.parse(update.createdAt))} signed, id ${update.id.slice(0, 8)}, runtime ${update.runtimeVersion.slice(0, 12)}`;
}

/** The APK row's description: this app's APK, as the web writes the server's. */
export function describeApk(apkVersion: string | null, runtime: string): string {
  return `${apkVersion ? `${apkVersion}, ` : ""}runtime ${runtime.slice(0, 12)}`;
}
