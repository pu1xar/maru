// The dashboard's work list (GET /api/dashboard/work, DESIGN.md 6j), one reader for the page. It is
// read every few seconds while a dashboard is mounted, and soon after the /ws messages that change
// it: a question that arrives or is answered (`session.pending`), and a session whose status or
// owner moved (`index`). After an action (answer, stop, resume, send) refreshDashboardWork reads at once.
// While the page is hidden (another tab, a minimized window) it reads nothing, and reads once it shows.
import type { DashboardWork, ServerMessage } from "@maru/shared";
import { useEffect, useSyncExternalStore } from "react";

import { socketHub } from "./socket";

/** How often the list is read while shown. A refresh interval, not a limit on what is listed. */
const REFRESH_MS = 3000;
/** /ws changes that come together (a session's status, then its question) cost one read. */
const SOON_MS = 150;

export interface DashboardWorkState {
  work: DashboardWork | null;
  error: string | null;
}

const EMPTY: DashboardWorkState = { work: null, error: null };

let state: DashboardWorkState = EMPTY;
const listeners = new Set<() => void>();
let views = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let ctrl: AbortController | null = null;
let seq = 0;
let offSocket: (() => void) | null = null;
/** Session key -> "status owner" as /ws last said, so only a real change asks for a read. */
const known = new Map<string, string>();

function publish(next: DashboardWorkState): void {
  state = next;
  for (const l of [...listeners]) l();
}

/** A read is owed while the page was hidden; it runs when the page shows. */
let owed = false;

function onVisibility(): void {
  if (!document.hidden && owed && views > 0) {
    owed = false;
    void read();
  }
}

function schedule(ms: number): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (document.hidden) owed = true;
    else void read();
  }, ms);
}

async function read(): Promise<void> {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  ctrl?.abort();
  const mine = new AbortController();
  ctrl = mine;
  const n = ++seq;
  try {
    const res = await fetch("/api/dashboard/work", { signal: mine.signal });
    const body = (await res.json().catch(() => null)) as (DashboardWork & { error?: string }) | null;
    if (n !== seq) return;
    if (!res.ok || !body) publish({ ...state, error: body?.error ?? `HTTP ${res.status}` });
    else publish({ work: body, error: null });
  } catch (err) {
    if (mine.signal.aborted || n !== seq) return;
    publish({ ...state, error: err instanceof Error ? err.message : String(err) });
  }
  if (n === seq && views > 0) schedule(REFRESH_MS);
}

function onSocket(msg: ServerMessage): void {
  if (msg.type === "session.pending") {
    schedule(SOON_MS);
  } else if (msg.type === "hello") {
    known.clear();
    for (const s of msg.sessions) known.set(s.key, `${s.status} ${s.owner}`);
    schedule(SOON_MS);
  } else if (msg.type === "index") {
    const e = msg.event;
    if (e.type === "remove") {
      if (known.delete(e.key)) schedule(SOON_MS);
      return;
    }
    const next = `${e.session.status} ${e.session.owner}`;
    if (known.get(e.session.key) === next) return;
    known.set(e.session.key, next);
    schedule(SOON_MS);
  }
}

/** Reads the list again now (after an action), when a dashboard shows it. */
export function refreshDashboardWork(): void {
  if (views > 0) void read();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The work list, kept current while the calling component is mounted. */
export function useDashboardWork(): DashboardWorkState {
  const current = useSyncExternalStore(subscribe, () => state, () => EMPTY);
  useEffect(() => {
    views++;
    if (views === 1) {
      offSocket = socketHub().onMessage(onSocket);
      document.addEventListener("visibilitychange", onVisibility);
      void read();
    }
    return () => {
      views--;
      if (views > 0) return;
      offSocket?.();
      offSocket = null;
      document.removeEventListener("visibilitychange", onVisibility);
      owed = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      ctrl?.abort();
      ctrl = null;
      seq++;
    };
  }, []);
  return current;
}
