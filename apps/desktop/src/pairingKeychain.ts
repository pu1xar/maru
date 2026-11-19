// The Mac's pairing storage: one generic password in the login Keychain, written and read by Apple's
// own /usr/bin/security tool (DESIGN.md 2e). The item the tool creates trusts the tool itself
// (partition `apple-tool:`), so a new app build, whose code hash changes every time, is never a
// stranger to it and macOS has nothing to ask. Electron's safeStorage item ("maru Safe Storage") is
// partitioned by the app's code hash and asked again after each update.
import { execFileSync } from "node:child_process";
import os from "node:os";

/** The Keychain item's service. Its own name, apart from Chromium's "maru Safe Storage", so Keychain Access shows what it holds. */
export const KEYCHAIN_SERVICE = "maru Desktop Pairing";

/** `security` exits 44 when the item is not found. */
const NOT_FOUND = 44;

/** Runs the security tool with these arguments and returns its stdout; the real one is execFile (no shell). */
export type RunSecurity = (args: string[]) => string;

export const runSecurity: RunSecurity = (args) => execFileSync("/usr/bin/security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function keychainAccount(): string {
  return process.env.USER || os.userInfo().username;
}

function exitCode(e: unknown): number | null {
  return typeof e === "object" && e !== null && "status" in e && typeof (e as { status: unknown }).status === "number" ? (e as { status: number }).status : null;
}

/** The pairing text kept in the Keychain; stored as base64 so `security -w` always prints it as it was stored. */
export interface PairingKeychain {
  read(): string | null;
  write(text: string): void;
  remove(): void;
}

export function pairingKeychain(opts: { service?: string; account?: string; run?: RunSecurity } = {}): PairingKeychain {
  const service = opts.service ?? KEYCHAIN_SERVICE;
  const account = opts.account ?? keychainAccount();
  const run = opts.run ?? runSecurity;
  return {
    read() {
      try {
        const out = run(["find-generic-password", "-s", service, "-a", account, "-w"]);
        return Buffer.from(out.trim(), "base64").toString("utf8");
      } catch (e) {
        if (exitCode(e) === NOT_FOUND) return null;
        throw new Error(`security find-generic-password failed (exit ${exitCode(e) ?? "?"})`);
      }
    },
    // The value rides in argv for the length of the call, as the maru server's own Keychain use does.
    // The tool's prompt path (-w with no value, text on stdin) keeps only the first 128 characters and
    // drops the rest without an error (measured), and a pairing JSON is longer.
    write(text) {
      try {
        run(["add-generic-password", "-U", "-s", service, "-a", account, "-w", Buffer.from(text, "utf8").toString("base64")]);
      } catch (e) {
        throw new Error(`security add-generic-password failed (exit ${exitCode(e) ?? "?"})`);
      }
    },
    remove() {
      try {
        run(["delete-generic-password", "-s", service, "-a", account]);
      } catch (e) {
        if (exitCode(e) === NOT_FOUND) return;
        throw new Error(`security delete-generic-password failed (exit ${exitCode(e) ?? "?"})`);
      }
    },
  };
}
