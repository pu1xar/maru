// Push notifications through FCM (DESIGN.md 2d, push notifications). The server pushes when a listed
// session waits for an answer, ends a turn or fails, and only while this app is off the screen:
// it counts the app as on the screen while its /ws is open, and MainScreen closes /ws in the
// background. Here: whether this APK can get a token at all, the channel and permission, handing
// the token to the server, and opening the session a tapped notification names.
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import * as Notifications from "expo-notifications";
import { PUSH_CHANNEL_ID } from "@maru/shared";
import { setPushToken, type Pairing } from "./pairing.ts";
import { apkHasPush, pushDataOf, type PushStatus } from "./pushData.ts";

/** Built with google-services.json (app.config.ts); without it no FCM token exists. */
export const PUSH_BUILT =
  Platform.OS === "android" && apkHasPush(requireOptionalNativeModule<{ manifest?: unknown }>("ExponentConstants")?.manifest ?? null);

/** The session key the screen shows now; a push for it is not shown while the app is open. */
let onScreen: string | null = null;
export function setSessionOnScreen(key: string | null): void {
  onScreen = key;
}

Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const show = pushDataOf(n.request.content.data)?.sessionKey !== onScreen;
    return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
  },
});

/**
 * Turns pushes on for this pairing: the channel, the permission (Android 13 asks), the token to
 * the server, and the token again whenever FCM rotates it. Returns the status and a cleanup.
 */
export async function enablePush(pairing: Pairing, onStatus: (s: PushStatus) => void): Promise<() => void> {
  if (!PUSH_BUILT) {
    onStatus({ state: "off-build" });
    return () => {};
  }
  try {
    await Notifications.setNotificationChannelAsync(PUSH_CHANNEL_ID, {
      name: "Session notifications",
      description: "Questions waiting for an answer, finished turns, errors",
      importance: Notifications.AndroidImportance.HIGH,
    });
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) {
      onStatus({ state: "denied" });
      return () => {};
    }
    const token = await Notifications.getDevicePushTokenAsync();
    await setPushToken(pairing, String(token.data));
    onStatus({ state: "on" });
  } catch (e) {
    onStatus({ state: "failed", error: e instanceof Error ? e.message : String(e) });
    return () => {};
  }
  const sub = Notifications.addPushTokenListener((t) => {
    setPushToken(pairing, String(t.data)).then(
      () => onStatus({ state: "on" }),
      (e: unknown) => onStatus({ state: "failed", error: e instanceof Error ? e.message : String(e) }),
    );
  });
  return () => sub.remove();
}

/**
 * Opens what tapped notifications name: the one that launched the app, then every later one.
 * expo-notifications keeps the last response until it is cleared, so it is cleared once handled;
 * otherwise every later mount (a new pairing, a reload) would jump back to that old session.
 */
export function onPushOpened(open: (sessionKey: string) => void): () => void {
  let done = false;
  const handle = (r: Notifications.NotificationResponse) => {
    const d = pushDataOf(r.notification.request.content.data);
    void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
    if (d) open(d.sessionKey);
  };
  void Notifications.getLastNotificationResponseAsync().then((r) => {
    if (!done && r) handle(r);
  });
  const sub = Notifications.addNotificationResponseReceivedListener((r) => {
    handle(r);
  });
  return () => {
    done = true;
    sub.remove();
  };
}
