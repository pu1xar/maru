// The subagent cards of the timeline (web V2LifecycleRow SubagentCard, TimelineV2EventRow
// V2SubagentGroup): a bordered card with the provider's mark, the title, the live detail line, a
// status word and the time it ran; several together behind a group line that opens them.
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../ui/Text.tsx";
import { BotIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react-native";
import type { OrchestrationV2Notification, OrchestrationV2Subagent, OrchestrationV2TurnItem } from "@maru/shared";
import { formatSubagentDisplayTitle, subagentGroupSummary, summarizeSubagentStatuses } from "../../../../web/src/client-runtime/state/subagentDisplay.ts";
import { SUBAGENT_STATUS_LABEL, subagentDetailLine, subagentResumedSince } from "../../../../web/src/components/chat/V2LifecycleRow.logic.ts";
import { DEFAULT_TIMESTAMP_FORMAT, formatShortTimestamp } from "../../../../web/src/timestampFormat.ts";
import { tones } from "../../lib/timelineTones.ts";
import {
  isSubagentActive,
  subagentCardTexts,
  subagentDotRole,
  subagentElapsedText,
  subagentGroupTiming,
  withAlpha,
} from "../../lib/timelineView.ts";
import { usePalette, type Palette } from "../../theme.ts";
import { type } from "../../typography.ts";
import { Press } from "../Press.tsx";
import { ProviderIcon } from "../sidebar/ProviderIcon.tsx";
import { ROW_HIT_SLOP, useTimelineCtx } from "./TimelineContext.ts";
import { useNow } from "./useNow.ts";

export type SubagentItem = Extract<OrchestrationV2TurnItem, { type: "subagent" }>;

/** The provider's mark (Claude, Codex) in a 24 box, a chip glyph for another driver, and the status dot when given (web SubagentAvatar). */
function Avatar({ p, driver, status }: { p: Palette; driver: string | undefined; status?: OrchestrationV2TurnItem["status"] | undefined }) {
  const dot = status === undefined ? null : { info: p.info, ok: p.ok, danger: p.danger, muted: withAlpha(p.muted, 0.6) }[subagentDotRole(status)];
  return (
    <View style={styles.avatar}>
      {driver === "claude" || driver === "codex" ? (
        <ProviderIcon provider={driver} size={14} />
      ) : (
        <BotIcon size={14} color={p.muted} />
      )}
      {dot ? <View style={[styles.dot, { backgroundColor: dot }]} /> : null}
    </View>
  );
}

/** One line of text in a card: a path-like detail keeps both its ends. */
function DetailText({ detail, color }: { detail: string; color: string }) {
  const path = detail.includes("/") && !detail.includes(" ");
  return (
    <Text numberOfLines={1} ellipsizeMode={path ? "middle" : "tail"} style={[type.tiny, { color, lineHeight: 19 }]}>
      {detail}
    </Text>
  );
}

/**
 * A subagent: its provider mark and title, live detail or status, a status word while it is not done,
 * and the time it ran; tapping opens its transcript. `event` is a task notification's own outcome and
 * time in place of the live status and the elapsed time. The card keeps 8 above and below so it
 * stands apart from the text around it and from the next card.
 */
export function SubagentCard({ item, event }: { item: SubagentItem; event?: { status: OrchestrationV2TurnItem["status"] | null; label: string; timestamp: string } }) {
  const p = usePalette();
  const ctx = useTimelineCtx();
  const live = ctx.subagentsById.get(item.subagentId);
  const liveStatus = live?.status ?? item.status;
  const status = event ? event.status : liveStatus;
  const title = formatSubagentDisplayTitle(live?.title ?? item.title ?? "Subagent");
  const detail = subagentDetailLine({ status: status ?? liveStatus, result: live?.result ?? item.result, progress: live?.progress ?? item.progress });
  const childThreadId = live?.childThreadId ?? item.childThreadId;
  const statusLabel = event?.label ?? SUBAGENT_STATUS_LABEL[liveStatus];
  const texts = subagentCardTexts({ statusLabel, detail, status: status ?? liveStatus });
  const failed = status === "failed";
  const wordShown = detail !== null && (event !== undefined || status !== "completed");
  const now = useNow(isSubagentActive(liveStatus) ? 1000 : null);
  const elapsed = event ? event.timestamp : subagentElapsedText({ status: liveStatus, startedAt: live?.startedAt ?? item.startedAt, completedAt: live?.completedAt ?? item.completedAt }, now);
  const failedColor = tones(p).error;
  return (
    <Press
      onPress={childThreadId ? () => ctx.openThread(childThreadId) : undefined}
      hitSlop={ROW_HIT_SLOP}
      style={[styles.subagent, cardColors(p)]}
      accessibilityRole={childThreadId ? "button" : undefined}
      accessibilityLabel={`${title}, ${statusLabel}`}
    >
      <Avatar p={p} driver={live?.driver ?? item.driver} status={status ?? undefined} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={[type.small, { color: p.text, fontWeight: "500" }]}>{title}</Text>
        <DetailText detail={texts.sub} color={failed ? failedColor : p.muted} />
      </View>
      {wordShown ? <Text style={[type.small, { color: failed ? failedColor : p.muted }]}>{statusLabel}</Text> : null}
      {elapsed ? <Text style={[type.small, { color: p.muted, fontVariant: ["tabular-nums"] }]}>{elapsed}</Text> : null}
      {childThreadId ? <ChevronRightIcon size={14} color={withAlpha(p.muted, 0.6)} /> : null}
    </Press>
  );
}

const NOTIFICATION_OUTCOME_STATUS: Record<OrchestrationV2Notification["outcome"], OrchestrationV2TurnItem["status"] | null> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  updated: null,
  unknown: null,
};

const NOTIFICATION_OUTCOME_LABEL: Record<OrchestrationV2Notification["outcome"], string> = {
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  updated: "Updated",
  unknown: "Done",
};

/** The subagent a task notification names (web SubagentNotificationLink): by task ids when it has them, else by the child thread. */
export function notifiedSubagent(
  subagents: ReadonlyMap<string, OrchestrationV2Subagent>,
  childThreadId: string,
  taskIds: ReadonlyArray<string> | undefined,
): OrchestrationV2Subagent | null {
  return [...subagents.values()].find((c) => (taskIds === undefined ? c.childThreadId === childThreadId : taskIds.includes(c.id))) ?? null;
}

/** A task notification of a known subagent: that subagent's card with the notification's outcome and time in place of its live status and elapsed time, unless the subagent has run again since. */
export function SubagentNotificationCard({ agent, childThreadId, outcome, createdAt }: { agent: OrchestrationV2Subagent; childThreadId: string; outcome: OrchestrationV2Notification["outcome"]; createdAt: string }) {
  const resumed = NOTIFICATION_OUTCOME_STATUS[outcome] !== null && subagentResumedSince(agent, createdAt);
  const item = {
    type: "subagent",
    id: `notification:${agent.id}`,
    subagentId: agent.id,
    driver: agent.driver,
    title: agent.title,
    prompt: agent.prompt,
    status: agent.status,
    result: agent.result,
    progress: agent.progress,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
    childThreadId,
  } as unknown as SubagentItem;
  return (
    <SubagentCard
      item={item}
      {...(resumed ? {} : { event: { status: NOTIFICATION_OUTCOME_STATUS[outcome], label: NOTIFICATION_OUTCOME_LABEL[outcome], timestamp: formatShortTimestamp(createdAt, DEFAULT_TIMESTAMP_FORMAT) } })}
    />
  );
}

/** Several subagents of one turn behind one line: up to three marks, the count, their statuses and the span they ran (web V2SubagentGroup). */
export function SubagentGroup({ members }: { members: SubagentItem[] }) {
  const p = usePalette();
  const ctx = useTimelineCtx();
  const [open, setOpen] = useState(false);
  const agents = members.map((item) => {
    const live = ctx.subagentsById.get(item.subagentId);
    return { item, status: live?.status ?? item.status, startedAt: live?.startedAt ?? item.startedAt, completedAt: live?.completedAt ?? item.completedAt };
  });
  const summary = subagentGroupSummary(agents);
  const statusLine = summarizeSubagentStatuses(agents.map((a) => a.status));
  const timing = subagentGroupTiming(agents);
  const now = useNow(summary.active ? 1000 : null);
  const elapsed = subagentElapsedText(timing, now);
  const headColor = open || summary.active ? p.text : p.muted;
  const failedColor = tones(p).error;
  return (
    <View>
      <Press onPress={() => setOpen((o) => !o)} hitSlop={ROW_HIT_SLOP} style={[styles.subagent, cardColors(p)]} accessibilityRole="button" accessibilityLabel={summary.label} accessibilityState={{ expanded: open }}>
        <View style={styles.marks}>
          {agents.slice(0, 3).map(({ item }, i) => (
            <View key={item.id} style={i === 0 ? undefined : { marginLeft: -6 }}>
              <Avatar p={p} driver={item.driver} />
            </View>
          ))}
          {agents.length > 3 ? (
            <View style={[styles.more, { marginLeft: -6, backgroundColor: tones(p).muted }]}>
              <Text style={[type.tiny, { color: p.muted, fontWeight: "500" }]}>{`+${agents.length - 3}`}</Text>
            </View>
          ) : null}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[type.small, { color: headColor, fontWeight: "600" }]}>{`${members.length} subagent${members.length === 1 ? "" : "s"}`}</Text>
          <Text numberOfLines={1} style={[type.tiny, { color: summary.active ? p.info : summary.failed ? failedColor : p.muted }]}>{statusLine}</Text>
        </View>
        {elapsed ? <Text style={[type.small, { color: p.muted, fontVariant: ["tabular-nums"] }]}>{elapsed}</Text> : null}
        <ChevronDownIcon size={14} color={p.muted} style={open ? { transform: [{ rotate: "180deg" }] } : undefined} />
      </Press>
      {open ? (
        <View style={styles.groupMembers}>
          {members.map((m) => (
            <SubagentCard key={m.id} item={m} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The subagent card's colors, as the web's SUBAGENT_CARD tints of the text color. */
function cardColors(p: { text: string }) {
  return { borderColor: withAlpha(p.text, 0.15), backgroundColor: withAlpha(p.text, 0.08) };
}

const styles = StyleSheet.create({
  avatar: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  dot: { position: "absolute", right: -1, bottom: -1, width: 8, height: 8, borderRadius: 4 },
  // The subagent card (the web's SUBAGENT_CARD): one subagent's row and a group's header both draw it.
  subagent: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8, marginVertical: 8 },
  marks: { flexDirection: "row", alignItems: "center" },
  more: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  // Each member is a bordered card already; the indent says they belong to the group.
  groupMembers: { marginTop: -4, paddingLeft: 16 },
});
