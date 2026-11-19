// The open thread's rows (lib/timeline.ts) with what the reader changed. Closed turn folds and opened
// groups belong to the thread: switching threads starts from the defaults (finished turns show their
// work), as on the web.
import { useCallback, useMemo, useRef, useState } from "react";
import type { ThreadSnapshot } from "@maru/shared";
import { CLOSED, timelineRows, toggled, type TimelineDisclosure, type TimelineMemo, type TimelineResult } from "./timeline.ts";

export interface TimelineView {
  rows: TimelineResult["rows"];
  isWorking: boolean;
  latestRunId: string | null;
  toggleRun: (runId: string) => void;
  toggleGroup: (groupId: string) => void;
  toggleAttempt: (attemptId: string) => void;
  /** Opens a finished turn's fold the reader closed (a no-op when open); the conversation find opens the one that hides its entry. */
  openRun: (runId: string) => void;
  /** The fold that hides entry `entryId`, if any (lib/timeline.ts foldRunIdOf). */
  foldRunIdOf: (entryId: string) => string | undefined;
}

export function useTimeline(snapshot: ThreadSnapshot | null): TimelineView | null {
  const threadId = snapshot?.threadId ?? null;
  const [state, setState] = useState<{ threadId: string | null; open: TimelineDisclosure }>({ threadId, open: CLOSED });
  const open = state.threadId === threadId ? state.open : CLOSED;
  if (state.threadId !== threadId) setState({ threadId, open: CLOSED });

  const memo = useRef<TimelineMemo | null>(null);
  const result = useMemo(() => {
    if (!snapshot) return null;
    const r = timelineRows(snapshot, open, memo.current);
    memo.current = r.memo;
    return r;
  }, [snapshot, open]);

  const latest = result?.latestRun ?? null;

  const change = useCallback(
    (fn: (o: TimelineDisclosure) => TimelineDisclosure) =>
      setState((s) => ({ threadId: s.threadId, open: fn(s.threadId === threadId ? s.open : CLOSED) })),
    [threadId],
  );
  const toggleRun = useCallback((id: string) => change((o) => ({ ...o, collapsedRunIds: toggled(o.collapsedRunIds, id) })), [change]);
  const toggleGroup = useCallback(
    (id: string) => change((o) => ({ ...o, expandedWorkGroupIds: toggled(o.expandedWorkGroupIds, id) })),
    [change],
  );
  const toggleAttempt = useCallback(
    (id: string) => change((o) => ({ ...o, expandedAttemptIds: toggled(o.expandedAttemptIds, id) })),
    [change],
  );

  const openRun = useCallback(
    (id: string) => change((o) => (o.collapsedRunIds.has(id) ? { ...o, collapsedRunIds: new Set([...o.collapsedRunIds].filter((r) => r !== id)) } : o)),
    [change],
  );

  if (!result) return null;
  return {
    rows: result.rows,
    isWorking: result.isWorking,
    latestRunId: latest?.runId ?? null,
    toggleRun,
    toggleGroup,
    toggleAttempt,
    openRun,
    foldRunIdOf: result.foldRunIdOf,
  };
}
