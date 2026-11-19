import crypto from "node:crypto";
import fs from "node:fs";
import { secretKind } from "../devices/secrets.ts";

/**
 * The OTA read token (DESIGN.md 2d): one `maru_u_` secret per Mac in a file outside the
 * repository, built into every APK as the update request's Authorization header
 * (apps/mobile/app.config.ts). It only opens /ota/*, whose content is signed and holds no secret,
 * so it is not per device: expo-updates ties every update it stores to the request headers it was
 * fetched with and launches only those matching its configuration, so a header that changed at
 * pairing would leave the APK's own bundle unlaunchable (measured on the emulator).
 * The file is read again when it changes; without it, /ota/* refuses every request.
 */
export class UpdateToken {
  private file: string;
  private cached: { mtimeMs: number; hash: Buffer } | null = null;

  constructor(file: string) {
    this.file = file;
  }

  check(secret: string): boolean {
    if (secretKind(secret) !== "update") return false;
    const expected = this.hash();
    if (!expected) return false;
    return crypto.timingSafeEqual(expected, crypto.createHash("sha256").update(secret).digest());
  }

  private hash(): Buffer | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch {
      this.cached = null;
      return null;
    }
    if (!this.cached || this.cached.mtimeMs !== stat.mtimeMs) {
      const value = fs.readFileSync(this.file, "utf8").trim();
      this.cached = { mtimeMs: stat.mtimeMs, hash: crypto.createHash("sha256").update(value).digest() };
    }
    return this.cached.hash;
  }
}
