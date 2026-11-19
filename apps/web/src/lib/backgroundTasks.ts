// Sending foreground work to the background (DESIGN.md 4.5): the Claude Code CLI's Ctrl+B. The
// server answers `thread.background` with a notice or the reason nothing moved (the composers show
// both) and announces which calls the CLI holds in the foreground (`session.foreground`); this
// file sends the request and holds the React parts. The rules are in backgroundTasks.logic.ts.
import { createContext, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  BACKGROUND_KEY_QUIET_MS, BACKGROUND_OFFER_AFTER_MS, backgroundKeyAction, isBackgroundKey, offerShown,
} from "./backgroundTasks.logic.ts";
import { inShellTerminal } from "./shellKeys.ts";
import { socketHub } from "./socket.ts";
import { useWindowKeysRef } from "./windowKeys.ts";

export * from "./backgroundTasks.logic.ts";

// ---- the foreground calls the server announced ----

const EMPTY: ReadonlyMap<string, number> = new Map();
/** Per session: tool_use id -> when this page first heard it was in the foreground (ms). */
const byKey = new Map<string, ReadonlyMap<string, number>>();
const listeners = new Set<() => void>();
let started = false;

/** Called once at boot (main.tsx), so the lists sent with hello are not missed. */
export function startForegroundTasks(): void {
  if (started) return;
  started = true;
  socketHub().onMessage((msg) => {
    if (msg.type === "hello") {
      // A new connection resends what is still in the foreground; anything else ended.
      byKey.clear();
    } else if (msg.type === "session.foreground") {
      if (msg.toolUseIds.length === 0) byKey.delete(msg.key);
      else {
        const before = byKey.get(msg.key);
        const now = Date.now();
        byKey.set(msg.key, new Map(msg.toolUseIds.map((id) => [id, before?.get(id) ?? now])));
      }
    } else {
      return;
    }
    for (const l of [...listeners]) l();
  });
}

function subscribe(listener: () => void): () => void {
  startForegroundTasks();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The session's foreground calls the CLI holds: tool_use id to when this page first heard of it. */
export function useForegroundCalls(sessionKey: string): ReadonlyMap<string, number> {
  return useSyncExternalStore(subscribe, () => byKey.get(sessionKey) ?? EMPTY);
}

// ---- sending ----

let seq = 0;

/** Sends `thread.background`; `toolUseId` names one call, none sends them all. False when the socket is down. */
export function sendBackground(sessionKey: string, toolUseId?: string): boolean {
  seq += 1;
  return socketHub().send({
    type: "thread.background",
    threadId: sessionKey,
    ...(toolUseId ? { toolUseId } : {}),
    reqId: `background-${Date.now().toString(36)}-${seq}`,
  });
}

/** What the conversation below offers: `send` is null where it cannot (Codex, a terminal-held session). */
export interface BackgroundOffer {
  /** Sends one call (a tool_use id) to the background; null where the session cannot. */
  send: ((toolUseId: string) => void) | null;
  /** The key's name for the hint. */
  keyLabel: string;
  /** The session's foreground calls (see useForegroundCalls). */
  calls: ReadonlyMap<string, number>;
  /** Send now for the waiting messages (queuedMessages.ts sendQueuedNow); null where the session cannot (canSendNow). */
  sendNow: (() => void) | null;
}

export const BackgroundOfferContext = createContext<BackgroundOffer>({ send: null, keyLabel: "ctrl+b", calls: EMPTY, sendNow: null });

/**
 * Whether one call shows "백그라운드로" or the terminal hint now (offerShown). An Agent call waits
 * out BACKGROUND_OFFER_AFTER_MS from when it was announced, on a timer (no polling).
 */
export function useOfferShown(offer: BackgroundOffer, toolUseId: string | null, kind: "command" | "agent"): boolean {
  const since = toolUseId === null ? undefined : offer.calls.get(toolUseId);
  const [now, setNow] = useState(() => Date.now());
  const wait = offer.send !== null && kind === "agent" && since !== undefined ? since + BACKGROUND_OFFER_AFTER_MS - now : 0;
  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [wait]);
  if (offer.send === null || toolUseId === null) return false;
  return offerShown({ kind, announced: since !== undefined, since: since ?? null, now });
}

/**
 * The background key on the whole window while this conversation owns the window keys (the focused
 * pane in the split view, lib/windowKeys.ts). A press sends every foreground call of the session;
 * with nothing in the foreground it is left to the page (a Mac textarea takes ctrl+b as "cursor
 * left"). The press that follows a send closely is swallowed, so a tmux-style double press neither
 * moves the cursor nor does anything else.
 */
export function useBackgroundKey(opts: { sessionKey: string; enabled: boolean; foregroundCount: number }): void {
  const live = useWindowKeysRef();
  const latest = useRef(opts);
  latest.current = opts;
  const quietUntil = useRef(0);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!live.current || event.defaultPrevented || !isBackgroundKey(event)) return;
      // ctrl+b typed in a shell terminal is the shell's (emacs keys, a tmux in it; lib/shellKeys.ts).
      if (inShellTerminal(event.target)) return;
      const now = Date.now();
      const cur = latest.current;
      const action = backgroundKeyAction({ enabled: cur.enabled, foregroundCount: cur.foregroundCount, now, quietUntil: quietUntil.current });
      if (action === "pass") return;
      event.preventDefault();
      if (action === "swallow") return;
      quietUntil.current = now + BACKGROUND_KEY_QUIET_MS;
      sendBackground(cur.sessionKey);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [live]);
}
