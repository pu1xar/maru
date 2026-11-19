import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  clearTimelinePositions,
  movedThreadKey,
  movedTimelineId,
  moveTimelinePositions,
  readTimelinePosition,
  rememberTimelinePosition,
  timelineRestoreStep,
  type RememberedTimelinePosition,
} from "./timelinePositions.ts";

const away = (rowId: string): RememberedTimelinePosition => ({ rowId, offsetWithinRow: 12, scrollOffset: 4000, atEnd: false });

beforeEach(() => clearTimelinePositions());

test("a thread keeps where it was left; following the end counts as at the end", () => {
  assert.equal(readTimelinePosition("claude:a:s1"), undefined);
  rememberTimelinePosition("claude:a:s1", away("m-10"), false);
  assert.deepEqual(readTimelinePosition("claude:a:s1"), away("m-10"));
  rememberTimelinePosition("claude:a:s1", away("m-40"), true);
  assert.equal(readTimelinePosition("claude:a:s1")?.atEnd, true);
  assert.equal(readTimelinePosition("claude:a:s1")?.rowId, "m-40");
});

test("movedThreadKey renames the session and its subagent threads, nothing that only shares the text", () => {
  assert.equal(movedThreadKey("claude:a:s1", "claude:a:s1", "claude:b:s1"), "claude:b:s1");
  assert.equal(movedThreadKey("claude:a:s1:agent-x", "claude:a:s1", "claude:b:s1"), "claude:b:s1:agent-x");
  assert.equal(movedThreadKey("claude:a:s12", "claude:a:s1", "claude:b:s1"), null);
  assert.equal(movedThreadKey("claude:a:s2", "claude:a:s1", "claude:b:s1"), null);
});

test("a move takes the session's and its subagents' positions to the new key and leaves others", () => {
  rememberTimelinePosition("claude:a:s1", away("root"), false);
  rememberTimelinePosition("claude:a:s1:agent-x", away("child"), false);
  rememberTimelinePosition("claude:a:s12", away("other"), false);
  moveTimelinePositions("claude:a:s1", "claude:b:s1");
  assert.equal(readTimelinePosition("claude:a:s1"), undefined);
  assert.equal(readTimelinePosition("claude:a:s1:agent-x"), undefined);
  assert.equal(readTimelinePosition("claude:b:s1")?.rowId, "root");
  assert.equal(readTimelinePosition("claude:b:s1:agent-x")?.rowId, "child");
  assert.equal(readTimelinePosition("claude:a:s12")?.rowId, "other");
  // A second call for the same move finds nothing to carry.
  moveTimelinePositions("claude:a:s1", "claude:b:s1");
  assert.equal(readTimelinePosition("claude:b:s1")?.rowId, "root");
});

test("a moved position names its rows, disclosures and work group anchors under the new key", () => {
  const from = "claude:a:s1";
  const t = `${from}:agent-x`;
  rememberTimelinePosition(
    t,
    {
      // Ids carry their thread id at the start or after a kind.
      rowId: `assistant-meta:${t}:blk:msg_1:1`,
      offsetWithinRow: 30,
      scrollOffset: 900,
      atEnd: false,
      oldestRowId: `${t}:uuid:u0`,
      disclosures: {
        collapsedRuns: new Set([`${t}:run:r1`]),
        workGroups: new Set([`work-group:${t}:uuid:e1`]),
        attempts: new Set(),
        workGroupState: {
          scrollPositions: new Map([[`work-group:${t}:uuid:e1`, { entryId: `${t}:uuid:e2`, offset: 4 }]]),
          expandedEntries: new Set([`subagent-group:${t}:uuid:r1`, "other-entry"]),
        },
      },
    },
    false,
  );
  moveTimelinePositions(from, "claude:b:s1");
  const n = "claude:b:s1:agent-x";
  const moved = readTimelinePosition(n);
  assert.equal(moved?.rowId, `assistant-meta:${n}:blk:msg_1:1`);
  assert.equal(moved?.oldestRowId, `${n}:uuid:u0`);
  assert.equal(moved?.offsetWithinRow, 30);
  assert.deepEqual([...moved!.disclosures!.collapsedRuns], [`${n}:run:r1`]);
  assert.deepEqual([...moved!.disclosures!.workGroups], [`work-group:${n}:uuid:e1`]);
  assert.deepEqual([...moved!.disclosures!.workGroupState.scrollPositions], [
    [`work-group:${n}:uuid:e1`, { entryId: `${n}:uuid:e2`, offset: 4 }],
  ]);
  assert.deepEqual([...moved!.disclosures!.workGroupState.expandedEntries], [`subagent-group:${n}:uuid:r1`, "other-entry"]);
});

test("movedTimelineId renames `<thread id>:` wherever it sits in an id", () => {
  assert.equal(movedTimelineId("claude:a:s1", "claude:a:s1", "claude:b:s1"), "claude:b:s1");
  assert.equal(movedTimelineId("turn-fold:claude:a:s1:run:1", "claude:a:s1", "claude:b:s1"), "turn-fold:claude:b:s1:run:1");
  assert.equal(movedTimelineId("claude:a:s12:uuid:x", "claude:a:s1", "claude:b:s1"), "claude:a:s12:uuid:x");
  assert.equal(movedTimelineId("working-indicator-row", "claude:a:s1", "claude:b:s1"), "working-indicator-row");
});

test("a move keeps a position the new key already has", () => {
  rememberTimelinePosition("claude:a:s1", away("old"), false);
  rememberTimelinePosition("claude:b:s1", away("new"), false);
  moveTimelinePositions("claude:a:s1", "claude:b:s1");
  assert.equal(readTimelinePosition("claude:b:s1")?.rowId, "new");
  assert.equal(readTimelinePosition("claude:a:s1"), undefined);
});

test("a restore away from the end loads older history only while the row may still be in it", () => {
  const step = (rowFound: boolean, hasMoreHistory: boolean, opts: { gaveUp?: boolean; historyReached?: boolean; restoring?: boolean } = {}) =>
    timelineRestoreStep({ restoring: opts.restoring ?? true, rowFound, hasMoreHistory, historyReached: opts.historyReached ?? false, gaveUp: opts.gaveUp ?? false });
  assert.equal(step(true, true, { restoring: false }), "none");
  assert.equal(step(true, true), "scroll");
  assert.equal(step(false, true), "load-older");
  // The history ended without the row, a request added nothing, or the history the list held when
  // the reader left is back without the row (it is gone): the remembered offset stands in.
  assert.equal(step(false, false), "scroll");
  assert.equal(step(false, true, { gaveUp: true }), "scroll");
  assert.equal(step(false, true, { historyReached: true }), "scroll");
});
