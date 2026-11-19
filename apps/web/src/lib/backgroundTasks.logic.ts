// The pure rules of sending foreground work to the background (DESIGN.md 4.5): when a call offers
// it, which key sends the foreground calls and what a key press does. backgroundTasks.ts sends the
// request and holds the React parts; terminalModel.ts reads these rules too, so no React or socket
// module is imported here.
import type { SessionSummary } from "@maru/shared";

/**
 * How long a foreground Agent call runs before the CLI offers "run in background": its bundle
 * (2.1.325) arms a 2000 ms timer when the Agent call starts (`_o=2000`), so a call that ends sooner
 * never shows it. A Bash command needs no timer here: the CLI registers it as a foreground task
 * only after 2000 ms of running (`yNo=2000`), and the server announces that registration
 * (`session.foreground`).
 */
export const BACKGROUND_OFFER_AFTER_MS = 2000;

/** A second press right after one that sent is swallowed (the tmux habit of pressing the prefix twice). */
export const BACKGROUND_KEY_QUIET_MS = 1000;

/** The tool_use id inside an item id (`<thread>:tool:<toolUseId>`). */
export function toolUseIdOfItem(itemId: string): string | null {
  const at = itemId.lastIndexOf(":tool:");
  return at === -1 ? null : itemId.slice(at + ":tool:".length) || null;
}

/**
 * Whether a call offers "백그라운드로" now: the CLI holds it in the foreground (`session.foreground`
 * names it) and, for an Agent call, it has done so for BACKGROUND_OFFER_AFTER_MS (`since`: when this
 * page first heard it, ms; null before it did).
 */
export function offerShown(opts: { kind: "command" | "agent"; announced: boolean; since: number | null; now: number }): boolean {
  if (!opts.announced) return false;
  if (opts.kind === "command") return true;
  return opts.since !== null && opts.now - opts.since >= BACKGROUND_OFFER_AFTER_MS;
}

/** Whether the screen offers it for this session at all: a Claude session this server runs. */
export function canBackground(session: Pick<SessionSummary, "provider" | "owner">, isSubagentView: boolean): boolean {
  return session.provider === "claude" && session.owner === "ui" && !isSubagentView;
}

export interface BackgroundKeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

/**
 * The key: Ctrl+B, the CLI's own, on every system. The sidebar is ⌘B on a Mac and Ctrl+Shift+B
 * elsewhere (App.tsx), so neither takes it (user request 2026-11-16).
 * `code`, not `key`: a Korean input source turns the B key into a jamo.
 */
export function isBackgroundKey(event: BackgroundKeyLike): boolean {
  if (event.isComposing || event.code !== "KeyB" || !event.ctrlKey || event.metaKey || event.altKey) return false;
  return !event.shiftKey;
}

/** The key as the hint and tooltips name it. */
export const BACKGROUND_KEY_LABEL = "ctrl+b";

/** What a key press does: send, or swallow a press that follows a send closely, or leave the key alone. */
export function backgroundKeyAction(opts: {
  enabled: boolean;
  foregroundCount: number;
  now: number;
  quietUntil: number;
}): "send" | "swallow" | "pass" {
  if (opts.now < opts.quietUntil) return "swallow";
  if (!opts.enabled || opts.foregroundCount === 0) return "pass";
  return "send";
}
