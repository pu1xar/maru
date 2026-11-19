// The files and pictures waiting to go with a session's next message (DESIGN.md 6n), per session
// and outside React state like the text draft (drafts.ts): switching the open session keeps them.
// Each picked file uploads at once (api.ts uploadAttachment), so a send only names upload ids.
// Kept for the life of the app; a restart drops them (the uploads stay on the server).
import { useCallback, useSyncExternalStore } from "react";
import type { UploadedAttachment } from "@maru/shared";
import { uploadAttachment, type Pairing } from "./api.ts";
import {
  prepended,
  restored,
  waitingFrom,
  withFailure,
  withProgress,
  withRetry,
  withUploaded,
  type PickedFile,
  type WaitingAttachment,
} from "./composerAttachments.logic.ts";

const EMPTY: readonly WaitingAttachment[] = Object.freeze([]);
const lists = new Map<string, readonly WaitingAttachment[]>();
const listeners = new Set<() => void>();
/** Running uploads by local id, so removing an item stops its upload. */
const running = new Map<string, () => void>();
let seq = 0;

function get(key: string): readonly WaitingAttachment[] {
  return lists.get(key) ?? EMPTY;
}

function set(key: string, next: readonly WaitingAttachment[]): void {
  if (next.length === 0) lists.delete(key);
  else lists.set(key, next);
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function startUpload(key: string, pairing: Pairing, item: WaitingAttachment): void {
  const up = uploadAttachment(pairing, { uri: item.uri, name: item.name, mimeType: item.mimeType }, (sent) => set(key, withProgress(get(key), item.localId, sent)));
  running.set(item.localId, up.abort);
  up.done.then(
    (u) => {
      running.delete(item.localId);
      set(key, withUploaded(get(key), item.localId, u));
    },
    (err: unknown) => {
      running.delete(item.localId);
      // An item taken off the list while it ran is not on it to fail.
      set(key, withFailure(get(key), item.localId, err instanceof Error ? err.message : String(err)));
    },
  );
}

/** Adds picked files to the session's next message and uploads them. */
export function addPickedFiles(key: string, pairing: Pairing, picked: readonly PickedFile[]): void {
  if (picked.length === 0) return;
  const added = waitingFrom(picked, new Date(), () => {
    seq += 1;
    return `local-${Date.now().toString(36)}-${seq}`;
  });
  set(key, [...get(key), ...added]);
  for (const item of added) startUpload(key, pairing, item);
}

/** Uploads a failed item again from its picked file. */
export function retryAttachment(key: string, pairing: Pairing, localId: string): void {
  const before = get(key).find((a) => a.localId === localId);
  if (!before || before.status !== "failed") return;
  const next = withRetry(get(key), localId);
  set(key, next);
  const item = next.find((a) => a.localId === localId);
  if (item && item.status === "uploading") startUpload(key, pairing, item);
}

export function removeAttachment(key: string, localId: string): void {
  running.get(localId)?.();
  running.delete(localId);
  set(key, get(key).filter((a) => a.localId !== localId));
}

/** Empties the list after a send. */
export function clearAttachments(key: string): void {
  set(key, EMPTY);
}

/** Puts back the uploads of a message the server refused (command.error `unsentAttachments`), while the list is empty. */
export function restoreAttachments(key: string, uploads: readonly UploadedAttachment[]): void {
  set(key, restored(get(key), uploads));
}

/** Puts the uploads of queued messages taken back (thread.recalled) in front of the waiting ones. */
export function prependAttachments(key: string, uploads: readonly UploadedAttachment[]): void {
  set(key, prepended(get(key), uploads));
}

export function useAttachments(key: string): readonly WaitingAttachment[] {
  return useSyncExternalStore(subscribe, () => get(key), () => EMPTY);
}

/** The waiting attachments' actions for one session, bound to the pairing the uploads go through. */
export function useAttachmentActions(key: string, pairing: Pairing) {
  const add = useCallback((picked: readonly PickedFile[]) => addPickedFiles(key, pairing, picked), [key, pairing]);
  const retry = useCallback((localId: string) => retryAttachment(key, pairing, localId), [key, pairing]);
  const remove = useCallback((localId: string) => removeAttachment(key, localId), [key]);
  return { add, retry, remove };
}
