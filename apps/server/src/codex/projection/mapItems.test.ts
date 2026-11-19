import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrchestrationV2TurnItem } from "@maru/shared";
import type { ThreadItem } from "../protocol/v2/ThreadItem.ts";
import { codexItemKey, mapThreadItem } from "./mapItems.ts";
import type { CodexMapContext } from "./mapItems.ts";
import { threadRuntime, tokenUsageSnapshot, turnFailure, turnToRun } from "./summaries.ts";

const KEY = "codex:acct:th1";

function ctx(over: Partial<CodexMapContext> = {}): CodexMapContext {
  return {
    threadKey: KEY,
    account: "acct",
    providerThreadId: "th1",
    providerInstanceId: "codex:.codex",
    turnId: "t1",
    turnStatus: "completed",
    lifecycle: "history",
    userMessageIndex: 0,
    fallbackAt: "2026-11-15T00:00:00.000Z",
    raw: { source: "codex-rpc", key: "k", conn: "thread/turns/list", seq: 1 },
    ...over,
  };
}

/** One item of every ThreadItem type; `satisfies` fails when the protocol gains a type. */
const SAMPLES = {
  userMessage: { type: "userMessage", id: "i", clientId: null, content: [{ type: "text", text: "hi", text_elements: [] }] },
  hookPrompt: { type: "hookPrompt", id: "i", fragments: [{ text: "be nice", hookRunId: "h" }] },
  agentMessage: { type: "agentMessage", id: "i", text: "ok", phase: "final_answer", moderation: null, memoryCitation: null, delivery: null, questions: null },
  functionCallOutput: { type: "functionCallOutput", id: "i", name: "fn", namespace: "ns", output: "out" },
  plan: { type: "plan", id: "i", text: "# plan" },
  reasoning: { type: "reasoning", id: "i", summary: ["**A**"], content: ["raw"] },
  commandExecution: {
    type: "commandExecution",
    id: "i",
    pluginId: null,
    scriptPath: null,
    command: "ls",
    cwd: "/w",
    processId: null,
    source: "agent",
    status: "completed",
    commandActions: [],
    aggregatedOutput: "a\n",
    exitCode: 0,
    durationMs: 3,
  },
  fileChange: { type: "fileChange", id: "i", changes: [{ path: "a.ts", kind: { type: "add" }, diff: "x\n" }], status: "completed" },
  mcpToolCall: {
    type: "mcpToolCall",
    id: "i",
    server: "srv",
    tool: "t",
    status: "completed",
    arguments: { a: 1 },
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: null,
    result: { content: [], structuredContent: null, _meta: null },
    error: null,
    durationMs: 1,
  },
  dynamicToolCall: { type: "dynamicToolCall", id: "i", namespace: null, tool: "dt", arguments: {}, status: "completed", contentItems: null, success: true, durationMs: null },
  collabAgentToolCall: {
    type: "collabAgentToolCall",
    id: "i",
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: "th1",
    receiverThreadIds: ["child"],
    prompt: "do it",
    model: "m",
    reasoningEffort: null,
    agentsStates: {},
  },
  subAgentActivity: { type: "subAgentActivity", id: "i", kind: "completed", agentThreadId: "child", agentPath: "/root/a", model: null, reasoningEffort: null },
  webSearch: { type: "webSearch", id: "i", query: "q", action: null, results: null },
  imageView: { type: "imageView", id: "i", path: "/p.png" },
  sleep: { type: "sleep", id: "i", durationMs: 5 },
  imageGeneration: { type: "imageGeneration", id: "i", status: "completed", revisedPrompt: "cat", failure: null, generationId: null, savedPath: "/c.png", result: "AAAA" },
  enteredReviewMode: { type: "enteredReviewMode", id: "i", review: "r" },
  exitedReviewMode: { type: "exitedReviewMode", id: "i", review: "r" },
  contextCompaction: { type: "contextCompaction", id: "i" },
} satisfies { [K in ThreadItem["type"]]: Extract<ThreadItem, { type: K }> };

/** Expected TurnItem type per ThreadItem type (null: hidden). */
const EXPECTED: { [K in ThreadItem["type"]]: OrchestrationV2TurnItem["type"] | null } = {
  userMessage: "user_message",
  hookPrompt: "system_notice",
  agentMessage: "assistant_message",
  functionCallOutput: "dynamic_tool",
  plan: "proposed_plan",
  reasoning: "reasoning",
  commandExecution: "command_execution",
  fileChange: "file_change",
  mcpToolCall: "dynamic_tool",
  dynamicToolCall: "dynamic_tool",
  collabAgentToolCall: "subagent",
  subAgentActivity: "notification",
  webSearch: "web_search",
  imageView: "dynamic_tool",
  sleep: null,
  imageGeneration: "dynamic_tool",
  enteredReviewMode: null,
  exitedReviewMode: null,
  contextCompaction: "compaction",
};

test("every ThreadItem type maps to its T3 row or is hidden", () => {
  for (const [type, item] of Object.entries(SAMPLES)) {
    const m = mapThreadItem(item as ThreadItem, ctx());
    const want = EXPECTED[type as ThreadItem["type"]];
    if (want === null) {
      assert.equal(m.disposition, "hidden", type);
      assert.equal(m.rows.length, 0, type);
      continue;
    }
    assert.equal(m.disposition, "displayed", type);
    assert.equal(m.rows[0]?.item.type, want, type);
    const row = m.rows[0]!;
    assert.equal(row.item.id, `${KEY}:item:i`, type);
    assert.equal(row.item.runId, `${KEY}:run:t1`, type);
    assert.equal(row.item.providerTurnId, "t1", type);
    assert.deepEqual(row.item.nativeItemRef, { driver: "codex", nativeId: "i", strength: "strong" }, type);
    assert.equal(row.x.sourceKey, m.key, type);
    assert.equal(row.x.raw.length, 1, type);
  }
});

test("an unknown item type is kept as a collapsed notice and counted as unknown", () => {
  const item = { type: "hologram", id: "h1", payload: { z: 1 } } as unknown as ThreadItem;
  const m = mapThreadItem(item, ctx());
  assert.equal(m.key, "codex|item|type=hologram");
  assert.equal(m.disposition, "unknown");
  assert.equal(m.rows.length, 1);
  const row = m.rows[0]!;
  assert.equal(row.item.type, "system_notice");
  assert.equal(row.item.title, "Unknown record");
  assert.equal(row.x.unknown, true);
  assert.deepEqual(row.x.data, { item: { type: "hologram", id: "h1", payload: { z: 1 } } });
});

test("statistics keys carry the sub-discriminators", () => {
  assert.equal(codexItemKey(SAMPLES.collabAgentToolCall), "codex|item|type=collabAgentToolCall|tool=spawnAgent");
  assert.equal(codexItemKey(SAMPLES.subAgentActivity), "codex|item|type=subAgentActivity|kind=completed");
  assert.equal(codexItemKey({ ...SAMPLES.agentMessage, delivery: "async", questions: [{ title: "q", options: null }] }), "codex|item|type=agentMessage|questions");
});

test("commandExecution: actions title, declined, output and exit code", () => {
  const explore = mapThreadItem(
    {
      ...SAMPLES.commandExecution,
      commandActions: [
        { type: "read", command: "cat a.ts", name: "a.ts", path: "/w/a.ts" },
        { type: "search", command: "rg foo src", query: "foo", path: "src" },
      ],
    },
    ctx(),
  ).rows[0]!;
  assert.equal(explore.item.title, "Read a.ts, Search foo in src");
  assert.equal(explore.item.type === "command_execution" && explore.item.output, "a\n");
  assert.equal(explore.item.type === "command_execution" && explore.item.exitCode, 0);
  assert.deepEqual((explore.x.data as { commandActions: unknown[] }).commandActions.length, 2);

  const mixed = mapThreadItem({ ...SAMPLES.commandExecution, commandActions: [{ type: "unknown", command: "make" }] }, ctx()).rows[0]!;
  assert.equal(mixed.item.title, null);

  const declined = mapThreadItem({ ...SAMPLES.commandExecution, status: "declined", aggregatedOutput: null, exitCode: null }, ctx()).rows[0]!;
  assert.equal(declined.item.status, "failed");
  assert.equal(declined.item.toolNonExecutionKind, "declined");
  assert.ok(declined.item.type === "command_execution" && !("output" in declined.item));
});

test("reasoning shows the summary and keeps the raw content in x.body", () => {
  const r = mapThreadItem({ type: "reasoning", id: "r", summary: ["**Plan**", "step two"], content: ["raw a", "raw b"] }, ctx()).rows[0]!;
  assert.ok(r.item.type === "reasoning");
  assert.equal(r.item.text, "**Plan**\n\nstep two");
  assert.equal(r.item.streaming, false);
  assert.equal(r.x.body, "raw a\n\nraw b");
});

test("lifecycle and turn status decide status and streaming", () => {
  const started = mapThreadItem(SAMPLES.agentMessage, ctx({ lifecycle: "started", turnStatus: "inProgress" })).rows[0]!;
  assert.equal(started.item.status, "running");
  assert.ok(started.item.type === "assistant_message" && started.item.streaming);

  const openHistory = mapThreadItem({ ...SAMPLES.agentMessage, completedAtMs: null }, ctx({ turnStatus: "inProgress" })).rows[0]!;
  assert.equal(openHistory.item.status, "running");

  const interrupted = mapThreadItem({ ...SAMPLES.commandExecution, status: "inProgress" }, ctx({ turnStatus: "interrupted" })).rows[0]!;
  assert.equal(interrupted.item.status, "interrupted");

  const timed = mapThreadItem({ ...SAMPLES.agentMessage, startedAtMs: 1_794_000_000_000, completedAtMs: 1_794_000_001_000 }, ctx()).rows[0]!;
  assert.equal(timed.item.startedAt, "2026-11-06T21:20:00.000Z");
  assert.equal(timed.item.completedAt, "2026-11-06T21:20:01.000Z");
  assert.equal(timed.item.updatedAt, timed.item.completedAt);
});

test("userMessage: steer after the first, attachments and their sources", () => {
  const item: ThreadItem = {
    type: "userMessage",
    id: "u",
    clientId: "c1",
    content: [
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: "/tmp/shot.png" },
      { type: "image", url: "data:image/jpeg;base64,AAAA" },
      { type: "skill", name: "deploy", path: "/s/deploy" },
      { type: "text", text: "here", text_elements: [] },
    ],
  };
  const first = mapThreadItem(item, ctx()).rows[0]!;
  assert.ok(first.item.type === "user_message");
  assert.equal(first.item.inputIntent, "turn_start");
  assert.equal(first.item.text, "look\nhere");
  assert.equal(first.item.messageId, first.item.id);
  assert.deepEqual(first.item.attachments, [
    { type: "image", id: "u:1", name: "shot.png", mimeType: "image/png", sizeBytes: 0 },
    { type: "image", id: "u:2", name: "pasted", mimeType: "image/jpeg", sizeBytes: 0 },
  ]);
  assert.deepEqual(first.x.data, {
    attachmentSources: { "u:1": { path: "/tmp/shot.png" }, "u:2": { dataUrlChars: 27 } },
    mentions: [{ type: "skill", name: "deploy", path: "/s/deploy" }],
    clientId: "c1",
  });
  const steer = mapThreadItem(item, ctx({ userMessageIndex: 1 })).rows[0]!;
  assert.ok(steer.item.type === "user_message" && steer.item.inputIntent === "steer");
});

test("agentMessage with async questions adds a user input request", () => {
  const m = mapThreadItem(
    { ...SAMPLES.agentMessage, delivery: "async", questions: [{ title: "Which?", options: ["a", "b"] }] },
    ctx({ lifecycle: "completed" }),
  );
  assert.equal(m.rows.length, 2);
  const req = m.rows[1]!.item;
  assert.ok(req.type === "user_input_request");
  assert.equal(req.id, `${KEY}:item:i:questions`);
  assert.equal(req.requestId, req.id);
  assert.equal(req.status, "waiting");
  assert.deepEqual(req.questions[0]?.options, [
    { label: "a", description: "" },
    { label: "b", description: "" },
  ]);
});

test("fileChange: the daemon's bare hunks and whole-file adds and deletes become one unified diff", () => {
  // Shapes measured on ~/.codex: an update is hunks without file headers, an add or a delete is
  // the whole file text.
  const r = mapThreadItem(
    {
      type: "fileChange",
      id: "f",
      status: "completed",
      changes: [
        { path: "old.ts", kind: { type: "update", move_path: "new.ts" }, diff: "@@ -1,2 +1,3 @@\n-x\n+y\n+z\n keep" },
        { path: "new.md", kind: { type: "add" }, diff: "# T\n\nbody\n" },
        { path: "gone.sql", kind: { type: "delete" }, diff: "-- a comment\nselect 1;" },
      ],
    },
    ctx(),
  ).rows[0]!;
  assert.ok(r.item.type === "file_change");
  assert.equal(r.item.fileName, "old.ts");
  assert.equal(
    r.item.diffStr,
    [
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1,2 +1,3 @@",
      "-x",
      "+y",
      "+z",
      " keep",
      "--- /dev/null",
      "+++ b/new.md",
      "@@ -0,0 +1,3 @@",
      "+# T",
      "+",
      "+body",
      "--- a/gone.sql",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "--- a comment",
      "-select 1;",
      "\\ No newline at end of file",
      "",
    ].join("\n"),
  );
  // Counted from the source: the deleted "-- a comment" line is not taken for a header.
  assert.equal(r.item.additions, 5);
  assert.equal(r.item.deletions, 3);
  assert.deepEqual(r.item.changes, [
    { operation: "move", path: "new.ts", oldPath: "old.ts" },
    { operation: "add", path: "new.md" },
    { operation: "delete", path: "gone.sql" },
  ]);
});

test("subagents: spawn record, collab states and activity signals", () => {
  const spawn = mapThreadItem({ ...SAMPLES.collabAgentToolCall, agentsStates: { child: { status: "running", message: "busy" } } }, ctx());
  assert.equal(spawn.subagent?.childThreadId, "codex:acct:child");
  assert.equal(spawn.subagent?.status, "running");
  assert.equal(spawn.subagent?.parentNodeId, `${KEY}:item:i`);
  assert.ok(spawn.rows[0]?.item.type === "subagent" && spawn.rows[0].item.progress === "busy");

  const wait = mapThreadItem({ ...SAMPLES.collabAgentToolCall, tool: "wait", agentsStates: { child: { status: "completed", message: null } } }, ctx());
  assert.equal(wait.disposition, "hidden");
  assert.deepEqual(wait.subagentSignals, [{ childProviderThreadId: "child", status: "completed" }]);

  const started = mapThreadItem({ ...SAMPLES.subAgentActivity, kind: "started" }, ctx());
  assert.equal(started.disposition, "hidden");
  assert.deepEqual(started.subagentSignals, [{ childProviderThreadId: "child", status: "running" }]);
  const done = mapThreadItem(SAMPLES.subAgentActivity, ctx()).rows[0]!.item;
  assert.ok(done.type === "notification" && done.source.kind === "subagent" && done.source.childThreadId === "codex:acct:child");
});

test("imageGeneration keeps the saved path and leaves the base64 result out", () => {
  const r = mapThreadItem(SAMPLES.imageGeneration, ctx()).rows[0]!;
  assert.ok(r.item.type === "dynamic_tool");
  assert.equal(r.item.toolName, "imagegen");
  assert.equal(r.item.viewedImagePath, "/c.png");
  assert.deepEqual(r.item.output, { savedPath: "/c.png" });
  assert.deepEqual(r.x.data, { resultChars: 4 });
});

test("runs, runtime, token usage and failures", () => {
  const run = turnToRun(KEY, { id: "t9", rootTurnId: null, status: "inProgress", error: null, startedAt: 1_794_000_000, completedAt: null, durationMs: null }, { assistantMessageId: null, waiting: true });
  assert.deepEqual(run, {
    runId: `${KEY}:run:t9`,
    status: "waiting",
    requestedAt: "2026-11-06T21:20:00.000Z",
    startedAt: "2026-11-06T21:20:00.000Z",
    completedAt: null,
    assistantMessageId: null,
    turnEnded: false,
  });
  const opts = { providerInstanceId: "codex:.codex", activeRunId: "r", activityStartedAt: null, lastError: null };
  assert.equal(threadRuntime({ type: "notLoaded" }, opts).status, "idle");
  assert.equal(threadRuntime({ type: "notLoaded" }, opts).activeRunId, null);
  assert.equal(threadRuntime({ type: "active", activeFlags: [] }, opts).status, "running");
  assert.equal(threadRuntime({ type: "active", activeFlags: ["waitingOnUserInput"] }, opts).status, "waiting");
  assert.equal(threadRuntime({ type: "systemError" }, opts).status, "failed");
  assert.ok(threadRuntime({ type: "systemError" }, opts).lastError);

  const usage = tokenUsageSnapshot({
    total: { totalTokens: 100, inputTokens: 90, cachedInputTokens: 50, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 4 },
    last: { totalTokens: 30, inputTokens: 25, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1 },
    modelContextWindow: 258_400,
  });
  assert.equal(usage.usedTokens, 30);
  assert.equal(usage.totalProcessedTokens, 100);
  assert.equal(usage.maxTokens, 258_400);
  assert.equal(usage.inputTokens, 90);
  assert.equal(usage.lastOutputTokens, 5);

  assert.deepEqual(turnFailure({ message: "slow down", codexErrorInfo: "usageLimitExceeded", additionalDetails: null, misalignment: null }, false), {
    class: "usage_limit",
    message: "slow down",
    code: "usageLimitExceeded",
    retryable: false,
  });
  assert.equal(
    turnFailure({ message: "net", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } }, additionalDetails: null, misalignment: null }, true).class,
    "transport_error",
  );
});
