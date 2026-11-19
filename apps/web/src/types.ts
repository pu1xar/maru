// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/types.ts (the message, plan and attachment types the timeline reads).
// Local changes: contract types come from @maru/shared (docs/event-model.md 2.6); terminal,
// project and composer types are left out. TurnDiffSummary keeps T3's checkpoint summary shape,
// though maru always passes an empty list.
import type {
  ChatAttachment as ContractChatAttachment,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
} from "@maru/shared";
import type { OrchestrationV2IdleCompaction } from "./t3-shared/contracts.ts";
import { imageMimeType } from "./t3-shared/image.ts";
import { videoMimeType } from "./t3-shared/video.ts";

export { videoMimeType } from "./t3-shared/video.ts";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";

export interface ChatImageAttachment extends ContractChatAttachment {
  readonly type: "image";
  readonly previewUrl?: string;
}

export interface ChatFileAttachment extends ContractChatAttachment {
  readonly type: "file";
  readonly previewUrl?: string;
  readonly downloadable?: boolean;
  readonly htmlRender?: boolean;
}

// Render unknown attachment contracts as inert rows so newer servers cannot crash older clients.
export type ChatUnknownAttachment = ContractChatAttachment & { readonly previewUrl?: string };

export type ChatAttachment = ChatImageAttachment | ChatFileAttachment | ChatUnknownAttachment;

export function isImageAttachment(attachment: ChatAttachment): attachment is ChatImageAttachment {
  // Legacy file attachments can be images; unknown types must never be reclassified by name.
  if (attachment.type === "image") return true;
  return attachment.type === "file" && imageMimeType(attachment) !== null;
}

export function isFileAttachment(attachment: ChatAttachment): attachment is ChatFileAttachment {
  // Keep disjoint from isImageAttachment so independently filtered sets do not render legacy images twice.
  return attachment.type === "file" && !isImageAttachment(attachment);
}

export function isVideoAttachment(attachment: ChatFileAttachment): boolean {
  return videoMimeType(attachment) !== null;
}

export interface ChatMessage {
  readonly context?: unknown;
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly runId: string | null;
  readonly streaming: boolean;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: string;
  readonly senderThreadId?: string;
  readonly linkedSender?: { environmentId: string; threadId: string; title: string };
  readonly idleCompaction?: OrchestrationV2IdleCompaction;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly inputIntent?: "turn_start" | "queued_turn" | "steer" | "promoted_queued_to_steer" | undefined;
}

export interface ProposedPlan {
  readonly id: string;
  readonly runId: string | null;
  readonly planMarkdown: string;
  readonly status: "draft" | "active" | "completed" | "superseded";
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** T3 client-runtime ThreadCheckpointSummary (a git checkpoint per turn). */
export interface TurnDiffSummary {
  readonly checkpointId?: string;
  readonly scopeId?: string;
  readonly runId: string;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: string;
  readonly status: "ready" | "missing" | "error" | "stale";
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly filesTotal?: unknown;
  readonly assistantMessageId: string | null;
  readonly completedAt: string;
}

export type TurnDiffFileChange = TurnDiffSummary["files"][number];
