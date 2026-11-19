// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: TOP_STATUS_ICONS and the row status classes in components/sidebar/SidebarThreadRow.tsx,
// and resolveSidebarFolderDot in components/Sidebar.logic.ts. Local change: they read
// maru's UnifiedStatus instead of T3's thread status, and a row shows the icon alone.
import { CircleAlertIcon, CircleDashedIcon, CircleIcon, MessageCircleQuestionIcon } from "lucide-react";

import type { FolderDot, SessionActivity } from "./sessionActivity.logic.ts";

// The activity rules live in sessionActivity.logic.ts (the Android app reads them too); the web
// keeps importing them from here.
export {
  ACTIVITY_COUNT_ORDER,
  ACTIVITY_LABEL,
  FOLDER_DOT_LABEL,
  resolveFolderDot,
  sessionActivity,
  sessionRecedes,
  type FolderDot,
  type SessionActivity,
} from "./sessionActivity.logic.ts";

/** The status icon shown in a row's trailing slot and the header counts. */
export interface SessionTopStatus {
  icon: typeof CircleDashedIcon;
  className: string;
}

const TOP_STATUS: Partial<Record<SessionActivity, SessionTopStatus>> = {
  // The main agent is at work: a solid circle.
  running: { icon: CircleIcon, className: "text-info-foreground" },
  // Only subagents or workflows run and the session waits on them: T3's "Working" dashed circle.
  background: { icon: CircleDashedIcon, className: "text-info-foreground" },
  // T3 "Input": the agent asked the user a question
  "waiting-input": {
    icon: MessageCircleQuestionIcon,
    className: "text-attention",
  },
  // T3 "Failed"
  error: { icon: CircleAlertIcon, className: "text-error-foreground" },
};

export function sessionTopStatus(activity: SessionActivity): SessionTopStatus | null {
  return TOP_STATUS[activity] ?? null;
}

export const FOLDER_DOT_CLASS_NAME: Record<FolderDot, string> = {
  attention: "bg-warning",
  failed: "bg-error",
  working: "bg-info",
};
