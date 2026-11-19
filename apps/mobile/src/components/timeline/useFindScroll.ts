// The timeline's side of the conversation find (DESIGN.md 6u): bring the row of the step the find
// shows onto the screen, and tell the find what is on screen (where a new find starts). The step
// names a timeline entry (lib/threadFind.ts); its row may sit inside a finished turn's fold, which
// opens first, and may be far from the rows drawn now, so the list scrolls by index and, where it
// has not measured the rows between, by an estimate it then corrects.
import { useCallback, useEffect, useMemo, useRef, type MutableRefObject, type RefObject } from "react";
import type { FlatList } from "react-native";
import type { MessagesTimelineRow } from "../../lib/timeline.ts";
import type { FindVisible, TimelineFind } from "../../lib/threadFind.ts";
import type { TimelineView } from "../../lib/useTimeline.ts";

/** Where in the screen the row lands: its middle at the screen's middle. */
const VIEW_POSITION = 0.5;
/** A row measured after the first jump moves the list; the jump repeats once the rows settle, ms. */
const SETTLE_MS = 400;
/** The estimate-and-retry loop of a jump over unmeasured rows ends after this many rounds. */
const MAX_JUMP_ROUNDS = 8;
const RETRY_MS = 100;

export function useFindScroll(opts: {
  listRef: RefObject<FlatList<MessagesTimelineRow> | null>;
  /** The list's rows as drawn (newest first, the list is inverted). */
  data: readonly MessagesTimelineRow[];
  view: TimelineView | null;
  find: TimelineFind | null | undefined;
  visibleRef: MutableRefObject<FindVisible> | undefined;
}) {
  const { listRef, data, view, find, visibleRef } = opts;
  const target = find?.target ?? null;
  const index = target ? data.findIndex((r) => r.id === target.entryId) : -1;
  const have = index >= 0;
  const indexRef = useRef(index);
  indexRef.current = index;
  const rounds = useRef(0);
  const scrolledFor = useRef<number | null>(null);

  // A message folded into its finished turn: open that turn, the row then comes.
  const openRun = view?.openRun;
  const foldRunIdOf = view?.foldRunIdOf;
  useEffect(() => {
    if (!target || have || !openRun || !foldRunIdOf) return;
    const runId = foldRunIdOf(target.entryId);
    if (runId !== undefined) openRun(runId);
  }, [target?.seq, target?.entryId, have, openRun, foldRunIdOf]);

  // One scroll per step, once its row is in the list.
  useEffect(() => {
    if (!target || !have || scrolledFor.current === target.seq) return;
    scrolledFor.current = target.seq;
    rounds.current = 0;
    const jump = () => listRef.current?.scrollToIndex({ index: indexRef.current, viewPosition: VIEW_POSITION, animated: false });
    jump();
    const settle = setTimeout(jump, SETTLE_MS);
    return () => clearTimeout(settle);
  }, [target?.seq, have, listRef]);

  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      if (rounds.current++ >= MAX_JUMP_ROUNDS) return;
      listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
      setTimeout(() => listRef.current?.scrollToIndex({ index: info.index, viewPosition: VIEW_POSITION, animated: false }), RETRY_MS);
    },
    [listRef],
  );

  // FlatList reads this callback once, so it is stable and writes through the ref.
  const visible = useRef(visibleRef);
  visible.current = visibleRef;
  const onViewableItemsChanged = useRef((info: { viewableItems: { item?: unknown; index?: number | null }[] }) => {
    const out = visible.current;
    if (!out) return;
    out.current = {
      ids: info.viewableItems.flatMap((v) => (v.item ? [(v.item as MessagesTimelineRow).id] : [])),
      atEnd: info.viewableItems.some((v) => v.index === 0),
    };
  }).current;
  const viewabilityConfig = useMemo(() => ({ itemVisiblePercentThreshold: 1 }), []);

  return { onScrollToIndexFailed, onViewableItemsChanged, viewabilityConfig };
}
