// The output of a background shell command or Monitor, shown under its row in the 작업 tab
// (GET /api/session-agents/output, DESIGN.md 6i). Read only while the row is unfolded: once when
// it opens, then every OUTPUT_REFRESH_MS while the task runs and the page is visible, and once
// more when the task ends (its last lines).
import type { SessionTaskOutput } from "@maru/shared";
import { useEffect, useState } from "react";

/** How often a running task's output is read again while its row is unfolded. A refresh interval, not a limit. */
export const OUTPUT_REFRESH_MS = 2000;

/**
 * When to read again after a read: the interval while the task runs and the page shows, null
 * otherwise (an ended task's output no longer changes; a hidden page reads again when it shows).
 */
export function nextOutputRead(running: boolean, hidden: boolean): number | null {
  return running && !hidden ? OUTPUT_REFRESH_MS : null;
}

/** The size note above a cut output ("끝 64.0KB만 보임, 전체 1.2MB"), or null when it holds everything. */
export function truncationNote(out: Pick<SessionTaskOutput, "truncated" | "totalBytes">, shownBytes: number): string | null {
  return out.truncated ? `Showing only the last ${formatBytes(shownBytes)} of ${formatBytes(out.totalBytes)}` : null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export interface TaskOutputState {
  out: SessionTaskOutput | null;
  error: string | null;
  /** The first read of this row has come back (with an output or an error). */
  loaded: boolean;
}

async function readOutput(key: string, kind: string, id: string, signal: AbortSignal): Promise<SessionTaskOutput> {
  const q = new URLSearchParams({ key, kind, id });
  const res = await fetch(`/api/session-agents/output?${q}`, { signal });
  const body = (await res.json().catch(() => null)) as (Partial<SessionTaskOutput> & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return { output: body?.output ?? "", totalBytes: body?.totalBytes ?? 0, truncated: body?.truncated === true };
}

/**
 * The task's output while `enabled` (its row is unfolded). `running` follows the row's state: a
 * change from running to ended reads once more.
 */
export function useTaskOutput(sessionKey: string, kind: string, id: string, enabled: boolean, running: boolean): TaskOutputState {
  const [state, setState] = useState<TaskOutputState>({ out: null, error: null, loaded: false });
  // A task row's own reads: the effect restarts when the row's state changes or the page is shown again.
  const [shown, setShown] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const onVisibility = () => setShown(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ctrl = new AbortController();
    const tick = async () => {
      try {
        const out = await readOutput(sessionKey, kind, id, ctrl.signal);
        if (!ctrl.signal.aborted) setState({ out, error: null, loaded: true });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setState((prev) => ({ ...prev, error: err instanceof Error ? err.message : String(err), loaded: true }));
      }
      const delay = nextOutputRead(running, !shown);
      if (delay !== null && !ctrl.signal.aborted) timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      ctrl.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [sessionKey, kind, id, enabled, running, shown]);

  return state;
}
