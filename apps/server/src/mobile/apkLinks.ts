import crypto from "node:crypto";
import { hashSecret } from "../devices/secrets.ts";

/**
 * How long a one-time APK link stays redeemable after it was issued. The app opens the link in the
 * phone's browser right away, so the time covers waking that browser (cold start on a slow phone,
 * a first-run screen) and nothing more; it does not cover the download, which runs after the link
 * was redeemed. 120 s leaves room for a slow browser start and is short enough that a link leaked
 * from a screenshot or the clipboard is dead before anyone can use it.
 */
export const APK_LINK_TTL_MS = 120_000;

/** The path the redeemable link lives at; the reverse proxy sends exactly this shape to the device listener. */
export const APK_LINK_PREFIX = "/dl/apk/";
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

interface Entry {
  expiresAt: number;
  deviceId: string;
  /** The APK file name the link was issued for, so a rebuild between issue and redeem cannot swap it. */
  file: string;
}

/**
 * One-time APK download links (DESIGN.md 2d). A paired phone asks with its device token and gets a
 * URL whose last path segment is 256 random bits. Anyone holding that URL can fetch the APK once
 * within the TTL without a token, because the phone's browser that opens it carries no
 * `Authorization` header. The server keeps only the SHA-256 of the segment; redeeming removes the
 * entry before the first byte is sent.
 */
export class ApkLinks {
  private entries = new Map<string, Entry>();
  private ttl: number;
  private now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttl = opts.ttlMs ?? APK_LINK_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  get ttlMs(): number {
    return this.ttl;
  }

  issue(deviceId: string, file: string): string {
    this.sweep();
    const token = crypto.randomBytes(32).toString("base64url");
    this.entries.set(hashSecret(token), { expiresAt: this.now() + this.ttl, deviceId, file });
    return token;
  }

  /** The file the link was issued for, and the link is spent; null for an unknown, used or expired one. */
  redeem(token: string): { file: string; deviceId: string } | null {
    if (!LINK_TOKEN.test(token)) return null;
    const key = hashSecret(token);
    const e = this.entries.get(key);
    if (!e) return null;
    this.entries.delete(key);
    return e.expiresAt > this.now() ? { file: e.file, deviceId: e.deviceId } : null;
  }

  /** Drops the links of a removed device, so unpairing also kills what it had asked for. */
  dropDevice(deviceId: string): void {
    for (const [k, e] of this.entries) if (e.deviceId === deviceId) this.entries.delete(k);
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(k);
  }
}

/** The token of `/dl/apk/<token>`, or null for another path. */
export function apkLinkToken(pathname: string): string | null {
  return pathname.startsWith(APK_LINK_PREFIX) ? pathname.slice(APK_LINK_PREFIX.length) : null;
}
