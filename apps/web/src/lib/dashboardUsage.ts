// Usage over the last 7 days (GET /api/usage/history, DESIGN.md 6j) for the dashboard's chart. The
// server writes a row when a poll changed a window and then sends `usage` over /ws, so the history
// is read again after such a message, at most once a minute (the poll's own pace). The current
// value between reads comes from the live snapshot (lib/usage.ts).
import type { UsageHistory } from "@maru/shared";
import { useEffect, useSyncExternalStore } from "react";

import { socketHub } from "./socket";

/** The usage poll reads each account once a minute; reading the history faster finds nothing new. */
const MIN_GAP_MS = 60_000;

export interface UsageHistoryState {
  history: UsageHistory | null;
  error: string | null;
}

const EMPTY: UsageHistoryState = { history: null, error: null };

let state: UsageHistoryState = EMPTY;
const listeners = new Set<() => void>();
let views = 0;
let lastRead = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let offSocket: (() => void) | null = null;
let inflight: Promise<void> | null = null;

function publish(next: UsageHistoryState): void {
  state = next;
  for (const l of [...listeners]) l();
}

function read(): Promise<void> {
  if (inflight) return inflight;
  lastRead = Date.now();
  inflight = (async () => {
    try {
      const res = await fetch("/api/usage/history");
      const body = (await res.json().catch(() => null)) as (UsageHistory & { error?: string }) | null;
      if (!res.ok || !body) publish({ ...state, error: body?.error ?? `HTTP ${res.status}` });
      else publish({ history: body, error: null });
    } catch (err) {
      publish({ ...state, error: err instanceof Error ? err.message : String(err) });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function onUsageChange(): void {
  if (timer !== null || views === 0) return;
  const wait = Math.max(0, lastRead + MIN_GAP_MS - Date.now());
  timer = setTimeout(() => {
    timer = null;
    if (views > 0) void read();
  }, wait);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUsageHistory(): UsageHistoryState {
  const current = useSyncExternalStore(subscribe, () => state, () => EMPTY);
  useEffect(() => {
    views++;
    if (views === 1) {
      offSocket = socketHub().onMessage((msg) => {
        if (msg.type === "usage") onUsageChange();
      });
      if (Date.now() - lastRead >= MIN_GAP_MS || state.history === null) void read();
    }
    return () => {
      views--;
      if (views > 0) return;
      offSocket?.();
      offSocket = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
  }, []);
  return current;
}
