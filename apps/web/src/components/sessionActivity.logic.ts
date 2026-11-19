// What a session is doing as the lists show it. React-free and icon-free so the Android app reads
// the same rules by path (the icons and classes that draw them stay in sessionPresentation.ts).
import type { SessionSummary, UnifiedStatus } from "@maru/shared";

import { STATUS_LABEL } from "../model.ts";

/**
 * What a session is doing as the sidebar and the header show it (user request 2026-11-16): the
 * status, except that an idle turn with subagents or workflows still running in the background
 * counts as working ("background"). Shell commands left running do not count.
 */
export type SessionActivity = UnifiedStatus | "background";

export function sessionActivity(s: Pick<SessionSummary, "status" | "backgroundTasks" | "backgroundAgents">): SessionActivity {
  // Subagents and workflows only: a shell command left running (a dev server) is not one at work.
  return s.status === "open-idle" && (s.backgroundAgents ?? s.backgroundTasks ?? 0) > 0 ? "background" : s.status;
}

export const ACTIVITY_LABEL: Record<SessionActivity, string> = {
  ...STATUS_LABEL,
  background: "Background work running",
};

/** The activities the sidebar header counts, most urgent first; idle and closed counts say little. */
export const ACTIVITY_COUNT_ORDER: SessionActivity[] = ["waiting-input", "running", "background", "error"];

/** Closed sessions recede like T3's settled threads: lighter title, muted row. */
export function sessionRecedes(status: UnifiedStatus): boolean {
  return status === "closed";
}

export type FolderDot = "attention" | "failed" | "working";

export const FOLDER_DOT_LABEL: Record<FolderDot, string> = {
  attention: ", waiting for input",
  failed: ", error",
  working: ", running",
};

/** The dot a collapsed project folder shows for the sessions it hides, most urgent first. */
export function resolveFolderDot(sessions: readonly Pick<SessionSummary, "status" | "backgroundTasks" | "backgroundAgents">[]): FolderDot | null {
  const activities = new Set(sessions.map(sessionActivity));
  if (activities.has("waiting-input")) return "attention";
  if (activities.has("error")) return "failed";
  if (activities.has("running") || activities.has("background")) return "working";
  return null;
}
