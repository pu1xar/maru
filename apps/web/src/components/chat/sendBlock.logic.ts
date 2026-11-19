// Why a view cannot send to a session (DESIGN.md 4.2), as pure rules. ThreadComposer, the terminal
// mode's input and the Android app's input read the same function.
import type { SessionSummary } from "@maru/shared";

/** Why this view cannot send to the session (DESIGN.md 4.2), as the composer's place shows it. */
export interface SendBlock {
  kind: "subagent" | "terminal" | "other-client";
  label: string;
}

/** A subagent's conversation, which no view sends to. */
export const SUBAGENT_BLOCK: SendBlock = { kind: "subagent", label: "Cannot send to a subagent conversation" };

export function sendBlock(session: SessionSummary, isSubagent: boolean): SendBlock | null {
  if (isSubagent) return SUBAGENT_BLOCK;
  if (session.provider === "codex") {
    // The daemon serializes writers: an idle thread is taken over by the next send.
    return session.owner === "terminal" && (session.status === "running" || session.status === "waiting-input")
      ? { kind: "other-client", label: "Can send once the other client's turn ends" }
      : null;
  }
  if (session.owner === "terminal" && session.status !== "closed") {
    return { kind: "terminal", label: "Cannot send while open in a terminal" };
  }
  return null;
}

/** Why this session cannot take a message here, or null when it can. The terminal mode uses it too. */
export function sendBlocker(session: SessionSummary, isSubagent: boolean): string | null {
  return sendBlock(session, isSubagent)?.label ?? null;
}
