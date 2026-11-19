// A session's subagents and workflows (GET /api/session-agents), read again every few seconds
// while a view shows them, so a running agent's state and time stay current. One reader per
// session key serves every view of it (the conversation header, the 작업 tab, the terminal view).
// - A view that shows the rows asks for the full list; while none does, only the running count is
//   read (GET /api/session-agents/count): the full list of a big session is half a MB.
// - After the 작업 tab stops or resumes one (DESIGN.md 6i), refreshSessionAgents reads at once, and
//   while a row says its stop is on its way the list is read more often until it settles.
import type { SessionAgentsCount, SessionAgentsResponse, SessionAgentView } from "@maru/shared";
import { useEffect, useSyncExternalStore } from "react";

import { isOrchestrationV2WorkActive } from "~/t3-shared/contracts";

/** How often the list or count is read while shown. A refresh interval, not a limit on what is listed. */
const REFRESH_MS = 3000;
/** The interval while a stop is on its way: the CLI writes the stop within a few hundred ms. */
const SETTLING_REFRESH_MS = 500;

export interface SessionAgentsState {
  /** The rows of the last full read (empty before one). */
  agents: readonly SessionAgentView[];
  error: string | null;
  /** A full read of this session's rows has arrived. */
  loaded: boolean;
  /** Running rows, from the last full read or, while no view asks for the list, the count. */
  running: number;
}

const EMPTY: SessionAgentsState = { agents: [], error: null, loaded: false, running: 0 };

interface Reader {
  state: SessionAgentsState;
  listeners: Set<() => void>;
  subscribe: (onChange: () => void) => () => void;
  /** Mounted hooks, and those of them that show the rows. */
  views: number;
  fullViews: number;
  timer: ReturnType<typeof setTimeout> | null;
  ctrl: AbortController | null;
  /** Bumps on every read, so a reply that a newer read overtook is dropped. */
  seq: number;
}

const readers = new Map<string, Reader>();

function readerOf(key: string): Reader {
  let r = readers.get(key);
  if (!r) {
    const listeners = new Set<() => void>();
    const subscribe = (onChange: () => void) => {
      listeners.add(onChange);
      return () => void listeners.delete(onChange);
    };
    r = { state: EMPTY, listeners, subscribe, views: 0, fullViews: 0, timer: null, ctrl: null, seq: 0 };
    readers.set(key, r);
  }
  return r;
}

function publish(r: Reader, next: SessionAgentsState): void {
  r.state = next;
  for (const l of r.listeners) l();
}

function errorText(body: { error?: string } | null, status: number): string {
  return body?.error ?? `HTTP ${status}`;
}

async function read(key: string, r: Reader): Promise<void> {
  if (r.timer !== null) clearTimeout(r.timer);
  r.timer = null;
  r.ctrl?.abort();
  const ctrl = new AbortController();
  r.ctrl = ctrl;
  const seq = ++r.seq;
  const full = r.fullViews > 0;
  let delay = REFRESH_MS;
  try {
    const q = new URLSearchParams({ key });
    const res = await fetch(full ? `/api/session-agents?${q}` : `/api/session-agents/count?${q}`, { signal: ctrl.signal });
    const body = (await res.json().catch(() => null)) as (Partial<SessionAgentsResponse & SessionAgentsCount> & { error?: string }) | null;
    if (seq !== r.seq) return;
    if (!res.ok) {
      publish(r, { ...r.state, error: errorText(body, res.status) });
    } else if (full) {
      const agents = body?.agents ?? [];
      // A warning (the Codex terminals could not be read) shows as the error line beside the rows that did come.
      publish(r, { agents, error: body?.warnings?.[0] ?? null, loaded: true, running: agents.filter((a) => isOrchestrationV2WorkActive(a.status)).length });
      if (agents.some((a) => a.settling === "stopping")) delay = SETTLING_REFRESH_MS;
    } else {
      publish(r, { ...r.state, error: null, running: body?.running ?? 0 });
    }
  } catch (err) {
    if (ctrl.signal.aborted || seq !== r.seq) return;
    publish(r, { ...r.state, error: err instanceof Error ? err.message : String(err) });
  }
  if (seq === r.seq && r.views > 0) r.timer = setTimeout(() => void read(key, r), delay);
}

function stop(r: Reader): void {
  if (r.timer !== null) clearTimeout(r.timer);
  r.timer = null;
  r.ctrl?.abort();
  r.ctrl = null;
  r.seq++;
}

/** Reads the session's rows (or count) again now, for every view of it. */
export function refreshSessionAgents(sessionKey: string): void {
  const r = readers.get(sessionKey);
  if (r && r.views > 0) void read(sessionKey, r);
}

/**
 * The session's subagents and workflows. `full`: this view shows the rows, so the list is read
 * while it is mounted; otherwise only `running` stays current (unless another view shows them).
 */
export function useSessionAgents(sessionKey: string, full: boolean): SessionAgentsState {
  const r = readerOf(sessionKey);
  const state = useSyncExternalStore(r.subscribe, () => r.state, () => EMPTY);

  useEffect(() => {
    const reader = readerOf(sessionKey);
    reader.views++;
    if (full) reader.fullViews++;
    // A view that needs the list reads at once; so does the first view of the session.
    if (full ? reader.fullViews === 1 || !reader.state.loaded : reader.views === 1) void read(sessionKey, reader);
    return () => {
      reader.views--;
      if (full) reader.fullViews--;
      if (reader.views === 0) {
        stop(reader);
        // The rows stay for the next view of the session; nothing reads them meanwhile.
      }
    };
  }, [sessionKey, full]);

  return state;
}
