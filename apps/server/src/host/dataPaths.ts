// maru's data folder (~/.config/maru) as both processes find it. It lives with the
// host so the host's import graph stays small (scripts/host-fingerprint.ts): config.ts re-exports
// these, and an edit there (accounts, ports) is no host change.
import os from "node:os";
import path from "node:path";

/** Client state that has no home in the providers' own files (projects, locks, chosen sessions). */
export const STATE_FILE = process.env.MARU_STATE || path.join(os.homedir(), ".config", "maru", "state.sqlite");

/**
 * The Claude session host's unix socket (DESIGN.md 2b), next to the state file. A socket path
 * must stay under 104 bytes on macOS.
 */
export const HOST_SOCKET = process.env.MARU_HOST_SOCKET || path.join(path.dirname(STATE_FILE), "session-host.sock");
