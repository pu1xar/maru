// Questions the sessions this server drives are waiting on (`session.pending`), kept for the whole
// page: the server sends them right after hello and on every change, before any view mounts.
import type { PendingQuestionView } from "@maru/shared";
import { useSyncExternalStore } from "react";

import { socketHub } from "./socket";

const EMPTY: readonly PendingQuestionView[] = [];
const byKey = new Map<string, readonly PendingQuestionView[]>();
const listeners = new Set<() => void>();
let started = false;

/** Called once at boot (main.tsx), so the questions sent with hello are not missed. */
export function startPendingQuestions(): void {
  if (started) return;
  started = true;
  socketHub().onMessage((msg) => {
    if (msg.type === "hello") {
      // A new connection resends what is still pending; anything else was answered or ended.
      byKey.clear();
    } else if (msg.type === "session.pending") {
      if (msg.questions.length) byKey.set(msg.key, msg.questions);
      else byKey.delete(msg.key);
    } else {
      return;
    }
    for (const l of [...listeners]) l();
  });
}

function subscribe(listener: () => void): () => void {
  startPendingQuestions();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePendingQuestions(sessionKey: string): readonly PendingQuestionView[] {
  return useSyncExternalStore(subscribe, () => byKey.get(sessionKey) ?? EMPTY);
}
