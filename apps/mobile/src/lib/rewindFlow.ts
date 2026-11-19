// The rewind sheet's state (DESIGN.md 6o, 2d), as plain data so node tests can drive it. The rules
// (options, their reasons, what a choice does, the draft after a rewind) are the web's
// (apps/web/src/lib/rewind.logic.ts); this file is the web's useRewindScreen reduced to the one
// step the phone has: the sheet always opens at the message the user pressed (the web's
// "preselected" confirm step), so there is no message list.
import type { RewindMode, RewindTarget, SessionRewindList, SessionRewindPreview } from "@maru/shared";
import { defaultOption, rewindOptions, type RewindChoice, type RewindOption } from "../../../web/src/lib/rewind.logic.ts";

export interface RewindFlow {
  open: boolean;
  /** The list is being read. */
  loading: boolean;
  list: SessionRewindList | null;
  target: RewindTarget | null;
  /** The runnable choices (no "Never mind": the sheet's cancel button is that). */
  options: RewindOption[];
  /** The picked choice; null when none can run. */
  choice: RewindMode | null;
  /** The dry run of the code restore, once read. */
  preview: SessionRewindPreview | null;
  /** The mode being sent. */
  running: RewindMode | null;
  error: string | null;
}

export const CLOSED: RewindFlow = { open: false, loading: false, list: null, target: null, options: [], choice: null, preview: null, running: null, error: null };

export const LOADING: RewindFlow = { ...CLOSED, open: true, loading: true };

const runnable = (options: readonly RewindOption[]): RewindOption[] => options.filter((o) => o.value !== "nevermind");

/** The choice the web focuses first: code and conversation when the code can go back, else the conversation. */
function firstChoice(all: readonly RewindOption[]): RewindMode | null {
  const o = all[defaultOption(all)];
  return o && o.enabled && o.value !== "nevermind" ? o.value : null;
}

/** The sheet once the server's list is read: the pressed message's options, or why it is not in the conversation. */
export function listed(list: SessionRewindList, targetId: string): RewindFlow {
  const target = list.targets.find((t) => t.id === targetId);
  if (!target) return { ...CLOSED, open: true, list, error: "This message is not in the conversation now" };
  const all = rewindOptions(target, list.blocked);
  return { ...CLOSED, open: true, list, target, options: runnable(all), choice: firstChoice(all) };
}

/** Whether the code's dry run is worth asking for: the code can go back and nothing blocks. */
export function wantsPreview(flow: RewindFlow): boolean {
  return flow.target !== null && flow.target.code.enabled && !flow.list?.blocked;
}

/**
 * The dry run arrived: it can turn the code options off (it refused, or nothing would change), and
 * a choice that went off moves to the first one that can run.
 */
export function previewed(flow: RewindFlow, preview: SessionRewindPreview): RewindFlow {
  if (!flow.target) return flow;
  const all = rewindOptions(flow.target, flow.list?.blocked ?? null, preview);
  const current = all.find((o) => o.value === flow.choice);
  return { ...flow, preview, options: runnable(all), choice: current?.enabled ? flow.choice : firstChoice(all) };
}

/** A tap on an option: the choice moves there when that option can run, else the sheet says why. */
export function choose(flow: RewindFlow, value: RewindChoice): RewindFlow {
  if (flow.running || value === "nevermind") return flow;
  const opt = flow.options.find((o) => o.value === value);
  if (!opt) return flow;
  if (!opt.enabled) return { ...flow, error: opt.reason ?? "Not available right now" };
  return { ...flow, choice: opt.value as RewindMode, error: null };
}

/** The mode the confirm button sends; null when nothing can run or a request is already on its way. */
export function runnableMode(flow: RewindFlow): RewindMode | null {
  if (flow.running || !flow.target) return null;
  const opt = flow.options.find((o) => o.value === flow.choice);
  return opt?.enabled && flow.choice ? flow.choice : null;
}
