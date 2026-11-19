// What the session list draws beside a row: the mark of the session's activity, and the small
// facts that tell rows apart. React Native-free; the activity rules are the web's
// (sessionActivity.logic.ts), so a row here means what the web sidebar's row means.
import type { SessionSummary } from "@maru/shared";
import { sessionActivity, sessionRecedes, type SessionActivity } from "../../../web/src/components/sessionActivity.logic.ts";
import type { SessionGroup } from "../../../web/src/model.ts";

/** The palette role a mark takes its color from. */
export type MarkRole = "info" | "attention" | "danger";

/** solid: the main agent works; dashed: only subagents or workflows work; the others name the state. */
export interface SessionMark {
  shape: "solid" | "dashed" | "question" | "alert";
  role: MarkRole;
}

const MARKS: Partial<Record<SessionActivity, SessionMark>> = {
  running: { shape: "solid", role: "info" },
  background: { shape: "dashed", role: "info" },
  "waiting-input": { shape: "question", role: "attention" },
  error: { shape: "alert", role: "danger" },
};

/** The mark of an activity: an idle open session and a closed one have none, only work and attention show (as on the web). */
export function activityMark(activity: SessionActivity): SessionMark | null {
  return MARKS[activity] ?? null;
}

export function sessionMark(s: Pick<SessionSummary, "status" | "backgroundTasks" | "backgroundAgents">): SessionMark | null {
  return activityMark(sessionActivity(s));
}

/** What a row carries besides its mark: closed rows recede, a pin in the Groups, a terminal's hold. */
export function rowFacts(s: SessionSummary, group: Pick<SessionGroup, "kind">) {
  return {
    recede: sessionRecedes(s.status),
    // In Pinned the folder already says it, and Archive keeps the pin without enforcing it.
    pinned: s.pinPosition != null && (group.kind === "project" || group.kind === "unassigned"),
    terminalHeld: s.owner === "terminal" && s.status !== "closed",
  };
}
