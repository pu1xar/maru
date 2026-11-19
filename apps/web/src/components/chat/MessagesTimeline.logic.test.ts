// Cases adapted from T3 Code apps/web/src/components/chat/MessagesTimeline.logic.test.ts (MIT,
// Copyright (c) 2026 T3 Tools Inc.), with Korean labels and ISO-string timestamps.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2TurnItem } from "@maru/shared";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic.ts";
import { makeStreamingTimelineFixture } from "../../test-fixtures.ts";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
  liveWorkEntryLabel,
  timelineTurnFoldRunIdsByEntryId,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic.ts";

type Row<K extends MessagesTimelineRow["kind"]> = Extract<MessagesTimelineRow, { kind: K }>;

function message(
  id: string,
  createdAt: string,
  role: "user" | "assistant",
  runId: string | null,
  extra: { updatedAt?: string; inputIntent?: "turn_start" | "steer"; streaming?: boolean } = {},
): TimelineEntry {
  return {
    kind: "message",
    id,
    createdAt,
    message: {
      id,
      role,
      text: id,
      runId,
      createdAt,
      updatedAt: extra.updatedAt ?? createdAt,
      streaming: extra.streaming ?? false,
      ...(extra.inputIntent ? { inputIntent: extra.inputIntent } : {}),
    },
  };
}

function work(id: string, createdAt: string, runId: string | null, fields: Partial<WorkLogEntry> = {}): TimelineEntry {
  return {
    kind: "work",
    id,
    createdAt,
    entry: { id, createdAt, runId, label: "Ran command", tone: "tool", ...fields },
  };
}

const settled = { isWorking: false, turnDiffSummaries: [], supportsConversationRollback: false } as const;

describe("deriveMessagesTimelineRows", () => {
  test("folds settled work and keeps every assistant message in place", () => {
    const timelineEntries = [
      message("user-entry", "2026-01-01T00:00:00Z", "user", null),
      message("assistant-first-entry", "2026-01-01T00:00:05Z", "assistant", "turn-1", {
        updatedAt: "2026-01-01T00:00:06Z",
      }),
      work("work-entry-1", "2026-01-01T00:00:08Z", "turn-1"),
      message("assistant-final-entry", "2026-01-01T00:00:20Z", "assistant", "turn-1", {
        updatedAt: "2026-01-01T00:00:22Z",
      }),
    ];
    const opened = deriveMessagesTimelineRows({ ...settled, timelineEntries, activeTurnStartedAt: null });
    assert.deepEqual(
      opened.map((row) => row.id),
      ["user-entry", "turn-fold:turn-1", "assistant-first-entry", "work-entry-1", "assistant-final-entry"],
    );
    const openedFold = opened.find((row): row is Row<"turn-fold"> => row.kind === "turn-fold");
    assert.equal(openedFold?.expanded, true);
    const collapsed = deriveMessagesTimelineRows({
      ...settled,
      timelineEntries,
      activeTurnStartedAt: null,
      collapsedRunIds: new Set(["turn-1"]),
    });
    const fold = collapsed.find((row): row is Row<"turn-fold"> => row.kind === "turn-fold");
    assert.equal(fold?.runId, "turn-1");
    assert.equal(fold?.expanded, false);
    assert.equal(fold?.label, "Worked for 22s");
    assert.deepEqual(
      collapsed.map((row) => row.id),
      ["user-entry", "turn-fold:turn-1", "assistant-first-entry", "assistant-final-entry"],
    );
  });

  for (const count of [1, 2, 3]) {
    test(`folds ${count} completed activities after the terminal response`, () => {
      const runId = "turn-1";
      const timelineEntries = [
        work("work-entry-before-text", "2026-01-01T00:00:01Z", runId, { label: "Status updated", tone: "info" }),
        message("assistant-final-entry", "2026-01-01T00:00:05Z", "assistant", runId, {
          updatedAt: "2026-01-01T00:00:06Z",
        }),
        ...Array.from({ length: count }, (_, index) =>
          work(`work-entry-after-text-${index}`, `2026-01-01T00:00:0${index + 7}Z`, runId, {
            itemType: "command_execution",
            toolLifecycleStatus: "completed",
          }),
        ),
      ];
      const input = {
        ...settled,
        latestRun: { runId, status: "completed" as const, startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:10Z" },
        activeTurnStartedAt: null,
      };
      const collapsedInput = { ...input, collapsedRunIds: new Set([runId]) };
      const rows = deriveMessagesTimelineRows({ ...collapsedInput, timelineEntries });
      assert.deepEqual(rows.map((row) => row.id), ["turn-fold:turn-1", "assistant-final-entry"]);
      const expanded = deriveMessagesTimelineRows({ ...input, timelineEntries });
      assert.ok(
        expanded.some(
          (row) =>
            row.id === "work-entry-after-text-0" ||
            (row.kind === "work-toggle" && row.id === "work-toggle:work-entry-after-text-0" && row.hiddenCount === count),
        ),
      );
      const failedEntries = timelineEntries.map((entry) =>
        entry.kind === "work" && entry.id === "work-entry-after-text-0"
          ? { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "failed" as const } }
          : entry,
      );
      const failedRows = deriveMessagesTimelineRows({ ...collapsedInput, timelineEntries: failedEntries });
      assert.ok(failedRows.some((row) => row.id === "work-entry-after-text-0"));
      const pendingEntries = timelineEntries.map((entry) =>
        entry.kind === "work" && entry.id === "work-entry-after-text-0"
          ? { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "inProgress" as const } }
          : entry,
      );
      const pendingRows = deriveMessagesTimelineRows({
        ...input,
        timelineEntries: pendingEntries,
        latestRun: { ...input.latestRun, status: "running", completedAt: null },
        isWorking: true,
        activeTurnStartedAt: input.latestRun.startedAt,
      });
      assert.ok(pendingRows.some((row) => row.kind === "work-live" && row.entry.id === "work-entry-after-text-0"));
    });
  }

  test("uses latest-turn timings and the stopped label for an interrupted latest turn", () => {
    const rows = deriveMessagesTimelineRows({
      ...settled,
      timelineEntries: [work("work-entry-1", "2026-01-01T00:00:05Z", "turn-1")],
      latestRun: { runId: "turn-1", status: "interrupted", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:47Z" },
      activeTurnStartedAt: null,
      collapsedRunIds: new Set(["turn-1"]),
    });
    assert.equal(rows.length, 1);
    assert.partialDeepStrictEqual(rows[0], {
      kind: "turn-fold",
      runId: "turn-1",
      label: "Interrupted after 47s",
      expanded: false,
    });
  });

  test("splits a settled turn's work at each steer and keeps the total time on top", () => {
    const runId = "steered-run";
    const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const rows = (collapsedRunIds: ReadonlySet<string>) =>
      deriveMessagesTimelineRows({
        ...settled,
        timelineEntries: [
          message("prompt", time(0), "user", runId, { inputIntent: "turn_start" }),
          work("work-before-steer", time(4), runId),
          message("steer", time(10), "user", runId, { inputIntent: "steer" }),
          work("work-after-steer", time(15), runId),
          message("final", time(30), "assistant", runId),
        ],
        latestRun: { runId, status: "completed", startedAt: time(0), completedAt: time(30) },
        collapsedRunIds,
      });
    const segmentKey = `${runId}:steer:steer`;
    assert.deepEqual(rows(new Set()).map((row) => row.id), [
      "prompt",
      `turn-fold:${runId}`,
      "work-before-steer",
      "steer",
      `turn-fold:${segmentKey}`,
      "work-after-steer",
      "final",
    ]);
    const collapsed = rows(new Set([runId, segmentKey]));
    assert.deepEqual(
      collapsed.map((row) => row.id),
      ["prompt", `turn-fold:${runId}`, "steer", `turn-fold:${segmentKey}`, "final"],
    );
    assert.partialDeepStrictEqual(collapsed[1], { label: "Worked for 30s" });
    assert.partialDeepStrictEqual(collapsed[3], { label: "Worked 20s more", createdAt: time(10) });
    assert.deepEqual(
      rows(new Set([runId])).map((row) => row.id),
      ["prompt", `turn-fold:${runId}`, "steer", `turn-fold:${segmentKey}`, "work-after-steer", "final"],
    );
  });

  test("keeps three messages between tool runs visible and folds only the work", () => {
    const runId = "turn-1";
    const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const timelineEntries = [
      message("prompt", time(0), "user", runId, { inputIntent: "turn_start" }),
      message("text-1", time(2), "assistant", runId),
      work("work-1", time(4), runId),
      message("text-2", time(6), "assistant", runId),
      work("work-2", time(8), runId),
      work("work-3", time(9), runId),
      message("text-3", time(12), "assistant", runId),
    ];
    const input = {
      ...settled,
      timelineEntries,
      latestRun: { runId, status: "completed" as const, startedAt: time(0), completedAt: time(12) },
    };
    const collapsed = deriveMessagesTimelineRows({ ...input, collapsedRunIds: new Set([runId]) });
    assert.deepEqual(
      collapsed.map((row) => row.id),
      ["prompt", `turn-fold:${runId}`, "text-1", "text-2", "text-3"],
    );
    assert.partialDeepStrictEqual(collapsed[1], { label: "Worked for 12s", expanded: false });
    const expanded = deriveMessagesTimelineRows(input);
    assert.deepEqual(
      expanded.filter((row) => row.kind === "message").map((row) => row.id),
      ["prompt", "text-1", "text-2", "text-3"],
    );
    assert.ok(expanded.findIndex((row) => row.id === "text-1") < expanded.findIndex((row) => row.id === "work-1"));
    assert.ok(expanded.findIndex((row) => row.id === "work-1") < expanded.findIndex((row) => row.id === "text-2"));
    assert.ok(expanded.some((row) => row.kind === "turn-fold" && row.expanded));
  });

  test("a blank assistant message between tool runs stays folded", () => {
    const runId = "turn-1";
    const base = message("blank", "2026-01-01T00:00:03Z", "assistant", runId);
    const blank: TimelineEntry =
      base.kind === "message" ? { ...base, message: { ...base.message, text: "  " } } : base;
    const rows = deriveMessagesTimelineRows({
      ...settled,
      timelineEntries: [
        message("prompt", "2026-01-01T00:00:00Z", "user", runId, { inputIntent: "turn_start" }),
        work("work-1", "2026-01-01T00:00:02Z", runId),
        blank,
        message("final", "2026-01-01T00:00:05Z", "assistant", runId),
      ],
      latestRun: { runId, status: "completed", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:05Z" },
      collapsedRunIds: new Set([runId]),
    });
    assert.deepEqual(rows.map((row) => row.id), ["prompt", `turn-fold:${runId}`, "final"]);
  });

  test("a running turn keeps its messages and work unfolded", () => {
    const runId = "turn-1";
    const rows = deriveMessagesTimelineRows({
      ...settled,
      isWorking: true,
      timelineEntries: [
        message("prompt", "2026-01-01T00:00:00Z", "user", runId, { inputIntent: "turn_start" }),
        message("text-1", "2026-01-01T00:00:02Z", "assistant", runId),
        work("work-1", "2026-01-01T00:00:04Z", runId, { toolLifecycleStatus: "inProgress" }),
      ],
      latestRun: { runId, status: "running", startedAt: "2026-01-01T00:00:00Z", completedAt: null },
      runningRunId: runId,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
    });
    assert.ok(!rows.some((row) => row.kind === "turn-fold"));
    assert.ok(rows.some((row) => row.id === "text-1"));
  });

  test("steered work folds per segment while every message stays visible", () => {
    const runId = "steered-run";
    const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const rows = deriveMessagesTimelineRows({
      ...settled,
      timelineEntries: [
        message("prompt", time(0), "user", runId, { inputIntent: "turn_start" }),
        message("text-before", time(2), "assistant", runId),
        work("work-before-steer", time(4), runId),
        message("steer", time(10), "user", runId, { inputIntent: "steer" }),
        message("text-after", time(12), "assistant", runId),
        work("work-after-steer", time(15), runId),
        message("final", time(30), "assistant", runId),
      ],
      latestRun: { runId, status: "completed", startedAt: time(0), completedAt: time(30) },
      collapsedRunIds: new Set([runId, `${runId}:steer:steer`]),
    });
    assert.deepEqual(rows.map((row) => row.id), [
      "prompt",
      `turn-fold:${runId}`,
      "text-before",
      "steer",
      `turn-fold:${runId}:steer:steer`,
      "text-after",
      "final",
    ]);
  });

  test("carries the latest thought on the live row while a later tool runs", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        work("old-thought", "2026-01-01T00:00:01Z", "turn-1", {
          itemType: "reasoning",
          detail: "First idea.",
          tone: "thinking",
          toolLifecycleStatus: "completed",
        }),
        work("new-thought", "2026-01-01T00:00:02Z", "turn-1", {
          itemType: "reasoning",
          detail: "Found the cause.",
          tone: "thinking",
          toolLifecycleStatus: "completed",
        }),
        work("running-command", "2026-01-01T00:00:03Z", "turn-1", {
          command: "rg cause",
          requestKind: "command",
          toolLifecycleStatus: "inProgress",
        }),
      ],
      latestRun: { runId: "turn-1", status: "running", startedAt: "2026-01-01T00:00:00Z", completedAt: null },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const live = rows.find((row): row is Row<"work-live"> => row.kind === "work-live");
    assert.equal(live?.entry.id, "running-command");
    assert.equal(live?.thought?.id, "new-thought");
    assert.equal(liveWorkEntryLabel(live!.entry, undefined, live!.active), "Running rg");
  });

  test("keeps an actually running tool in the shared activity row", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        work("running-command", "2026-01-01T00:00:05Z", "turn-1", {
          command: "rg toolCall",
          requestKind: "command",
          toolLifecycleStatus: "inProgress",
        }),
        work("completed-edit", "2026-01-01T00:00:06Z", "turn-1", {
          requestKind: "file-change",
          changedFiles: ["src/one.ts", "src/two.ts"],
          toolLifecycleStatus: "completed",
        }),
        work("completed-command", "2026-01-01T00:00:07Z", "turn-1", {
          command: "vp test run",
          requestKind: "command",
          toolLifecycleStatus: "completed",
        }),
      ],
      latestRun: { runId: "turn-1", status: "running", startedAt: "2026-01-01T00:00:00Z", completedAt: null },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    assert.deepEqual(rows.map((row) => row.kind), ["working", "work-live"]);
    const live = rows.find((row): row is Row<"work-live"> => row.kind === "work-live");
    assert.equal(live?.entry.id, "running-command");
    assert.equal(live?.active, true);
    assert.deepEqual(
      live?.groupedEntries.map((entry) => entry.id),
      ["running-command", "completed-edit", "completed-command"],
    );
  });

  test("summarizes a settled tool group in Korean", () => {
    const runId = "turn-1";
    const rows = deriveMessagesTimelineRows({
      ...settled,
      timelineEntries: [
        message("prompt", "2026-01-01T00:00:00Z", "user", runId),
        work("cmd-1", "2026-01-01T00:00:01Z", runId, { itemType: "command_execution", command: "ls", toolLifecycleStatus: "completed" }),
        work("cmd-2", "2026-01-01T00:00:02Z", runId, { itemType: "command_execution", command: "pwd", toolLifecycleStatus: "completed" }),
        work("edit", "2026-01-01T00:00:03Z", runId, { itemType: "file_change", changedFiles: ["a.ts", "b.ts"], toolLifecycleStatus: "completed" }),
        work("read", "2026-01-01T00:00:04Z", runId, { itemType: "dynamic_tool", toolData: { toolName: "Read" }, toolLifecycleStatus: "completed" }),
        message("final", "2026-01-01T00:00:05Z", "assistant", runId),
      ],
    });
    const toggle = rows.find((row): row is Row<"work-toggle"> => row.kind === "work-toggle");
    assert.equal(toggle?.summary, "Ran 2 commands, Changed 2 files, 1 other action");
    assert.equal(toggle?.summaryKind, "mixed");
  });
});

describe("finished turns open by default", () => {
  const runId = "turn-1";
  const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  const entries = [
    message("prompt", time(0), "user", runId, { inputIntent: "turn_start" }),
    work("work-1", time(4), runId, { itemType: "command_execution", toolLifecycleStatus: "completed" }),
    message("final", time(9), "assistant", runId),
  ];
  const finished = {
    ...settled,
    timelineEntries: entries,
    latestRun: { runId, status: "completed" as const, startedAt: time(0), completedAt: time(9) },
  };

  test("shows the work with an open fold row that carries the duration", () => {
    const rows = deriveMessagesTimelineRows(finished);
    assert.deepEqual(rows.map((row) => row.id), ["prompt", `turn-fold:${runId}`, "work-1", "final"]);
    assert.partialDeepStrictEqual(rows[1], { kind: "turn-fold", label: "Worked for 9s", expanded: true });
  });

  test("a turn the reader closed hides only its work, and closing another run leaves it open", () => {
    const closed = deriveMessagesTimelineRows({ ...finished, collapsedRunIds: new Set([runId]) });
    assert.deepEqual(closed.map((row) => row.id), ["prompt", `turn-fold:${runId}`, "final"]);
    assert.partialDeepStrictEqual(closed[1], { expanded: false });
    const other = deriveMessagesTimelineRows({ ...finished, collapsedRunIds: new Set(["other-run"]) });
    assert.deepEqual(other.map((row) => row.id), ["prompt", `turn-fold:${runId}`, "work-1", "final"]);
  });

  test("a new run does not touch what the reader closed", () => {
    const next = "turn-2";
    const rows = deriveMessagesTimelineRows({
      ...settled,
      timelineEntries: [
        ...entries,
        message("prompt-2", time(20), "user", next, { inputIntent: "turn_start" }),
        work("work-2", time(24), next, { itemType: "command_execution", toolLifecycleStatus: "completed" }),
        message("final-2", time(29), "assistant", next),
      ],
      latestRun: { runId: next, status: "completed", startedAt: time(20), completedAt: time(29) },
      collapsedRunIds: new Set([runId]),
    });
    assert.deepEqual(
      rows.map((row) => row.id),
      ["prompt", `turn-fold:${runId}`, "final", "prompt-2", `turn-fold:${next}`, "work-2", "final-2"],
    );
  });

  test("the find's fold lookup names the closed turn that hides an entry", () => {
    const hidden = timelineTurnFoldRunIdsByEntryId({
      timelineEntries: entries,
      latestRun: finished.latestRun,
      isWorking: false,
      runlessWorkActive: false,
      runningRunId: null,
      toolCallVisibility: "showAll",
    });
    assert.equal(hidden.get("work-1"), runId);
  });
});

describe("pictures a tool opened", () => {
  const runId = "turn-1";
  const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  const blobBlock = {
    type: "image",
    mimeType: "image/png",
    blob: {
      raw: { source: "claude-transcript", key: "k", path: "/home/u/.claude/projects/p/s.jsonl", byteOffset: 4096 },
      jsonPath: "$.message.content[0].content[0].source.data",
      mediaType: "image/png",
    },
  };
  const read = (id: string, second: number, path: string, output?: unknown): TimelineEntry =>
    work(id, time(second), runId, {
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
      label: "Read",
      detail: path,
      viewedImagePath: path,
      toolData: { input: { file_path: path }, ...(output === undefined ? {} : { output }) },
    });
  const input = (timelineEntries: TimelineEntry[]) => ({
    ...settled,
    timelineEntries,
    latestRun: { runId, status: "completed" as const, startedAt: time(0), completedAt: time(20) },
  });

  test("a Read of a picture file adds a viewed-images row carrying the transcript copy", () => {
    const rows = deriveMessagesTimelineRows(
      input([
        message("prompt", time(0), "user", runId, { inputIntent: "turn_start" }),
        read("read-1", 4, "/tmp/v.png", [blobBlock]),
        message("final", time(9), "assistant", runId),
      ]),
    );
    const viewed = rows.find((row): row is Row<"viewed-images"> => row.kind === "viewed-images");
    assert.deepEqual(viewed?.images, [
      {
        path: "/tmp/v.png",
        blob: { path: "/home/u/.claude/projects/p/s.jsonl", byteOffset: 4096, jsonPath: "$.message.content[0].content[0].source.data" },
      },
    ]);
  });

  test("a picture read without an image block in the result keeps its path for the file route", () => {
    const rows = deriveMessagesTimelineRows(
      input([
        message("prompt", time(0), "user", runId, { inputIntent: "turn_start" }),
        read("read-1", 4, "/tmp/v.svg", "<svg/>"),
        message("final", time(9), "assistant", runId),
      ]),
    );
    const viewed = rows.find((row): row is Row<"viewed-images"> => row.kind === "viewed-images");
    assert.deepEqual(viewed?.images, [{ path: "/tmp/v.svg", blob: null }]);
  });

  test("closing the turn's fold hides the row with the work it belongs to", () => {
    const rows = deriveMessagesTimelineRows({
      ...input([
        message("prompt", time(0), "user", runId, { inputIntent: "turn_start" }),
        read("read-1", 4, "/tmp/v.png", [blobBlock]),
        message("final", time(9), "assistant", runId),
      ]),
      collapsedRunIds: new Set([runId]),
    });
    assert.ok(!rows.some((row) => row.kind === "viewed-images"));
  });

  test("a Read of a text file adds no viewed-images row", () => {
    const rows = deriveMessagesTimelineRows(
      input([
        message("prompt", time(0), "user", runId, { inputIntent: "turn_start" }),
        work("read-text", time(4), runId, {
          itemType: "dynamic_tool",
          toolLifecycleStatus: "completed",
          detail: "/tmp/a.ts",
          toolData: { input: { file_path: "/tmp/a.ts" }, output: "text" },
        }),
        message("final", time(9), "assistant", runId),
      ]),
    );
    assert.ok(!rows.some((row) => row.kind === "viewed-images"));
  });
});

describe("linked timeline resources", () => {
  const runId = "resource-run";
  const event = (id: string, type: "subagent" | "thread_created", eventRunId = runId): TimelineEntry => ({
    id,
    kind: "event",
    createdAt: "2026-09-08T10:00:02Z",
    projectedItem: { item: { id, type, runId: eventRunId } } as OrchestrationV2ProjectedTurnItem,
  });

  test("groups adjacent subagents without merging across a resource or run boundary", () => {
    const rows = deriveMessagesTimelineRows({
      ...settled,
      timelineEntries: [
        event("a", "subagent"),
        event("b", "subagent"),
        event("c", "thread_created"),
        event("d", "subagent"),
        event("e", "subagent", "other-run"),
      ],
    });
    assert.deepEqual(
      rows.map((row) => row.id),
      ["turn-fold:resource-run", "a", "c", "d", "turn-fold:other-run", "e"],
    );
    const grouped = rows[1] as Row<"event">;
    assert.deepEqual(grouped.subagents?.map((item) => item.item.id), ["a", "b"]);
  });
});

describe("parent run waiting on foreground subagents", () => {
  const runId = "parent-run";
  const threadId = "parent-thread";
  const at = (second: number) => `2026-10-06T10:00:${String(second).padStart(2, "0")}Z`;
  const base = (id: string, second: number) => ({
    id,
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: "parent-provider-turn",
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
    title: null,
    startedAt: at(second),
    completedAt: at(second),
    updatedAt: at(second),
  });
  const child = (id: string, second: number): OrchestrationV2TurnItem => ({
    ...base(id, second),
    status: "running",
    completedAt: null,
    type: "subagent",
    subagentId: id,
    origin: "provider_native",
    driver: "claude",
    providerInstanceId: "claude:.claude",
    childThreadId: null,
    prompt: `Read ${id}`,
    result: null,
  });
  const liveRow = (later: ReadonlyArray<OrchestrationV2TurnItem>, toolCallVisibility?: "hideAll") =>
    deriveMessagesTimelineRows({
      timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: (
          [
            {
              ...base("user", 0),
              status: "completed",
              type: "user_message",
              messageId: "user",
              createdBy: "user",
              creationSource: "web",
              inputIntent: "turn_start",
              text: "Research these in parallel",
              attachments: [],
            },
            {
              ...base("assistant", 1),
              status: "completed",
              type: "assistant_message",
              messageId: "assistant",
              text: "Dispatching three subagents.",
              streaming: false,
            },
            child("a", 2),
            { ...child("b", 3), status: "completed", completedAt: at(3) },
            child("c", 4),
            ...later,
          ] satisfies OrchestrationV2TurnItem[]
        ).map((item) => ({
          position: item.ordinal,
          visibility: "local" as const,
          sourceThreadId: threadId,
          sourceItemId: item.id,
          item,
        })),
        optimisticMessages: [],
      }),
      latestRun: { runId, status: "running", startedAt: at(0), completedAt: null },
      isWorking: true,
      activeTurnStartedAt: at(0),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      ...(toolCallVisibility ? { toolCallVisibility } : {}),
    }).find((row) => row.id === "live-activity-row");
  const thinking = { kind: "thinking", id: "live-activity-row", createdAt: at(0) };

  test("names the running children while the open run has done nothing since launching them", () => {
    assert.deepEqual(liveRow([]), { ...thinking, label: "Waiting on 2 subagents" });
    assert.deepEqual(liveRow([], "hideAll"), { ...thinking, label: "Waiting on 2 subagents" });
  });

  test("keeps the thinking row when a hidden newer parent command follows the children", () => {
    const command: OrchestrationV2TurnItem = {
      ...base("command", 5),
      status: "running",
      completedAt: null,
      type: "command_execution",
      input: "sleep 5",
    };
    assert.deepEqual(liveRow([command], "hideAll"), thinking);
  });
});

describe("streaming v2 row projection", () => {
  function fixture(text = "") {
    const source = makeStreamingTimelineFixture(text);
    const timelineInput = { visibleTurnItems: source.visibleTurnItems, optimisticMessages: [] };
    const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput);
    const input = {
      timelineEntries: timeline.entries,
      latestRun: { runId: source.runId, status: "running" as const, startedAt: source.time(5), completedAt: null },
      runningRunId: source.runId,
      isWorking: true,
      activeTurnStartedAt: source.time(5),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];
    return { ...source, timelineInput, timeline, input };
  }

  function updateText(items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>, text: string) {
    return items.map((row) =>
      row.item.type === "assistant_message" && row.item.streaming
        ? { ...row, item: { ...row.item, text, updatedAt: "2026-09-04T00:00:08.000Z" } }
        : row,
    );
  }

  for (const [before, after] of [
    ["", "Now visible"],
    [" \n", "Now visible"],
    ["Visible", ""],
    ["", " \t\n"],
    ["Visible", "★ Insight\nKeep these line breaks"],
  ] as const) {
    test(`keeps row parity and history identity from ${JSON.stringify(before)} to ${JSON.stringify(after)}`, () => {
      const initial = fixture(before);
      const previous = deriveMessagesTimelineRowsWithState({
        ...initial.input,
        pendingApprovalRequestIds: new Set<string>(),
      });
      Object.freeze(previous.rows);
      for (const row of previous.rows) Object.freeze(row);
      const timelineInput = {
        ...initial.timelineInput,
        visibleTurnItems: updateText(initial.visibleTurnItems, after),
      };
      const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput, initial.timeline);
      const input = {
        ...initial.input,
        timelineEntries: timeline.entries,
        latestRun: { ...initial.input.latestRun },
        pendingApprovalRequestIds: new Set<string>(),
      };
      const next = deriveMessagesTimelineRowsWithState(input, previous);
      assert.deepEqual(
        next.rows,
        deriveMessagesTimelineRows({
          ...input,
          timelineEntries: deriveTimelineEntriesFromVisibleTurnItems(timelineInput),
        }),
      );
      for (const [index, row] of previous.rows.entries()) {
        if ((row.kind === "message" || row.kind === "assistant-meta") && row.message.id === "live-assistant") {
          assert.equal((next.rows[index] as Row<"message">).message.text, after);
          assert.equal(
            (next.rows[index] as Row<"message">).projectedItem,
            timelineInput.visibleTurnItems.at(-1),
          );
          assert.equal(row.message.text, before);
        } else {
          assert.equal(next.rows[index], row);
        }
      }
    });
  }

  test("keeps unchanged rows by identity across a rebuild", () => {
    const initial = fixture("Partial");
    const rows = deriveMessagesTimelineRows(initial.input);
    const stable = computeStableMessagesTimelineRows(rows, { byId: new Map(), result: [] });
    const rebuilt = deriveMessagesTimelineRows({ ...initial.input, latestRun: { ...initial.input.latestRun } });
    const again = computeStableMessagesTimelineRows(rebuilt, stable);
    assert.equal(again, stable);
  });
});
