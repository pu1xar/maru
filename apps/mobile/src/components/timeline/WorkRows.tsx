// The work log rows: tool calls and thoughts as one-line rows that open, tool groups behind a
// summary row, the live activity row of a running turn, and the working and thinking rows. Which
// rows exist, what they say and which icon they carry is the web's (MessagesTimeline.logic.ts,
// TimelineWorkEntryRow.logic.ts); this file draws them for a phone with the web's sizes and
// colors (WorkLog.tsx, TimelineWorkEntryRow.tsx, TimelineWorkGroupRows.tsx, V2ItemInspector.tsx).
import { createContext, memo, useContext, useMemo, useState, type ReactNode, createElement } from "react";
import { Linking, ScrollView, StyleSheet, useColorScheme, View } from "react-native";
import { Text } from "../ui/Text.tsx";
import { BrainIcon, ChevronRightIcon, CircleAlertIcon, ExternalLinkIcon, Minimize2Icon } from "lucide-react-native";
import { type IconComponent } from "../ui/AppIcons.tsx";
import { liveThoughtLine } from "../../../../web/src/client-runtime/work-log/presentation.ts";
import {
  getQuestionAnswerPreview,
  getQuestionAnswerText,
  getQuestionTextPreview,
  hasQuestionAnswer,
} from "../../../../web/src/client-runtime/work-log/userInput.ts";
import { workEntryDisplayIndicatesToolFailure, workEntrySignalsSevereFailure, workLogEntryIsToolLike } from "../../../../web/src/session-logic.ts";
import { liveWorkEntryLabel, workEntryDisplayLabel, workEntryIsVisibleInGroup } from "../../../../web/src/components/chat/MessagesTimeline.logic.ts";
import {
  THOUGHT_PREVIEW_SOURCE_MAX_LENGTH,
  thoughtPreviewText,
  toolGroupSummaryIconName,
  workEntryIconName,
} from "../../../../web/src/components/chat/TimelineWorkEntryRow.logic.ts";
import { formatWorkingTimerNow } from "../../../../web/src/components/chat/TimelineWorkGroupRows.logic.ts";
import type { MessagesTimelineRow, TimelineWorkEntry } from "../../lib/timeline.ts";
import { workEntryCanOpen, workEntryDetail, type DetailBlock } from "../../lib/timelineDetail.ts";
import { tones } from "../../lib/timelineTones.ts";
import { diffDisplayRows, diffLineTint, failedToolIconColor, groupEntryOpacity, GROUP_INDENT, messageTimeLabel, withAlpha } from "../../lib/timelineView.ts";
import { type } from "../../typography.ts";
import { useAppearance } from "../../appearance.tsx";
import { fonts, usePalette, type Palette } from "../../theme.ts";
import { Markdown } from "../Markdown.tsx";
import { Press } from "../Press.tsx";
import { Shine } from "./Shine.tsx";
import { notifiedSubagent, SubagentNotificationCard } from "./SubagentRows.tsx";
import { ROW_HIT_SLOP, TOOL_ICON, useTimelineCtx } from "./TimelineContext.ts";
import { useNow } from "./useNow.ts";

type Row<K extends MessagesTimelineRow["kind"]> = Extract<MessagesTimelineRow, { kind: K }>;

/**
 * True inside an opened tool group: its rows sit one level under the group's summary line, so they
 * are indented, one size step smaller and dimmer until opened (web WorkLog GroupedRows).
 */
const NestedCtx = createContext(false);

/** A nested row is 24 tall, so it takes a wider slop to keep the 44dp touch (DESIGN.md 7, app touch targets). */
const NESTED_HIT_SLOP = { top: 10, bottom: 10 } as const;

/** A run of work entries: each one a row, or the opened group's entries one level under its summary line. */
export const WorkSection = memo(function WorkSection({ row }: { row: Row<"work"> }) {
  const entries = row.groupedEntries.filter((e) => workEntryIsVisibleInGroup(e, row.isExpandedToolGroup));
  if (entries.length === 0) return null;
  if (row.isExpandedToolGroup) {
    // A group of thoughts only reads as their text (web ReasoningTraceContent), outside the nested list.
    if (entries.every((e) => e.itemType === "reasoning")) return <ReasoningDetails texts={entries.map((e) => e.detail ?? "")} indent={GROUP_INDENT} />;
    return (
      <NestedCtx.Provider value>
        <View style={{ paddingLeft: GROUP_INDENT }}>
          {entries.map((e) => (
            <EntryRow key={e.id} entry={e} />
          ))}
        </View>
      </NestedCtx.Provider>
    );
  }
  return (
    <View>
      {entries.map((e) => (
        <EntryRow key={e.id} entry={e} displayLabel={row.displayLabel} />
      ))}
    </View>
  );
});

/** The icon's box and the label's type: a nested row is one step smaller (web size-3.5 in w-4.5, text-xs). */
function rowMetrics(nested: boolean) {
  return nested
    ? { icon: 14, slot: 18, text: type.small, detailIndent: 22 }
    : { icon: 16, slot: 24, text: type.row, detailIndent: 28 };
}

function RowIcon({ name, color, nested, opacity }: { name: IconComponent; color: string; nested: boolean; opacity?: number }) {
  const m = rowMetrics(nested);
  return (
    <View style={{ width: m.slot, alignItems: "center" }}>
      {createElement(name, { size: m.icon, color, ...(opacity === undefined ? {} : { style: { opacity } }) })}
    </View>
  );
}

/** The icon color of a row's tone (web workToneIcon): tools and thoughts are the muted icon, an error or a plain step the foreground at 92%. */
function toneIconColor(p: Palette, tone: TimelineWorkEntry["tone"]): string {
  return tone === "tool" || tone === "thinking" || tone === "info" ? p.muted : withAlpha(p.text, 0.92);
}

/** A thought's text, opened (web ReasoningTraceContent in WorkLogDetails): markdown at the foreground, scrolling past 24rem. */
function ReasoningDetails({ texts, indent }: { texts: string[]; indent: number }) {
  const p = usePalette();
  const ctx = useTimelineCtx();
  return (
    <ScrollView nestedScrollEnabled style={{ maxHeight: 384, marginLeft: indent }} contentContainerStyle={styles.reasoning}>
      {texts.map((t, i) => (
        <Markdown key={i} text={t} color={p.text} cwd={ctx.workspaceRoot} />
      ))}
    </ScrollView>
  );
}

/** One tool call, thought or notice (web WorkEntryLogRow). Tapping opens what it carries. */
const EntryRow = memo(function EntryRow({ entry, displayLabel }: { entry: TimelineWorkEntry; displayLabel?: string | undefined }) {
  const p = usePalette();
  const ctx = useTimelineCtx();
  const nested = useContext(NestedCtx);
  const scheme = useColorScheme();
  const m = rowMetrics(nested);
  const [open, setOpen] = useState(false);
  const item = entry.projectedItem?.item;
  const t = tones(p);
  // A task notification that names a subagent the thread knows is that subagent's card (web SimpleWorkEntryRow).
  const source = item?.type === "notification" ? item.source : null;
  const childThreadId = source && (source.kind === "subagent" || source.kind === "delegated_task") ? source.childThreadId : undefined;
  if (item?.type === "notification" && source && childThreadId !== undefined) {
    const agent = notifiedSubagent(ctx.subagentsById, childThreadId, source.kind === "delegated_task" ? source.taskIds : undefined);
    if (agent) return <SubagentNotificationCard agent={agent} childThreadId={childThreadId} outcome={item.outcome} createdAt={entry.createdAt} />;
  }
  if (item?.type === "error" && item.status === "failed") {
    const warning = item.failure.class === "usage_limit";
    const resetAt = item.failure.resetAt ? new Date(item.failure.resetAt) : null;
    const label = warning
      ? `Usage limit reached${resetAt && !Number.isNaN(resetAt.getTime()) ? `. Try again after ${resetAt.toLocaleString("en-US")}` : ""}`
      : entry.label;
    const color = warning ? t.warning : t.error;
    const time = messageTimeLabel(entry.createdAt);
    return (
      <View>
        <View style={[styles.entryHead, nested ? styles.nestedHead : null, { alignItems: "flex-start" }]}>
          <RowIcon name={CircleAlertIcon} color={warning ? p.warn : p.danger} nested={nested} />
          <Text style={[styles.entryLabel, m.text, { color, fontWeight: "500" }]}>{label}</Text>
          {time ? <Text style={[type.small, { color: p.muted, fontVariant: ["tabular-nums"] }]}>{time}</Text> : null}
        </View>
        {!warning ? <Text style={[type.body, { color: withAlpha(p.text, 0.8), marginLeft: 28, paddingVertical: 4 }]} selectable>{item.failure.message}</Text> : null}
      </View>
    );
  }
  const warning = entry.sourceActivityKind === "runtime.warning";
  const failed = !warning && workEntryDisplayIndicatesToolFailure(entry);
  const severe = !warning && failed && (workEntrySignalsSevereFailure(entry) || !workLogEntryIsToolLike(entry));
  const icon: IconComponent = warning || severe ? CircleAlertIcon : TOOL_ICON[workEntryIconName(entry)];
  const isReasoning = entry.itemType === "reasoning";
  const questionHeading = entry.questionAnswer ? thoughtPreviewText(getQuestionTextPreview(entry.questionAnswer), "") : "";
  const previewText =
    isReasoning && open
      ? entry.toolLifecycleStatus === "inProgress" ? "Thinking" : "Thought"
      : questionHeading || (displayLabel ?? workEntryDisplayLabel(entry, ctx.workspaceRoot));
  const shown =
    isReasoning && !open
      ? thoughtPreviewText(entry.detail ?? previewText, entry.toolLifecycleStatus === "inProgress" ? "Thinking" : "Thought")
      : previewText;
  const answered = entry.questionAnswer !== undefined && hasQuestionAnswer(entry.questionAnswer);
  const answerPreview = entry.questionAnswer && answered ? thoughtPreviewText(getQuestionAnswerPreview(entry.questionAnswer), "") || null : null;
  const canOpen = workEntryCanOpen(entry, ctx.workspaceRoot, previewText);
  // A failed tool shows only in its icon (web tool-error-icon); a nested line recedes until opened.
  const iconColor = warning ? p.warn : severe ? p.danger : failed ? failedToolIconColor(p.danger) : toneIconColor(p, entry.tone);
  const labelColor = warning ? t.warning : severe ? t.error : workLogEntryIsToolLike(entry) ? p.muted : withAlpha(p.text, 0.8);
  const recedes = nested && !open;
  return (
    <View>
      <Press
        onPress={canOpen ? () => setOpen((o) => !o) : undefined}
        hitSlop={nested ? NESTED_HIT_SLOP : ROW_HIT_SLOP}
        style={[styles.entryHead, nested ? styles.nestedHead : null, recedes ? { opacity: groupEntryOpacity(scheme) } : null]}
        accessibilityRole={canOpen ? "button" : undefined}
        accessibilityLabel={failed ? `${shown}, tool call failed` : shown}
        accessibilityState={canOpen ? { expanded: open } : undefined}
      >
        <RowIcon name={icon} color={iconColor} nested={nested} opacity={warning || severe || failed ? 1 : 0.8} />
        <Text numberOfLines={1} style={[styles.entryLabel, m.text, { color: labelColor }, warning || severe ? { fontWeight: "500" } : null]}>
          {shown}
        </Text>
        {answerPreview ? (
          <Text numberOfLines={1} style={[styles.answerPreview, m.text, { color: !open && answered ? p.text : p.muted }]}>
            {answerPreview}
          </Text>
        ) : null}
        {canOpen ? (
          <View style={styles.chevron}>
            <ChevronRightIcon size={12} color={p.muted} style={{ opacity: 0.7, transform: [{ rotate: open ? "90deg" : "0deg" }] }} />
          </View>
        ) : null}
      </Press>
      {open && entry.questionAnswer ? <QuestionAnswerHistory p={p} answer={entry.questionAnswer} /> : null}
      {open && isReasoning && !entry.questionAnswer ? <ReasoningDetails texts={[entry.detail ?? ""]} indent={m.detailIndent} /> : null}
      {open && !isReasoning && !entry.questionAnswer ? <DetailBlocks p={p} blocks={workEntryDetail(entry, ctx.workspaceRoot, previewText)} /> : null}
    </View>
  );
});

function QuestionAnswerHistory({ p, answer }: { p: Palette; answer: NonNullable<TimelineWorkEntry["questionAnswer"]> }) {
  const ids = [...new Set([...Object.keys(answer.questionTextById ?? {}), ...Object.keys(answer.answers), ...Object.keys(answer.attachmentsByQuestionId)])];
  return (
    <View style={styles.questions}>
      {ids.map((id) => (
        <View key={id} style={{ gap: 4 }}>
          {answer.questionTextById?.[id] ? <Text style={[type.row, { color: p.muted }]} selectable>{answer.questionTextById[id]}</Text> : null}
          {getQuestionAnswerText(answer.answers[id]) ? (
            <Text style={[type.row, { color: p.muted, marginLeft: 12 }]} selectable>{getQuestionAnswerText(answer.answers[id])}</Text>
          ) : null}
          {(answer.attachmentsByQuestionId[id] ?? []).length > 0 ? (
            <View style={styles.answerFiles}>
              {(answer.attachmentsByQuestionId[id] ?? []).map((a) => (
                <Text key={a.id} style={[type.row, { color: p.muted }]}>{a.name}</Text>
              ))}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/** Monospace at the chat code size and the web's relaxed leading (V2ItemInspector monoClassName). */
const mono = { fontFamily: fonts.mono, fontSize: type.code.fontSize, lineHeight: 21 } as const;

/** Text in a box that scrolls past `maxHeight` (web max-h-80 and max-h-64 pre). */
function Scrolling({ maxHeight, children }: { maxHeight: number; children: ReactNode }) {
  return (
    <ScrollView nestedScrollEnabled style={{ maxHeight }}>
      {children}
    </ScrollView>
  );
}

/**
 * The sections an opened row shows (lib/timelineDetail.ts): the web's inspector in a panel under the
 * row, flush with the row's icon, in 13pt with the monospace text at the chat code size and no box
 * (only a diff has its own).
 */
export function DetailBlocks({ p, blocks }: { p: Palette; blocks: DetailBlock[] }) {
  if (blocks.length === 0) return null;
  return (
    <View style={styles.panel}>
      {blocks.map((b, i) => (
        <Block key={i} p={p} block={b} />
      ))}
    </View>
  );
}

function Block({ p, block }: { p: Palette; block: DetailBlock }) {
  const t = tones(p);
  const strong = withAlpha(p.text, 0.85);
  switch (block.kind) {
    case "command":
      return <Text style={[mono, { color: strong }]} selectable>{block.text}</Text>;
    case "args":
      return (
        <View>
          {block.items.map((it, i) => (
            <Text key={i} style={[mono, { color: strong }]} selectable>
              <Text style={{ color: p.muted }}>{`${it.key} `}</Text>
              {it.value}
            </Text>
          ))}
        </View>
      );
    case "output":
      return (
        <Scrolling maxHeight={320}>
          <Text style={[mono, { color: block.json ? strong : p.muted }]} selectable>{block.text}</Text>
        </Scrolling>
      );
    case "plain":
      return (
        <Scrolling maxHeight={256}>
          <Text style={[mono, { color: p.muted }]} selectable>{block.text}</Text>
        </Scrolling>
      );
    case "failure":
      return <Text style={[mono, { color: t.error }]}>{block.text}</Text>;
    case "path":
      return (
        <View style={styles.pathRow}>
          <Text style={[mono, { color: p.muted, flexShrink: 1 }]} selectable>{block.text}</Text>
          {block.counts ? (
            <Text style={[type.small, { color: p.text }]}>
              <Text style={{ color: t.success }}>{block.counts.add}</Text>
              {" "}
              <Text style={{ color: t.error }}>{block.counts.del}</Text>
            </Text>
          ) : null}
        </View>
      );
    case "changes":
      return (
        <View style={{ gap: 4 }}>
          {block.items.map((c, i) => (
            <Text key={i} style={[mono, { color: p.muted }]} selectable>{c}</Text>
          ))}
        </View>
      );
    case "diff":
      return <DiffView p={p} diff={block.text} />;
    case "markdown":
      return <Markdown text={block.text} color={p.text} />;
    case "files":
      return (
        <View style={{ gap: 4 }}>
          {block.items.map((it, i) => (
            <View key={i}>
              <Text style={[mono, { color: withAlpha(p.text, 0.8) }]} selectable>{it.label}</Text>
              {it.preview ? <Text style={[type.small, { color: p.muted, marginTop: 2 }]} selectable>{it.preview}</Text> : null}
            </View>
          ))}
        </View>
      );
    case "web":
      return (
        <View style={{ gap: 6 }}>
          {block.items.map((it, i) => (
            <View key={i}>
              {it.href ? (
                <Press onPress={() => void Linking.openURL(it.href!)} hitSlop={ROW_HIT_SLOP} accessibilityRole="link" style={styles.link}>
                  <Text style={[type.small, { color: p.text, fontWeight: "500", flexShrink: 1 }]}>{it.title}</Text>
                  <ExternalLinkIcon size={12} color={p.text} />
                </Press>
              ) : (
                <Text style={[type.small, { color: p.text, fontWeight: "500" }]} selectable>{it.title}</Text>
              )}
              {it.snippet ? <Text style={[type.small, { color: p.muted }]} selectable>{it.snippet}</Text> : null}
            </View>
          ))}
        </View>
      );
  }
}

/** A unified diff: old and new line numbers, a +/- column, added lines on a success wash and removed ones on an error wash (web DiffView). */
function DiffView({ p, diff }: { p: Palette; diff: string }) {
  const { rows, numberDigits } = useMemo(() => diffDisplayRows(diff), [diff]);
  const t = tones(p);
  // A monospace character is about 0.6 of its size wide; the column holds the digits and the 8 of padding (web: Nch + 0.5rem).
  const { env } = useAppearance();
  const cell = mono.fontSize * env.ui * env.code;
  const numberWidth = Math.round(numberDigits * cell * 0.6) + 8;
  return (
    // Tall diffs scroll inside their own box (web max-h-96) and wrap long lines, so the numbers stay by their lines.
    <ScrollView nestedScrollEnabled style={[styles.diff, { borderColor: withAlpha(p.border, 0.45), backgroundColor: withAlpha(t.muted, 0.15) }]}>
      {rows.map((row, i) =>
        row.kind === "note" ? (
          <Text key={i} style={[mono, styles.diffNote, { color: p.muted }]}>{row.text}</Text>
        ) : (
          <View key={i} style={[styles.diffLine, { backgroundColor: diffLineTint(row.type, p) }]}>
            <Text style={[mono, styles.diffNumber, { width: numberWidth, color: p.muted }]}>{row.oldNumber ?? ""}</Text>
            <Text style={[mono, styles.diffNumber, { width: numberWidth, color: p.muted }]}>{row.newNumber ?? ""}</Text>
            <Text style={[mono, { width: Math.round(cell * 0.6 * 3), textAlign: "center", color: row.type === "add" ? t.success : row.type === "del" ? t.error : p.muted }]}>
              {row.type === "add" ? "+" : row.type === "del" ? "-" : " "}
            </Text>
            <Text style={[mono, { flex: 1, paddingRight: 8, color: withAlpha(p.text, 0.85) }]} selectable>{row.text}</Text>
          </View>
        ),
      )}
    </ScrollView>
  );
}

/** A collapsed tool group: its summary and the count it hides; tapping opens the group. */
export const WorkToggleRow = memo(function WorkToggleRow({ row }: { row: Row<"work-toggle"> }) {
  const p = usePalette();
  const ctx = useTimelineCtx();
  return (
    <Press
      onPress={() => ctx.toggleGroup(row.groupId)}
      hitSlop={ROW_HIT_SLOP}
      style={styles.entryHead}
      accessibilityRole="button"
      accessibilityLabel={row.hasFailure ? `${row.summary}, tool call failed` : row.summary}
      accessibilityState={{ expanded: row.expanded }}
    >
      <RowIcon name={TOOL_ICON[toolGroupSummaryIconName(row.summaryKind)]} color={row.hasFailure ? failedToolIconColor(p.danger) : p.muted} nested={false} opacity={row.hasFailure ? 1 : 0.8} />
      <Text numberOfLines={1} style={[styles.entryLabel, type.row, { color: p.muted }]}>{row.summary}</Text>
    </Press>
  );
});

/** The running turn's latest activity, with its latest thought above it (web LiveWorkEntryTimelineRow). */
export const LiveWorkRow = memo(function LiveWorkRow({ row }: { row: Row<"work-live"> }) {
  const p = usePalette();
  const ctx = useTimelineCtx();
  const label = liveWorkEntryLabel(row.entry, ctx.workspaceRoot, row.active);
  const failed = workEntryDisplayIndicatesToolFailure(row.entry);
  const thoughtLine = row.thought && !row.expanded ? liveThoughtLine((row.thought.detail ?? "").slice(0, THOUGHT_PREVIEW_SOURCE_MAX_LENGTH)) : "";
  const thoughtIsStatus = thoughtLine !== "" && row.entry === row.thought;
  const text = thoughtIsStatus
    ? row.active ? "Thinking" : "Thought"
    : row.entry.itemType === "reasoning"
      ? thoughtPreviewText(row.entry.detail ?? label, row.active ? "Thinking" : "Thought")
      : label;
  return (
    <Press onPress={() => ctx.toggleGroup(row.groupId)} hitSlop={ROW_HIT_SLOP} accessibilityRole="button" accessibilityState={{ expanded: row.expanded }}>
      {thoughtLine ? (
        <View style={[styles.entryHead, { alignItems: "flex-start" }]}>
          <RowIcon name={BrainIcon} color={p.muted} nested={false} opacity={0.8} />
          <Text numberOfLines={4} style={[styles.entryLabel, type.row, { color: p.muted }]}>{thoughtPreviewText(thoughtLine, "Thought")}</Text>
        </View>
      ) : null}
      <View style={styles.entryHead}>
        <RowIcon name={TOOL_ICON[workEntryIconName(row.entry)]} color={failed ? failedToolIconColor(p.danger) : p.muted} nested={false} opacity={failed ? 1 : 0.8} />
        <Shine active={row.active && !failed} style={{ flex: 1 }}>
          <Text numberOfLines={1} style={[type.row, { color: p.muted }]}>{text}</Text>
        </Shine>
      </View>
    </Press>
  );
});

/** "Thinking" while the turn has nothing newer to show; opens the failed group it stands for. */
export const ThinkingRow = memo(function ThinkingRow({ row }: { row: Row<"thinking"> }) {
  const p = usePalette();
  const ctx = useTimelineCtx();
  const body = (
    <View style={styles.entryHead}>
      <RowIcon name={BrainIcon} color={p.muted} nested={false} opacity={0.8} />
      <Shine active style={{ flex: 1 }}>
        <Text numberOfLines={1} style={[type.row, { color: p.muted }]}>{row.label ?? "Thinking"}</Text>
      </Shine>
    </View>
  );
  const { groupId } = row;
  if (groupId === undefined) return body;
  return (
    <Press onPress={() => ctx.toggleGroup(groupId)} hitSlop={ROW_HIT_SLOP} accessibilityRole="button" accessibilityState={{ expanded: row.expanded === true }}>
      {body}
    </Press>
  );
});

/** "Working for 12s" (the web's duration format) at the head of the running turn (web WorkingTimelineRow). */
export const WorkingRow = memo(function WorkingRow({ row }: { row: Row<"working"> }) {
  const p = usePalette();
  const now = useNow(row.createdAt ? 1000 : null);
  const timer = row.createdAt ? formatWorkingTimerNow(row.createdAt, now) : null;
  const label = row.compacting ? (timer ? `Compacting context ${timer}` : "Compacting context") : timer ? `Working for ${timer}` : "Working";
  return (
    <View style={[styles.working, { borderBottomColor: withAlpha(p.border, 0.6) }]}>
      <Shine active={row.compacting === true} style={styles.workingLine}>
        {row.compacting ? <Minimize2Icon size={12} color={p.muted} /> : null}
        <Text style={[type.body, { color: p.muted, fontVariant: ["tabular-nums"] }]}>{label}</Text>
      </Shine>
    </View>
  );
});

const styles = StyleSheet.create({
  entryHead: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28, paddingVertical: 3, paddingHorizontal: 2 },
  nestedHead: { minHeight: 24, paddingVertical: 0 },
  entryLabel: { flex: 1 },
  answerPreview: { maxWidth: "50%" },
  chevron: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  reasoning: { gap: 12, paddingHorizontal: 2, paddingVertical: 4 },
  questions: { marginLeft: 28, marginTop: 8, gap: 8 },
  answerFiles: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  panel: { gap: 8, marginTop: 2, marginBottom: 6, paddingBottom: 8 },
  pathRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  diff: { maxHeight: 384, borderRadius: 6, borderWidth: 1, paddingVertical: 4 },
  diffLine: { flexDirection: "row" },
  diffNote: { paddingHorizontal: 8 },
  diffNumber: { textAlign: "right", paddingLeft: 8 },
  link: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" },
  working: { paddingTop: 4, paddingBottom: 8, borderBottomWidth: 1 },
  workingLine: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 24, paddingHorizontal: 4 },
});
