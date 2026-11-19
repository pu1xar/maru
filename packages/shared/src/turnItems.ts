// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Plain TypeScript copies of T3's OrchestrationV2 turn-item contracts (packages/contracts/src/
// orchestrationV2.ts and neighbours) without Effect Schema: brands are strings, DateTimeUtc is an
// ISO string. Our own additions are the `x` extension and the thread-level state (docs/event-model.md 6).

export type IsoDateTime = string;
export type OrchestrationV2Actor = "user" | "agent" | "system";
export type OrchestrationV2CreationSource = "web" | "mobile" | "mcp" | "provider" | "server";

export interface OrchestrationV2ProviderRef {
  driver: string;
  nativeId: string | null;
  strength: "strong" | "weak" | "none";
  fingerprint?: string;
  ordinal?: number;
}

export type OrchestrationV2TurnItemStatus =
  | "idle" | "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";

export type OrchestrationV2NotificationSource =
  | { kind: "subagent"; childThreadId?: string }
  | { kind: "command" }
  | { kind: "monitor" }
  | { kind: "background_task" }
  | { kind: "system" }
  | { kind: "delegated_task"; taskIds: string[]; childThreadId?: string };

export interface OrchestrationV2Notification {
  source: OrchestrationV2NotificationSource;
  outcome: "completed" | "failed" | "cancelled" | "updated" | "unknown";
  summary: string;
  detail?: string;
}

export interface OrchestrationV2PlanStep {
  id: string;
  text: string;
  status: "pending" | "running" | "completed";
  durationAnchorAt?: IsoDateTime;
  durationMs?: number;
}

export interface OrchestrationV2UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string; value?: string; preview?: string }>;
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
  initialAnswer?: string;
  required?: boolean;
}

export type ChatAttachment = { type: string; id: string; name: string; mimeType: string; sizeBytes: number };

export interface UserInputAttachmentAnswerPayload {
  requestId: string;
  questionTextById?: Record<string, string>;
  answers: Record<string, unknown>;
  attachmentsByQuestionId: Record<string, ChatAttachment[]>;
}

export interface OrchestrationV2WebSearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  /** Our additions for a Claude WebFetch (its `toolUseResult`): the fetched body's size, the HTTP status and how long the fetch took. */
  bytes?: number;
  code?: number;
  codeText?: string;
  durationMs?: number;
}

export interface OrchestrationV2FileChangeDetail {
  operation: string;
  path: string;
  oldPath?: string;
  fileType?: string;
  mimeType?: string;
}

export type OrchestrationV2ProviderFailureClass =
  | "usage_limit" | "provider_error" | "transport_error" | "permission_error" | "validation_error" | "unknown";

export interface OrchestrationV2ProviderFailure {
  class: OrchestrationV2ProviderFailureClass;
  message: string;
  code: string | null;
  retryable: boolean | null;
  resetAt?: IsoDateTime | null;
}

export interface OrchestrationV2ProviderRetry { attempt: number; maxAttempts: number | null; retryDelayMs: number | null }

export type ProviderRequestKind = "command" | "file-read" | "file-change" | "mcp-elicitation" | "permission";
export type ProviderApprovalDecision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";
export interface ProviderApprovalOption { decision: ProviderApprovalDecision; label: string; warning?: string }

export interface OrchestrationV2TurnItemBase {
  id: string;
  threadId: string;
  runId: string | null;
  nodeId: string | null;
  providerThreadId: string | null;
  providerTurnId: string | null;
  nativeItemRef: OrchestrationV2ProviderRef | null;
  parentItemId: string | null;
  ordinal: number;
  status: OrchestrationV2TurnItemStatus;
  title: string | null;
  startedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  updatedAt: IsoDateTime;
  toolNonExecutionKind?: string;
}

type Base = OrchestrationV2TurnItemBase;

export type OrchestrationV2TurnItem =
  | (Base & { type: "notification" } & OrchestrationV2Notification)
  | (Base & {
      type: "user_message";
      createdBy: OrchestrationV2Actor;
      creationSource: OrchestrationV2CreationSource;
      messageId: string;
      scheduledTaskId?: string;
      senderThreadId?: string;
      linkedSender?: { environmentId: string; threadId: string; title: string };
      idleCompaction?: "beforeCacheExpires" | "onReturn";
      workflowScript?: boolean;
      freshContext?: boolean;
      inputIntent: "turn_start" | "queued_turn" | "steer" | "promoted_queued_to_steer";
      text: string;
      textOmitted?: true;
      context?: unknown;
      attachments: ChatAttachment[];
      modelSwitch?: { from: unknown; to: unknown };
    })
  | (Base & {
      type: "assistant_message";
      phase?: "commentary" | "partial_answer" | "final_answer";
      messageId: string;
      text: string;
      textOmitted?: true;
      attachments?: ChatAttachment[];
      streaming: boolean;
      /** Our addition: the model that wrote this message (Claude `message.model`). */
      model?: string;
    })
  | (Base & { type: "reasoning"; text: string; streaming: boolean })
  | (Base & { type: "proposed_plan"; planId: string; markdown: string; streaming: boolean })
  | (Base & { type: "todo_list"; planId: string; steps: OrchestrationV2PlanStep[]; explanation?: string })
  | (Base & {
      type: "user_input_request";
      requestId: string;
      questions: OrchestrationV2UserInputQuestion[];
      questionAnswer?: UserInputAttachmentAnswerPayload;
      responseMode?: "message";
    })
  | (Base & {
      type: "file_change";
      fileName: string;
      additions?: number;
      deletions?: number;
      diffStr?: string;
      oldStr?: string;
      newStr?: string;
      changes?: OrchestrationV2FileChangeDetail[];
    })
  | (Base & {
      type: "command_execution";
      input: string;
      output?: string;
      outputOmitted?: boolean;
      outputIndicatesFailure?: boolean;
      exitCode?: number;
      monitor?: boolean;
      completionWake?: "always";
    })
  | (Base & {
      type: "file_search";
      pattern?: string;
      results?: Array<{ fileName: string; line?: number; column?: number; preview?: string }>;
    })
  | (Base & { type: "web_search"; patterns?: string[]; results?: OrchestrationV2WebSearchResult[] })
  | (Base & {
      type: "approval_request";
      requestId: string;
      requestKind: ProviderRequestKind;
      prompt?: string;
      reason?: string;
      fullAccessOverride?: "ask_rule" | "provider_check";
      appName?: string;
      options?: ProviderApprovalOption[];
    })
  | (Base & { type: "checkpoint"; checkpointId: string; scopeId: string; files: unknown[]; filesTotal?: unknown; filesOmitted?: true })
  | (Base & { type: "run_interrupt_request"; message: string; unresponsiveAt?: IsoDateTime })
  | (Base & { type: "run_interrupt_result"; message: string })
  | (Base & { type: "system_notice"; message: string; level?: "info" | "warning" | "error" })
  | (Base & { type: "error"; failure: OrchestrationV2ProviderFailure; retry?: OrchestrationV2ProviderRetry })
  | (Base & { type: "compaction"; driver: string | null; summary?: string; beforeTokenCount?: number; afterTokenCount?: number })
  | (Base & { type: "handoff"; [k: string]: unknown })
  | (Base & {
      type: "fork";
      source:
        | { type: "run"; threadId: string; runId: string }
        | { type: "node"; nodeId: string }
        | { type: "provider_thread"; providerThreadId: string; providerTurnId?: string };
      targetThreadId: string;
      providerThreadId?: string;
    })
  | (Base & { type: "thread_created"; [k: string]: unknown })
  | (Base & { type: "secret_request"; [k: string]: unknown })
  | (Base & { type: "link_request"; [k: string]: unknown })
  | (Base & {
      type: "subagent";
      subagentId: string;
      origin: "provider_native" | "app_owned";
      driver: string;
      providerInstanceId: string;
      childThreadId: string | null;
      remoteChild?: unknown;
      prompt: string;
      progress?: string;
      result: string | null;
      promptOmitted?: true;
      resultOmitted?: true;
    })
  | (Base & {
      type: "dynamic_tool";
      toolName: string | null;
      viewedImagePath?: string;
      input: unknown;
      output?: unknown;
      outputOmitted?: boolean;
    });

export type TurnItemType = OrchestrationV2TurnItem["type"];

// ---- our extension (docs/event-model.md 6.2) ----

export interface RawRef {
  source: "claude-transcript" | "claude-stream" | "claude-sidecar" | "codex-rpc";
  /** census-style discriminator */
  key: string;
  path?: string;
  line?: number;
  byteOffset?: number;
  conn?: string;
  seq?: number;
}

export interface BlobRef { raw: RawRef; jsonPath: string; mediaType?: string; bytes?: number }

export interface ProjectionExtension {
  /** Every source record merged into this item. */
  raw: RawRef[];
  sourceKey: string;
  noticeKind?: "context" | "hook" | "command_output" | "link" | "goal" | "mode" | "refusal" | "branch" | "info";
  body?: string;
  /**
   * Provider details without a field of their own. Keys the UI reads (DESIGN.md 6i, server contract):
   *   file_change        toolName: the Claude tool that made it (Write, Edit, MultiEdit, NotebookEdit)
   *   command_execution  description, runInBackground: true (Claude Bash input)
   *   user_message       clientId: the id the message was sent with (PendingSend.id)
   *                      mergedClientIds: the ids of the sends the CLI folded into this line (Claude)
   */
  data?: Record<string, unknown>;
  /** The source record has no row in the mapping tables. */
  unknown?: true;
  origin?: {
    kind: "human" | "task_notification" | "scheduled" | "peer" | "coordinator" | "auto_continuation" | "sdk" | "system";
    taskId?: string;
    cron?: string;
    /** peer, coordinator: the sending agent's id. */
    from?: string;
    /** peer, coordinator: the sending agent's name or type, when the CLI records one. */
    name?: string;
  };
  link?: {
    url?: string;
    threadId?: string;
    evidence?: "meta.toolUseId" | "toolUseResult.agentId" | "journal" | "parentThreadId" | "forkedFrom" | "unlinked";
  };
  inheritsContextUntil?: string;
  compaction?: { trigger?: string; durationMs?: number; logicalParentUuid?: string; preservedUuids?: string[] };
  retracted?: true;
  durationMs?: number;
  estimatedTokens?: number;
  /** Ids of collapsed notices tied to this tool call. */
  attachedNotices?: string[];
  hooks?: Array<{ event: string; name?: string; exitCode?: number; durationMs?: number }>;
  background?: { taskId: string; status: "running" | "completed" | "failed" | "killed" | "unknown"; outputFile?: string };
  partialInput?: string;
  progress?: string;
  stdin?: string;
  /** Several results for one tool call (event-model 7.1). */
  previousOutputs?: unknown[];
  branch?: { forkPointUuid: string; alternates: Array<{ laneId: string; firstLine: number; itemCount: number }> };
  relatedCallId?: string;
}

export interface OrchestrationV2ProjectedTurnItem {
  position: number;
  visibility: "local" | "inherited" | "synthetic";
  sourceThreadId: string;
  sourceItemId: string;
  item: OrchestrationV2TurnItem;
  x?: ProjectionExtension;
}

// ---- side records (T3 contracts and client-runtime) ----

export interface OrchestrationV2WorkflowPhase { index: number; title: string }

export interface OrchestrationV2WorkflowAgent {
  index: number;
  label: string;
  agentId?: string;
  childThreadId?: string;
  state: "queued" | "running" | "completed" | "failed";
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
  effort?: string;
  speed?: string;
  attempt?: number;
  totalTokens?: number;
  toolCalls?: number;
  durationMs?: number;
  /** epoch ms */
  queuedAt?: number;
  startedAt?: number;
  completedAt?: number;
  prompt?: string;
  result?: string;
}

export interface OrchestrationV2SubagentWorkflow {
  name?: string;
  runHandles?: { runId?: string; transcriptDir?: string; scriptPath?: string };
  phases: OrchestrationV2WorkflowPhase[];
  agents: OrchestrationV2WorkflowAgent[];
  totalTokens?: number;
  toolCalls?: number;
  durationMs?: number;
}

export interface OrchestrationV2Subagent {
  id: string;
  threadId: string;
  runId: string | null;
  parentNodeId: string;
  origin: "provider_native" | "app_owned";
  createdBy: OrchestrationV2Actor;
  driver: string;
  providerInstanceId: string;
  providerThreadId: string | null;
  childThreadId: string | null;
  nativeTaskRef: OrchestrationV2ProviderRef | null;
  prompt: string;
  title: string | null;
  model: string | null;
  status: "idle" | "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  progress?: string;
  workflow?: OrchestrationV2SubagentWorkflow;
  result: string | null;
  startedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  updatedAt: IsoDateTime;
  // Our additions (DESIGN.md 6i, server contract), filled from Claude records that carry them.
  /** Claude `subagent_type` (general-purpose, Explore, a custom agent). */
  agentType?: string;
  /** Model id the CLI ran the agent on, e.g. claude-haiku-4-5 (`model` is what the call asked for, often an alias). */
  modelResolved?: string;
  toolUses?: number;
  totalTokens?: number;
  durationMs?: number;
  /** Ran in the background: launched async, or asked to with run_in_background. */
  background?: boolean;
}

export type OrchestrationV2RunStatus =
  | "preparing" | "queued" | "starting" | "running" | "waiting" | "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back";

export interface ThreadRunSummary {
  runId: string;
  status: OrchestrationV2RunStatus;
  requestedAt: IsoDateTime | null;
  startedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  assistantMessageId: string | null;
  turnEnded?: boolean;
}

export interface ThreadRuntimeSummary {
  status: OrchestrationV2RunStatus | "idle";
  activeRunId: string | null;
  activityStartedAt?: IsoDateTime | null;
  providerInstanceId: string;
  providerName: string | null;
  lastError: string | null;
}

export interface OrchestrationV2AppThreadLineage {
  parentThreadId: string | null;
  relationshipToParent: "fork" | "subagent" | null;
  rootThreadId: string;
}

export interface ThreadTokenUsageSnapshot {
  usedTokens: number;
  totalProcessedTokens?: number;
  /** Context window. Claude: set when the model's window is known (claudeModels.ts), 1M when the request carried the 1M context beta. */
  maxTokens?: number;
  /** Output tokens of the latest run (all its model responses so far). Claude only. */
  runOutputTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  lastUsedTokens?: number;
  lastInputTokens?: number;
  lastCachedInputTokens?: number;
  lastOutputTokens?: number;
  lastReasoningOutputTokens?: number;
  toolUses?: number;
  durationMs?: number;
  cost?: { amount: number; currency: string };
  /** Claude only: when the conversation's prompt cache was last used and its TTL (promptCache.ts). */
  promptCache?: import("./promptCache.ts").ThreadPromptCache;
}

export interface ServerProviderUsageWindow {
  id: string;
  kind: "session" | "weekly" | "monthly" | "other";
  label: string;
  /** 0..100 */
  usedPercent: number;
  resetsAt?: IsoDateTime;
  windowDurationMins?: number;
}

export interface ServerProviderUsageLimits { checkedAt: IsoDateTime; windows: ServerProviderUsageWindow[] }

// ---- thread-level projection state (docs/event-model.md 6.2) ----

/** The daemon's ThreadGoalStatus (codex protocol v2). */
export type ThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

/**
 * A thread's goal (/goal). A Codex goal is what the daemon's thread/goal/get and thread/goal/updated
 * carry; while its status is active the daemon starts turns of its own until the model marks it
 * complete. A Claude goal (`claude` present) is a condition a session-scoped Stop hook checks at the
 * end of every turn; it exists only while the condition is unmet, so its status is always active
 * (tokenBudget null, tokensUsed and timeUsedSeconds 0: its clock is `claude.setAt`).
 */
export interface ThreadGoalState {
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  /** Seconds the goal's turns have run, as of the daemon's last update (not ticking). */
  timeUsedSeconds: number;
  /** Claude only. */
  claude?: ClaudeGoalDetail;
}

/** What a Claude goal adds to ThreadGoalState. */
export interface ClaudeGoalDetail {
  /** How many times the Stop hook's evaluator judged the condition unmet since the goal was set. */
  checks: number;
  /** When the goal was set (ms since the epoch); null when the transcript does not say. */
  setAt: number | null;
  /** The evaluator's reason for the latest unmet judgment; null before the first. */
  lastReason: string | null;
}

export interface ThreadProjectionState {
  ownership: "terminal" | "headless" | "codex-daemon";
  control: "readonly" | "headless" | "codex-rpc";
  nameSource:
    | "custom-title" | "agent-name" | "ai-title" | "live-registry" | "subagent-meta"
    | "codex-name" | "codex-preview" | "first-prompt" | "id";
  customTitle?: string;
  agentName?: string;
  aiTitle?: string;
  lastPrompt?: { text: string; leafUuid?: string };
  model?: string;
  /**
   * The latest request ran at the 1M context (its `context-1m-*` beta) on a model that has both
   * windows. `model` has no `[1m]` in a transcript, so this is what tells `claude-opus-4-6[1m]`
   * from `claude-opus-4-6`. Absent when no request record is known.
   */
  oneMillion?: boolean;
  /**
   * Reasoning effort of the latest response (Claude assistant line `effort`, Codex thread
   * reasoningEffort). null: the latest Claude response ran without one (a model without the effort parameter).
   */
  effort?: string | null;
  permissionMode?: string;
  /** What this server set for the next turns, or what the process reported (sessionControls.ts). null: nothing. */
  chosen?: import("./sessionControls.ts").SessionChosen | null;
  /**
   * The thread's goal. null: none (or cleared); absent: not read (a Codex read that failed, or a
   * Claude transcript with no goal record).
   */
  goal?: ThreadGoalState | null;
  mode?: string;
  outputStyle?: string;
  cwd?: string;
  gitBranch?: string;
  /** The file the thread is read from (Claude transcript, Codex rollout). */
  transcriptPath?: string;
  live?: { pid?: number; tmux?: string | null; registryStatus?: string; updatedAt?: string };
  mainLeafUuid?: string;
  byModel?: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number; costUsd?: number }>;
  stats: {
    linesRead: number;
    parseFailures: number;
    partialTail: number;
    byKey: Record<string, number>;
    displayedByKey: Record<string, number>;
    hiddenByKey: Record<string, number>;
    unknownByKey: Record<string, number>;
  };
}

export interface ThreadBranches {
  lanes: Array<{ laneId: string; forkPointUuid: string; items: OrchestrationV2ProjectedTurnItem[] }>;
}

/** Everything the UI needs to draw one thread (a snapshot; live updates follow as ThreadLiveEvent). */
export interface ThreadSnapshot {
  threadId: string;
  lineage: OrchestrationV2AppThreadLineage;
  providerInstanceId: string;
  title: string;
  state: ThreadProjectionState;
  runtime: ThreadRuntimeSummary | null;
  runs: ThreadRunSummary[];
  visibleTurnItems: OrchestrationV2ProjectedTurnItem[];
  branches: ThreadBranches;
  subagents: OrchestrationV2Subagent[];
  tokenUsage: ThreadTokenUsageSnapshot | null;
  /** Older items exist before the first visible one (paged history). */
  hasMoreBefore: boolean;
}

// ---- live updates (docs/event-model.md 6.3) ----

export type ThreadLiveEvent =
  | { t: "thread.patched"; threadId: string; title?: string; state?: Partial<ThreadProjectionState> }
  | { t: "thread.removed"; threadId: string; reason: "deleted" | "archived" }
  | { t: "runtime.updated"; threadId: string; runtime: ThreadRuntimeSummary | null }
  | { t: "run.upserted"; threadId: string; run: ThreadRunSummary }
  /** Full replace of one row. */
  | { t: "turnItem.upserted"; threadId: string; row: OrchestrationV2ProjectedTurnItem }
  | { t: "turnItem.textAppended"; threadId: string; itemId: string; field: "text" | "markdown" | "output"; value: string }
  | { t: "subagent.upserted"; threadId: string; subagent: OrchestrationV2Subagent }
  | { t: "pending.updated"; threadId: string; approvals: unknown[]; userInputs: unknown[] }
  | {
      t: "turnItems.replaced";
      threadId: string;
      reason: "branch" | "reverted" | "resync";
      visibleTurnItems: OrchestrationV2ProjectedTurnItem[];
      branches: ThreadBranches;
      /** A windowed subscriber's: older rows exist before the first one (threadWindow.ts). */
      hasMoreBefore?: boolean;
    }
  | { t: "tokenUsage.updated"; threadId: string; usage: ThreadTokenUsageSnapshot }
  | { t: "usageLimits.updated"; providerInstanceId: string; limits: ServerProviderUsageLimits };
