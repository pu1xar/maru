// Files and images a message carries (DESIGN.md 6n). The composer uploads each file to the server
// first (POST /api/attachments), so a phone or another PC can attach too; `thread.send` then names
// the uploads by id. The server keeps every upload under its state folder, where the session can
// read it, and puts its path in the message text. An image also goes to the model as an image
// (a Claude image block, a Codex localImage).

/**
 * image  the model sees it (Claude image block, Codex localImage) besides its path
 * file   the message names its path; the agent reads it with its own tools when it needs it
 */
export type AttachmentKind = "image" | "file";

/** What POST /api/attachments answers for one uploaded file. */
export interface UploadedAttachment {
  /** Server id: `<YYYYMMDD>-<uuid>`. `thread.send` names uploads by it. */
  id: string;
  kind: AttachmentKind;
  /** The file name as stored (path separators and control characters replaced). */
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Absolute path of the stored file, the one the message names. */
  path: string;
  /** Pixel size of the image the model gets (after fitting), for an image. */
  width?: number;
  height?: number;
  /** Why the server sends a picture as a file (its path only): a format or size the model does not take. */
  notice?: string;
}

/** POST body is the file's bytes; the query names it. */
export function attachmentUploadUrl(name: string): string {
  return `/api/attachments?${new URLSearchParams({ name })}`;
}

/**
 * GET: the stored bytes of an upload. `image` is the picture the model gets (fitted and re-encoded
 * when the original was too large or in another format), so a browser can always draw it.
 */
export function attachmentUrl(id: string, variant: "original" | "image" = "original"): string {
  return variant === "image" ? `/api/attachments/${encodeURIComponent(id)}/image` : `/api/attachments/${encodeURIComponent(id)}`;
}

/**
 * GET: base64 data inside one transcript line, decoded (an image a Claude user line carries).
 * `pointer` is the projector's JSON path, e.g. `$.message.content[0].source.data`.
 */
export function transcriptBlobUrl(ref: { path: string; byteOffset: number; jsonPath: string }): string {
  return `/api/file/blob?${new URLSearchParams({ path: ref.path, offset: String(ref.byteOffset), pointer: ref.jsonPath })}`;
}

// ---- the line a message carries for each attachment ----

export interface AttachmentNote {
  kind: AttachmentKind;
  name: string;
  path: string;
}

const NOTE_LINE = /^\[Attached (image|file) "([^"\n]*)" is saved at: (.+)\]$/;

/** One line per attachment, as T3 Code writes it (provider-core attachmentPrompt.ts). */
export function attachmentNoteLine(note: AttachmentNote): string {
  return `[Attached ${note.kind} "${note.name.replace(/["\r\n]/g, "_")}" is saved at: ${note.path}]`;
}

/** The text a message sends: what the user wrote, a blank line, then one note line per attachment. */
export function textWithAttachmentNotes(text: string, notes: readonly AttachmentNote[]): string {
  if (notes.length === 0) return text;
  const block = notes.map(attachmentNoteLine).join("\n");
  return text.trim() === "" ? block : `${text}\n\n${block}`;
}

/**
 * The reverse, for drawing a sent message: the note lines at the end of the text come off as
 * notes, the rest is what the user wrote. Note lines anywhere else stay in the text.
 */
export function splitAttachmentNotes(text: string): { text: string; notes: AttachmentNote[] } {
  const lines = text.split("\n");
  let start = lines.length;
  while (start > 0 && NOTE_LINE.test(lines[start - 1]!.replace(/\r$/, ""))) start--;
  if (start === lines.length) return { text, notes: [] };
  // The notes follow a blank line, or make up the whole text.
  if (start > 0 && lines[start - 1]!.trim() !== "") return { text, notes: [] };
  const notes = lines.slice(start).map((line) => {
    const m = NOTE_LINE.exec(line.replace(/\r$/, ""))!;
    return { kind: m[1] as AttachmentKind, name: m[2]!, path: m[3]! };
  });
  return { text: lines.slice(0, Math.max(0, start - 1)).join("\n"), notes };
}
