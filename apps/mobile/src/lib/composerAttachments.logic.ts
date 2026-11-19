// Pure rules of the attachments waiting in the app's input (DESIGN.md 6n): a picked file becomes a
// waiting item, its upload moves it through uploading, ready and failed, and the list says whether
// a send can go. The names, sizes and the send rule are the web's (apps/web/src/lib/
// composerAttachments.logic.ts); the store that uploads and notifies lives in composerAttachments.ts.
import type { UploadedAttachment } from "@maru/shared";
import { distinctNames, formatBytes, looksLikeImage, pastedFileName } from "../../../web/src/lib/composerAttachments.logic.ts";

/** What a picker (gallery, camera, documents) hands over for one file. */
export interface PickedFile {
  uri: string;
  name?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

/** One waiting attachment: where it is from, and how far its upload has got. */
export interface WaitingAttachment {
  /** App-local id (the upload id once uploaded). */
  localId: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  /** The picked file on this phone: drawn as the preview of a picture, and sent again on a retry. */
  uri: string;
  image: boolean;
  status: "uploading" | "ready" | "failed";
  /** Bytes sent so far while uploading. */
  sentBytes: number;
  uploaded?: UploadedAttachment;
  error?: string;
}

/** The last path part of a file URI, percent-decoded, or "" when there is none. */
export function nameFromUri(uri: string): string {
  const last = uri.split("?")[0]!.split("/").pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** The picked files as waiting items, named as the web names a batch (a camera's `image.jpg` gets the time, repeats get -2). */
export function waitingFrom(picked: readonly PickedFile[], now: Date, nextId: () => string): WaitingAttachment[] {
  const named = picked.map((f) => ({ f, mime: f.mimeType || "application/octet-stream" }));
  const names = distinctNames(named.map(({ f, mime }) => pastedFileName(f.name || nameFromUri(f.uri), mime, now)));
  return named.map(({ f, mime }, i) => {
    const name = names[i]!;
    return {
      localId: nextId(),
      name,
      mimeType: mime,
      sizeBytes: f.sizeBytes ?? null,
      uri: f.uri,
      image: looksLikeImage({ name, type: mime }),
      status: "uploading",
      sentBytes: 0,
    };
  });
}

export function fromUploaded(u: UploadedAttachment): WaitingAttachment {
  return {
    localId: u.id,
    name: u.name,
    mimeType: u.mimeType,
    sizeBytes: u.sizeBytes,
    uri: "",
    image: u.kind === "image",
    status: "ready",
    sentBytes: u.sizeBytes,
    uploaded: u,
  };
}

function change(list: readonly WaitingAttachment[], localId: string, f: (a: WaitingAttachment) => WaitingAttachment): readonly WaitingAttachment[] {
  return list.map((a) => (a.localId === localId ? f(a) : a));
}

export const withProgress = (list: readonly WaitingAttachment[], localId: string, sent: number) =>
  change(list, localId, (a) => (a.status === "uploading" ? { ...a, sentBytes: sent } : a));

export const withUploaded = (list: readonly WaitingAttachment[], localId: string, u: UploadedAttachment) =>
  change(list, localId, (a) => {
    const { error: _e, ...rest } = a;
    return { ...rest, status: "ready", sentBytes: u.sizeBytes, sizeBytes: u.sizeBytes, uploaded: u, name: u.name };
  });

export const withFailure = (list: readonly WaitingAttachment[], localId: string, error: string) =>
  change(list, localId, (a) => ({ ...a, status: "failed", error }));

/** A failed item goes back to uploading from its picked file; anything else stays. */
export function withRetry(list: readonly WaitingAttachment[], localId: string): readonly WaitingAttachment[] {
  return change(list, localId, (a) => {
    if (a.status !== "failed" || a.uri === "") return a;
    const { error: _e, ...rest } = a;
    return { ...rest, status: "uploading", sentBytes: 0 };
  });
}

/** Puts back the uploads of a message the server refused, while nothing waits (what was added since stays). */
export function restored(list: readonly WaitingAttachment[], uploads: readonly UploadedAttachment[]): readonly WaitingAttachment[] {
  return uploads.length === 0 || list.length > 0 ? list : uploads.map(fromUploaded);
}

/** Puts the uploads of messages taken back in front of the waiting ones; one already waiting is not added twice. */
export function prepended(list: readonly WaitingAttachment[], uploads: readonly UploadedAttachment[]): readonly WaitingAttachment[] {
  const have = new Set(list.map((a) => a.uploaded?.id ?? a.localId));
  const back = uploads.filter((u) => !have.has(u.id)).map(fromUploaded);
  return back.length > 0 ? [...back, ...list] : list;
}

/** A chip's second line: the size, or the share uploaded, or the failure. */
export function chipDetail(a: WaitingAttachment): string {
  if (a.status === "failed") return a.error ?? "Upload failed";
  if (a.status === "uploading") {
    const total = a.sizeBytes;
    return total && total > 0 ? `Uploading ${Math.min(100, Math.floor((a.sentBytes / total) * 100))}%` : "Uploading";
  }
  return a.sizeBytes === null ? "" : formatBytes(a.sizeBytes);
}

/** Validates what POST /api/attachments answered (the web's isUploaded). */
export function isUploadedAttachment(v: unknown): v is UploadedAttachment {
  const o = v as Partial<UploadedAttachment> | null;
  return (
    !!o &&
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.path === "string" &&
    (o.kind === "image" || o.kind === "file") &&
    typeof o.sizeBytes === "number" &&
    typeof o.mimeType === "string"
  );
}
