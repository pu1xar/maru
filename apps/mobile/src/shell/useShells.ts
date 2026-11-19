// The shells for a screen (DESIGN.md 6s): the store of listStore.ts for the paired server, kept
// read every few seconds while `polling` and the app is on the screen (the web reads every 3 s
// while its page is visible; a phone also stops while the app is in the background).
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import type { Pairing } from "../lib/api.ts";
import { shellApi } from "./api.ts";
import { ShellListStore, type ShellListState } from "./listStore.ts";

/** How often the list is read again while it is wanted (the web's SHELL_LIST_POLL_MS). */
export const SHELL_LIST_POLL_MS = 3000;

export interface Shells extends ShellListState {
  store: ShellListStore;
}

export function useShells(pairing: Pairing, polling: boolean): Shells {
  const store = useMemo(() => new ShellListStore(shellApi(pairing)), [pairing]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setForeground(s === "active"));
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!polling || !foreground) return;
    void store.refresh();
    const timer = setInterval(() => void store.refresh(), SHELL_LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [store, polling, foreground]);
  return useMemo(() => ({ ...state, store }), [state, store]);
}
