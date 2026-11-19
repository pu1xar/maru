// A session's own view mode (chat or terminal), kept per session in expo-secure-store as the web keeps
// it in localStorage (viewMode.ts useViewMode; the key form is terminalView.logic.ts
// sessionModeStoreKey). A session without its own choice shows the default view mode of the
// settings (appearance.tsx). The stored mode is read the first time a session is on screen, so for
// that moment the default shows.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";
import { isViewMode, resolveViewMode, type ViewMode } from "../../../web/src/lib/viewMode.logic.ts";
import { useAppearance } from "../appearance.tsx";
import { sessionModeStoreKey } from "./terminalView.logic.ts";

/** Session modes read so far; `null` means "no own choice". */
const modes = new Map<string, ViewMode | null>();
const reading = new Set<string>();
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

function read(sessionKey: string): void {
  if (modes.has(sessionKey) || reading.has(sessionKey)) return;
  reading.add(sessionKey);
  SecureStore.getItemAsync(sessionModeStoreKey(sessionKey)).then(
    (raw) => {
      reading.delete(sessionKey);
      // A choice made while the read was on its way stands.
      if (modes.has(sessionKey)) return;
      let value: unknown = null;
      try {
        value = raw === null ? null : JSON.parse(raw);
      } catch {
        // Not JSON: no own choice.
      }
      modes.set(sessionKey, isViewMode(value) ? value : null);
      notify();
    },
    () => {
      // Storage unreadable: the default shows and the choice holds for this launch only.
      reading.delete(sessionKey);
      modes.set(sessionKey, null);
      notify();
    },
  );
}

/** The mode this session shows, and a setter that keeps it as the session's own choice. */
export function useViewMode(sessionKey: string | null): [ViewMode, (mode: ViewMode) => void] {
  const { prefs } = useAppearance();
  const own = useSyncExternalStore(subscribe, () => (sessionKey === null ? null : (modes.get(sessionKey) ?? null)));
  useEffect(() => {
    if (sessionKey !== null) read(sessionKey);
  }, [sessionKey]);
  const setMode = useCallback(
    (next: ViewMode) => {
      if (sessionKey === null) return;
      modes.set(sessionKey, next);
      SecureStore.setItemAsync(sessionModeStoreKey(sessionKey), JSON.stringify(next)).catch(() => undefined);
      notify();
    },
    [sessionKey],
  );
  return [resolveViewMode(own, prefs.defaultViewMode), setMode];
}

/**
 * A session moved to another account (its key carries the account): its own mode goes to the new
 * key, unless that key has one already (web moveSessionViewMode).
 */
export function moveSessionViewMode(from: string, to: string): void {
  const own = modes.get(from) ?? null;
  if (own === null) return;
  modes.set(from, null);
  SecureStore.deleteItemAsync(sessionModeStoreKey(from)).catch(() => undefined);
  if ((modes.get(to) ?? null) === null) {
    modes.set(to, own);
    SecureStore.setItemAsync(sessionModeStoreKey(to), JSON.stringify(own)).catch(() => undefined);
  }
  notify();
}
