// Pure rules of the composer's attachments (DESIGN.md 6n): which pasted data becomes an attachment,
// what a pasted picture is called, and how a sent message's notes and images line up. The store
// and the upload live in composerAttachments.ts; these are here so node can test them.
import type { AttachmentNote, ChatAttachment, UploadedAttachment } from "@maru/shared";
import { splitAttachmentNotes } from "@maru/shared";

/** Media types the model takes as an image (Claude vision docs; Codex reads the same). */
const MODEL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|avif)$/i;

/** True for a file a browser or the server can treat as a picture (by type, or by name when the type is missing). */
export function looksLikeImage(file: { name: string; type: string }): boolean {
  if (file.type.startsWith("image/") && file.type !== "image/svg+xml") return true;
  return (file.type === "" || file.type === "application/octet-stream") && IMAGE_EXTENSION.test(file.name);
}

export function isModelImageType(mimeType: string): boolean {
  return MODEL_IMAGE_TYPES.has(mimeType.toLowerCase());
}

const HEIC = /^image\/hei[cf]$/i;
const HEIC_NAME = /\.hei[cf]$/i;

/**
 * Whether a paste attaches its files (T3 Code composerAttachmentFiles.ts
 * shouldHandleComposerAttachmentPaste and classifyComposerAttachmentFile): a picture the model
 * takes (PNG, JPEG, GIF, WebP) or a HEIC always does; any other file, a TIFF or BMP among them,
 * only when no text came with it, so the text of an app that also puts such a picture on the
 * clipboard wins.
 */
export function pasteAttaches(files: ReadonlyArray<{ name: string; type: string }>, plainText: string): boolean {
  if (files.length === 0) return false;
  const picture = (f: { name: string; type: string }) =>
    isModelImageType(f.type) || HEIC.test(f.type) || ((f.type === "" || f.type === "application/octet-stream") && HEIC_NAME.test(f.name));
  if (files.some(picture)) return true;
  return plainText.length === 0;
}

/**
 * Why an upload failed, from the HTTP status and body. A proxy on the way answers in its own page,
 * not maru's JSON: a public address through a proxy can limit the request body size (413) and
 * the time to the server's answer (524). The loopback address has neither (DESIGN.md 6n).
 */
export function uploadFailureReason(status: number, body: string): string {
  let error: string | null = null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") error = (parsed as { error: string }).error;
  } catch {
    // A proxy's page: the status says what happened.
  }
  if (error) return error;
  if (status === 0) return "Could not upload to the server (disconnected)";
  if (status === 413) return "The file is too large and a proxy between this device and the server refused it. Opening maru at the 127.0.0.1 address on the host machine has no such limit.";
  if (status === 524) return "A proxy between this device and the server did not get an answer in time and cut the connection. It happens with large files on slow connections.";
  if (status === 408) return "The upload took too long and the server cut the connection";
  const text = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text ? `HTTP ${status}: ${text.slice(0, 160)}` : `HTTP ${status}`;
}

/** Names of one batch of files, with `-2`, `-3` before the extension on repeats (pictures pasted in the same second). */
export function distinctNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n === 1) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
  });
}

/**
 * The name a pasted picture is stored under. Browsers call every clipboard picture "image.png";
 * a name with the paste time tells several apart in the session folder and in the message.
 */
export function pastedFileName(name: string, type: string, now: Date): string {
  if (name && !/^image\.(png|jpe?g|gif|webp)$/i.test(name)) return name;
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1] ?? (type.split("/")[1] || "png");
  return `pasted-${stamp}.${ext.replace("jpeg", "jpg")}`;
}

/** Bytes as the strip shows them: 1 decimal from KB on. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/**
 * The CLI's placeholder for the n-th attachment of a message (Claude Code writes `[Image #1]` for a
 * pasted picture). Files get the file's name, since a path reference is what the model receives.
 */
export function terminalAttachmentLabel(kind: "image" | "file", n: number, name: string): string {
  return kind === "image" ? `[Image #${n}]` : `[File ${name}]`;
}

// ---- a sent message ----

/** Where the server can return an attachment's picture: a transcript blob or a stored file. */
export interface AttachmentPreviewSources {
  /** Claude: x.data.attachmentBlobs (claude/projection/extract.ts). */
  attachmentBlobs?: unknown;
  /** Codex: x.data.attachmentSources (codex/projection/mapItems.ts). */
  attachmentSources?: unknown;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** The URL a browser draws the attachment from, or null when the server has no picture for it. */
export function attachmentPreviewUrl(attachmentId: string, data: AttachmentPreviewSources | undefined): string | null {
  const blob = rec(rec(data?.attachmentBlobs)?.[attachmentId]);
  if (blob) {
    const raw = rec(blob.raw);
    const media = typeof blob.mediaType === "string" ? blob.mediaType : "";
    if (raw && typeof raw.path === "string" && typeof raw.byteOffset === "number" && typeof blob.jsonPath === "string" && isModelImageType(media)) {
      return `/api/file/blob?${new URLSearchParams({ path: raw.path, offset: String(raw.byteOffset), pointer: blob.jsonPath })}`;
    }
  }
  const source = rec(rec(data?.attachmentSources)?.[attachmentId]);
  if (source) {
    if (typeof source.path === "string" && source.path.startsWith("/")) return `/api/file/raw?${new URLSearchParams({ path: source.path })}`;
    if (typeof source.url === "string" && /^https?:\/\//i.test(source.url)) return source.url;
  }
  return null;
}

/** One attachment of a sent message as the bubble draws it. */
export interface SentAttachment {
  key: string;
  kind: "image" | "file";
  name: string;
  /** The stored file the message names (a maru upload), for opening in the file panel. */
  path: string | null;
  /** Where to draw the picture from; null draws a name chip. */
  url: string | null;
}

function dirOf(p: string): string {
  return p.slice(0, p.lastIndexOf("/"));
}

/**
 * A sent message's text without its attachment notes, and its attachments: the message's own
 * attachments (images the provider recorded) in order, then the files only a note names.
 * An image note gives a recorded image its name and path: in order when there are as many image
 * notes as recorded images (maru sends them that way), else only by folder (a Codex localImage is
 * the upload's own folder); a note left without its image shows from its stored file.
 */
export function sentMessageAttachments(
  text: string,
  attachments: ReadonlyArray<Pick<ChatAttachment, "id" | "type" | "name" | "mimeType">>,
  data: AttachmentPreviewSources | undefined,
): { text: string; attachments: SentAttachment[] } {
  const split = splitAttachmentNotes(text);
  const imageNotes: AttachmentNote[] = split.notes.filter((n) => n.kind === "image");
  const isImage = (a: Pick<ChatAttachment, "type" | "mimeType">) => a.type === "image" || a.mimeType.startsWith("image/");
  const recorded = attachments.filter(isImage);
  const inOrder = recorded.length === imageNotes.length;
  const used = new Set<AttachmentNote>();
  const out: SentAttachment[] = [];
  for (const a of attachments) {
    let note: AttachmentNote | undefined;
    if (isImage(a)) {
      if (inOrder) note = imageNotes[recorded.indexOf(a)];
      else {
        const source = rec(rec(data?.attachmentSources)?.[a.id]);
        const at = typeof source?.path === "string" ? dirOf(source.path) : null;
        note = at ? imageNotes.find((n) => !used.has(n) && dirOf(n.path) === at) : undefined;
      }
      if (note) used.add(note);
    }
    out.push({
      key: a.id,
      kind: isImage(a) ? "image" : "file",
      name: note?.name ?? a.name,
      path: note?.path ?? null,
      url: isImage(a) ? attachmentPreviewUrl(a.id, data) : null,
    });
  }
  // Image notes without a recorded image (a provider that keeps only text) still show by path.
  for (const note of imageNotes.filter((n) => !used.has(n))) {
    out.push({ key: `note:${note.path}`, kind: "image", name: note.name, path: note.path, url: `/api/file/raw?${new URLSearchParams({ path: note.path })}` });
  }
  for (const note of split.notes) {
    if (note.kind === "file") out.push({ key: `note:${note.path}`, kind: "file", name: note.name, path: note.path, url: null });
  }
  return { text: split.text, attachments: out };
}

// ---- the waiting attachments ----

/** What a waiting attachment's upload has come to (the web's ComposerAttachment and the app's carry more). */
export interface UploadState {
  status: "uploading" | "ready" | "failed";
  uploaded?: UploadedAttachment;
}

/** What a send says while uploads run; the composers take it away again once they end. */
export const UPLOADING = "Attachments are uploading";

/** Upload ids to send, or why the message cannot go yet (`uploading`: it can once the uploads end). */
export function attachmentsToSend(list: readonly UploadState[]): { ids: string[]; blocked: string | null; uploading: boolean } {
  if (list.some((a) => a.status === "uploading")) return { ids: [], blocked: UPLOADING, uploading: true };
  if (list.some((a) => a.status === "failed")) return { ids: [], blocked: "Some attachments failed to upload. Remove them and send", uploading: false };
  return { ids: list.flatMap((a) => (a.uploaded ? [a.uploaded.id] : [])), blocked: null, uploading: false };
}

