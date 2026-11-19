import crypto from "node:crypto";
import type { DeviceInfo, DeviceKind, PairDeviceResponse } from "@maru/shared";
import { SHORT_CODE_LENGTH, shortCodeCredential, shortCodeFromBytes } from "@maru/shared";
import { hashSecret, newSecret, secretKind } from "./secrets.ts";
import type { DeviceStore } from "./store.ts";

export interface PairingSession {
  code: string;
  /** The same code to type (`maru_s_` dropped), for a desktop pairing; absent for a phone. */
  shortCode?: string;
  /** Ends the code (the dialog closed); a no-op after it was claimed. */
  close(): void;
}

interface OpenCode {
  kind: DeviceKind;
  onClaimed: (device: DeviceInfo) => void;
  /** Both hashes of the session (long code, short code), so a claim by either ends both. */
  keys: string[];
}

const SHORT_SHAPE = new RegExp(`^maru_s_[0-9A-HJKMNP-TV-Z]{${SHORT_CODE_LENGTH}}$`);

/**
 * One-time pairing codes (DESIGN.md 2d, 2e). A code is open from start() until its session is
 * closed or a device claims it, whichever comes first. The web keeps it open exactly as long as the
 * pairing dialog's event stream (webRoutes.ts). Codes live only in memory, as hashes; a server
 * restart ends them all.
 *
 * The code fixes the kind of device it pairs (the dialog the operator opened), which sets what the
 * new token may reach. A desktop code also has a short form to type on another computer
 * (`maru_s_` and 12 Crockford base32 characters, 60 bits); either form claims the same session.
 */
export class PairingHub {
  private open = new Map<string, OpenCode>();
  private store: DeviceStore;

  constructor(store: DeviceStore) {
    this.store = store;
  }

  start(onClaimed: (device: DeviceInfo) => void, kind: DeviceKind = "android"): PairingSession {
    const code = newSecret("pairing");
    const keys = [hashSecret(code)];
    let shortCode: string | undefined;
    if (kind === "desktop") {
      // A collision with another open short code would let one claim end the wrong session.
      do shortCode = shortCodeFromBytes(crypto.randomBytes(SHORT_CODE_LENGTH));
      while (this.open.has(hashSecret(shortCodeCredential(shortCode))));
      keys.push(hashSecret(shortCodeCredential(shortCode)));
    }
    const entry: OpenCode = { kind, onClaimed, keys };
    for (const k of keys) this.open.set(k, entry);
    return { code, ...(shortCode ? { shortCode } : {}), close: () => this.end(entry) };
  }

  /** Whether a bearer credential has the shape of a pairing code (long or short). */
  isCode(secret: string): boolean {
    return secretKind(secret) === "pairing" || SHORT_SHAPE.test(secret);
  }

  /** The kind an open code pairs; null when the code is not open. */
  kindOf(code: string): DeviceKind | null {
    if (!this.isCode(code)) return null;
    return this.open.get(hashSecret(code))?.kind ?? null;
  }

  /** Uses a code: a new device of the code's kind and its token, or null when the code is not open. */
  claim(code: string, name: string): PairDeviceResponse | null {
    if (!this.isCode(code)) return null;
    const entry = this.open.get(hashSecret(code));
    if (!entry) return null;
    this.end(entry);
    const created = this.store.create(name, Date.now(), entry.kind);
    entry.onClaimed(created.device);
    return created;
  }

  /** Open pairing sessions (a desktop session's two forms count once). */
  openCount(): number {
    return new Set(this.open.values()).size;
  }

  private end(entry: OpenCode): void {
    for (const k of entry.keys) if (this.open.get(k) === entry) this.open.delete(k);
  }
}
