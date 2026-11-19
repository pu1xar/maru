// Pure rules of the waiting messages (queuedMessages.ts, DESIGN.md 4.4).
import type { PendingSend, SessionSummary, UploadedAttachment } from "@maru/shared";
import { attachmentUrl, deliveredIds } from "@maru/shared";
import type { SentAttachment } from "./composerAttachments.logic.ts";

// The rule lives in shared so the server settles a message by the same ids the UI hides it by.
export { deliveredIds };

/**
 * The rows to draw: every send the conversation does not show yet. A message becomes the
 * conversation's only when its row is in `delivered` (the transcript has it), so a message the model
 * took stays drawn until then and there is no moment with neither; `delivered` comes from the same
 * snapshot the timeline draws, so the two never show together either.
 */
export function shownQueued(sends: readonly PendingSend[], delivered: ReadonlySet<string>): readonly PendingSend[] {
  return sends.filter((s) => !delivered.has(s.id));
}

/**
 * The draft after taking `texts` back, as the Claude Code CLI 2.1.325 pulls queued messages into
 * its prompt (measured with ↑, and its `popAllEditable`): the messages in the order sent, one per
 * line, then a newline and the draft; the caret stays where it was in the draft, or goes to the
 * end of an empty one.
 */
export function mergeRecalled(texts: readonly string[], draft: string, caret: number): { text: string; caret: number } {
  const back = texts.filter((t) => t !== "").join("\n");
  if (!back) return { text: draft, caret };
  if (!draft) return { text: back, caret: back.length };
  return { text: `${back}\n${draft}`, caret: back.length + 1 + Math.min(Math.max(caret, 0), draft.length) };
}

/**
 * The ids in `sends` that were not in `before`: a message that just arrived in the list. The
 * chat timeline scrolls to the end when one does while the reader follows the end, since the
 * list does not follow its footer's growth on its own.
 */
export function addedQueuedIds(before: ReadonlySet<string>, sends: readonly PendingSend[]): string[] {
  return sends.filter((s) => !before.has(s.id)).map((s) => s.id);
}

/**
 * Whether sending a message brings the conversation to its end: always, as in every chat and the
 * CLI, whether the reader follows the end or scrolled up to read. Without it a message sent from a
 * scrolled-up page waits (or runs) below the fold and nothing on screen says it was sent.
 * `before` and `now` are the per-session counts of sends made on this page.
 */
export function sendBringsEnd(before: number, now: number): boolean {
  return now > before;
}

/** The ids ↑ takes back: every message that can come back now, oldest first. */
export function recallableIds(sends: readonly PendingSend[], busy: ReadonlySet<string>): string[] {
  return sends.filter((s) => s.recall.enabled && !busy.has(s.id)).map((s) => s.id);
}

/** A waiting message's uploads as the sent message's attachment rows draw them (chat and terminal). */
export function queuedAttachments(uploads: readonly UploadedAttachment[]): SentAttachment[] {
  return uploads.map((u) => ({ key: u.id, kind: u.kind, name: u.name, path: u.path, url: u.kind === "image" ? attachmentUrl(u.id, "image") : null }));
}

/** The short state label under a waiting message. */
export function queuedStateLabel(s: PendingSend): string {
  switch (s.state) {
    case "sending":
      return "Sending";
    case "queued":
      return "Queued";
    case "taken":
      return "Delivered";
    case "failed":
      return "Not sent";
  }
}

/**
 * Whether the screen offers "Send now" for the session's waiting messages (DESIGN.md 4.4): a Claude
 * session this server runs, while its turn runs. Codex puts a sent message into the running turn at
 * once, so no message waits there for a tool boundary; a waiting-input session waits on a question,
 * which no foreground work stands in the way of.
 */
export function canSendNow(session: Pick<SessionSummary, "provider" | "owner" | "status">, isSubagentView: boolean): boolean {
  return session.provider === "claude" && session.owner === "ui" && session.status === "running" && !isSubagentView;
}

/** Whether a message waits in the CLI's queue, the thing Send now moves ahead (a "sending" one is not there yet). */
export function hasQueuedForSendNow(sends: readonly PendingSend[]): boolean {
  return sends.some((s) => s.state === "queued");
}

export interface SendNowKeyLike {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** The key: a plain Esc, never one that ends an IME composition (keyCode 229 is a Korean syllable being committed). */
export function isSendNowKey(event: SendNowKeyLike): boolean {
  if (event.key !== "Escape" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
  return !event.isComposing && event.keyCode !== 229;
}
