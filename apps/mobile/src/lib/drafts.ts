// The input's draft per session, outside React state: typing redraws only the input, and text taken
// back from the queue (DESIGN.md 4.4) lands in the draft of the session it was sent to, whichever
// session is on screen.
import { useCallback, useSyncExternalStore } from "react";
import { mergeRecalled } from "../../../web/src/lib/queuedMessages.logic.ts";
import { draftAfterRewind } from "../../../web/src/lib/rewind.logic.ts";

const drafts = new Map<string, string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setDraft(key: string, text: string): void {
  if ((drafts.get(key) ?? "") === text) return;
  if (text) drafts.set(key, text);
  else drafts.delete(key);
  notify();
}

export function draftOf(key: string): string {
  return drafts.get(key) ?? "";
}

/** Puts queued messages taken back in front of the session's draft, as the web does. */
export function putBackDraft(key: string, texts: readonly string[]): void {
  const draft = drafts.get(key) ?? "";
  setDraft(key, mergeRecalled(texts, draft, draft.length).text);
}

/**
 * The message a conversation rewind took back (DESIGN.md 6o) goes in front of what the session's
 * draft already holds, as the web's composer does (draftAfterRewind).
 */
export function putBackRewound(key: string, prefill: string): void {
  setDraft(key, draftAfterRewind(drafts.get(key) ?? "", prefill));
}

/** Puts back the text of a send the server refused, while the draft is empty (what was typed since stays). */
export function restoreDraft(key: string, text: string): void {
  if (text && (drafts.get(key) ?? "") === "") setDraft(key, text);
}

export function useDraft(key: string): [string, (text: string) => void] {
  const text = useSyncExternalStore(subscribe, () => drafts.get(key) ?? "");
  const set = useCallback((next: string) => setDraft(key, next), [key]);
  return [text, set];
}
