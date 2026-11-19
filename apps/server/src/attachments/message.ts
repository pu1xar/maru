// What a message with attachments becomes for each provider (DESIGN.md 6n). Pure but for reading
// the picture bytes, which the caller passes in.
//
// - Every attachment adds a note line with its stored path to the text (T3 Code's format,
//   @maru/shared attachmentNoteLine), so the agent can read, copy or reopen the file with its own
//   tools. A PDF, a text or code file, anything that is not a picture goes this way only: the CLI
//   does the same with a dropped file (a path), and the agent's Read tool takes PDFs page by page.
// - A picture also goes to the model as a picture: Claude an image block (base64) before the text,
//   as the CLI sends a pasted image; Codex a localImage item that the daemon reads from disk.
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AttachmentNote } from "@maru/shared";
import { textWithAttachmentNotes } from "@maru/shared";
import type { UserInput } from "../codex/protocol/v2/UserInput.ts";
import type { StoredAttachment } from "./store.ts";

export type ClaudeContent = SDKUserMessage["message"]["content"];
type ClaudeBlock = Exclude<ClaudeContent, string>[number];

/**
 * Why a command with attachments was not sent (DESIGN.md 6n): maru's own commands, the CLI's
 * built-in ones and every Codex `/name` take no attachments; the web server gives the text and
 * the attachments back to the composer.
 */
export function commandWithAttachments(name: string): string {
  return `/${name} is a command, so it was not sent with the attachment. Send the command and the attachment separately`;
}

export function noteOf(a: Pick<StoredAttachment, "kind" | "name" | "path">): AttachmentNote {
  return { kind: a.kind, name: a.name, path: a.path };
}

/**
 * The content of a Claude user message: the text alone when nothing is attached (as before), else
 * the image blocks first and one text block last. The CLI expands a `/skill` only when it starts the
 * last text block, so the pictures go before it (T3 Code ClaudeAdapterV2 does the same).
 */
export function claudeContent(
  text: string,
  attachments: readonly StoredAttachment[],
  readImage: (a: StoredAttachment) => Buffer,
): ClaudeContent {
  if (attachments.length === 0) return text;
  const blocks: ClaudeBlock[] = [];
  for (const a of attachments) {
    if (a.kind !== "image" || !a.imagePath || !a.imageMime) continue;
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: a.imageMime as "image/png", data: readImage(a).toString("base64") },
    });
  }
  blocks.push({ type: "text", text: textWithAttachmentNotes(text, attachments.map(noteOf)) });
  return blocks;
}

/** The input of a Codex turn/start or turn/steer: the text with the notes, then each picture as a localImage. */
export function codexInput(text: string, attachments: readonly StoredAttachment[]): UserInput[] {
  const input: UserInput[] = [{ type: "text", text: textWithAttachmentNotes(text, attachments.map(noteOf)), text_elements: [] }];
  for (const a of attachments) {
    if (a.kind === "image" && a.imagePath) input.push({ type: "localImage", path: a.imagePath });
  }
  return input;
}
