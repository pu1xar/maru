// Paired devices (DESIGN.md 2d, 2e): the web settings' 기기 tab, the device listener's API, and the
// Android app's update and download info. The desktop app's feed is in desktop.ts.

/**
 * What a paired device is. The pairing code fixes it (the web dialog the operator opened), and it
 * decides what the device's token may reach on the device listener (DESIGN.md 2e):
 *   android  the phone app: the session list, /ws and the app's own routes
 *   desktop  the Mac and Windows app: everything the web listener serves except device management
 */
export type DeviceKind = "android" | "desktop";

/** A paired device as the settings list shows it. Its tokens never leave the server after pairing. */
export interface DeviceInfo {
  id: string;
  name: string;
  /** Always set by this server; absent from a server before kinds (and a phone's stored pairing from then): android. */
  kind?: DeviceKind;
  createdAt: number;
  /** The last request the device authenticated, ms since epoch; null before its first one. */
  lastUsedAt: number | null;
}

// Web (behind Google sign-in)
//   GET    /api/devices            -> DeviceList
//   DELETE /api/devices/:id        -> { ok: true }   404 unknown id; the device's tokens stop at once
//   GET    /api/devices/pairing    text/event-stream; ?kind=desktop for the desktop app (default
//                                  android). The pairing code lives exactly as long as this stream
//                                  (the dialog open in the browser) and works once:
//                                    event `code`     PairingOffer, right away
//                                    event `claimed`  PairingClaimed, then the stream ends
//   GET    /api/mobile/app         -> MobileAppInfo
//   GET    /api/mobile/apk         the newest APK (attachment), 404 when none was built
// Device listener (every request carries `Authorization: Bearer <secret>`)
//   POST   /api/device/pair        PairDeviceRequest -> PairDeviceResponse, bearer = the pairing code
//                                  or its short form; 409 when the request's kind is not the code's
//   GET    /api/device/me          -> DeviceSelf
//   DELETE /api/device/me          -> { ok: true }   the device unpairs itself
//   GET    /api/device/app         -> MobileAppInfo
//   PUT    /api/device/push        DevicePushRegistration -> { ok: true }   this device's FCM token
//   DELETE /api/device/push        -> { ok: true }   no more pushes to this device
//   GET    /ws                     the same /ws protocol as the web (index.ts ServerMessage, ClientMessage)
//   GET    /api/sessions, /api/projects, /api/accounts, /api/usage   as on the web
//   everything else the web listener serves, for a desktop token only (not /api/devices*)
//   GET    /ota/manifest, /ota/assets/<key>   Expo Updates protocol 1, with the update token the APK
//                                  was built with (not a device token)
export interface DeviceList { devices: DeviceInfo[] }

export interface PairingOffer {
  /** `maru://pair?server=<url>&code=<code>`: the QR content and the text to paste in the app. */
  link: string;
  /** The URL the app will use for every request. */
  server: string;
  /** The kind of device this code pairs. */
  kind: DeviceKind;
  /**
   * The same code in a form to type (`XXXX-XXXX-XXXX`, 60 bits), for a desktop app on another
   * computer than the browser. Desktop codes only: the phone reads the QR.
   */
  shortCode?: string;
}

export interface PairingClaimed { device: DeviceInfo }

export interface PairDeviceRequest {
  name: string;
  /** The app's kind; absent (the Android app before 2e) means android. It must be the code's kind. */
  kind?: DeviceKind;
}

export interface PairDeviceResponse {
  device: DeviceInfo;
  /** API and /ws requests: `Authorization: Bearer <token>`. The app keeps it in the Android Keystore. */
  token: string;
}

export interface DeviceSelf { device: DeviceInfo }

export interface MobileApkInfo {
  file: string;
  runtimeVersion: string;
  size: number;
  sha256: string;
  builtAt: string;
  updatesUrl: string;
  /** The APK's versionName (version.ts); absent from an APK built before versions. */
  version?: string | null;
}

export interface MobileAppInfo {
  /** The newest APK built on this Mac (apps/mobile/scripts/build-apk.sh); null when there is none. */
  apk: MobileApkInfo | null;
  /**
   * The OTA update this server's release offers; null when the release has none. `version` is the
   * release that first exported this update (an unchanged app keeps it across releases).
   */
  update: { id: string; runtimeVersion: string; createdAt: string; version?: string | null } | null;
  /**
   * Whether this server can send pushes: it has the Firebase service account
   * (apps/mobile/FCM-SETUP.md). Absent from a server that predates pushes.
   */
  push?: { server: boolean };
}

/**
 * POST /api/device/apk-link: a one-time URL for the newest APK. Opening it in the phone's browser
 * downloads the file with no sign-in (the URL itself is the credential), once, until `expiresInSec`
 * has passed.
 */
export interface MobileApkLink {
  url: string;
  expiresInSec: number;
  file: string;
  size: number;
  runtimeVersion: string;
  version?: string | null;
}

// ---- Push notifications (FCM, DESIGN.md 2d) ----

/** PUT /api/device/push: the FCM registration token of the app on this device. */
export interface DevicePushRegistration { token: string }

/**
 * Why the server pushed (DESIGN.md 2d, 푸시 알림).
 * question        a listed session started to wait for an answer (permission, AskUserQuestion, plan)
 * turn.completed  a listed session's turn ended
 * turn.failed     a listed session's turn ended in an error
 */
export type PushKind = "question" | "turn.completed" | "turn.failed";

/** The data of every push message. FCM data values are strings. */
export interface PushData {
  kind: PushKind;
  /** The session to open when the notification is tapped. */
  sessionKey: string;
}

/** The Android notification channel pushes post to; the app creates it before asking for permission. */
export const PUSH_CHANNEL_ID = "maru-sessions";

/** The pairing link the web shows as a QR code and the app reads back. */
export function pairingLink(server: string, code: string): string {
  return `maru://pair?server=${encodeURIComponent(server)}&code=${encodeURIComponent(code)}`;
}

/** Crockford base32: no I, L, O, U, so a typed code survives the usual misreadings. */
const SHORT_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Characters of a short pairing code (5 bits each: 60 bits). */
export const SHORT_CODE_LENGTH = 12;

/** A short pairing code as the web shows it: groups of four joined by hyphens. */
export function formatShortCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

/**
 * A typed short code in its canonical form, or null. Case, spaces and hyphens do not matter, and
 * the letters Crockford base32 leaves out read as the digits they look like (I and L as 1, O as 0).
 */
export function normalizeShortCode(text: string): string | null {
  const s = text.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (s.length !== SHORT_CODE_LENGTH) return null;
  for (const c of s) if (!SHORT_ALPHABET.includes(c)) return null;
  return s;
}

/** The bearer credential a short code is sent as (a reverse proxy routes `Bearer maru_...` to the device port). */
export function shortCodeCredential(code: string): string {
  return `maru_s_${code}`;
}

/** Random bytes to a short code (the caller passes SHORT_CODE_LENGTH bytes of randomness). */
export function shortCodeFromBytes(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) out += SHORT_ALPHABET[bytes[i]! & 31];
  return out;
}
