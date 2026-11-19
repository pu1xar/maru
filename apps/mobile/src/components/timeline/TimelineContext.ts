// What every timeline row reads besides its own row: the thread's folder (paths show relative to
// it), the live subagent records, whether a turn runs, and the disclosure toggles (lib/useTimeline).
import { createContext, useContext } from "react";
import type { OrchestrationV2Subagent } from "@maru/shared";
import { BotIcon, BrainIcon, CheckIcon, CircleAlertIcon, Code2Icon, EyeIcon, GitPullRequestIcon, GlobeIcon, HammerIcon, InfoIcon, ListTodoIcon, MessageCircleIcon, SearchIcon, SmartphoneIcon, SquarePenIcon, TerminalIcon, WrenchIcon, XIcon, ZapIcon } from "lucide-react-native";
import { BrowserAppIcon, type IconComponent } from "../ui/AppIcons.tsx";
import type { TimelineFind } from "../../lib/threadFind.ts";
import type { WorkEntryIconName } from "../../../../web/src/components/chat/TimelineWorkEntryRow.logic.ts";

export interface TimelineCtxValue {
  workspaceRoot: string | undefined;
  subagentsById: ReadonlyMap<string, OrchestrationV2Subagent>;
  isWorking: boolean;
  latestRunId: string | null;
  toggleRun: (runId: string) => void;
  toggleGroup: (groupId: string) => void;
  toggleAttempt: (attemptId: string) => void;
  /** Opens a child thread (a subagent's transcript) in place of this one. */
  openThread: (threadId: string) => void;
  /** The conversation find (DESIGN.md 6u): FindRow turns it into what each row paints. Null while find is closed. */
  find: TimelineFind | null;
}

export const TimelineCtx = createContext<TimelineCtxValue | null>(null);

export function useTimelineCtx(): TimelineCtxValue {
  const v = useContext(TimelineCtx);
  if (!v) throw new Error("TimelineCtx is missing");
  return v;
}

/**
 * A row keeps the web's 24px density on screen and takes touches over 44dp (28dp of row plus this
 * above and below), the platform's touch minimum (DESIGN.md 7, app touch targets).
 */
export const ROW_HIT_SLOP = { top: 8, bottom: 8 } as const;

/** The web's named tool icons (TimelineToolActivityIcon.tsx WorkEntryIcon), the same lucide components. */
export const TOOL_ICON: Record<WorkEntryIconName, IconComponent> = {
  bot: BotIcon,
  brain: BrainIcon,
  browser: BrowserAppIcon,
  computer: BrowserAppIcon,
  check: CheckIcon,
  "list-todo": ListTodoIcon,
  "circle-alert": CircleAlertIcon,
  code: Code2Icon,
  device: SmartphoneIcon,
  eye: EyeIcon,
  globe: GlobeIcon,
  hammer: HammerIcon,
  "message-circle": MessageCircleIcon,
  search: SearchIcon,
  "square-pen": SquarePenIcon,
  terminal: TerminalIcon,
  "pull-request": GitPullRequestIcon,
  "t3-code": InfoIcon,
  wrench: WrenchIcon,
  x: XIcon,
  zap: ZapIcon,
};
