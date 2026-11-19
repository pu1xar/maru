// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/TimelineV2EventRow.tsx
// Local changes: live subagent records come from the snapshot through the row context instead of
// an environment atom. Secret and link request cards are gone (we never produce those items).
// A settled group dims by color, not opacity. UI text is Korean.
import { ChevronDownIcon } from "lucide-react";
import { memo, use, useState } from "react";

import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";
import {
  subagentGroupSummary,
  summarizeSubagentStatuses,
} from "../../client-runtime/state/subagentDisplay.ts";
import { subagentGroupTiming } from "./TimelineV2EventRow.logic";
import { SUBAGENT_CARD, SUBAGENT_CARD_PRESSABLE, SubagentAvatar, SubagentElapsed, V2LifecycleRow } from "./V2LifecycleRow";
import { WorkLogBlock } from "./WorkLog";
import { plural } from "../../lib/plural.ts";

export function V2EventTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "event" }> }) {
  const ctx = use(TimelineRowCtx);
  const { item } = row.projectedItem;
  if (item.type === "subagent" && (row.subagents?.length ?? 1) > 1) {
    return <V2SubagentGroup key={row.id} row={row} />;
  }
  return <V2LifecycleRow item={item} onOpenThread={ctx.onOpenThread} />;
}

const V2SubagentGroup = memo(function V2SubagentGroup({
  row,
}: {
  row: Extract<TimelineRow, { kind: "event" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const groupId = `subagent-group:${row.id}`;
  const [expanded, setExpanded] = useState(() =>
    ctx.workGroupViewState.expandedEntries.has(groupId),
  );
  const members = (row.subagents ?? [row.projectedItem]).flatMap(({ item }) =>
    item.type === "subagent" ? [item] : [],
  );
  const agents = members.map((item) => {
    const live = ctx.subagentsById.get(item.subagentId);
    return {
      item,
      status: live?.status ?? item.status,
      startedAt: live?.startedAt ?? item.startedAt,
      completedAt: live?.completedAt ?? item.completedAt,
    };
  });
  const summary = subagentGroupSummary(agents);
  const label = plural(members.length, "subagent");
  const statusSummary = summarizeSubagentStatuses(agents.map(({ status }) => status));
  const toggleExpanded = (open: boolean) => {
    ctx.onToggleWorkEntry(row.id, expanded);
    if (open) ctx.workGroupViewState.expandedEntries.add(groupId);
    else ctx.workGroupViewState.expandedEntries.delete(groupId);
    setExpanded(open);
  };
  return (
    <WorkLogBlock continues={row.continuesWorkLog}>
      <Collapsible open={expanded} onOpenChange={toggleExpanded} data-subagent-group>
        {/* The subagent card (SUBAGENT_CARD), so a group reads as one of its members and its time
            lines up with theirs. Dims by color: T3's opacity-55 left this text at 3.0:1 on black. */}
        <CollapsibleTrigger
          aria-label={summary.label}
          aria-description={statusSummary}
          className={cn(
            SUBAGENT_CARD,
            SUBAGENT_CARD_PRESSABLE,
            expanded || summary.active ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <span className="flex shrink-0 items-center -space-x-1.5" aria-hidden>
            {agents.slice(0, 3).map(({ item, status }) => (
              <SubagentAvatar
                key={item.id}
                driver={item.driver}
                status={agents.length === 1 ? status : undefined}
              />
            ))}
            {agents.length > 3 ? (
              <span className="relative inline-flex size-6 items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground">
                +{agents.length - 3}
              </span>
            ) : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold">{label}</span>
            <span
              className={cn(
                "block truncate text-3xs text-muted-foreground",
                summary.active ? "text-info-foreground" : summary.failed && "text-destructive-foreground",
              )}
            >
              {statusSummary}
            </span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            <SubagentElapsed agent={subagentGroupTiming(agents)} />
          </span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </CollapsibleTrigger>
        {/* Virtualized rows must settle before disclosure scroll anchoring resumes. */}
        <CollapsiblePanel animate={false}>
          {expanded ? (
            // Each member is a bordered card already; the indent says they belong to the group.
            <div className="-mt-1 pl-4">
              {members.map((item) => (
                <V2LifecycleRow key={item.id} item={item} onOpenThread={ctx.onOpenThread} />
              ))}
            </div>
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
    </WorkLogBlock>
  );
});
