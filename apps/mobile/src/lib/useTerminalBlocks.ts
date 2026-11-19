// The open thread's terminal blocks (the web's TerminalTimeline: useIncrementalTimelineEntries and
// terminalBlocks). The entries come from the same projection as the chat timeline; the blocks are the
// CLI's drawing of them (web terminalModel.ts). The reader's choices, which collapsed groups are open
// and whether the history before a compaction shows, belong to the thread.
import { useCallback, useMemo, useRef, useState } from "react";
import type { ThreadSnapshot } from "@maru/shared";
import {
  deriveThreadTimelineRunState,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntriesProjection,
} from "../../../web/src/session-logic.ts";
import { terminalBlocks, type TermBlock } from "../../../web/src/components/terminal/terminalModel.ts";

const NO_OPTIMISTIC_MESSAGES: never[] = [];

export interface TerminalBlocksView {
  blocks: TermBlock[];
  /** Rewind target source: a user block's entry id to the item it came from (lib/messageActions.ts messageTarget). */
  userItems: ReadonlyMap<string, unknown>;
  run: ReturnType<typeof deriveThreadTimelineRunState>;
  openGroup: (id: string) => void;
  showEarlier: () => void;
  beforeCompaction: boolean;
}

export function useTerminalBlocks(
  snapshot: ThreadSnapshot,
  o: { cwd: string | undefined; columns: number; verbose: boolean; agentName: string },
): TerminalBlocksView {
  const threadId = snapshot.threadId;
  const [open, setOpen] = useState<{ threadId: string; groups: ReadonlySet<string>; earlier: boolean }>({ threadId, groups: new Set(), earlier: false });
  const current = open.threadId === threadId ? open : { threadId, groups: new Set<string>(), earlier: false };
  if (open.threadId !== threadId) setOpen(current);

  const memo = useRef<{ threadId: string; entries: TimelineEntriesProjection } | null>(null);
  const entries = useMemo(() => {
    const previous = memo.current?.threadId === threadId ? memo.current.entries : null;
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState({ visibleTurnItems: snapshot.visibleTurnItems, optimisticMessages: NO_OPTIMISTIC_MESSAGES }, previous);
    memo.current = { threadId, entries: next };
    return next.entries;
  }, [snapshot.visibleTurnItems, threadId]);
  const run = useMemo(() => deriveThreadTimelineRunState(snapshot), [snapshot]);

  // Plan entries carry no status; the items do (an answered or a rejected ExitPlanMode).
  const items = useMemo(
    () => new Map(snapshot.visibleTurnItems.filter((row) => row.item.type === "proposed_plan").map((row) => [row.item.id, row.item])),
    [snapshot.visibleTurnItems],
  );
  const blocks = useMemo(
    () =>
      terminalBlocks(entries, {
        cwd: o.cwd,
        columns: o.columns,
        verbose: o.verbose,
        openGroups: current.groups,
        subagents: snapshot.subagents,
        model: snapshot.state.model ?? null,
        beforeCompaction: current.earlier,
        agentName: o.agentName,
        items,
      }),
    [entries, o.cwd, o.columns, o.verbose, current.groups, snapshot.subagents, snapshot.state.model, current.earlier, o.agentName, items],
  );
  const userItems = useMemo(() => {
    const map = new Map<string, unknown>();
    for (const e of entries) if (e.kind === "message" && e.message.role === "user") map.set(e.id, e.projectedItem?.item);
    return map;
  }, [entries]);

  const openGroup = useCallback(
    (id: string) => setOpen((s) => (s.threadId === threadId ? { ...s, groups: new Set(s.groups).add(id) } : s)),
    [threadId],
  );
  const showEarlier = useCallback(() => setOpen((s) => (s.threadId === threadId ? { ...s, earlier: true } : s)), [threadId]);
  return { blocks, userItems, run, openGroup, showEarlier, beforeCompaction: current.earlier };
}
