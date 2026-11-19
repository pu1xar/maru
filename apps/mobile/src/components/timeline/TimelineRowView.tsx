// One timeline row (lib/timeline.ts MessagesTimelineRow, the web's row kinds): the user's turns in
// a bubble on the right, the answer on the page in the system sans like the web, the
// work log as quiet one-line rows, turn folds as "Worked for 12s" lines. The labels and the rules
// behind them are the web's; see WorkRows.tsx for the work log rows, SubagentRows.tsx for the
// subagent cards and lib/timelineView.ts for the decisions that are plain data (spacing, a bubble's
// fold, the pills). Sizes, borders and colors follow the web's classes in MessagesTimeline.tsx,
// TimelineUserMessageRow.tsx, TimelineAssistantRows.tsx, TimelineSystemDivider.tsx and
// ProposedPlanCard.tsx.
import { memo, useEffect, useMemo, useState, type ReactNode, createElement } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../ui/Text.tsx";
import { ArrowRightIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, CircleStopIcon, CopyIcon, FileIcon, GitForkIcon, ImageIcon, ImageOffIcon, MessagesSquareIcon, Minimize2Icon, MoreHorizontalIcon, Redo2Icon, type LucideIcon } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { viewedImageUrls, type OrchestrationV2TurnItem } from "@maru/shared";
import { foldedMessageLabel, resolveUserMessagePresentation } from "../../../../web/src/client-runtime/userMessage.ts";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "../../../../web/src/t3-shared/proposedPlanText.ts";
import { buildCollapsedProposedPlanPreviewMarkdown } from "../../../../web/src/components/chat/ProposedPlanCard.logic.ts";
import { formatWorkspaceRelativePath } from "../../../../web/src/filePathDisplay.ts";
import { interruptDividerDetail } from "../../../../web/src/components/chat/V2LifecycleRow.logic.ts";
import type { MessagesTimelineRow } from "../../lib/timeline.ts";
import { blendOver, isLightPalette, tones } from "../../lib/timelineTones.ts";
import {
  assistantStatusPill,
  messageTimeLabel,
  USER_MESSAGE_FOLDED_HEIGHT,
  userMessageFolds,
  userMessageMarkdown,
  userMessageParts,
  userStatusPill,
  withAlpha,
  workLogGap,
} from "../../lib/timelineView.ts";
import { PaletteScope, useAppearance } from "../../appearance.tsx";
import { bubbleContent } from "../../lib/appearancePalette.ts";
import { usePalette, type Palette } from "../../theme.ts";
import { type } from "../../typography.ts";
import { messageTarget, openMessageMenu, useMessageActionsKey } from "../../lib/messageActions.ts";
import { PicturePreview } from "../FileImage.tsx";
import { Markdown } from "../Markdown.tsx";
import { Press } from "../Press.tsx";
import { useFindHighlight } from "./findHighlight.ts";
import { Shine } from "./Shine.tsx";
import { SubagentCard, SubagentGroup, type SubagentItem } from "./SubagentRows.tsx";
import { ROW_HIT_SLOP, useTimelineCtx } from "./TimelineContext.ts";
import { LiveWorkRow, ThinkingRow, WorkingRow, WorkSection, WorkToggleRow } from "./WorkRows.tsx";

type Row<K extends MessagesTimelineRow["kind"]> = Extract<MessagesTimelineRow, { kind: K }>;

export const TimelineRowView = memo(function TimelineRowView({ row }: { row: MessagesTimelineRow }) {
  return <View style={[styles.lane, { paddingBottom: gapAfter(row) }]}>{content(row)}</View>;
});

/** The subagents an event row draws: its group, or the one item. */
function subagentMembers(row: Row<"event">): SubagentItem[] {
  return (row.subagents ?? [row.projectedItem]).flatMap(({ item: m }) => (m.type === "subagent" ? [m] : []));
}

/** Space under a row: work log rows sit together, a message ends a block (web TimelineRowContent). */
function gapAfter(row: MessagesTimelineRow): number {
  switch (row.kind) {
    case "work":
      return workLogGap({ continuesWorkLog: row.continuesWorkLog, layout: row.isExpandedToolGroup ? "group-content" : "standalone" });
    case "work-live":
    case "work-toggle":
    case "thinking":
      return workLogGap({ continuesWorkLog: row.continuesWorkLog, layout: row.expanded === true ? "group-header" : "standalone" });
    case "turn-fold":
    case "working":
      return 6;
    case "message":
      if (row.groupedWithNext) return 4;
      return row.message.role === "assistant" && !row.showAssistantMeta ? 8 : 16;
    case "event":
      if (row.projectedItem.item.type === "subagent") {
        // A group part owns its trailing space; a single card carries its own margin (web TimelineV2EventRow).
        return subagentMembers(row).length > 1 ? workLogGap({ continuesWorkLog: row.continuesWorkLog, layout: "standalone" }) : 0;
      }
      return 8;
    case "attempt-fold":
    case "viewed-images":
      return 8;
    default:
      return 16;
  }
}

function content(row: MessagesTimelineRow) {
  switch (row.kind) {
    case "work":
      return <WorkSection row={row} />;
    case "work-live":
      return <LiveWorkRow row={row} />;
    case "work-toggle":
      return <WorkToggleRow row={row} />;
    case "thinking":
      return <ThinkingRow row={row} />;
    case "working":
      return <WorkingRow row={row} />;
    case "turn-fold":
      return <TurnFoldRow row={row} />;
    case "attempt-fold":
      return <AttemptFoldRow row={row} />;
    case "context-compaction":
      return <CompactionRow row={row} />;
    case "message":
      return row.message.role === "user" ? <UserMessageRow row={row} /> : <AssistantRow row={row} />;
    case "assistant-meta":
      return (
        <View style={styles.assistantMeta}>
          <AssistantMeta text={row.message.text} at={row.message.createdAt} status={row.projectedItem?.item.status} streaming={row.message.streaming} />
        </View>
      );
    case "proposed-plan":
      return (
        <View style={styles.assistant}>
          <PlanCard markdown={row.proposedPlan.planMarkdown} />
        </View>
      );
    case "viewed-images":
      return <ViewedImages row={row} />;
    case "event":
      return <EventRow row={row} />;
  }
}

/** "Worked for 12s" with a chevron, under a hairline (web TurnFoldTimelineRow). */
function TurnFoldRow({ row }: { row: Row<"turn-fold"> }) {
  const p = usePalette();
  const ctx = useTimelineCtx();
  return (
    <View style={[styles.foldFrame, { borderBottomColor: withAlpha(p.border, 0.6) }]}>
      <Press
        onPress={() => ctx.toggleRun(row.runId)}
        hitSlop={ROW_HIT_SLOP}
        style={styles.foldButton}
        accessibilityRole="button"
        accessibilityState={{ expanded: row.expanded }}
      >
        <Text style={[type.body, { color: p.muted, fontVariant: ["tabular-nums"] }]}>{row.label}</Text>
        {row.expanded ? <ChevronDownIcon size={14} color={p.muted} /> : <ChevronRightIcon size={14} color={p.muted} />}
      </Press>
    </View>
  );
}

/** A steer cut this attempt off: a quiet bordered line that opens it (web AttemptFoldTimelineRow). */
function AttemptFoldRow({ row }: { row: Row<"attempt-fold"> }) {
  const p = usePalette();
  const ctx = useTimelineCtx();
  return (
    <Press
      onPress={() => ctx.toggleAttempt(row.attemptId)}
      hitSlop={ROW_HIT_SLOP}
      style={[styles.attempt, { borderColor: withAlpha(p.border, 0.6), backgroundColor: withAlpha(tones(p).muted, 0.2) }]}
      accessibilityRole="button"
      accessibilityState={{ expanded: row.expanded }}
    >
      {row.expanded ? <ChevronDownIcon size={14} color={p.muted} /> : <ChevronRightIcon size={14} color={p.muted} />}
      <Text style={[type.small, { color: withAlpha(p.text, 0.8), fontWeight: "500" }]}>{row.label}</Text>
      <Text style={[type.tiny, { color: p.muted }]}>Interrupted by steer</Text>
    </Press>
  );
}

/** A line across the conversation with a small label (web TimelineSystemDivider and the compaction row's rules). */
function Rules({ color, gap, paddingVertical, children }: { color: string; gap: number; paddingVertical: number; children: ReactNode }) {
  return (
    <View style={[styles.divider, { gap, paddingVertical }]}>
      <View style={[styles.rule, { backgroundColor: color }]} />
      {children}
      <View style={[styles.rule, { backgroundColor: color }]} />
    </View>
  );
}

/**
 * The system divider's label: a medium-weight label after a small icon, then the detail after a comma
 * at 70% (web TimelineSystemDivider, text-2xs). The icon is a glyph inside the text, so a long detail wraps with it.
 */
function DividerLabel({ icon, color, label, detail }: { icon: LucideIcon; color: string; label: string; detail?: string | null }) {
  return (
    <Text style={[type.tiny, { color, flexShrink: 1, textAlign: "center" }]}>
      <Text style={{ fontWeight: "500" }}>
        {createElement(icon, { size: 12, color })}
        {` ${label}${detail ? "," : ""}`}
      </Text>
      {detail ? <Text style={{ opacity: 0.7 }}>{` ${detail}`}</Text> : null}
    </Text>
  );
}

/** "Context compacted, 12000 to 4000 tokens": the arrow is an icon, as on the web (text-xs between rules, a failure in the error color). */
function CompactionRow({ row }: { row: Row<"context-compaction"> }) {
  const p = usePalette();
  const color = row.failed ? tones(p).error : p.muted;
  const head = row.title ?? "Context compacted";
  const label = row.title ?? row.label;
  const body = (
    <View style={styles.compaction}>
      {row.failed ? <CircleAlertIcon size={12} color={color} /> : <Minimize2Icon size={12} color={color} />}
      {row.tokenCounts ? (
        <>
          <Text style={[type.small, { color }]}>{`${head} ${row.tokenCounts.before}`}</Text>
          <ArrowRightIcon size={12} color={color} />
          <Text style={[type.small, { color }]}>{`${row.tokenCounts.after} tokens`}</Text>
        </>
      ) : (
        <Text style={[type.small, { color, flexShrink: 1 }]} numberOfLines={1}>{label}</Text>
      )}
      {row.failure ? <Text style={[type.small, { color, flexShrink: 1, opacity: 0.8 }]} numberOfLines={1}>{`, ${row.failure}`}</Text> : null}
    </View>
  );
  return (
    <View accessibilityRole="text" accessibilityLabel={row.failure ? `${label}: ${row.failure}` : label}>
      <Rules color={row.failed ? withAlpha(p.danger, 0.3) : withAlpha(p.border, 0.7)} gap={12} paddingVertical={4}>
        <Shine active={row.active === true} style={{ flexShrink: 1 }}>{body}</Shine>
      </Rules>
    </View>
  );
}

/** A small icon button (24 square, the web's xs ghost button) that copies `text` and shows a check for a moment. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const p = usePalette();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Press hitSlop={10} onPress={() => void Clipboard.setStringAsync(text).then(() => setCopied(true))} accessibilityLabel={copied ? "Copied" : label} style={styles.iconButton}>
      {copied ? <CheckIcon size={12} color={p.accent} /> : <CopyIcon size={12} color={p.muted} />}
    </Press>
  );
}

/** A small status word in a rounded outline (web AssistantStatusBadge, UserMessageProjectedStatus). */
function Pill({ text, color, border, fill }: { text: string; color: string; border: string; fill?: string }) {
  return (
    <View style={[styles.pill, { borderColor: border, backgroundColor: fill }]}>
      <Text style={[type.tiny, { color, fontWeight: "500" }]}>{text}</Text>
    </View>
  );
}

/** The files a message carries, one row each: the icon and the name (web MessageAttachments rows). */
function AttachmentRows({ p, names }: { p: Palette; names: Array<{ key: string; icon: LucideIcon; name: string }> }) {
  return (
    <View style={{ gap: 4 }}>
      {names.map((a) => (
        <View key={a.key} style={styles.attachment}>
          <a.icon size={16} color={p.muted} />
          <Text numberOfLines={1} style={[type.row, { color: p.text, flex: 1 }]}>{a.name}</Text>
        </View>
      ))}
    </View>
  );
}

/** A viewed image: its path in a quiet outlined chip (web ViewedImagesTimelineRow). */
function PathChip({ p, name }: { p: Palette; name: string }) {
  return (
    <View style={[styles.chip, { borderColor: withAlpha(p.border, 0.6) }]}>
      <ImageIcon size={14} color={p.muted} />
      <Text style={[type.small, { color: p.muted, flexShrink: 1 }]}>{name}</Text>
    </View>
  );
}

/** The folded header of an agent's, an automation's or the system's message (web FoldedMessageHeader). */
function FoldedHeader({ p, label, summary, open, onToggle }: { p: Palette; label: string; summary: string; open: boolean; onToggle: () => void }) {
  return (
    <Press onPress={onToggle} hitSlop={ROW_HIT_SLOP} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.foldedHead}>
      <MessagesSquareIcon size={16} color={p.muted} />
      <Text numberOfLines={1} style={[styles.foldedText, { color: p.muted, maxWidth: "50%" }]}>{label}</Text>
      <Text numberOfLines={1} style={[styles.foldedText, { color: p.text, flex: 1 }]}>{summary}</Text>
      <ChevronDownIcon size={14} color={p.muted} style={open ? { transform: [{ rotate: "180deg" }] } : undefined} />
    </Press>
  );
}

/** The user's message; one an agent, an automation or the system sent folds to a labelled line in its bubble. */
function UserMessageRow({ row }: { row: Row<"message"> }) {
  const p = usePalette();
  // A blue bubble (Settings, My bubble color) has white text: its contents read this palette.
  const { prefs } = useAppearance();
  const scoped = useMemo(() => bubbleContent(p, prefs.messageBubble), [p, prefs.messageBubble]);
  const bp = scoped ?? p;
  const ctx = useTimelineCtx();
  const presentation = resolveUserMessagePresentation(row.message);
  const [opened, setOpen] = useState(false);
  const revealed = useFindHighlight()?.revealed === true;
  const open = opened || revealed;
  const intent = row.message.inputIntent;
  // The attachment notes at the end of the text become file rows (web sentMessageAttachments).
  const data = row.projectedItem?.x?.data;
  const sent = useMemo(() => userMessageParts(row.message, presentation.text, data), [row.message, presentation.text, data]);
  // The menu (copy, Rewind to here, Fork from here) belongs to a message the server can name and an open session it can act on (lib/messageActions.ts).
  const menuTarget = messageTarget(useMessageActionsKey(), row.projectedItem?.item);
  const folded = presentation.attribution !== null;
  const corners = [
    row.groupedWithPrevious ? { borderTopRightRadius: 6 } : null,
    row.groupedWithNext ? { borderBottomRightRadius: 6 } : null,
  ];
  if (folded) {
    const label = foldedMessageLabel(presentation.attribution!, row.projectedItem?.x?.origin);
    const first = sent.text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
    return (
      <View style={styles.userRow}>
        {/* Not the user's message: the web's neutral card (FOLDED_MESSAGE_CARD) in place of the user's bubble color. */}
        <View style={[styles.foldedBubble, { borderWidth: 1, borderColor: p.border, backgroundColor: withAlpha(p.text, 0.04) }, corners, open ? { width: "80%" } : null]}>
          <FoldedHeader p={p} label={label} summary={first} open={open} onToggle={() => setOpen((o) => !o)} />
          {open ? (
            <ScrollView nestedScrollEnabled style={{ maxHeight: 384 }} contentContainerStyle={styles.foldedBody}>
              {sent.attachments.length > 0 ? <AttachmentRows p={p} names={sent.attachments.map((a) => ({ key: a.key, icon: a.kind === "image" ? ImageOffIcon : FileIcon, name: a.name }))} /> : null}
              {sent.text.trim() ? <Markdown text={userMessageMarkdown(sent.text)} color={p.text} cwd={ctx.workspaceRoot} /> : null}
            </ScrollView>
          ) : null}
        </View>
        {open && presentation.text ? (
          <View style={styles.actionsFrame}>
            <View style={styles.actionsRow}>
              <CopyButton text={presentation.text} label="Copy message" />
            </View>
          </View>
        ) : null}
      </View>
    );
  }
  if (!sent.text.trim() && sent.attachments.length === 0) return null;
  const status = userStatusPill(row.projectedItem?.item.status);
  const steer = intent === "steer" || intent === "promoted_queued_to_steer";
  const unread = row.projectedItem?.item.status === "pending";
  const errorText = tones(p).error;
  return (
    <View style={styles.userRow}>
      {steer && !row.continuesSteer ? (
        <View style={styles.steer}>
          <Redo2Icon size={12} color={p.muted} />
          <Text style={[type.small, { color: p.muted }]}>{unread ? "steer, waiting to be read" : "steer"}</Text>
        </View>
      ) : null}
      <PaletteScope value={scoped}>
        <View style={[styles.bubble, { backgroundColor: p.userBubble }, corners]}>
          {sent.attachments.length > 0 ? (
            <AttachmentRows p={bp} names={sent.attachments.map((a) => ({ key: a.key, icon: a.kind === "image" ? ImageOffIcon : FileIcon, name: a.name }))} />
          ) : null}
          {sent.text.trim() ? <UserMessageBody p={bp} text={sent.text} cwd={ctx.workspaceRoot} /> : null}
        </View>
      </PaletteScope>
      {status ? (
        <View style={styles.userStatus}>
          <Pill text={status} color={errorText} border={withAlpha(p.danger, 0.25)} fill={withAlpha(p.danger, 0.08)} />
        </View>
      ) : null}
      {/* Touch shows the actions all the time and never the time. The copy keeps the text as sent, notes included (web: copy keeps the original). */}
      <View style={styles.actionsFrame}>
        <View style={styles.actionsRow}>
          {presentation.text ? <CopyButton text={presentation.text} label="Copy message" /> : null}
          {menuTarget !== null ? (
            <Press hitSlop={10} onPress={() => openMessageMenu({ text: presentation.text, targetId: menuTarget })} accessibilityRole="button" accessibilityLabel="More message actions" style={styles.iconButton}>
              <MoreHorizontalIcon size={12} color={p.muted} />
            </Press>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/**
 * Stacked strips that fade the bottom of a clipped block into `color` (RN has no gradient without a
 * native module). `steps` are the strips' opacities from the top of the fade down.
 */
function FadeOut({ color, height, steps }: { color: string; height: number; steps: readonly number[] }) {
  return (
    <View pointerEvents="none" style={[styles.fade, { height }]}>
      {steps.map((o) => (
        <View key={o} style={{ flex: 1, backgroundColor: color, opacity: o }} />
      ))}
    </View>
  );
}

/** The bubble's text as markdown; one that would fill the screen folds to a start with "Show all" (web CollapsibleUserMessageBody). */
function UserMessageBody({ p, text, cwd }: { p: Palette; text: string; cwd: string | undefined }) {
  const [height, setHeight] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const markdown = useMemo(() => userMessageMarkdown(text), [text]);
  const folds = userMessageFolds(height);
  // The row a find shows keeps its whole text in view (the paint inside a fold would be hidden).
  const revealed = useFindHighlight()?.revealed === true;
  const collapsed = folds && !expanded && !revealed;
  return (
    <View>
      {/* The clip is outside the measured view, so the height read is the whole text's. */}
      <View style={collapsed ? { maxHeight: USER_MESSAGE_FOLDED_HEIGHT, overflow: "hidden" } : null}>
        <View onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
          <Markdown text={markdown} color={p.text} cwd={cwd} inBubble />
        </View>
        {collapsed ? <FadeOut color={blendOver(p.userBubble, p.bg)} height={28} steps={[0.2, 0.45, 0.7, 0.95]} /> : null}
      </View>
      {folds ? (
        <View style={styles.foldFooter}>
          <Press onPress={() => setExpanded((v) => !v)} hitSlop={ROW_HIT_SLOP} accessibilityRole="button" accessibilityState={{ expanded }} style={styles.foldAction}>
            <Text style={[type.small, { color: p.muted }]}>{expanded ? "Show less" : "Show all"}</Text>
          </Press>
        </View>
      ) : null}
    </View>
  );
}

function AssistantRow({ row }: { row: Row<"message"> }) {
  const p = usePalette();
  const ctx = useTimelineCtx();
  const text = row.message.text;
  // An empty answer draws nothing while it streams (the web's empty markdown), and "(empty response)" once it ended empty.
  const shown = text || (row.message.streaming || row.suppressEmptyResponse ? "" : "(empty response)");
  const status = row.projectedItem?.item.status;
  return (
    <View style={styles.assistant}>
      {shown ? <Markdown text={shown} cwd={ctx.workspaceRoot} /> : null}
      {!row.showAssistantMeta && status === "interrupted" ? (
        <View style={styles.assistantPill}>
          <Pill text={assistantStatusPill(status) ?? ""} color={p.muted} border={withAlpha(p.border, 0.7)} />
        </View>
      ) : null}
      {row.showAssistantMeta ? (
        <View style={{ marginTop: 6 }}>
          <AssistantMeta text={text} at={row.message.createdAt} status={status} streaming={row.message.streaming} />
        </View>
      ) : null}
    </View>
  );
}

/** Under a finished answer (or after the tool group that trails it): its status if unfinished, a copy button and its time. */
function AssistantMeta({ text, at, status, streaming }: { text: string; at: string; status: OrchestrationV2TurnItem["status"] | undefined; streaming: boolean }) {
  const p = usePalette();
  const pill = assistantStatusPill(status);
  const time = streaming ? "" : messageTimeLabel(at);
  return (
    <View style={styles.meta}>
      {pill ? <Pill text={pill} color={p.muted} border={withAlpha(p.border, 0.7)} /> : null}
      <CopyButton text={text} label="Copy answer" />
      {time ? <Text style={[type.small, { color: p.muted, fontVariant: ["tabular-nums"] }]}>{time}</Text> : null}
    </View>
  );
}

/** A proposed plan: a "Plan" badge, its title and an actions menu; long ones fold to their first lines (web ProposedPlanCard). */
function PlanCard({ markdown }: { markdown: string }) {
  const p = usePalette();
  const ctx = useTimelineCtx();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const title = proposedPlanTitle(markdown) ?? "Proposed plan";
  const body = stripDisplayedPlanMarkdown(markdown);
  const long = markdown.length > 900 || markdown.split("\n").length > 20;
  const collapsed = long && !open;
  const preview = useMemo(() => (long ? buildCollapsedProposedPlanPreviewMarkdown(markdown, { maxLines: 10 }) : ""), [long, markdown]);
  const light = isLightPalette(p);
  const outline = { borderColor: tones(p).input, backgroundColor: light ? p.surface : withAlpha(tones(p).input, 0.32) };
  return (
    <View style={[styles.card, { borderColor: withAlpha(p.border, 0.8), backgroundColor: withAlpha(p.surface, 0.7) }]}>
      <View style={styles.cardHead}>
        <View style={[styles.badge, { backgroundColor: tones(p).muted }]}>
          <Text style={[type.small, { color: p.text, fontWeight: "500", lineHeight: 16 }]}>Plan</Text>
        </View>
        <Text numberOfLines={1} style={[type.row, { color: p.text, fontWeight: "500", flex: 1, lineHeight: 21 }]}>{title}</Text>
        <Press hitSlop={10} onPress={() => setMenu((m) => !m)} accessibilityRole="button" accessibilityLabel="Plan actions" accessibilityState={{ expanded: menu }} style={[styles.outlineIcon, outline]}>
          <MoreHorizontalIcon size={16} color={p.text} />
        </Press>
      </View>
      {/* The menu opens in the card's flow: a popup would sit under the next row of the list. */}
      {menu ? (
        <View style={[styles.menu, { borderColor: p.border, backgroundColor: p.surface }]}>
          <Press
            onPress={() => {
              void Clipboard.setStringAsync(`${markdown.trimEnd()}\n`);
              setMenu(false);
            }}
            accessibilityRole="menuitem"
            style={styles.menuItem}
          >
            <Text style={[type.row, { color: p.text }]}>Copy to clipboard</Text>
          </Press>
        </View>
      ) : null}
      <View style={{ marginTop: 16 }}>
        <View style={collapsed ? { maxHeight: 416, overflow: "hidden" } : null}>
          <Markdown text={collapsed ? preview : body} cwd={ctx.workspaceRoot} />
          {collapsed ? <FadeOut color={p.surface} height={96} steps={[0.08, 0.3, 0.55, 0.75, 0.88, 0.95]} /> : null}
        </View>
        {long ? (
          <View style={{ marginTop: 16, alignItems: "center" }}>
            <Press onPress={() => setOpen((o) => !o)} hitSlop={ROW_HIT_SLOP} accessibilityRole="button" style={[styles.planButton, outline]}>
              <Text style={[type.row, { color: p.text, fontWeight: "500" }]}>{open ? "Collapse plan" : "Expand plan"}</Text>
            </Press>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function ViewedImages({ row }: { row: Row<"viewed-images"> }) {
  const p = usePalette();
  const ctx = useTimelineCtx();
  return (
    <View style={styles.chips}>
      {row.images.map((image) => {
        const name = formatWorkspaceRelativePath(image.path, ctx.workspaceRoot);
        return (
          <View key={image.path} style={styles.viewed}>
            <PathChip p={p} name={name} />
            <PicturePreview urls={viewedImageUrls(image)} name={name} />
          </View>
        );
      })}
    </View>
  );
}

function EventRow({ row }: { row: Row<"event"> }) {
  const p = usePalette();
  const ctx = useTimelineCtx();
  const rule = withAlpha(p.border, 0.7);
  const { item } = row.projectedItem;
  if (item.type === "run_interrupt_result") {
    return (
      <Rules color={rule} gap={8} paddingVertical={8}>
        <View style={styles.dividerLabel}>
          <DividerLabel icon={CircleStopIcon} color={p.muted} label="Run interrupted" detail={interruptDividerDetail(item.message)} />
        </View>
      </Rules>
    );
  }
  if (item.type === "fork") {
    const fromConversation = item.source.type === "run" || item.source.type === "provider_thread";
    const label = fromConversation ? "Forked from another conversation" : "Conversation forked";
    if (item.source.type !== "run") {
      return (
        <Rules color={rule} gap={8} paddingVertical={8}>
          <View style={styles.dividerLabel}>
            <DividerLabel icon={GitForkIcon} color={p.muted} label={label} />
          </View>
        </Rules>
      );
    }
    // A fork made from another conversation opens it (web V2LifecycleRow, open the original conversation).
    const from = item.source.threadId;
    return (
      <Rules color={rule} gap={8} paddingVertical={8}>
        <Press
          onPress={() => ctx.openThread(from)}
          hitSlop={ROW_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel="Open original conversation"
          style={[styles.forkPill, { borderColor: rule, backgroundColor: p.bg }]}
        >
          <DividerLabel icon={GitForkIcon} color={p.muted} label={label} />
        </Press>
      </Rules>
    );
  }
  if (item.type !== "subagent") return null;
  const members = subagentMembers(row);
  return members.length > 1 ? <SubagentGroup members={members} /> : <SubagentCard item={item} />;
}

const styles = StyleSheet.create({
  // The list's side padding is 12 (web messages-timeline-scroll on a phone); an answer sits 4 inside it (px-1).
  lane: { paddingHorizontal: 12 },
  assistant: { paddingHorizontal: 4, paddingVertical: 2 },
  assistantMeta: { paddingHorizontal: 4, paddingTop: 2 },
  assistantPill: { marginTop: 6, flexDirection: "row" },
  foldFrame: { borderBottomWidth: 1, paddingTop: 4, paddingBottom: 8, paddingRight: 2 },
  foldButton: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 4 },
  attempt: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 6, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8 },
  divider: { flexDirection: "row", alignItems: "center" },
  rule: { flex: 1, height: 1 },
  dividerLabel: { flexShrink: 1, paddingHorizontal: 8, paddingVertical: 4 },
  compaction: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
  forkPill: { flexShrink: 1, borderRadius: 999, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 4 },
  foldedBubble: { maxWidth: "80%", borderRadius: 16 },
  foldedHead: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  foldedText: { fontSize: 15, lineHeight: 20 },
  foldedBody: { paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  userRow: { alignItems: "flex-end", gap: 4 },
  steer: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4, marginRight: 4 },
  bubble: { maxWidth: "80%", borderRadius: 16, padding: 12, gap: 8 },
  userStatus: { marginRight: 4 },
  foldFooter: { marginTop: 6, flexDirection: "row", justifyContent: "flex-end" },
  foldAction: { height: 24, justifyContent: "center", paddingHorizontal: 7 },
  actionsFrame: { width: "80%", alignItems: "flex-end", paddingRight: 4 },
  actionsRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 2 },
  iconButton: { minWidth: 24, height: 24, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  attachment: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  meta: { flexDirection: "row", alignItems: "center", gap: 8 },
  pill: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  card: { borderRadius: 16, borderWidth: 1, padding: 16 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  badge: { height: 18, minWidth: 18, borderRadius: 4, paddingHorizontal: 3, alignItems: "center", justifyContent: "center" },
  outlineIcon: { width: 24, height: 24, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  menu: { alignSelf: "flex-end", marginTop: 4, borderRadius: 8, borderWidth: 1, padding: 4 },
  menuItem: { minHeight: 32, justifyContent: "center", paddingHorizontal: 8, borderRadius: 6 },
  planButton: { minHeight: 28, borderRadius: 8, borderWidth: 1, paddingHorizontal: 9, alignItems: "center", justifyContent: "center" },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0 },
  chips: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 8, paddingHorizontal: 2 },
  viewed: { maxWidth: "100%", alignItems: "flex-start" },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 6, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4, maxWidth: "100%" },
});
