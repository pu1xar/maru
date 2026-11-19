// The files and pictures waiting to go with a session's next message (DESIGN.md 6n), shared by the
// chat composer and the terminal mode's input like the text draft (composerDraft.ts): switching the
// view keeps them, a reload keeps the uploaded ones.
//
// - Each file uploads to the server as soon as it is added (POST /api/attachments), so a send only
//   names upload ids. A paste, a drop and the file button all come here.
// - A picture shows its local copy (an object URL) until a reload; after one, the server's copy.
// - Uploaded attachments are kept in localStorage per session (`maru_composer_attachments:<key>`);
//   uploads still running or failed live in this page only.
import { useCallback, useSyncExternalStore } from "react";
import type { UploadedAttachment } from "@maru/shared";
import { attachmentUploadUrl, attachmentUrl } from "@maru/shared";
import { distinctNames, looksLikeImage, pasteAttaches, pastedFileName, uploadFailureReason } from "./composerAttachments.logic.ts";

const STORE_PREFIX = "maru_composer_attachments:";

export interface ComposerAttachment {
  /** Page-local id (the upload id once uploaded). */
  localId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** The picture to draw: a local object URL, or the server's copy after a reload. */
  previewUrl: string | null;
  status: "uploading" | "ready" | "failed";
  /** Bytes sent so far while uploading. */
  sentBytes: number;
  uploaded?: UploadedAttachment;
  error?: string;
}

type Listener = () => void;
const EMPTY: readonly ComposerAttachment[] = Object.freeze([]);
const lists = new Map<string, readonly ComposerAttachment[]>();
const listeners = new Map<string, Set<Listener>>();
let seq = 0;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isUploaded(v: unknown): v is UploadedAttachment {
  const o = v as Partial<UploadedAttachment> | null;
  return !!o && typeof o.id === "string" && typeof o.name === "string" && typeof o.path === "string"
    && (o.kind === "image" || o.kind === "file") && typeof o.sizeBytes === "number" && typeof o.mimeType === "string";
}

function fromUploaded(u: UploadedAttachment): ComposerAttachment {
  return {
    localId: u.id, name: u.name, mimeType: u.mimeType, sizeBytes: u.sizeBytes, status: "ready", sentBytes: u.sizeBytes, uploaded: u,
    previewUrl: u.kind === "image" ? attachmentUrl(u.id, "image") : null,
  };
}

function readStored(key: string): readonly ComposerAttachment[] {
  try {
    const raw = storage()?.getItem(STORE_PREFIX + key);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isUploaded).map(fromUploaded) : EMPTY;
  } catch {
    return EMPTY;
  }
}

function writeStored(key: string, list: readonly ComposerAttachment[]): void {
  try {
    const store = storage();
    if (!store) return;
    const ready = list.flatMap((a) => (a.uploaded ? [a.uploaded] : []));
    if (ready.length === 0) store.removeItem(STORE_PREFIX + key);
    else store.setItem(STORE_PREFIX + key, JSON.stringify(ready));
  } catch {
    // Full or blocked storage: the list stays in this page.
  }
}

export function getComposerAttachments(key: string): readonly ComposerAttachment[] {
  if (!lists.has(key)) lists.set(key, readStored(key));
  return lists.get(key) ?? EMPTY;
}

function setList(key: string, next: readonly ComposerAttachment[]): void {
  lists.set(key, next);
  writeStored(key, next);
  for (const l of [...(listeners.get(key) ?? [])]) l();
}

function update(key: string, localId: string, change: (a: ComposerAttachment) => ComposerAttachment): void {
  const list = getComposerAttachments(key);
  if (!list.some((a) => a.localId === localId)) return;
  setList(key, list.map((a) => (a.localId === localId ? change(a) : a)));
}

/** Uploads one file with progress; resolves with what the server stored or rejects with its error text. */
function upload(file: File, name: string, onProgress: (sent: number) => void): Promise<UploadedAttachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", attachmentUploadUrl(name));
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    // A proxy that refuses the body early (a 413) may close the connection: no status.
    xhr.onerror = () => reject(new Error(uploadFailureReason(xhr.status, xhr.responseText)));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // A proxy page or the guard's plain text: uploadFailureReason reads the status.
      }
      if (xhr.status >= 200 && xhr.status < 300 && isUploaded(body)) return resolve(body);
      reject(new Error(uploadFailureReason(xhr.status, xhr.responseText)));
    };
    xhr.send(file);
  });
}

/** Adds files to the session's next message and uploads them. */
export function addComposerFiles(key: string, files: readonly File[]): void {
  if (files.length === 0) return;
  const now = new Date();
  const names = distinctNames(files.map((file) => pastedFileName(file.name, file.type, now)));
  const added = files.map((file, i) => {
    seq += 1;
    const name = names[i]!;
    const item: ComposerAttachment = {
      localId: `local-${Date.now().toString(36)}-${seq}`,
      name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      previewUrl: looksLikeImage(file) && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null,
      status: "uploading",
      sentBytes: 0,
    };
    return { file, item };
  });
  setList(key, [...getComposerAttachments(key), ...added.map((a) => a.item)]);
  for (const { file, item } of added) {
    upload(file, item.name, (sent) => update(key, item.localId, (a) => ({ ...a, sentBytes: sent }))).then(
      (u) => update(key, item.localId, (a) => {
        // A picture the browser cannot draw (HEIC on most desktops) shows the server's converted copy.
        const swap = u.kind === "image" && (!a.previewUrl || !/^image\/(png|jpeg|gif|webp)$/.test(a.mimeType));
        if (swap && a.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(a.previewUrl);
        return { ...a, status: "ready", sentBytes: u.sizeBytes, uploaded: u, name: u.name, previewUrl: swap ? attachmentUrl(u.id, "image") : a.previewUrl };
      }),
      (err: unknown) => update(key, item.localId, (a) => ({ ...a, status: "failed", error: err instanceof Error ? err.message : String(err) })),
    );
  }
}

export function removeComposerAttachment(key: string, localId: string): void {
  const list = getComposerAttachments(key);
  const gone = list.find((a) => a.localId === localId);
  if (gone?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(gone.previewUrl);
  setList(key, list.filter((a) => a.localId !== localId));
}

/** Empties the list after a send and frees the local previews (the sent bubble draws from the server). */
export function clearComposerAttachments(key: string): void {
  const list = getComposerAttachments(key);
  for (const a of list) if (a.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(a.previewUrl);
  setList(key, EMPTY);
}

/**
 * Puts back the attachments of a message the server refused (command.error `unsentAttachments`),
 * while the list is still empty: what was added since the send stays as it is.
 */
export function restoreComposerAttachments(key: string, uploads: readonly UploadedAttachment[]): void {
  if (uploads.length === 0 || getComposerAttachments(key).length > 0) return;
  setList(key, uploads.filter(isUploaded).map(fromUploaded));
}

/**
 * Puts the attachments of queued messages taken back (thread.recall, DESIGN.md 4.4) in front of the
 * waiting ones, as their text goes in front of the draft. Unlike a refused send's (above), they come
 * back also when attachments wait already: the user asked for them. One already waiting is not
 * added twice.
 */
export function prependComposerAttachments(key: string, uploads: readonly UploadedAttachment[]): void {
  const list = getComposerAttachments(key);
  const have = new Set(list.map((a) => a.uploaded?.id ?? a.localId));
  const back = uploads.filter(isUploaded).filter((u) => !have.has(u.id)).map(fromUploaded);
  if (back.length > 0) setList(key, [...back, ...list]);
}

// Whether a send can go (UPLOADING, attachmentsToSend) is pure and lives in composerAttachments.logic.ts,
// where the Android app reads it too.
export { attachmentsToSend, UPLOADING } from "./composerAttachments.logic.ts";

export function subscribeComposerAttachments(key: string, listener: Listener): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/** Files a paste carries, or none when the paste is text (composerAttachments.logic.ts pasteAttaches). */
export function pastedFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files);
  return pasteAttaches(files, data.getData("text/plain")) ? files : [];
}

/** True while a drag carries files (not text or a link from the page). */
export function dragHasFiles(data: DataTransfer | null): boolean {
  return !!data && Array.from(data.types).includes("Files");
}

/**
 * The session's waiting attachments and the actions on them. `onPaste` and the drop handlers go on
 * the input (or its frame); both composers use the same ones.
 */
export function useComposerAttachments(key: string) {
  const subscribe = useCallback((l: Listener) => subscribeComposerAttachments(key, l), [key]);
  const items = useSyncExternalStore(subscribe, () => getComposerAttachments(key), () => EMPTY);
  const add = useCallback((files: readonly File[]) => addComposerFiles(key, files), [key]);
  const remove = useCallback((localId: string) => removeComposerAttachment(key, localId), [key]);
  const clear = useCallback(() => clearComposerAttachments(key), [key]);
  const onPaste = useCallback(
    (event: { clipboardData: DataTransfer | null; preventDefault(): void }) => {
      const files = pastedFiles(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      addComposerFiles(key, files);
    },
    [key],
  );
  return { items, add, remove, clear, onPaste };
}
