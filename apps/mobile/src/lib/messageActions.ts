// The message menu (DESIGN.md 2d): copy, rewind and fork from one of the user's messages. A row asks
// the menu to open through this registry, as the web's timeline asks the composer (web lib/rewind.ts
// openRewind): the host (components/MessageActions.tsx) registers for the open session and the
// rows show their "more" button only while one is registered, so a subagent's transcript, which
// the server cannot rewind or fork, has none.
import { useSyncExternalStore } from "react";
import type { OrchestrationV2TurnItem } from "@maru/shared";
import { rewindTargetOf } from "../../../web/src/lib/rewind.logic.ts";

export interface MessageMenuRequest {
  /** The message as sent (what the copy item puts on the clipboard). */
  text: string;
  /** The rewind target (web rewindTargetOf): the transcript uuid of a Claude message, the turn of a Codex one. */
  targetId: string;
}

export type MenuAction = "copy" | "rewind" | "fork";

export interface MenuItem {
  action: MenuAction;
  label: string;
  /** Why it cannot be pressed now; null when it can. */
  disabled: string | null;
}

/** The menu's rows, in the web's action order (copy, Rewind to here, Fork from here). Copy needs text; fork waits while a fork of the session runs. */
export function menuItems(m: { hasText: boolean; forking: boolean }): MenuItem[] {
  return [
    ...(m.hasText ? [{ action: "copy" as const, label: "Copy message", disabled: null }] : []),
    { action: "rewind", label: "Rewind to here", disabled: null },
    { action: "fork", label: "Fork from here", disabled: m.forking ? "Forking" : null },
  ];
}

interface Host {
  /** The open session's key, the one the server is asked about. */
  key: string;
  open: (m: MessageMenuRequest) => void;
}

let host: Host | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

/** The host takes the menu requests for the session; returns the unregister function. */
export function registerMessageActions(h: Host): () => void {
  host = h;
  notify();
  return () => {
    if (host === h) host = null;
    notify();
  };
}

/** Opens the menu; false when no host is registered. */
export function openMessageMenu(m: MessageMenuRequest): boolean {
  if (!host) return false;
  host.open(m);
  return true;
}

/** The session key the registered host serves, or null (no menu on this screen). */
export function useMessageActionsKey(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => host?.key ?? null,
  );
}

/** The row's target: its rewind id when the menu serves this session and the message has one. */
export function messageTarget(key: string | null, item: OrchestrationV2TurnItem | undefined): string | null {
  return key === null ? null : rewindTargetOf(key, item);
}
