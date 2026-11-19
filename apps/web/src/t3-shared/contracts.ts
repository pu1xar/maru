// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: packages/contracts/src/orchestrationV2.ts, providerRuntime.ts, providerPolicy.ts,
// chatAttachment.ts and settings.ts (the helpers and literal types the timeline logic reads).
// Local changes: Effect Schema literals become plain union types; brands are plain strings.
import type {
  OrchestrationV2AppThreadLineage,
  OrchestrationV2TurnItemStatus,
  ProviderApprovalOption,
  ProviderRequestKind,
} from "@maru/shared";

export type ToolCallVisibility = "showAll" | "hideSuccessful" | "hideAll" | "zen";

export type RuntimeItemStatus = "inProgress" | "completed" | "failed" | "declined";

const TOOL_LIFECYCLE_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
] as const;

export type ToolLifecycleItemType = (typeof TOOL_LIFECYCLE_ITEM_TYPES)[number];

export function isToolLifecycleItemType(value: string): value is ToolLifecycleItemType {
  return TOOL_LIFECYCLE_ITEM_TYPES.includes(value as ToolLifecycleItemType);
}

export type ToolActivitySurface = "browser" | "computer";

export type ToolActivityNativeAppReference =
  | { readonly _tag: "app-id"; readonly appId: string }
  | { readonly _tag: "display-name"; readonly displayName: string };

export type ToolActivityIcon =
  | {
      readonly _tag: "website";
      readonly pageUrl: string;
      readonly faviconUrl?: string;
      readonly faviconUrlDark?: string;
    }
  | { readonly _tag: "native-app"; readonly app: ToolActivityNativeAppReference }
  | { readonly _tag: "themed-logo"; readonly logoUrl: string; readonly logoUrlDark?: string };

export interface ToolActivitySource {
  readonly key: string;
  readonly name: string;
  readonly kind: "browser" | "computer" | "integration";
  readonly icon?: ToolActivityIcon;
}

export type ProviderApprovalFullAccessOverride = "ask_rule" | "provider_check";

export type OrchestrationV2IdleCompaction = "beforeCacheExpires" | "onReturn";

export function isOrchestrationV2WorkActive(status: OrchestrationV2TurnItemStatus | string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

export function isProviderNativeSubagentThread(thread: {
  readonly lineage: Pick<OrchestrationV2AppThreadLineage, "relationshipToParent">;
  readonly creationSource: string;
}): boolean {
  return thread.lineage.relationshipToParent === "subagent" && thread.creationSource === "provider";
}

export const IDLE_COMPACTION_TEXT = "/compact";

interface CompactionMessageFields {
  readonly role: string;
  readonly text: string;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
  readonly createdBy?: string | undefined;
  readonly creationSource?: string | undefined;
  readonly idleCompaction?: OrchestrationV2IdleCompaction | undefined;
}

export function isCompactionCommandMessage(message: CompactionMessageFields): boolean {
  return (
    message.role === "user" &&
    message.text.trim().toLowerCase() === IDLE_COMPACTION_TEXT &&
    (message.attachments?.length ?? 0) === 0
  );
}

export function idleCompactionOf(
  message: CompactionMessageFields,
): OrchestrationV2IdleCompaction | undefined {
  if (!isCompactionCommandMessage(message)) return undefined;
  if (message.idleCompaction !== undefined) return message.idleCompaction;
  // Servers before `idleCompaction` marked their own as agent-created.
  return message.createdBy === "agent" && message.creationSource === "server"
    ? "beforeCacheExpires"
    : undefined;
}

export const ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE = "workspace_preparation_failed";

export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPE_SET = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function isProviderSendTurnSupportedImageMimeType(mimeType: string): boolean {
  return PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPE_SET.has(mimeType.toLowerCase());
}

/** client-runtime/state/threadRequests.ts ThreadPendingApproval. */
export interface ThreadPendingApproval {
  readonly requestId: string;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  readonly reason?: string;
  readonly fullAccessOverride?: ProviderApprovalFullAccessOverride;
  readonly appName?: string;
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
  readonly responseCapability: "live" | "not_resumable";
  readonly supportsFeedback?: boolean;
}

/** client-runtime/state/threadRequests.ts ThreadPendingUserInput. */
export interface ThreadPendingUserInput {
  readonly requestId: string;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
    readonly multiSelect?: boolean;
  }>;
  readonly responseCapability: "live" | "not_resumable";
  readonly responseMode?: "message";
  readonly dismissible: boolean;
}
