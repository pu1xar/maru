// The platform wiring of PairingStore (DESIGN.md 2e). Kept apart from pairingStore.ts so its logic
// runs under plain node in tests; this file is the only one that reaches Electron's safeStorage.
import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import { pairingKeychain } from "./pairingKeychain.ts";
import { PairingStore, type LegacyPairing, type PairingBackend } from "./pairingStore.ts";

const FILE_NAME = "pairing.bin";

/** The pairing as a file encrypted by safeStorage (DPAPI under the Windows user). */
function safeStorageFile(dir: string): PairingBackend & LegacyPairing {
  const file = path.join(dir, FILE_NAME);
  return {
    exists: () => fs.existsSync(file),
    read: () => safeStorage.decryptString(fs.readFileSync(file)),
    write(text) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Could not save the token because secure storage is not available on this computer");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, safeStorage.encryptString(text), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
    remove: () => fs.rmSync(file, { force: true }),
  };
}

/** Whether a safeStorage file waits to be moved to the Keychain (Mac only); main.ts asks before ready. */
export function hasLegacyPairingFile(dir: string): boolean {
  return process.platform === "darwin" && fs.existsSync(path.join(dir, FILE_NAME));
}

export function createPairingStore(dir: string): PairingStore {
  const file = safeStorageFile(dir);
  if (process.platform === "darwin") return new PairingStore(pairingKeychain(), file);
  return new PairingStore({
    read: () => (file.exists() ? file.read() : null),
    write: file.write,
    remove: file.remove,
  });
}
