// The open thread's conversation: the rows the web would draw (lib/useTimeline), newest at the
// bottom of an inverted list; scrolling up past the oldest row asks for the previous page.
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { FlatList, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Text } from "../ui/Text.tsx";
import { ChevronDownIcon } from "lucide-react-native";
import type { ThreadSnapshot } from "@maru/shared";
import type { MessagesTimelineRow } from "../../lib/timeline.ts";
import { sendMovedList, showJumpToEnd, withAlpha } from "../../lib/timelineView.ts";
import { useTimeline } from "../../lib/useTimeline.ts";
import { usePalette } from "../../theme.ts";
import { type } from "../../typography.ts";
import { Press } from "../Press.tsx";
import { TimelineCtx, type TimelineCtxValue } from "./TimelineContext.ts";
import { FindRow } from "./FindRow.tsx";
import { useFindScroll } from "./useFindScroll.ts";
import type { FindVisible, TimelineFind } from "../../lib/threadFind.ts";

export function Timeline(props: {
  snapshot: ThreadSnapshot;
  cwd: string | null;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onOpenThread: (threadId: string) => void;
  /** Under the newest row: the messages still waiting in the queue (QueuedRows). */
  tail?: ReactNode;
  /** Counts the messages the reader sent; a new value brings the list back to its end (DESIGN.md 4.4, sending brings the end). */
  sendTick?: number;
  /** The conversation find (DESIGN.md 6u): the query to paint and the step to bring on screen. */
  find?: TimelineFind | null;
  /** Written with what is on screen, for a find that starts at the reader's place. */
  visibleRef?: MutableRefObject<FindVisible>;
}) {
  const p = usePalette();
  const view = useTimeline(props.snapshot);
  const subagents = props.snapshot.subagents;
  const subagentsById = useMemo(() => new Map(subagents.map((a) => [a.id, a] as const)), [subagents]);
  const { onOpenThread } = props;
  const find = props.find ?? null;
  // Built from stable parts only, so a streamed update re-renders the rows that changed, not all.
  const isWorking = view?.isWorking ?? false;
  const latestRunId = view?.latestRunId ?? null;
  const toggleRun = view?.toggleRun;
  const toggleGroup = view?.toggleGroup;
  const toggleAttempt = view?.toggleAttempt;
  const ctx = useMemo<TimelineCtxValue | null>(
    () =>
      toggleRun && toggleGroup && toggleAttempt
        ? { workspaceRoot: props.cwd ?? undefined, subagentsById, isWorking, latestRunId, toggleRun, toggleGroup, toggleAttempt, openThread: onOpenThread, find }
        : null,
    [props.cwd, subagentsById, isWorking, latestRunId, toggleRun, toggleGroup, toggleAttempt, onOpenThread, find],
  );
  const listRef = useRef<FlatList<MessagesTimelineRow>>(null);
  const [away, setAway] = useState(false);
  const seenTick = useRef(props.sendTick);
  // Sending while reading far up returns to the end: in an inverted list that is offset 0, where the
  // waiting bubble and the sent message sit (without it they stay far below the screen).
  useEffect(() => {
    const moved = sendMovedList(seenTick.current, props.sendTick);
    seenTick.current = props.sendTick;
    if (moved) listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, [props.sendTick]);
  // A switched thread opens at its newest row.
  useEffect(() => setAway(false), [props.snapshot.threadId]);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setAway(showJumpToEnd(e.nativeEvent.contentOffset.y));
  }, []);
  const rows = view?.rows;
  const data = useMemo(() => (rows ? [...rows].reverse() : []), [rows]);
  const findScroll = useFindScroll({ listRef, data, view, find, visibleRef: props.visibleRef });
  if (!view || !ctx) return null;
  if (data.length === 0 && !view.isWorking && !props.snapshot.hasMoreBefore && !props.tail) {
    return (
      <View style={styles.empty}>
        <Text style={[type.row, { color: p.muted }]}>No conversation to show</Text>
      </View>
    );
  }
  return (
    <TimelineCtx.Provider value={ctx}>
      <View style={styles.fill}>
      <FlatList
        ref={listRef}
        // One list per thread, so a switch starts at the newest row (as the web keys its list).
        key={props.snapshot.threadId}
        inverted
        data={data}
        keyExtractor={keyOf}
        renderItem={renderRow}
        contentContainerStyle={styles.content}
        onEndReached={props.onLoadOlder}
        onEndReachedThreshold={0.4}
        ListFooterComponent={
          props.snapshot.hasMoreBefore ? (
            <HistoryControl loading={props.loadingOlder} onLoad={props.onLoadOlder} color={p.muted} rule={withAlpha(p.border, 0.7)} />
          ) : undefined
        }
        // Inverted: the header sits under the newest row.
        ListHeaderComponent={props.tail ? <>{props.tail}</> : undefined}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={100}
        {...findScroll}
      />
      {away ? (
        <View pointerEvents="box-none" style={styles.jumpFrame}>
          <Press
            onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Jump to bottom"
            style={[styles.jump, { backgroundColor: withAlpha(p.bg, 0.8), borderColor: withAlpha(p.border, 0.6) }]}
          >
            <ChevronDownIcon size={14} color={p.text} />
            <Text style={[type.small, { color: p.text, fontWeight: "500" }]}>Jump to bottom</Text>
          </Press>
        </View>
      ) : null}
      </View>
    </TimelineCtx.Provider>
  );
}

/** "Load earlier history" between two rules at the top of the list (web TimelineHistoryControl); the list also asks on its own near the top. */
function HistoryControl({ loading, onLoad, color, rule }: { loading: boolean; onLoad: () => void; color: string; rule: string }) {
  return (
    <Press onPress={onLoad} disabled={loading} hitSlop={8} accessibilityRole="button" accessibilityLabel="Load earlier history" style={styles.history}>
      <View style={[styles.rule, { backgroundColor: rule }]} />
      <Text style={[type.small, { color }]}>{loading ? "Loading earlier history" : "Load earlier history"}</Text>
      <View style={[styles.rule, { backgroundColor: rule }]} />
    </Press>
  );
}

const keyOf = (row: MessagesTimelineRow) => row.id;
const renderRow = ({ item }: { item: MessagesTimelineRow }) => <FindRow row={item} />;

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: "center", justifyContent: "center" },
  fill: { flex: 1 },
  // The list's top and bottom space is 12 (web TIMELINE_LIST_HEADER h-3, the footer's h-3).
  content: { paddingVertical: 12 },
  history: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 8 },
  rule: { flex: 1, height: 1 },
  jumpFrame: { position: "absolute", left: 0, right: 0, bottom: 8, paddingVertical: 6, alignItems: "center" },
  jump: { flexDirection: "row", alignItems: "center", gap: 4, height: 24, paddingHorizontal: 7, borderRadius: 999, borderWidth: 1, elevation: 1 },
});
