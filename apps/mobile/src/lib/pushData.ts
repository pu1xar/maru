// The pure half of push notifications (lib/push.ts holds the native calls): whether this APK was
// built with FCM, and what a notification that arrived asks the app to open. Node tests run it.
import type { PushData, PushKind } from "@maru/shared";

/**
 * Whether the installed APK was built with google-services.json (app.config.ts `extra.maruPush`).
 * Read from the APK's own app config (expo-constants' native manifest, a JSON string on Android),
 * not from the running update's, so an OTA update never claims a native setup the APK lacks.
 */
export function apkHasPush(apkConfig: unknown): boolean {
  let config = apkConfig;
  if (typeof config === "string") {
    try {
      config = JSON.parse(config);
    } catch {
      return false;
    }
  }
  const extra = config && typeof config === "object" ? (config as { extra?: unknown }).extra : null;
  return Boolean(extra && typeof extra === "object" && (extra as { maruPush?: unknown }).maruPush === true);
}

const KINDS: ReadonlySet<string> = new Set<PushKind>(["question", "turn.completed", "turn.failed"]);

/** The server's push data (packages/shared PushData) from a notification's data, or null. */
export function pushDataOf(data: unknown): PushData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.kind !== "string" || !KINDS.has(d.kind) || typeof d.sessionKey !== "string" || !d.sessionKey) return null;
  return { kind: d.kind as PushKind, sessionKey: d.sessionKey };
}

/**
 * What the app shows about pushes in its settings sheet.
 * off-build  this APK was built without google-services.json
 * denied     the user turned notifications off for the app
 * on         the server has this device's token
 * failed     getting or handing over the token failed
 */
export type PushStatus = { state: "off-build" } | { state: "denied" } | { state: "on" } | { state: "failed"; error: string } | { state: "pending" };

export const PUSH_STATUS_TEXT: Record<PushStatus["state"], string> = {
  "off-build": "Off, this APK was built without FCM",
  denied: "Off, notification permission denied",
  on: "On",
  failed: "Failed",
  pending: "Checking",
};
