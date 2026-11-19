// Runs real ThreadSnapshot fixtures (built by the server projector from Claude transcripts) through
// the ported T3 timeline derivation. The fixtures hold private transcript text, so they stay
// outside the repository: point MARU_TIMELINE_FIXTURES at a directory of snapshot JSON files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ThreadSnapshot } from "@maru/shared";
import {
  deriveThreadTimelineRunState,
  deriveTimelineEntriesFromVisibleTurnItems,
  type TimelineEntry,
} from "./session-logic.ts";
import {
  deriveMessagesTimelineRows,
  type MessagesTimelineRow,
} from "./components/chat/MessagesTimeline.logic.ts";

const FIXTURE_DIR = process.env.MARU_TIMELINE_FIXTURES;

function countBy<T>(values: ReadonlyArray<T>, key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[key(value)] = (counts[key(value)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** Entry ids a row carries, so every derived entry can be traced to a row or a fold. */
function rowEntryIds(row: MessagesTimelineRow): string[] {
  switch (row.kind) {
    case "work":
      return row.groupedEntries.map((entry) => entry.id);
    case "work-live":
      return row.groupedEntries.map((entry) => entry.id);
    case "event":
      return row.subagents ? row.subagents.map((item) => item.item.id) : [row.projectedItem.item.id];
    case "message":
    case "context-compaction":
    case "proposed-plan":
      return [row.id];
    default:
      return [];
  }
}

const fixtureFiles = FIXTURE_DIR
  ? fs
      .readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith(".json"))
      .sort()
  : [];

if (!FIXTURE_DIR) {
  test("real transcript fixtures", { skip: "MARU_TIMELINE_FIXTURES is not set" }, () => {});
} else {
  test("fixture directory holds snapshots", () => {
    assert.ok(fixtureFiles.length > 0, `no *.json in ${FIXTURE_DIR}`);
  });
}

for (const name of fixtureFiles) {
  test(`fixture ${name}: entries and rows derive without errors`, () => {
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(FIXTURE_DIR!, name), "utf8"),
    ) as ThreadSnapshot;
    const entries: TimelineEntry[] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: snapshot.visibleTurnItems,
      optimisticMessages: [],
    });
    const runState = deriveThreadTimelineRunState(snapshot);
    const rowsInput = {
      timelineEntries: entries,
      latestRun: runState.latestRun,
      runningRunId: runState.runningRunId,
      isWorking: runState.isWorking,
      runlessWorkActive: runState.runlessWorkActive,
      activeTurnStartedAt: runState.activeTurnStartedAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };
    const rows = deriveMessagesTimelineRows(rowsInput);

    // Row ids key the virtual list; a duplicate would drop or swap rows.
    const ids = rows.map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length, "row ids are unique");

    // Every visible item reaches an entry, or is skipped on purpose (checkpoints, queued
    // messages that have not started).
    const entryIds = new Set(
      entries.map((entry) =>
        entry.kind === "message" ? (entry.projectedItem?.item.id ?? entry.id) : entry.id,
      ),
    );
    const unreached = snapshot.visibleTurnItems.filter(({ item }) => {
      if (entryIds.has(item.id)) return false;
      if (item.type === "checkpoint") return false;
      if (item.type === "user_message" && item.inputIntent === "queued_turn" && item.status === "pending")
        return false;
      return true;
    });
    assert.deepEqual(
      unreached.map(({ item }) => `${item.type}:${item.id}`),
      [],
      "visible items without an entry",
    );

    // Every entry reaches a row, or sits inside a closed fold (turn fold or work group). Finished
    // turns open by default, so the default rows are the open ones; the loop opens work groups
    // until nothing new appears.
    const expandedWorkGroupIds = new Set<string>();
    let expandedRows = deriveMessagesTimelineRows({ ...rowsInput, collapsedRunIds: new Set(), expandedWorkGroupIds });
    for (;;) {
      const before = expandedWorkGroupIds.size;
      for (const row of expandedRows) {
        if (row.kind === "work-toggle") expandedWorkGroupIds.add(row.groupId);
      }
      if (expandedWorkGroupIds.size === before) break;
      expandedRows = deriveMessagesTimelineRows({ ...rowsInput, collapsedRunIds: new Set(), expandedWorkGroupIds });
    }
    const shown = new Set([...rows, ...expandedRows].flatMap(rowEntryIds));
    const lost = entries.filter((entry) => {
      const id = entry.kind === "message" ? entry.message.id : entry.id;
      if (shown.has(id)) return false;
      // A reasoning item without text is dropped from groups on purpose (T3 workEntryIsVisibleInGroup).
      if (entry.kind === "work" && entry.entry.itemType === "reasoning" && !entry.entry.detail?.trim())
        return false;
      return true;
    });
    assert.deepEqual(
      lost.map((entry) => `${entry.kind}:${entry.id}`),
      [],
      "entries that reach no row even with every fold open",
    );

    const itemTypes = countBy(snapshot.visibleTurnItems, ({ item }) => item.type);
    const entryKinds = countBy(entries, (entry) =>
      entry.kind === "work" ? `work/${entry.entry.itemType ?? "?"}` : entry.kind,
    );
    const rowKinds = countBy(rows, (row) => row.kind);
    console.log(
      JSON.stringify({
        fixture: name,
        visibleTurnItems: snapshot.visibleTurnItems.length,
        runs: snapshot.runs.length,
        runtime: snapshot.runtime?.status ?? null,
        isWorking: runState.isWorking,
        itemTypes,
        entryKinds,
        rows: rows.length,
        rowKinds,
        expandedRows: expandedRows.length,
        foldLabels: rows.flatMap((row) => (row.kind === "turn-fold" ? [row.label] : [])),
        toggleSummaries: rows.flatMap((row) => (row.kind === "work-toggle" ? [row.summary] : [])),
      }),
    );
  });
}
