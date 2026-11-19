// This phone's pairing: the server it talks to and its device token, kept by expo-secure-store,
// which encrypts the value with a key held in the Android Keystore. OTA requests use the update
// token the APK was built with (app.config.ts), so pairing leaves expo-updates as it is. The API
// calls themselves are in api.ts.
import * as SecureStore from "expo-secure-store";
import * as Device from "expo-device";
import type { PairDeviceResponse } from "@maru/shared";
import { auth, call, type Pairing } from "./api.ts";
import type { PairingTarget } from "./pairingLink.ts";

export { ApiError, authHeaders, fetchAccounts, fetchAppInfo, fetchSelf, setPushToken, wsUrl, type Pairing } from "./api.ts";

const KEY = "maru.pairing.v1";

export async function loadPairing(): Promise<Pairing | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Pairing;
  } catch {
    return null;
  }
}

/** Claims the code: the server answers with this device's token. Nothing is stored yet. */
export async function claimPairing(target: PairingTarget): Promise<Pairing> {
  const name = [Device.manufacturer, Device.modelName].filter(Boolean).join(" ") || Device.deviceName || "Android";
  const res = await call<PairDeviceResponse>(`${target.server}/api/device/pair`, {
    method: "POST",
    headers: { ...auth(target.code), "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return { server: target.server, token: res.token, device: res.device };
}

/**
 * Stores a claimed pairing in place of the current one. The old token is then removed on its
 * server (best effort), after the new one is safe, so a failure keeps at least one working pairing.
 */
export async function adoptPairing(next: Pairing, previous: Pairing | null): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(next));
  if (previous && previous.token !== next.token) {
    await call(`${previous.server}/api/device/me`, { method: "DELETE", headers: auth(previous.token) }).catch(() => undefined);
  }
}

export async function forget(p: Pairing | null, opts: { tellServer: boolean }): Promise<void> {
  if (p && opts.tellServer) {
    await call(`${p.server}/api/device/me`, { method: "DELETE", headers: auth(p.token) }).catch(() => undefined);
  }
  await SecureStore.deleteItemAsync(KEY);
}
