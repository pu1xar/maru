// This computer's pairing (DESIGN.md 2e): the server, the device token and the device as the server
// answered the claim. Where the text lives is a backend: the login Keychain through /usr/bin/security
// on a Mac (pairingKeychain.ts), a safeStorage file under the Windows user's DPAPI
// (pairingBackends.ts). The token never goes to the page; the main process adds it to the page's
// requests (auth.ts).
import type { DeviceInfo } from "@maru/shared";

export interface Pairing {
  server: string;
  token: string;
  device: DeviceInfo;
}

/** Where the pairing JSON text is kept. `read` throws when the text exists but cannot be read. */
export interface PairingBackend {
  read(): string | null;
  write(text: string): void;
  remove(): void;
}

/** The Mac's earlier home of the text: a file encrypted by safeStorage, read once to move it to the Keychain. */
export interface LegacyPairing {
  exists(): boolean;
  /** The decrypted text; throws when the key is gone (another user, a new OS key). */
  read(): string;
  remove(): void;
}

function parse(text: string): Pairing {
  const p = JSON.parse(text) as Pairing;
  if (typeof p.server !== "string" || typeof p.token !== "string" || !p.device) throw new Error("bad pairing");
  return p;
}

export class PairingStore {
  private backend: PairingBackend;
  private legacy: LegacyPairing | null;

  constructor(backend: PairingBackend, legacy: LegacyPairing | null = null) {
    this.backend = backend;
    this.legacy = legacy;
  }

  /**
   * The saved pairing; `error` when one exists but cannot be read. With nothing in the backend and an
   * older file present, the file is read once, its text moved to the backend and the file deleted.
   */
  load(): { pairing: Pairing | null; error: string | null } {
    const fail = (e: unknown) => ({ pairing: null, error: `Could not read the saved connection (${e instanceof Error ? e.message : String(e)}). Connect again` });
    let text: string | null;
    try {
      text = this.backend.read();
    } catch (e) {
      return fail(e);
    }
    if (text !== null) {
      try {
        return { pairing: parse(text), error: null };
      } catch (e) {
        return fail(e);
      }
    }
    if (!this.legacy || !this.legacy.exists()) return { pairing: null, error: null };
    let pairing: Pairing;
    let old: string;
    try {
      old = this.legacy.read();
      pairing = parse(old);
    } catch (e) {
      return fail(e);
    }
    try {
      this.backend.write(old);
    } catch {
      // The old file stays, so the next start tries again; this run uses what it read.
      return { pairing, error: null };
    }
    this.legacy.remove();
    return { pairing, error: null };
  }

  save(p: Pairing): void {
    this.backend.write(JSON.stringify(p));
  }

  clear(): void {
    this.backend.remove();
    this.legacy?.remove();
  }
}
