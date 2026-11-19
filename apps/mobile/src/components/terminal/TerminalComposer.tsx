// The terminal mode's input (the web's TerminalComposer.tsx), shaped as the CLI draws it: a rule above and
// below a `❯` prompt, the permission mode line under it, the status line, and the pending asks as
// the CLI's pickers in its place. It sends, stops and answers through the same commands as the
// chat composer (the callbacks MainScreen owns) and edits the same draft and waiting attachments
// (lib/drafts.ts, lib/composerAttachments.ts). A phone has no keys, so what the CLI does with a key
// is a tap on a text button: `[send]` for Enter, `[stop]` for esc, the mode line cycles the
// permission mode (shift+tab), `[verbose]` toggles the transcript view (ctrl+o), `[+ file]` opens
// the attach menu. Not here, for lack of a touch counterpart: the `/` menu, `?` help, the history
// keys and the agent panel (DESIGN.md 6i, "앱의 터미널 모드").
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import type { PendingQuestionView, SessionSummary, ThreadSnapshot } from "@maru/shared";
import {
  effectivePermissionMode,
  nextPermissionMode,
  permissionModeLabel,
  planSignal,
  statusParts,
  type PermissionMode,
} from "../../../../web/src/components/terminal/terminalModel.ts";
import { formatBytes, terminalAttachmentLabel } from "../../../../web/src/lib/composerAttachments.logic.ts";
import type { Pairing } from "../../lib/api.ts";
import { pickFiles, pickPhotos, takePhoto } from "../../lib/attachmentPickers.ts";
import { clearAttachments, useAttachmentActions, useAttachments } from "../../lib/composerAttachments.ts";
import type { PickedFile, WaitingAttachment } from "../../lib/composerAttachments.logic.ts";
import { composerState, OFFLINE_NOTE } from "../../lib/composerState.ts";
import { goalOf, goalTuiText } from "../../lib/composerStatus.ts";
import { useDraft } from "../../lib/drafts.ts";
import { AttachMenu, progressLabel, type AttachChoice } from "../ComposerAttachments.tsx";
import { TerminalPending } from "./TerminalPending.tsx";
import { Cells, R, Rule, T, TermButton, TermInput, useTerm } from "./term.tsx";

export function TerminalComposer(props: {
  session: SessionSummary | null;
  snapshot: ThreadSnapshot | null;
  readOnly?: string | null;
  online: boolean;
  pairing: Pairing;
  bottomInset: number;
  /** ctrl+o's counterpart: the transcript view of the whole screen. */
  verbose: boolean;
  onToggleVerbose: () => void;
  /** The screen's error (a failed command) and notice (a rewind's result). */
  error: string | null;
  notice: string | null;
  onClearNotice: () => void;
  pending: readonly PendingQuestionView[];
  /** The request id of the last command that failed (an answer that failed can be sent again). */
  failedReqId: string | null;
  /** Sends an answer; the command's request id, or null when the connection is down. */
  onAnswer: (requestId: string, answers: Record<string, string>) => string | null;
  onSend: (text: string, attachmentIds: string[]) => void;
  onStop: () => void;
  /** Under the footer: the agent panel. */
  below?: ReactNode;
  /** The `/ws` thread.setPermissionMode request (shift+tab's counterpart); false when the connection is down. */
  onSetMode: (mode: PermissionMode) => boolean;
}) {
  const { tokens, cellW } = useTerm();
  const { height: windowHeight } = useWindowDimensions();
  const s = props.session;
  const key = s?.key ?? "";
  const [text, setText] = useDraft(key);
  const items = useAttachments(key);
  const attach = useAttachmentActions(key, props.pairing);
  const state = composerState({ session: s, readOnly: props.readOnly, online: props.online, text, attachments: items });
  const [menu, setMenu] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [offlineAnswer, setOfflineAnswer] = useState(false);

  // ---- permission mode (shift+tab) ----
  const stateMode = props.snapshot?.state.permissionMode;
  const claude = s?.provider === "claude";
  // The tap works where the server can change the mode: a Claude session whose process this server runs, with a mode reported.
  const modesKnown = claude && stateMode !== undefined;
  const canCycle = modesKnown && state.block === null && s?.owner === "ui";
  const visibleItems = props.snapshot?.visibleTurnItems;
  const signal = useMemo(() => planSignal(visibleItems ?? []), [visibleItems]);
  // When this screen last saw the server's value change, to order it against EnterPlanMode.
  const [modeSeen, setModeSeen] = useState<{ mode: string | undefined; at: number | null }>({ mode: stateMode, at: null });
  if (modeSeen.mode !== stateMode) setModeSeen({ mode: stateMode, at: Date.now() });
  // A request on its way: shown at once, and the next tap cycles from it.
  const [pendingMode, setPendingMode] = useState<PermissionMode | null>(null);
  if (pendingMode !== null && pendingMode === stateMode) setPendingMode(null);
  const shownMode = pendingMode ?? effectivePermissionMode(stateMode, claude ? signal : null, modeSeen.at);
  // An error from the server ends the wait; the mode line goes back to the server's value.
  useEffect(() => {
    if (props.error) setPendingMode(null);
  }, [props.error]);
  const cycleMode = () => {
    if (!canCycle) return;
    const next = nextPermissionMode(shownMode);
    if (props.onSetMode(next)) setPendingMode(next);
  };

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

  const mode = permissionModeLabel(shownMode);
  // The mode line: the server's mode, or plan mode the thread's items show while it has none.
  const showMode = claude && (modesKnown || shownMode === "plan");
  const status = statusParts(props.snapshot, s?.cwd ?? null);
  const goal = goalOf(props.snapshot);
  const effortValue = (props.snapshot?.state as { effort?: unknown } | undefined)?.effort;
  const effort = claude && typeof effortValue === "string" && effortValue ? effortValue : null;
  const placeholder = state.reason ?? 'Try "how does <filepath> work?"';
  const inputOff = state.block !== null || s === null;
  const modeColor = mode.tone === "bypass" ? "err" : mode.tone === "accept" ? "accept" : mode.tone === "plan" ? "plan" : "dim";
  let images = 0;
  let files = 0;

  return (
    <View style={[styles.wrap, { paddingBottom: Math.max(3, props.bottomInset), backgroundColor: tokens.bg }]}>
      {props.error ? <T c="err">{props.error}</T> : null}
      {pickError ? <T c="err">{pickError}</T> : null}
      {state.blocked ? <T c="err">{state.blocked}</T> : null}
      {offlineAnswer ? <T c="err">Disconnected from server, could not answer</T> : null}
      {props.notice ? (
        <T c="dim">
          {props.notice}
          <R c="dim" underline onPress={props.onClearNotice}>{" [x]"}</R>
        </T>
      ) : null}
      {props.pending.length > 0 ? (
        props.pending.map((q) => (
          <TerminalPending
            key={q.requestId}
            question={q}
            onAnswer={props.onAnswer}
            failedReqId={props.failedReqId}
            onOffline={setOfflineAnswer}
          />
        ))
      ) : (
        <>
          {/* Measured: "◉ xhigh" and "/effort" right-aligned over the top rule, when the model takes an effort. */}
          {effort ? <T c="dim" style={{ textAlign: "right", paddingRight: 2 * cellW }}>{`◉ ${effort}  /effort`}</T> : null}
          {items.length > 0 ? (
            <View style={{ paddingLeft: 2 * cellW }}>
              {items.map((a) => {
                const label = a.image ? terminalAttachmentLabel("image", ++images, a.name) : terminalAttachmentLabel("file", ++files, a.name);
                return <AttachmentLine key={a.localId} item={a} label={label} onRemove={() => attach.remove(a.localId)} onRetry={() => attach.retry(a.localId)} />;
              })}
            </View>
          ) : null}
          <Rule />
          <View style={styles.row}>
            <Cells n={2}>
              <T c={text ? undefined : "dim"}>{"❯ "}</T>
            </Cells>
            <TermInput
              value={text}
              onChangeText={setText}
              editable={!inputOff}
              multiline
              placeholder={placeholder}
              accessibilityLabel="Message"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              style={[styles.fill, { maxHeight: windowHeight * 0.4 }]}
            />
          </View>
          <Rule />
        </>
      )}
      <View style={{ paddingLeft: 2 * cellW }}>
        <View style={styles.footerRow}>
          {showMode ? (
            <Pressable
              onPress={cycleMode}
              disabled={!canCycle}
              accessibilityRole="button"
              accessibilityLabel={canCycle ? `Permission mode: ${mode.label}, tap to change` : `Permission mode: ${mode.label}`}
              hitSlop={{ top: 12, bottom: 12 }}
            >
              <T c={modeColor}>
                {mode.label}
                {canCycle ? <R c="dim">{" (tap to cycle)"}</R> : null}
              </T>
            </Pressable>
          ) : null}
          {state.block === null && s !== null ? <TermButton label="+ file" onPress={() => setMenu(true)} accessibilityLabel="Attach files" /> : null}
          <TermButton label="verbose" role={props.verbose ? "accent" : "dim"} onPress={props.onToggleVerbose} accessibilityLabel={props.verbose ? "Turn off the detailed transcript" : "Show the detailed transcript"} />
          <View style={styles.spacer} />
          {goal ? <GoalTui goal={goal} running={state.running} /> : null}
          {state.running ? <TermButton label="stop" role="err" onPress={props.onStop} accessibilityLabel="Stop" /> : null}
          <TermButton label="send" role="accent" disabled={state.send === null} onPress={send} accessibilityLabel="Send" />
        </View>
        {state.offline ? <T c="dim">{OFFLINE_NOTE}</T> : null}
        {status.length > 0 ? <T c="dim">{status.join("  ")}</T> : null}
      </View>
      {props.below}
      <AttachMenu open={menu} onChoose={choose} onClose={() => setMenu(false)} />
    </View>
  );
}

/** One line per waiting attachment: label, name, size or progress, remove (the web's TerminalAttachmentLines). */
function AttachmentLine(props: { item: WaitingAttachment; label: string; onRemove: () => void; onRetry: () => void }) {
  const a = props.item;
  const state = a.status === "uploading" ? progressLabel(a) : a.status === "failed" ? (a.error ?? "Upload failed") : a.sizeBytes === null ? "" : formatBytes(a.sizeBytes);
  const stateRole = a.status === "failed" ? "err" : a.uploaded?.notice ? "warn" : "dim";
  return (
    <View style={styles.row}>
      <T style={styles.fill} numberOfLines={1}>
        <R c="accent">{props.label}</R>
        {a.image ? ` ${a.name}` : ""}
        <R c={stateRole}>{`  ${a.uploaded?.notice ? `${state}, ${a.uploaded.notice}` : state}`}</R>
      </T>
      {a.status === "failed" && a.uri !== "" ? <TermButton label="retry" onPress={props.onRetry} accessibilityLabel={`Retry upload of ${a.name}`} /> : null}
      <TermButton label="x" onPress={props.onRemove} accessibilityLabel={`Remove ${a.name}`} />
    </View>
  );
}

/**
 * The TUI's goal indicator, at the right end of the footer ("Pursuing goal (1m)" for Codex, "/goal active (5m)" for
 * Claude). While a Codex goal is active and a turn runs the time counts on from the later of this screen's first
 * sight of the goal and of the turn (the web's GoalStatusText).
 */
function GoalTui(props: { goal: NonNullable<ReturnType<typeof goalOf>>; running: boolean }) {
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
    <T c="accept" numberOfLines={1} style={styles.goal}>
      {goalTuiText(goal, ticking, (now - baseline) / 1000, now)}
    </T>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 10 },
  row: { flexDirection: "row" },
  fill: { flex: 1, minWidth: 0 },
  footerRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 12 },
  spacer: { flex: 1 },
  goal: { flexShrink: 1, alignSelf: "center" },
});
