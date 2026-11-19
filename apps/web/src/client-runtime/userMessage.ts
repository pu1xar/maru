// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: packages/client-runtime/src/userMessage.ts.
// Local changes: resolveUserMessageFileCards and the guest attribution are left out (T3 composer
// context records and guest shares); the attachment-only bootstrap prompt check is inlined from
// packages/shared/src/composerContextReferences.ts; labels are Korean.
import type { OrchestrationV2Actor, OrchestrationV2CreationSource } from "@maru/shared";
import type { OrchestrationV2IdleCompaction } from "../t3-shared/contracts.ts";

/** The working row while T3 Code's own compaction runs. */
export const IDLE_COMPACTING_LABELS = {
  beforeCacheExpires: "Compacting context before the cache expires…",
  onReturn: "Compacting context…",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

/** Leads the finished compaction's token counts, in place of "Context compaction". */
export const IDLE_COMPACTION_TITLES = {
  beforeCacheExpires: "Automatic context compaction before the cache expires",
  onReturn: "Context compaction before send",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

const ATTACHMENT_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]";

/** Claude's ultrathink effort sends the prompt as `Ultrathink:\n<prompt>`. */
function isAttachmentOnlyBootstrapPrompt(text: string): boolean {
  return text.replace(/^Ultrathink:\s*/i, "") === ATTACHMENT_ONLY_BOOTSTRAP_PROMPT;
}

export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: string | undefined;
}): {
  readonly text: string;
  readonly attribution: "automation" | "agent" | "t3code" | null;
  readonly scheduledTaskId: string | undefined;
} {
  if (message.role !== "user") {
    return { text: message.text, attribution: null, scheduledTaskId: undefined };
  }
  if (message.scheduledTaskId !== undefined) {
    return {
      text: message.text,
      attribution: "automation",
      scheduledTaskId: message.scheduledTaskId,
    };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(message.text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  if (legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent")) {
    return {
      text: message.text.slice(legacyPrefix[0].length),
      attribution: "automation",
      scheduledTaskId: legacyTaskId,
    };
  }
  return {
    // The agent needs words to start a turn; people sent only the attachments.
    text: isAttachmentOnlyBootstrapPrompt(message.text) ? "" : message.text,
    attribution:
      message.createdBy !== "agent"
        ? null
        : message.creationSource === "server"
          ? "t3code"
          : "agent",
    scheduledTaskId: undefined,
  };
}

/**
 * The label of a folded message (one from an agent, an automation or the system), shared by the web
 * and the Android app. A message from another agent names its sender when the transcript records
 * one (`origin.name`, else `origin.from`), so it never reads as the user's own message.
 */
export function foldedMessageLabel(
  attribution: "automation" | "agent" | "t3code",
  origin?: { readonly kind?: string; readonly from?: string; readonly name?: string } | undefined,
): string {
  if (attribution === "automation") return "Automated run";
  if (attribution === "t3code") return "System";
  const sender = origin?.name ?? origin?.from;
  return sender ? `From ${sender}` : "Agent";
}

type GroupableUserMessage = Parameters<typeof resolveUserMessagePresentation>[0] & {
  readonly inputIntent?: "turn_start" | "queued_turn" | "steer" | "promoted_queued_to_steer";
};

export function resolveUserMessageGrouping(
  message: GroupableUserMessage | undefined,
  previous: GroupableUserMessage | undefined,
  next: GroupableUserMessage | undefined,
) {
  const isOwnMessage = (value: GroupableUserMessage | undefined) =>
    value?.role === "user" && resolveUserMessagePresentation(value).attribution === null;
  const isSteer = (value: GroupableUserMessage | undefined) =>
    value?.inputIntent === "steer" || value?.inputIntent === "promoted_queued_to_steer";
  const groupedWithPrevious = isOwnMessage(message) && isOwnMessage(previous);
  return {
    groupedWithPrevious,
    groupedWithNext: isOwnMessage(message) && isOwnMessage(next),
    continuesSteer: groupedWithPrevious && isSteer(message) && isSteer(previous),
  };
}
