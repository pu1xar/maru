// The input at the bottom, laid out as the web's ThreadComposer: a rounded glass box with the text on
// top (two lines to start) and a footer row under it (the clip, the model, the stop and send round
// buttons). Above the box, Codex's goal line and the errors. A session this view cannot send to
// gets the web's one-line bar in the box's place (DESIGN.md 4.2); a dropped connection stops only
// the send, the field stays open (lib/composerState.ts). The clip attaches pictures and files
// (DESIGN.md 6n); they upload at once and wait as tiles and rows inside the box, and the send waits
// for the uploads. The context use sits in the footer's free middle, where the web shows the
// connection note (an addition the phone keeps by request; the web's chat input has no context figure).
import { useEffect, useMemo, useState, type ReactNode, createElement } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { Text, TextInput } from "./ui/Text.tsx";
import { BotIcon, LockIcon, PaperclipIcon, TargetIcon, TerminalIcon, WifiOffIcon, type LucideIcon } from "lucide-react-native";
import { SendArrowIcon } from "./ui/AppIcons.tsx";
import type { SessionSummary, ThreadSnapshot } from "@maru/shared";
import type { Pairing } from "../lib/api.ts";
import { pickFiles, pickPhotos, takePhoto } from "../lib/attachmentPickers.ts";
import { clearAttachments, useAttachmentActions, useAttachments } from "../lib/composerAttachments.ts";
import type { PickedFile } from "../lib/composerAttachments.logic.ts";
import { composerState, OFFLINE_NOTE } from "../lib/composerState.ts";
import { composerStatus, goalOf, goalText } from "../lib/composerStatus.ts";
import { useDraft } from "../lib/drafts.ts";
import { usePalette } from "../theme.ts";
import { type } from "../typography.ts";
import { AttachMenu, AttachmentStrip, type AttachChoice } from "./ComposerAttachments.tsx";
import { ComposerError } from "./ComposerNotice.tsx";
import { Press } from "./Press.tsx";
import { useComposerColors } from "./useComposerColors.ts";

/** The 1px outline of the box; the web draws it over the box's edge, so the paddings below take it off. */
const OUTLINE = 1;

export function Composer(props: {
  session: SessionSummary | null;
  /** The open thread's snapshot (model, context use, goal); null for a subagent's thread. */
  snapshot: ThreadSnapshot | null;
  /** Set when the open thread is a subagent's and no listed session stands for it. */
  readOnly?: string | null;
  online: boolean;
  /** The pairing the attachments upload through (device token, device listener). */
  pairing: Pairing;
  bottomInset: number;
  /** What the web draws between the goal line and the errors: the question and approval cards, the
   * screen's error and notice (ThreadComposer's order: goal, questions, errors, the box). */
  above?: ReactNode;
  onSend: (text: string, attachmentIds: string[]) => void;
  onStop: () => void;
}) {
  const p = usePalette();
  const c = useComposerColors();
  const { height: windowHeight } = useWindowDimensions();
  // The session's draft, where queued messages taken back also land (lib/drafts.ts).
  const [text, setText] = useDraft(props.session?.key ?? "");
  const s = props.session;
  const key = s?.key ?? "";
  const items = useAttachments(key);
  const attach = useAttachmentActions(key, props.pairing);
  const state = composerState({ session: s, readOnly: props.readOnly, online: props.online, text, attachments: items });
  const canSend = state.send !== null;
  const [menu, setMenu] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const choose = (choice: AttachChoice) => {
    setMenu(false);
    setPickError(null);
    const pick: Promise<PickedFile[]> = choice === "photos" ? pickPhotos() : choice === "camera" ? takePhoto() : pickFiles();
    pick.then(attach.add, (e: unknown) => setPickError(e instanceof Error ? e.message : String(e)));
  };
  const send = () => {
    if (state.send === null) return;
    props.onSend(state.send, state.attachmentIds);
    setText("");
    clearAttachments(key);
  };
  const status = useMemo(() => composerStatus(props.snapshot), [props.snapshot]);
  const goal = goalOf(props.snapshot);
  const boxStyle = { backgroundColor: c.box, borderColor: focused ? c.outlineFocus : c.outline };
  // web: pb-[max(0.75rem,env(safe-area-inset-bottom))]
  const paddingBottom = Math.max(12, props.bottomInset);
  return (
    <View style={[styles.wrap, { paddingBottom, backgroundColor: p.bg }]}>
      {goal ? <GoalLine goal={goal} running={state.running} /> : null}
      {props.above}
      {pickError ? <ComposerError text={pickError} /> : null}
      {state.blocked ? <ComposerError text={state.blocked} /> : null}
      {state.block || s === null ? (
        <View style={[styles.blockedBar, boxStyle]} accessibilityLabel={state.reason ?? undefined}>
          {createElement(blockIcon(state.block?.kind), { size: 16, color: p.muted })}
          <Text style={[type.row, { color: p.muted, flex: 1 }]}>{state.reason}</Text>
          {state.running ? <StopButton onStop={props.onStop} /> : null}
        </View>
      ) : (
        <View style={[styles.box, boxStyle]}>
          <View style={styles.top}>
            {items.length > 0 ? (
              <View style={styles.strip}>
                <AttachmentStrip items={items} onRemove={attach.remove} onRetry={attach.retry} />
              </View>
            ) : null}
            <TextInput
              value={text}
              onChangeText={setText}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              multiline
              placeholder="Message"
              placeholderTextColor={p.muted}
              accessibilityLabel="Message"
              textAlignVertical="top"
              style={[styles.input, { color: p.text, maxHeight: windowHeight * 0.4 }]}
            />
          </View>
          <View style={styles.footer}>
            <Press onPress={() => setMenu(true)} style={styles.clip} hitSlop={6} accessibilityLabel="Attach files">
              <PaperclipIcon size={18} color={p.muted} />
            </Press>
            <View style={styles.free}>
              {state.offline ? (
                <>
                  <WifiOffIcon size={14} color={p.muted} />
                  <Text style={[type.small, { color: p.muted, flexShrink: 1 }]} numberOfLines={1}>{OFFLINE_NOTE}</Text>
                </>
              ) : status.context ? (
                <Text style={[type.small, { color: p.muted, flexShrink: 1 }]} numberOfLines={1}>{status.context}</Text>
              ) : null}
            </View>
            {status.model ? (
              <View style={styles.model} accessibilityLabel={`Model ${status.model}${status.effort ? `, effort ${status.effort}` : ""}`}>
                <Text style={[type.row, { color: c.modelText, flexShrink: 1 }]} numberOfLines={1}>{status.model}</Text>
                {status.effort ? <Text style={[type.small, { color: p.muted }]}>{status.effort}</Text> : null}
              </View>
            ) : null}
            {state.running ? <StopButton onStop={props.onStop} /> : null}
            <Press
              onPress={send}
              disabled={!canSend}
              style={[styles.round, { backgroundColor: canSend ? p.accent : c.chip }]}
              hitSlop={6}
              accessibilityLabel="Send"
            >
              <SendArrowIcon size={14} color={canSend ? p.onAccent : p.muted} />
            </Press>
          </View>
        </View>
      )}
      <AttachMenu open={menu} onChoose={choose} onClose={() => setMenu(false)} />
    </View>
  );
}

function blockIcon(kind: "subagent" | "terminal" | "other-client" | undefined): LucideIcon {
  return kind === "subagent" ? BotIcon : kind === "terminal" ? TerminalIcon : LockIcon;
}

/** The web's stop button: a neutral round button with a rounded square. */
function StopButton(props: { onStop: () => void }) {
  const p = usePalette();
  const c = useComposerColors();
  return (
    <Press onPress={props.onStop} style={[styles.round, { backgroundColor: c.chip }]} hitSlop={6} accessibilityLabel="Stop">
      <View style={[styles.stopSquare, { backgroundColor: p.text }]} />
    </Press>
  );
}

/**
 * The thread's goal (/goal): "Goal active (1m)" and what it works toward. While a Codex goal is
 * active and a turn runs the time counts on from the later of this screen's first sight of the goal
 * and of the turn (the web's GoalStatusText); the daemon's own count moves only when a tool call or
 * turn ends. A Claude goal ("Goal active (5m, 2 checks)") counts the time since it was set.
 */
function GoalLine(props: { goal: NonNullable<ReturnType<typeof goalOf>>; running: boolean }) {
  const p = usePalette();
  const { goal, running } = props;
  const observedAt = useMemo(() => Date.now(), [goal]);
  const runningSince = useMemo(() => (running ? Date.now() : null), [running]);
  const ticking = goal.status === "active" && (running || goal.claude !== undefined);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  const baseline = Math.max(observedAt, runningSince ?? 0);
  return (
    <View style={styles.goal}>
      <TargetIcon size={14} color={p.muted} />
      <Text style={[type.small, { color: p.text, fontWeight: "500", flexShrink: 0 }]}>{goalText(goal, ticking, (now - baseline) / 1000, now)}</Text>
      <Text style={[type.small, { color: p.muted, flex: 1 }]} numberOfLines={1}>{goal.objective}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // web: the lane is pt-1.5 with the rows 8 apart (gap-2), and its sides 12
  wrap: { paddingHorizontal: 12, paddingTop: 6, gap: 8 },
  goal: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 },
  // web: rounded-2xl; px-4 pt-3.5 pb-2 above, px-2 pb-2 for the footer row
  box: { borderRadius: 16, borderWidth: OUTLINE },
  top: { paddingHorizontal: 16 - OUTLINE, paddingTop: 14 - OUTLINE, paddingBottom: 8 },
  strip: { marginBottom: 12 },
  // web: rows={2}, text-sm with leading-relaxed, no padding of its own
  input: { ...type.body, minHeight: 2 * type.body.lineHeight, padding: 0 },
  footer: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8 - OUTLINE, paddingBottom: 8 - OUTLINE },
  // web: icon-sm is size-8 below the sm width, radius var(--control-radius)
  clip: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  free: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 },
  // web: h-7 max-w-44 px-1.75 gap-1 rounded-(--control-radius)
  model: { minHeight: 28, maxWidth: 176, minWidth: 0, flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 7, borderRadius: 8 },
  round: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  // web: the svg's rect is 8 of its 12 box, rx 1.5
  stopSquare: { width: 8, height: 8, borderRadius: 1.5 },
  // web: min-h-12 items-center gap-2.5 py-2 ps-4 pe-2 text-sm text-muted-foreground
  blockedBar: { minHeight: 48, borderRadius: 16, borderWidth: OUTLINE, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 - OUTLINE, paddingLeft: 16 - OUTLINE, paddingRight: 8 - OUTLINE },
});
