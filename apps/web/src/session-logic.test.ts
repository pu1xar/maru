// Cases adapted from T3 Code apps/web/src/session-logic.test.ts (MIT, Copyright (c) 2026 T3 Tools
// Inc.), with Korean labels and ISO-string timestamps.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  ThreadRuntimeSummary,
} from "@maru/shared";
import {
  deriveCanInterruptRunningThread,
  derivePhase,
  deriveThreadTimelineRunState,
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  isLatestRunSettled,
  providerErrorPresentation,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolFailure,
  type WorkLogEntry,
} from "./session-logic.ts";
import { deriveMessagesTimelineRows } from "./components/chat/MessagesTimeline.logic.ts";
import { makeStreamingTimelineFixture } from "./test-fixtures.ts";

const NOW = "2026-06-20T00:00:00.000Z";

function visible(item: OrchestrationV2TurnItem, position = 0): OrchestrationV2ProjectedTurnItem {
  return { position, visibility: "local", sourceThreadId: item.threadId, sourceItemId: item.id, item };
}

function baseItem(id: string, ordinal: number, runId = "run-visible") {
  return {
    id,
    threadId: "thread-visible",
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
  };
}

describe("V2 session presentation", () => {
  test("uses run status as the settlement boundary", () => {
    const runId = "run-1";
    assert.equal(
      isLatestRunSettled(
        { runId, status: "completed", startedAt: NOW, completedAt: "2026-06-20T00:01:00.000Z" },
        null,
      ),
      true,
    );
    assert.equal(
      isLatestRunSettled(
        { runId, status: "running", startedAt: null, completedAt: null },
        { status: "running", activeRunId: runId },
      ),
      false,
    );
    assert.equal(
      isLatestRunSettled(
        { runId, status: "queued", startedAt: null, completedAt: null },
        { status: "running", activeRunId: "run-active" },
      ),
      false,
    );
  });

  test("offers Stop while a run is preparing or starting, not just once it's running", () => {
    const runtime = (
      status: ThreadRuntimeSummary["status"],
      activeRunId: string | null = null,
    ): ThreadRuntimeSummary => ({
      status,
      activeRunId,
      providerInstanceId: "claude:.claude",
      providerName: null,
      lastError: null,
    });
    const runId = "run-stop-while-starting";
    for (const status of ["preparing", "starting", "running"] as const) {
      assert.equal(deriveCanInterruptRunningThread(true, runtime(status, runId)), true);
    }
    assert.equal(deriveCanInterruptRunningThread(false, runtime("running", runId)), false);
    assert.equal(derivePhase(runtime("queued")), "connecting");
    assert.equal(deriveCanInterruptRunningThread(true, runtime("queued")), false);
    assert.equal(deriveCanInterruptRunningThread(true, runtime("queued", runId)), true);
    assert.equal(derivePhase(runtime("waiting")), "running");
    assert.equal(deriveCanInterruptRunningThread(true, runtime("waiting")), true);
    assert.equal(deriveCanInterruptRunningThread(true, null), false);
  });

  test("labels provider retry progress, delay, recovery, and exhaustion", () => {
    const retryItem = {
      ...baseItem("item-provider-retry", 1, "run-provider-retry"),
      status: "running" as const,
      title: "Provider retry",
      completedAt: null,
      type: "error" as const,
      failure: {
        class: "provider_error" as const,
        message: "Claude API overloaded.",
        code: "api_error_529",
        retryable: true,
      },
      retry: { attempt: 2, maxAttempts: 10, retryDelayMs: 1_500 },
    } satisfies Extract<OrchestrationV2TurnItem, { type: "error" }>;

    assert.equal(
      providerErrorPresentation({
        ...retryItem,
        status: "failed",
        failure: { ...retryItem.failure, class: "usage_limit" },
      }).label,
      "Usage limit reached after 2/10 retries",
    );
    const recoveredLimit = {
      ...retryItem,
      status: "completed" as const,
      completedAt: NOW,
      failure: { ...retryItem.failure, class: "usage_limit" as const },
    };
    const [recoveredEntry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(recoveredLimit)],
      optimisticMessages: [],
    });
    if (recoveredEntry?.kind !== "work") throw new Error("Expected recovered provider work");
    assert.equal(recoveredEntry.entry.label, "Provider recovered (retry 2/10)");
    assert.notEqual(recoveredEntry.entry.sourceActivityKind, "runtime.warning");
    assert.equal(workEntryDisplayIndicatesToolFailure(recoveredEntry.entry), false);
    assert.deepEqual(providerErrorPresentation(retryItem), {
      label: "Retrying provider (2/10)",
      detail: "Claude API overloaded. Retrying in 1.5s.",
    });
    assert.equal(
      providerErrorPresentation({
        ...retryItem,
        status: "failed",
        retry: { ...retryItem.retry, attempt: 10 },
        completedAt: NOW,
      }).label,
      "Provider error after 10/10 retries",
    );
  });

  test("uses visible turn item order and keeps provider errors in the work log", () => {
    const userItem = {
      ...baseItem("item-user", 0),
      type: "user_message" as const,
      messageId: "message-user",
      inputIntent: "turn_start" as const,
      text: "Start",
      attachments: [],
      createdBy: "user" as const,
      creationSource: "web" as const,
    } satisfies OrchestrationV2TurnItem;
    const requestItem = {
      ...baseItem("item-interrupt-request", 1),
      type: "run_interrupt_request" as const,
      message: "Stopping",
    } satisfies OrchestrationV2TurnItem;
    const commandItem = {
      ...baseItem("item-command", 2),
      type: "command_execution" as const,
      input: "sleep 1",
      output: "done",
      exitCode: 0,
    } satisfies OrchestrationV2TurnItem;
    const resultItem = {
      ...baseItem("item-interrupt-result", 3),
      type: "run_interrupt_result" as const,
      message: "Stopped",
    } satisfies OrchestrationV2TurnItem;
    const todoItem = {
      ...baseItem("item-todo", 4),
      type: "todo_list" as const,
      planId: "plan-visible",
      explanation: "Show task updates where the agent wrote them",
      steps: [
        { id: "step-1", text: "First", status: "completed" as const },
        { id: "step-2", text: "Second", status: "pending" as const },
      ],
    } satisfies OrchestrationV2TurnItem;
    const errorItem = {
      ...baseItem("item-error", 5),
      status: "failed" as const,
      type: "error" as const,
      failure: {
        class: "validation_error" as const,
        message: "Invalid reasoning effort.",
        code: "invalid_request",
        retryable: false,
      },
    } satisfies OrchestrationV2TurnItem;
    const workspacePreparationItem = {
      ...baseItem("item-workspace-preparation", 6),
      type: "command_execution" as const,
      title: "Workspace ready",
      input: "Preparing workspace",
      output: "Workspace preparation completed.",
      exitCode: 0,
    } satisfies OrchestrationV2TurnItem;
    const visibleTurnItems = [
      userItem,
      requestItem,
      commandItem,
      resultItem,
      todoItem,
      errorItem,
      workspacePreparationItem,
    ].map((item, position) => visible(item, position));

    const entries = deriveTimelineEntriesFromVisibleTurnItems({ visibleTurnItems, optimisticMessages: [] });

    assert.deepEqual(
      entries.map((entry) => [entry.kind, entry.id]),
      [
        ["message", userItem.messageId],
        ["event", requestItem.id],
        ["work", commandItem.id],
        ["event", resultItem.id],
        ["work", todoItem.id],
        ["work", errorItem.id],
      ],
    );
    const [userEntry, , commandEntry, , todoEntry, errorEntry] = entries;
    assert.ok(userEntry?.kind === "message");
    assert.equal(userEntry.projectedItem, visibleTurnItems[0]);
    assert.equal(userEntry.message.inputIntent, "turn_start");
    assert.ok(commandEntry?.kind === "work");
    assert.equal(commandEntry.entry.structuredPayload, commandItem);
    assert.equal(commandEntry.entry.command, commandItem.input);
    assert.equal(commandEntry.entry.label, "Ran command");
    assert.equal(commandEntry.entry.detail, undefined);
    assert.ok(todoEntry?.kind === "work");
    assert.equal(todoEntry.entry.label, "To-dos 1/2, Second");
    assert.ok(errorEntry?.kind === "work");
    assert.equal(errorEntry.entry.label, "Provider error");
    assert.equal(errorEntry.entry.detail, "Invalid reasoning effort.");
    assert.equal(errorEntry.entry.tone, "info");
    assert.equal(errorEntry.entry.toolLifecycleStatus, "failed");
  });

  for (const stepStatus of ["pending", "running", "completed"] as const) {
    test(`shows a ${stepStatus} todo update in the timeline where the agent wrote it`, () => {
      const item = {
        ...baseItem("item-tasks", 0, "run-tasks"),
        type: "todo_list" as const,
        planId: "plan-tasks",
        steps: [{ id: "step-1", text: "Verify the change", status: stepStatus }],
      } satisfies OrchestrationV2TurnItem;
      const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [visible(item)],
        optimisticMessages: [],
      });
      assert.ok(entry?.kind === "work");
      assert.equal(
        entry.entry.label,
        stepStatus === "completed" ? "To-dos 1/1" : "To-dos 0/1, Verify the change",
      );
    });
  }

  test("excludes checkpoint-only work from the timeline", () => {
    const message = {
      ...baseItem("done-item", 0),
      type: "assistant_message" as const,
      messageId: "done",
      text: "Done",
      streaming: false,
    } satisfies OrchestrationV2TurnItem;
    const checkpoint = {
      ...baseItem("checkpoint", 1),
      type: "checkpoint" as const,
      checkpointId: "checkpoint",
      scopeId: "scope",
      files: [],
    } satisfies OrchestrationV2TurnItem;
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(message), visible(checkpoint, 1)],
      optimisticMessages: [],
    });
    assert.deepEqual(entries.map((entry) => entry.kind), ["message"]);
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      latestRun: { runId: "run-visible", status: "completed", startedAt: NOW, completedAt: NOW },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    assert.deepEqual(rows.map((row) => row.kind), ["message"]);
  });

  test("labels Claude Read, Grep and Edit tools in Korean from their input", () => {
    const read = {
      ...baseItem("read", 0),
      type: "dynamic_tool" as const,
      toolName: "Read",
      input: { file_path: "/repo/src/index.ts" },
    } satisfies OrchestrationV2TurnItem;
    const grep = {
      ...baseItem("grep", 1),
      type: "dynamic_tool" as const,
      toolName: "Grep",
      input: { pattern: "deriveRows", path: "/repo/src" },
    } satisfies OrchestrationV2TurnItem;
    const edit = {
      ...baseItem("edit", 2),
      type: "file_change" as const,
      fileName: "src/index.ts",
    } satisfies OrchestrationV2TurnItem;
    const labels = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(read), visible(grep, 1), visible(edit, 2)],
      optimisticMessages: [],
    }).map((entry) => (entry.kind === "work" ? entry.entry.label : entry.kind));
    assert.deepEqual(labels, ["Read /repo/src/index.ts", "Searched deriveRows in src", "Changed src/index.ts"]);
  });

  test("derives the read-only run inputs from a snapshot like T3's guest timeline", () => {
    const run = {
      runId: "run-1",
      status: "running" as const,
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      assistantMessageId: null,
    };
    const state = deriveThreadTimelineRunState({
      runs: [{ ...run, runId: "run-0", status: "completed", completedAt: NOW }, run],
      runtime: {
        status: "running",
        activeRunId: "run-1",
        providerInstanceId: "claude:.claude",
        providerName: "Claude",
        lastError: null,
      },
    });
    assert.deepEqual(state, {
      latestRun: run,
      isWorking: true,
      activeTurnStartedAt: NOW,
      runningRunId: "run-1",
      runlessWorkActive: false,
    });
    const subagent = deriveThreadTimelineRunState({
      runs: [],
      runtime: {
        status: "running",
        activeRunId: null,
        providerInstanceId: "claude:.claude",
        providerName: "Claude",
        lastError: null,
      },
    });
    assert.equal(subagent.isWorking, true);
    assert.equal(subagent.runlessWorkActive, true);
  });
});

describe("work-log failure policy", () => {
  const toolEntry = (overrides: Partial<WorkLogEntry>): WorkLogEntry => ({
    id: "entry-1",
    createdAt: "2026-08-27T00:00:00.000Z",
    label: "Ran command",
    tone: "tool",
    ...overrides,
  });

  test("flags success-status rows whose output text reports a failure", () => {
    assert.equal(
      workEntryIndicatesToolFailure(
        toolEntry({ toolLifecycleStatus: "completed", detail: "bash: foo: command not found" }),
      ),
      true,
    );
    assert.equal(
      workEntryIndicatesToolFailure(
        toolEntry({ toolLifecycleStatus: "completed", detail: "<exited with exit code 2>" }),
      ),
      true,
    );
  });

  test("keeps the rendered row calm when only the command mentions failure text", () => {
    const entry = toolEntry({ toolLifecycleStatus: "completed", command: "rg 'command not found' src/" });
    assert.equal(workEntryIndicatesToolFailure(entry), true);
    assert.equal(workEntryDisplayIndicatesToolFailure(entry), false);
  });
});

describe("incremental v2 timeline entries", () => {
  test("retains history and attachment previews through decoded streaming updates", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const attachment = {
      type: "image",
      id: "stream-image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    const visibleTurnItems = fixture.visibleTurnItems.map((row) =>
      row.item.type === "assistant_message"
        ? { ...row, item: { ...row.item, attachments: [attachment] } }
        : row,
    );
    const input = {
      visibleTurnItems,
      optimisticMessages: [],
      attachmentUrlById: new Map([[attachment.id, "https://server.test/image"]]),
    };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    Object.freeze(previous.entries);
    for (const entry of previous.entries) Object.freeze(entry);
    const last = visibleTurnItems.at(-1)!;
    if (last.item.type !== "assistant_message") throw new Error("Expected assistant fixture");
    const nextItem = {
      ...last,
      item: {
        ...last.item,
        text: "Next token",
        attachments: [{ ...attachment }],
        startedAt: fixture.time(7),
        updatedAt: fixture.time(8),
      },
    };
    const nextInput = {
      ...input,
      visibleTurnItems: [...visibleTurnItems.slice(0, -1), nextItem],
      attachmentUrlById: new Map(input.attachmentUrlById),
    };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    assert.deepEqual(next.entries, deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    for (const [index, entry] of previous.entries.slice(0, -1).entries()) {
      assert.equal(next.entries[index], entry);
    }
    const beforeMessage = previous.entries.at(-1)!;
    const nextMessage = next.entries.at(-1)!;
    if (beforeMessage.kind !== "message" || nextMessage.kind !== "message") {
      throw new Error("Expected assistant entries");
    }
    assert.equal(nextMessage.message.attachments, beforeMessage.message.attachments);
    assert.equal(nextMessage.projectedItem, nextItem);
    assert.equal(nextMessage.message.text, "Next token");
    assert.equal(beforeMessage.message.text, "Partial");
  });

  test("appends committed items in canonical order even when their timestamps go backwards", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const input = { visibleTurnItems: fixture.visibleTurnItems, optimisticMessages: [] };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const last = fixture.visibleTurnItems.at(-1)!;
    if (last.item.type !== "assistant_message") throw new Error("Expected assistant fixture");
    const appended = {
      ...last,
      position: last.position + 1,
      sourceItemId: "late-item",
      item: { ...last.item, id: "late-item", messageId: "late-message", startedAt: fixture.time(0) },
    };
    const nextInput = { ...input, visibleTurnItems: [...input.visibleTurnItems, appended] };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    assert.deepEqual(next.entries, deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    assert.equal(next.entries.at(-1)?.id, "late-message");
    for (const [index, entry] of previous.entries.entries()) assert.equal(next.entries[index], entry);
  });

  test("re-derives only the work entry whose tool item changed", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const visibleTurnItems = fixture.visibleTurnItems.map((row) =>
      row.item.id === "live-work"
        ? { ...row, item: { ...row.item, status: "running" as const, completedAt: null } }
        : row,
    );
    const input = { visibleTurnItems, optimisticMessages: [] };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const nextInput = { ...input, visibleTurnItems: fixture.visibleTurnItems };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    assert.deepEqual(next.entries, deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    for (const [index, entry] of previous.entries.entries()) {
      if (entry.id === "live-work") assert.notEqual(next.entries[index], entry);
      else assert.equal(next.entries[index], entry);
    }
  });

  for (const change of ["completion", "provenance", "ordering", "attachment", "run"] as const) {
    test(`rebuilds entries for a ${change} change instead of retaining stale v2 metadata`, () => {
      const fixture = makeStreamingTimelineFixture("Partial");
      const input = { visibleTurnItems: fixture.visibleTurnItems, optimisticMessages: [] };
      const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
      const last = fixture.visibleTurnItems.at(-1)!;
      if (last.item.type !== "assistant_message") throw new Error("Expected assistant fixture");
      const changed: OrchestrationV2ProjectedTurnItem =
        change === "provenance"
          ? { ...last, sourceThreadId: "inherited-thread" }
          : {
              ...last,
              item:
                change === "completion"
                  ? { ...last.item, streaming: false, status: "completed" }
                  : change === "ordering"
                    ? { ...last.item, startedAt: fixture.time(0) }
                    : change === "run"
                      ? { ...last.item, runId: fixture.historyRunId }
                      : {
                          ...last.item,
                          attachments: [
                            { type: "image", id: "new-image", name: "new.png", mimeType: "image/png", sizeBytes: 42 },
                          ],
                        },
            };
      const nextInput = { ...input, visibleTurnItems: [...input.visibleTurnItems.slice(0, -1), changed] };
      const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
      assert.deepEqual(next.entries, deriveTimelineEntriesFromVisibleTurnItems(nextInput));
      assert.notEqual(next.entries.at(-1), previous.entries.at(-1));
    });
  }
});

describe("Claude local command output (maru)", () => {
  test("renders as an assistant message; other notices stay work entries", () => {
    const out: OrchestrationV2ProjectedTurnItem = {
      ...visible({ ...baseItem("notice-1", 1), type: "system_notice", message: "## Context Usage\n\n| a | b |", level: "info" } as OrchestrationV2TurnItem),
      x: { raw: [], sourceKey: "k1", noticeKind: "command_output" },
    };
    const other: OrchestrationV2ProjectedTurnItem = {
      ...visible({ ...baseItem("notice-2", 2), type: "system_notice", message: "hook ran", level: "info" } as OrchestrationV2TurnItem, 1),
      x: { raw: [], sourceKey: "k2", noticeKind: "hook" },
    };
    const entries = deriveTimelineEntriesFromVisibleTurnItems({ visibleTurnItems: [out, other], optimisticMessages: [] });
    const first = entries[0]!;
    assert.equal(first.kind, "message");
    assert.equal(first.kind === "message" && first.message.role, "assistant");
    assert.equal(first.kind === "message" && first.message.text, "## Context Usage\n\n| a | b |");
    assert.equal(entries[1]!.kind, "work");
  });
});
