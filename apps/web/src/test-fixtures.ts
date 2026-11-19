// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/test-fixtures.ts (makeStreamingTimelineFixture).
// Local changes: timestamps are ISO strings and ids are plain strings; the thread projection
// fixtures are left out.
import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2TurnItem } from "@maru/shared";

export function makeStreamingTimelineFixture(text = "") {
  const threadId = "streaming-thread";
  const runId = "live-run";
  const historyRunId = "history-run";
  const time = (second: number) => new Date(Date.UTC(2026, 8, 4, 0, 0, second)).toISOString();
  const base = (id: string, run: string, second: number) => ({
    id,
    threadId,
    runId: run,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
    status: "completed" as const,
    title: null,
    startedAt: time(second),
    completedAt: time(second),
    updatedAt: time(second),
  });
  const items: OrchestrationV2TurnItem[] = [
    {
      ...base("history-user-item", historyRunId, 0),
      type: "user_message",
      messageId: "history-user",
      text: "Inspect",
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "web",
    },
    {
      ...base("history-work", historyRunId, 1),
      type: "command_execution",
      status: "failed",
      input: "vp test",
      output: "Test failed",
      exitCode: 1,
    },
    {
      ...base("history-assistant-item", historyRunId, 3),
      type: "assistant_message",
      messageId: "history-assistant",
      text: "Done",
      streaming: false,
      updatedAt: time(4),
    },
    {
      ...base("live-user-item", runId, 5),
      type: "user_message",
      messageId: "live-user",
      text: "Continue",
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "web",
    },
    {
      ...base("live-work", runId, 6),
      type: "dynamic_tool",
      toolName: "read_file",
      input: { path: "/repo/src/index.ts" },
      output: "Contents",
    },
    {
      ...base("live-assistant-item", runId, 7),
      type: "assistant_message",
      messageId: "live-assistant",
      text,
      streaming: true,
      status: "running",
      completedAt: null,
    },
  ];
  const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = items.map((item, position) => ({
    position,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  }));
  return { threadId, runId, historyRunId, visibleTurnItems, time, base };
}
