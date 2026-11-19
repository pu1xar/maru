// The 기기 tab's calls (DESIGN.md 2d, contract in packages/shared/src/devices.ts). Pairing itself is
// an event stream the dialog holds open (components/settings/DevicesPanel.tsx).
import type { DesktopAppInfo, DeviceInfo, DeviceKind, DeviceList, MobileAppInfo } from "@maru/shared";
import { ApiError } from "~/projectsApi";

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: the status line explains it
  }
  if (!res.ok) {
    const error = (body as { error?: unknown } | null)?.error;
    throw new ApiError(res.status, typeof error === "string" ? error : `${res.status} ${res.statusText}`);
  }
  return body as T;
}

export async function fetchDevices(): Promise<DeviceInfo[]> {
  return (await json<DeviceList>(await fetch("/api/devices", { headers: { accept: "application/json" } }))).devices;
}

export async function removeDevice(id: string): Promise<void> {
  await json(await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE", headers: { accept: "application/json" } }));
}

export async function fetchMobileApp(): Promise<MobileAppInfo> {
  return json<MobileAppInfo>(await fetch("/api/mobile/app", { headers: { accept: "application/json" } }));
}

export async function fetchDesktopApp(): Promise<DesktopAppInfo> {
  return json<DesktopAppInfo>(await fetch("/api/desktop/app", { headers: { accept: "application/json" } }));
}

/** The pairing stream for a kind of device (DESIGN.md 2e): the code it opens pairs only that kind. */
export function pairingStreamPath(kind: DeviceKind): string {
  return kind === "desktop" ? "/api/devices/pairing?kind=desktop" : "/api/devices/pairing";
}

export function desktopDownloadPath(file: string): string {
  return `/api/desktop/download/${encodeURIComponent(file)}`;
}
export const APK_PATH = "/api/mobile/apk";
