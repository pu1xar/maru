// The terminal mode's transcript (the web's TerminalTimeline.tsx): the thread's blocks (terminalModel.ts)
// drawn as the CLI draws them, with the waiting messages and the progress line under the last block.
// Newest at the bottom of an inverted list, as the chat timeline is; scrolling up past the oldest
// block asks for the previous page, and a screen that starts at a compaction stops there until the
// reader asks for the history before it.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import type { PendingSend, ThreadSnapshot } from "@maru/shared";
import {
  DONE_VERBS,
  PROGRESS_VERBS,
  SPINNER_FRAMES,
  elapsedLabel,
  hashPick,
  progressDetail,
  stampTime,
  type TermBlock,
} from "../../../../web/src/components/terminal/terminalModel.ts";
import { queuedStateLabel } from "../../../../web/src/lib/queuedMessages.logic.ts";
import { linesBefore } from "../../lib/terminalView.logic.ts";
import type { TerminalBlocksView } from "../../lib/useTerminalBlocks.ts";
import { sendMovedList } from "../../lib/timelineView.ts";
import { Block } from "./TerminalBlocks.tsx";
import { Blank, Cells, R, Selectable, T, TermButton, TextRole, useTerm } from "./term.tsx";

const FOLLOW_TOP_SLACK = 0.4;

interface Item {
  block: TermBlock;
  /** Empty lines above the block. */
  gap: 0 | 1;
}

/** The progress line's "↓ N tokens": this run's output so far when the server counts it, else the last response's. */
function runOutputTokens(snapshot: ThreadSnapshot): number | null {
  const usage = snapshot.tokenUsage as (ThreadSnapshot["tokenUsage"] & { runOutputTokens?: unknown }) | null;
  if (typeof usage?.runOutputTokens === "number") return usage.runOutputTokens;
  return usage?.lastOutputTokens ?? null;
}

/** `✻ Verb… (12s  ↓ 1.2k tokens)` while a turn runs. */
function ProgressLine(props: { runKey: string; startedAt: string | null; outputTokens: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  const [frame, setFrame] = useState(0);
  // Advances the spinner frame and the clock.
  useEffect(() => {
    const t = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
      setNow(Date.now());
    }, 160);
    return () => clearInterval(t);
  }, []);
  const started = props.startedAt ? Date.parse(props.startedAt) : NaN;
  const elapsed = Number.isFinite(started) ? now - started : 0;
  // The verb shifts between the Claude color and its shimmer (index.css term-shimmer, 2s).
  const shimmer = Math.floor(now / 1000) % 2 === 1;
  return (
    <T>
      <R c="claude">{SPINNER_FRAMES[frame]}</R>
      {" "}
      <R c={shimmer ? "shimmer" : "claude"}>{`${hashPick(PROGRESS_VERBS, props.runKey)}…`}</R>
      {" "}
      <R c="dim">{progressDetail(elapsed, props.outputTokens)}</R>
    </T>
  );
}

/** The messages that wait for the model, drawn as the CLI draws its queue (a dim user line), with the touch controls the keys give there. */
function QueuedLines(props: {
  sends: readonly PendingSend[];
  busy: ReadonlySet<string>;
  sendNow: { busy: boolean; onSend: () => void } | null;
  onRecall: (id: string) => void;
}) {
  const { tokens, cellW } = useTerm();
  return (
    <>
      {props.sends.map((s) => {
        const failed = s.state === "failed";
        return (
          <View key={s.id}>
            <Blank />
            <View style={[styles.row, { backgroundColor: tokens.userBg, paddingRight: cellW }]}>
              <Cells n={2}>
                <T c="dim">{"❯ "}</T>
              </Cells>
              <View style={styles.fill}>
                <TextRole role="dim">
                  <T>{s.text}</T>
                </TextRole>
              </View>
            </View>
            {failed ? <T c="err">{`  ${s.error ?? "Not sent"}`}</T> : null}
            {s.state === "taken" ? null : (
              <View style={[styles.row, { paddingLeft: 2 * cellW, gap: 8 }]}>
                <T c="dim" style={styles.stateLabel}>{s.state === "sending" ? "Sending…" : queuedStateLabel(s)}</T>
                {props.sendNow && s.state === "queued" ? <TermButton label="send now" disabled={props.sendNow.busy} onPress={props.sendNow.onSend} accessibilityLabel="Send now" /> : null}
                {s.recall.enabled ? (
                  <TermButton label="take back" disabled={props.busy.has(s.id)} onPress={() => props.onRecall(s.id)} accessibilityLabel="Move back to input" />
                ) : null}
              </View>
            )}
          </View>
        );
      })}
    </>
  );
}

export function TerminalTimeline(props: {
  snapshot: ThreadSnapshot;
  view: TerminalBlocksView;
  columns: number;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onOpenThread: (threadId: string) => void;
  /** Counts the messages the reader sent; a new value brings the list back to its end. */
  sendTick: number;
  queued: readonly PendingSend[];
  queuedBusy: ReadonlySet<string>;
  sendNow: { busy: boolean; onSend: () => void } | null;
  onRecall: (id: string) => void;
  /** The long press on a user line: the message menu (copy, rewind, fork); null where there is none. */
  onUserMenu: ((blockId: string, text: string) => void) | null;
}) {
  const { snapshot, view } = props;
  const { blocks, run } = view;
  const listRef = useRef<FlatList<Item>>(null);

  // The run that ended while this view was open leaves "✻ Worked for Ns" under the last block.
  const [seenRunning, setSeenRunning] = useState<string | null>(null);
  const latest = run.latestRun;
  useEffect(() => {
    if (run.isWorking && latest) setSeenRunning(latest.runId);
  }, [run.isWorking, latest]);
  const finished = !run.isWorking && latest && seenRunning === latest.runId && latest.startedAt && latest.completedAt ? latest : null;

  const seenTick = useRef(props.sendTick);
  useEffect(() => {
    const moved = sendMovedList(seenTick.current, props.sendTick);
    seenTick.current = props.sendTick;
    if (moved) listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, [props.sendTick]);

  // The newest block first: an inverted list keeps the end in view as blocks arrive.
  const data = useMemo<Item[]>(() => {
    const items = blocks.map((block, i) => ({ block, gap: linesBefore(blocks[i - 1], block) }));
    return items.reverse();
  }, [blocks]);

  const { grid } = useTerm();
  const { onOpenThread, onUserMenu } = props;
  const { openGroup, showEarlier, beforeCompaction } = view;
  const columns = props.columns;
  const renderItem = useCallback(
    ({ item }: { item: Item }) => {
      const block = item.block;
      return (
        <View style={{ marginTop: item.gap * grid.lineHeight }}>
          {/* A user line has its own long press (the message menu); the rest selects and copies. */}
          <Selectable on={block.kind !== "user"}>
            <Block
              block={block}
              columns={columns}
              onOpenGroup={openGroup}
              onOpenThread={onOpenThread}
              onShowEarlier={block.kind === "compaction" && !beforeCompaction ? showEarlier : undefined}
              onUserMenu={block.kind === "user" && onUserMenu ? (text) => onUserMenu(block.id, text) : null}
            />
          </Selectable>
        </View>
      );
    },
    [columns, grid.lineHeight, openGroup, onOpenThread, beforeCompaction, showEarlier, onUserMenu],
  );

  // A screen that starts at a compaction stops there, as the CLI's does; [show earlier history] opens what is before it.
  const stopsAtCompaction = !beforeCompaction && blocks[0]?.kind === "compaction";
  const loadOlder = () => {
    if (snapshot.hasMoreBefore && !props.loadingOlder && !stopsAtCompaction) props.onLoadOlder();
  };

  const tail: ReactNode =
    props.queued.length > 0 || run.isWorking || finished ? (
      <View>
        <QueuedLines sends={props.queued} busy={props.queuedBusy} sendNow={props.sendNow} onRecall={props.onRecall} />
        {run.isWorking ? (
          <View>
            <Blank />
            <ProgressLine runKey={latest?.runId ?? snapshot.threadId} startedAt={run.activeTurnStartedAt} outputTokens={runOutputTokens(snapshot)} />
          </View>
        ) : finished ? (
          <View>
            <Blank />
            <T c="dim">
              {`✻ ${hashPick(DONE_VERBS, finished.runId)} for ${elapsedLabel(Date.parse(finished.completedAt!) - Date.parse(finished.startedAt!))}  done ${stampTime(finished.completedAt!).replace(/^0/, "")}`}
            </T>
          </View>
        ) : null}
      </View>
    ) : null;

  const empty = blocks.length === 0 && !run.isWorking && props.queued.length === 0;
  return (
    <FlatList
      ref={listRef}
      // One list per thread, so a switch starts at the newest block.
      key={snapshot.threadId}
      inverted
      data={data}
      keyExtractor={keyOf}
      renderItem={renderItem}
      contentContainerStyle={styles.content}
      onEndReached={loadOlder}
      onEndReachedThreshold={FOLLOW_TOP_SLACK}
      ListFooterComponent={
        snapshot.hasMoreBefore || props.loadingOlder ? (
          <View style={styles.history}>
            {props.loadingOlder ? <T c="dim">Loading earlier history</T> : <TermButton label="Load earlier history" onPress={props.onLoadOlder} />}
          </View>
        ) : empty ? (
          <T c="dim">The conversation is empty</T>
        ) : undefined
      }
      ListHeaderComponent={tail ?? undefined}
      keyboardShouldPersistTaps="handled"
    />
  );
}

const keyOf = (item: Item) => item.block.id;

const styles = StyleSheet.create({
  row: { flexDirection: "row" },
  fill: { flex: 1, minWidth: 0 },
  content: { paddingHorizontal: 10, paddingTop: 3, paddingBottom: 3 },
  history: { alignItems: "center", marginBottom: 8 },
  stateLabel: { alignSelf: "center" },
});
