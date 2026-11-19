// The desktop app's bridge (DESIGN.md 2e): the maru desktop app shows this same page and gives it
// window.maruDesktop (packages/shared/src/desktop.ts) for the shell's version, its own update and
// the paired device. A page in a browser has none, and every caller here returns null for it.
import { useEffect, useState } from "react";
import type { DesktopUpdateState, MaruDesktopBridge } from "@maru/shared";

declare global {
  interface Window {
    maruDesktop?: MaruDesktopBridge;
  }
}

export function desktopBridge(): MaruDesktopBridge | null {
  return typeof window !== "undefined" && window.maruDesktop ? window.maruDesktop : null;
}

/** The shell's update state, live; null in a browser. */
export function useDesktopUpdate(): DesktopUpdateState | null {
  const bridge = desktopBridge();
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the shell pushes its update state; the page mirrors it
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.getUpdateState().then((s) => live && setState(s));
    const off = bridge.onUpdateState((s) => setState(s));
    return () => {
      live = false;
      off();
    };
  }, [bridge]);
  return state;
}

/** One line for the update row of the 기기 tab. */
export function describeDesktopUpdate(s: DesktopUpdateState | null, appVersion: string): string {
  if (!s) return `maru ${appVersion}`;
  switch (s.status) {
    case "disabled":
      return `maru ${appVersion}, auto update off: ${s.reason}`;
    case "idle":
      return `maru ${appVersion}`;
    case "checking":
      return `maru ${appVersion}, checking`;
    case "up-to-date":
      return `maru ${appVersion}, up to date`;
    case "downloading":
      return `Downloading maru ${s.version} ${s.total > 0 ? Math.floor((s.received / s.total) * 100) : 0}%`;
    case "downloaded":
      return `maru ${s.version} downloaded, restart to apply`;
    case "error":
      return `maru ${appVersion}, ${s.context === "install" ? "install" : s.context === "download" ? "download" : "check"} failed: ${s.message}`;
  }
}
