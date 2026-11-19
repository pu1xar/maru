// What the input at the bottom allows, as pure rules: why the open session takes no message, whether
// the connection is down, and the text a send carries. A dropped connection stops only the send
// (the phone reconnects every time the app returns to the screen, and the field must stay usable);
// a session that cannot take messages at all locks the field.
import type { SessionSummary } from "@maru/shared";
import { messageToSend } from "../../../../packages/shared/src/messageText.ts";
import { SUBAGENT_BLOCK, sendBlock, type SendBlock } from "../../../web/src/components/chat/sendBlock.logic.ts";
import { attachmentsToSend, type UploadState } from "../../../web/src/lib/composerAttachments.logic.ts";

export interface ComposerState {
  /** Why the field is locked (no session, a subagent, the terminal holds it); null when it takes text. */
  reason: string | null;
  /** The web's block (its kind picks the icon of the bar that takes the field's place); null when none or no session is open. */
  block: SendBlock | null;
  /** The server connection is down: the field stays open, the send waits. */
  offline: boolean;
  /** This server's turn runs (the stop button shows). */
  running: boolean;
  /**
   * The text a send carries (trailing whitespace trimmed, the start kept; empty when only
   * attachments go); null when nothing can be sent now.
   */
  send: string | null;
  /** Upload ids a send carries. */
  attachmentIds: string[];
  /** Why the waiting attachments hold the send back (uploads running or failed), as the web says it; null when they do not. */
  blocked: string | null;
}

export const OFFLINE_NOTE = "Disconnected from server";

export function composerState(input: {
  session: SessionSummary | null;
  readOnly?: string | null;
  online: boolean;
  text: string;
  /** The waiting attachments (DESIGN.md 6n); a message may be only attachments. */
  attachments?: readonly UploadState[];
}): ComposerState {
  const { session: s } = input;
  // The web's rule and words (ThreadComposer's sendBlock): a Codex thread another client holds idle
  // can still be taken over, a closed Claude session the terminal had opens again on a send.
  const block: SendBlock | null = input.readOnly ? SUBAGENT_BLOCK : s ? sendBlock(s, Boolean(s.parentKey)) : null;
  const reason = block ? block.label : !s ? "Select a session" : null;
  const offline = !input.online;
  const waiting = input.attachments ?? [];
  const toSend = attachmentsToSend(waiting);
  const text = messageToSend(input.text);
  return {
    reason,
    block,
    offline,
    running: s?.owner === "ui" && (s.status === "running" || s.status === "waiting-input"),
    send: reason === null && !offline && toSend.blocked === null ? (text ?? (waiting.length > 0 ? "" : null)) : null,
    attachmentIds: toSend.ids,
    blocked: waiting.length > 0 ? toSend.blocked : null,
  };
}
