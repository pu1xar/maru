// A queued message taken back (`thread.recall`) either returns to the input (Take back) or is dropped
// (Remove, `discard`, as the web's recallQueued with `{ discard: true }`): the server answers both the
// same way, so the app remembers which one it asked for and decides here what the answer does.
import type { UploadedAttachment } from "@maru/shared";

export interface AskedRecall {
  /** The session the messages were sent to. */
  key: string;
  /** The queued message's id. */
  id: string;
  discard: boolean;
}

/** The texts that go back in front of the session's draft; none for a discard. */
export function textsToPutBack(asked: AskedRecall, messages: readonly { text: string }[]): string[] {
  return asked.discard ? [] : messages.map((m) => m.text);
}

/** The uploads of the taken-back messages, to go in front of the waiting attachments; none for a discard. */
export function attachmentsToPutBack(asked: AskedRecall, messages: readonly { attachments: readonly UploadedAttachment[] }[]): UploadedAttachment[] {
  return asked.discard ? [] : messages.flatMap((m) => m.attachments);
}
