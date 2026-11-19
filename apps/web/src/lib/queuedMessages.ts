// Messages sent to a session that the model has not taken in yet (`session.queued`, DESIGN.md 4.4),
// kept for the whole page: the server sends every list right after hello and each list again on
// every change, so a reload, another tab and the Android app show the same rows.
//
// - A row shows until the conversation has the message: a row of the thread whose
//   `x.data.clientId` is the send's id. The server keeps a taken message until its turn is over,
//   so the row does not blink out between "the model has it" and "the transcript line arrived".
// - Taking messages back (thread.recall) puts their text in front of this page's draft for the
//   session (mergeRecalled, the CLI's rule) and their attachments in front of the waiting ones.
import type { OrchestrationV2ProjectedTurnItem, PendingSend, RecalledMessage } from "@maru/shared";
import { useMemo, useSyncExternalStore } from "react";

import { prependComposerAttachments } from "./composerAttachments";
import { composerCaret, getComposerDraft, placeComposerCaret, setComposerDraft } from "./composerDraft";
import { deliveredIds, mergeRecalled, shownQueued } from "./queuedMessages.logic";
import { socketHub } from "./socket";

const EMPTY: readonly PendingSend[] = [];
const NO_IDS: ReadonlySet<string> = new Set();
const byKey = new Map<string, readonly PendingSend[]>();
/** Recalls on their way: reqId -> the session, the ids asked for, and whether the texts are dropped. */
const recalls = new Map<string, { key: string; ids: readonly string[]; discard: boolean }>();
let recalling: ReadonlySet<string> = NO_IDS;
/** Send now requests on their way: reqId -> the session. Answered by command.result or command.error with the reqId. */
const sendNows = new Map<string, string>();
let sendingNow: ReadonlySet<string> = NO_IDS;
const listeners = new Set<() => void>();
let started = false;
let reqSeq = 0;

function notify(): void {
  for (const l of [...listeners]) l();
}

function setSendingNow(): void {
  sendingNow = sendNows.size ? new Set(sendNows.values()) : NO_IDS;
}

function setRecalling(): void {
  recalling = recalls.size ? new Set([...recalls.values()].flatMap((r) => r.ids)) : NO_IDS;
}

/** Called once at boot (main.tsx), so the lists sent with hello are not missed. */
export function startQueuedMessages(): void {
  if (started) return;
  started = true;
  socketHub().onMessage((msg) => {
    if (msg.type === "hello") {
      // A new connection resends every list; a recall that was on its way gets no answer now.
      byKey.clear();
      recalls.clear();
      setRecalling();
      sendNows.clear();
      setSendingNow();
    } else if (msg.type === "command.result" || msg.type === "command.error") {
      if (!msg.reqId || !sendNows.delete(msg.reqId)) return;
      setSendingNow();
    } else if (msg.type === "session.queued") {
      if (msg.sends.length) byKey.set(msg.key, msg.sends);
      else byKey.delete(msg.key);
    } else if (msg.type === "thread.recalled") {
      const asked = msg.reqId ? recalls.get(msg.reqId) : undefined;
      if (!asked || !msg.reqId) return;
      recalls.delete(msg.reqId);
      setRecalling();
      if (msg.messages.length && !asked.discard) putBack(asked.key, msg.messages);
    } else {
      return;
    }
    notify();
  });
}

function subscribe(listener: () => void): () => void {
  startQueuedMessages();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The session's messages that wait, oldest first. */
export function useQueuedMessages(sessionKey: string): readonly PendingSend[] {
  return useSyncExternalStore(subscribe, () => byKey.get(sessionKey) ?? EMPTY);
}

/** Ids of the messages whose recall this page has sent and not heard back from. */
export function useRecalling(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => recalling);
}

/** Whether this page has a Send now for the session on its way and unanswered. */
export function useSendingNow(sessionKey: string): boolean {
  return useSyncExternalStore(subscribe, () => sendingNow.has(sessionKey));
}

/**
 * Asks the server to send the session's waiting messages now (`thread.sendNow`, DESIGN.md 4.4): the
 * foreground tasks go to the background, then each waiting message is sent again with priority now,
 * which cuts the call the turn waits on and runs the messages as a new turn (the turn is stopped
 * instead when the tasks cannot move). The waiting rows keep their place, under new ids. The
 * answer's notice shows in the composer (useCommandFeedback). False when the request could not be
 * sent, or one is already on its way.
 */
export function sendQueuedNow(sessionKey: string): boolean {
  if (sendingNow.has(sessionKey)) return false;
  reqSeq += 1;
  const reqId = `sendnow-${Date.now().toString(36)}-${reqSeq}`;
  if (!socketHub().send({ type: "thread.sendNow", threadId: sessionKey, reqId })) return false;
  sendNows.set(reqId, sessionKey);
  setSendingNow();
  notify();
  return true;
}

// Sends made on this page, counted per session. A send is the reader's own act, so the timelines
// bring the conversation to its end on it (`sendBringsEnd`), also when the reader had scrolled up.
const sentCounts = new Map<string, number>();
const sentListeners = new Set<() => void>();

/** Called by a composer right after it handed a `thread.send` to the socket. */
export function markSent(sessionKey: string): void {
  sentCounts.set(sessionKey, (sentCounts.get(sessionKey) ?? 0) + 1);
  for (const l of [...sentListeners]) l();
}

/** How many messages this page has sent to the session; changes on each send. */
export function useSentCount(sessionKey: string): number {
  return useSyncExternalStore(
    (listener) => {
      sentListeners.add(listener);
      return () => {
        sentListeners.delete(listener);
      };
    },
    () => sentCounts.get(sessionKey) ?? 0,
  );
}

/** The session's waiting messages the conversation does not show yet. */
export function useShownQueued(sessionKey: string, items: readonly OrchestrationV2ProjectedTurnItem[] | undefined): readonly PendingSend[] {
  const sends = useQueuedMessages(sessionKey);
  const waiting = sends.length > 0;
  // The rows are read only while something waits.
  const delivered = useMemo(() => (waiting && items ? deliveredIds(items) : NO_IDS), [waiting, items]);
  return useMemo(() => shownQueued(sends, delivered), [sends, delivered]);
}

function putBack(key: string, messages: RecalledMessage["messages"]): void {
  prependComposerAttachments(key, messages.flatMap((m) => m.attachments));
  const merged = mergeRecalled(messages.map((m) => m.text), getComposerDraft(key), composerCaret(key));
  setComposerDraft(key, merged.text);
  placeComposerCaret(key, merged.caret);
}

/**
 * Asks the server to take these messages back; their texts land in this page's draft, or nowhere
 * with `discard` (지우기: a failed message, or one not to send after all). A message that could not
 * come back answers command.error, which the composer shows. False when the request could not be sent.
 */
export function recallQueued(sessionKey: string, ids: readonly string[], opts: { discard?: boolean } = {}): boolean {
  if (ids.length === 0) return false;
  reqSeq += 1;
  const reqId = `recall-${Date.now().toString(36)}-${reqSeq}`;
  if (!socketHub().send({ type: "thread.recall", threadId: sessionKey, ids: [...ids], reqId })) return false;
  recalls.set(reqId, { key: sessionKey, ids, discard: opts.discard === true });
  setRecalling();
  notify();
  return true;
}
