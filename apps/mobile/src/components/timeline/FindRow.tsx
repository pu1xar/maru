// One timeline row inside the find's scope (DESIGN.md 6u): the row draws as always and, through
// FindHighlightCtx, learns the query to paint, whether it is the step the find shows (its active
// occurrence) and that a fold hiding its text opens. The scope is always there (null without a
// find), so opening or closing the find does not remount rows.
import { memo, useMemo } from "react";
import type { MessagesTimelineRow } from "../../lib/timeline.ts";
import { FindHighlightCtx, type FindHighlight } from "./findHighlight.ts";
import { useTimelineCtx } from "./TimelineContext.ts";
import { TimelineRowView } from "./TimelineRowView.tsx";

export const FindRow = memo(function FindRow({ row }: { row: MessagesTimelineRow }) {
  const find = useTimelineCtx().find;
  const query = find?.query ?? null;
  const target = find?.target ?? null;
  const here = target !== null && target.entryId === row.id;
  const occurrence = here ? target.occurrence : null;
  const value = useMemo<FindHighlight | null>(
    () => (query === null ? null : { query, active: occurrence, revealed: here }),
    [query, occurrence, here],
  );
  return (
    <FindHighlightCtx.Provider value={value}>
      <TimelineRowView row={row} />
    </FindHighlightCtx.Provider>
  );
});
