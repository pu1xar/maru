// The `/` menu's commands per session (GET /api/session-commands), kept for the page. Each menu
// opening asks the server again, which answers from its own cache unless the sources changed;
// the list read last stays on screen meanwhile.
import type { SessionCommand, SessionCommandsResponse } from "@maru/shared";
import { useEffect, useSyncExternalStore } from "react";

export interface SessionCommandsState {
  commands: readonly SessionCommand[] | null;
  loading: boolean;
  error: string | null;
}

const IDLE: SessionCommandsState = { commands: null, loading: false, error: null };
const byKey = new Map<string, SessionCommandsState>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function set(key: string, next: SessionCommandsState): void {
  byKey.set(key, next);
  for (const l of [...listeners]) l();
}

function load(key: string): Promise<void> {
  const running = inFlight.get(key);
  if (running) return running;
  const prev = byKey.get(key) ?? IDLE;
  set(key, { ...prev, loading: true });
  const p = (async () => {
    try {
      const res = await fetch(`/api/session-commands?key=${encodeURIComponent(key)}`, { headers: { accept: "application/json" } });
      const body = (await res.json().catch(() => null)) as (SessionCommandsResponse & { error?: string }) | null;
      if (!res.ok || !body || !Array.isArray(body.commands)) throw new Error(body?.error ?? `HTTP ${res.status}`);
      set(key, { commands: body.commands, loading: false, error: null });
    } catch (err) {
      set(key, { commands: (byKey.get(key) ?? IDLE).commands, loading: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The session's commands; `open` turning true (the menu opened) reads them again. */
export function useSessionCommands(key: string, open: boolean): SessionCommandsState {
  // Fetches the list from the server each time the menu opens.
  useEffect(() => {
    if (open) void load(key);
  }, [key, open]);
  return useSyncExternalStore(subscribe, () => byKey.get(key) ?? IDLE);
}
