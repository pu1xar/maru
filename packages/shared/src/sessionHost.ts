/**
 * The Claude session host as the web server sees it (DESIGN.md 2b). The host runs the Claude CLI
 * processes, so it decides whether Claude sessions can be started or sent to; Codex does not use it.
 * up        connected
 * down      not reachable: Claude sessions cannot be started, sent to, answered or closed
 * draining  waiting for running work before a restart: no new Claude processes until it is back
 * Sent as `{ type: "sessionHost" }` after hello and on every change.
 */
export interface SessionHostStatus {
  state: "up" | "down" | "draining";
  /** Why it is down (the connect error). */
  error: string | null;
  /** What a draining host still waits for, one line per session. */
  waitingFor: string[];
}
