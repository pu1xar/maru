// The install notice's state (DESIGN.md 2d): what the server's app info says about this app's runtime,
// read when the view mounts and whenever the app comes back to the foreground, and the one-tap APK
// download (a one-time link from the server, opened in the phone's browser).
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking } from "react-native";
import * as Updates from "expo-updates";
import type { MobileAppInfo } from "@maru/shared";
import { fetchAppInfo, requestApkLink, type Pairing } from "./api.ts";
import { installStatus, type InstallStatus } from "./apkUpdate.logic.ts";

export function useInstallStatus(pairing: Pairing): { status: InstallStatus; refresh: () => Promise<MobileAppInfo | null> } {
  const [status, setStatus] = useState<InstallStatus>({ kind: "unknown" });
  const refresh = useCallback(async () => {
    try {
      const info = await fetchAppInfo(pairing);
      setStatus(installStatus(info, Updates.runtimeVersion ?? null));
      return info;
    } catch {
      // Offline or the server is restarting: keep what was known, the next foreground tries again.
      return null;
    }
  }, [pairing]);
  useEffect(() => {
    void refresh();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void refresh();
    });
    return () => sub.remove();
  }, [refresh]);
  return { status, refresh };
}

export type ApkDownload = { phase: "idle" } | { phase: "opening" } | { phase: "opened" } | { phase: "failed"; message: string };

/** Asks for a one-time link and opens it: the browser downloads the APK with no further tap. */
export function useApkDownload(pairing: Pairing): { state: ApkDownload; start: () => void } {
  const [state, setState] = useState<ApkDownload>({ phase: "idle" });
  const start = useCallback(() => {
    setState({ phase: "opening" });
    requestApkLink(pairing)
      .then((link) => Linking.openURL(link.url))
      .then(
        () => setState({ phase: "opened" }),
        (e: unknown) => setState({ phase: "failed", message: e instanceof Error ? e.message : String(e) }),
      );
  }, [pairing]);
  return { state, start };
}

/** The words under the download button for each phase. */
export function describeApkDownload(s: ApkDownload): string | null {
  switch (s.phase) {
    case "idle":
      return null;
    case "opening":
      return "Asking the server for the APK";
    case "opened":
      return "Download started in your browser. Open the file when it finishes";
    case "failed":
      return `Could not start the download: ${s.message}`;
  }
}
