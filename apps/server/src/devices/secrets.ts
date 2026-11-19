import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * The device pairing's secrets (DESIGN.md 2d). Each one is 256 random bits, base64url without
 * padding (43 characters), behind a prefix that names its kind. The server stores pairing codes
 * and device tokens only as SHA-256 hashes.
 *   maru_p_  pairing code: valid while the web's pairing dialog is open, once
 *   maru_d_  device token: every API and /ws request of one paired device
 *   maru_u_  update token: OTA manifest and asset requests only. One per Mac, built into every APK
 *            (mobile/updateToken.ts), not per device: expo-updates launches only updates fetched
 *            with its build-time request headers, so a header changed at pairing would make the
 *            APK's own bundle unlaunchable
 * A reverse proxy sends a request whose `Authorization` is `Bearer maru_...` to the device listener
 * (deviceServer.ts), which checks every such request; all others go to the web listener.
 */
export type SecretKind = "pairing" | "device" | "update";

const PREFIX: Record<SecretKind, string> = { pairing: "maru_p_", device: "maru_d_", update: "maru_u_" };
const SHAPE = /^maru_([pdu])_[A-Za-z0-9_-]{43}$/;

export function newSecret(kind: SecretKind): string {
  return PREFIX[kind] + crypto.randomBytes(32).toString("base64url");
}

export function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

/** The kind a well-formed secret names; null for anything else. */
export function secretKind(secret: string): SecretKind | null {
  const m = SHAPE.exec(secret);
  if (!m) return null;
  return m[1] === "p" ? "pairing" : m[1] === "d" ? "device" : "update";
}

/** The credential of `Authorization: Bearer <credential>`, or null. */
export function bearerOf(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = /^bearer +(\S+)$/i.exec(h.trim());
  return m ? m[1]! : null;
}
