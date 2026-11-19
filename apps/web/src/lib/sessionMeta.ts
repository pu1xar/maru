// What the conversation header's meta line shows and lets a click do (DESIGN.md 6l): who holds the
// session, whether it can move to another account or change its working folder now, and the
// pieces of the folder chooser. Pure, so the rules are tested apart from the chips
// (components/SessionMetaLine.tsx).
import type { AccountInfo, SessionSummary } from "@maru/shared";

import { recentCwds } from "../model.ts";

/** Who holds an open session: this app's server (`maru`) or a process it did not start (`terminal`). */
export type MetaOwner = "maru" | "terminal";

/**
 * The holder the meta line names, or null for a closed session. A Codex thread another client has
 * loaded (TUI, `codex agents`, `codex queue`) is `terminal` too: the index reports it as owner
 * "terminal", the same value the composer's send rule reads (ThreadComposer `sendBlock`).
 */
export function metaOwner(s: SessionSummary): MetaOwner | null {
  if (s.status === "closed") return null;
  if (s.owner === "ui") return "maru";
  if (s.owner === "terminal") return "terminal";
  return null;
}

/** What a click on a chip changes: the account (a move) or the working folder (a rehome). */
export type Relocation = "account" | "folder";

/**
 * now          the session is closed; the server takes the change at once
 * close-first  this server holds it between turns (Claude): close that run, then change it
 * blocked      it cannot change now; `reason` says why (the chip's tooltip and the menu's note)
 */
export type RelocateAction = { kind: "now" } | { kind: "close-first" } | { kind: "blocked"; reason: string };

const CANNOT: Record<Relocation, string> = { account: "Cannot move to another account", folder: "Cannot change working folder" };

/**
 * Whether the server's move (`POST /api/session-move`) or rehome (`POST /api/session-rehome`) can
 * run on the session now. The server refuses an open session with 409; this says so before the
 * click, and for a Claude run this server holds between turns offers to close it first (the next
 * message resumes it, as after the 30 minute idle close).
 *
 * A Codex thread is never closed first: the daemon keeps a thread loaded while any client is
 * subscribed, this view included, and unloads it 60 seconds after the last one leaves (DESIGN.md
 * 4.3, Codex 닫기).
 */
export function relocateAction(s: SessionSummary, what: Relocation): RelocateAction {
  const blocked = (why: string): RelocateAction => ({ kind: "blocked", reason: `${CANNOT[what]}: ${why}` });
  if (what === "folder" && s.provider === "codex") return { kind: "blocked", reason: "Cannot change working folder: Codex sessions keep their folder" };
  if (s.parentKey) return { kind: "blocked", reason: what === "account" ? "A subagent thread moves with its parent session" : "Cannot change working folder: a subagent thread keeps its parent's folder" };
  if (s.status === "closed") return { kind: "now" };
  if (s.owner === "terminal") return blocked(s.provider === "claude" ? "open in a terminal" : "open in another client");
  if (s.status === "running" || s.status === "waiting-input") return blocked("a turn is running");
  if (s.owner === "ui" && s.provider === "claude" && s.status === "open-idle") {
    // Closing would end the background tasks too (the header's close waits for them the same way).
    return s.backgroundTasks ? blocked("background work is running") : { kind: "close-first" };
  }
  return blocked("the session is open");
}

/** The session's key once it lives under another account (keys are `provider:account:id`). */
export function movedKey(s: SessionSummary, to: string): string {
  return `${s.provider}:${to}:${s.id}`;
}

/**
 * Whether the page should select the moved session's new key once the move went through: while
 * the view that asked is still shown, or while the address still names the old key (the list drops
 * the old key before the move's answer arrives, which unmounts the view). A person who picked
 * another session meanwhile keeps it.
 */
export function shouldFollowMove(at: { viewShown: boolean; selected: string | null; from: string }): boolean {
  // The address holds the session id (lib/sessionUrl.ts), which a move keeps; an old full key too.
  const id = at.from.slice(at.from.lastIndexOf(":") + 1);
  return at.viewShown || at.selected === at.from || at.selected === id;
}

/** The accounts a move can take the session to: its provider's other accounts. */
export function moveTargets(accounts: readonly AccountInfo[], s: SessionSummary): AccountInfo[] {
  return accounts.filter((a) => a.provider === s.provider && a.id !== s.account);
}

/** Folders to offer first: the ones listed sessions work in, newest first, without the session's own. */
export function folderChoices(sessions: Iterable<SessionSummary>, current: string | null): string[] {
  return recentCwds(sessions).filter((cwd) => cwd !== current);
}

/**
 * The server's refusal while a run of this server still holds the Claude session
 * (sessions/claudeFiles.ts `holderMessage`, by "server" or an own pid). Right after a close the
 * index can show the session closed a moment before the driver lets it go (DESIGN.md 11).
 */
export function heldByThisServer(status: number, message: string): boolean {
  return status === 409 && /^(?:maru가 돌리는 세션|This session is run by maru)/u.test(message);
}

/**
 * Runs `op` again while it fails only because this server's run still holds the session and the
 * change is still wanted (the session stays closed and the view is still there). Any other
 * failure, or a change no longer wanted, ends it with that error.
 */
export async function retryWhileHeld<T>(
  op: () => Promise<T>,
  opts: { isHeld: (error: unknown) => boolean; stillWanted: () => boolean; wait: () => Promise<void> },
): Promise<T> {
  for (;;) {
    try {
      return await op();
    } catch (error) {
      if (!opts.isHeld(error) || !opts.stillWanted()) throw error;
      await opts.wait();
    }
  }
}

/** The last name of a folder path. */
export function folderName(dir: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "/";
}
