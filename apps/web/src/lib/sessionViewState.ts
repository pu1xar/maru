// A session's view state that outlives the view showing it (DESIGN.md 6p). A conversation unmounts
// whenever another screen takes its place (another session, settings, the dashboard, the other base
// view) and when the list drops and re-adds its key (a rehome). What it showed comes back from
// stores kept per key:
//
// - the subagent stack, lib/threadStack.ts
// - the scroll position of each thread, components/chat/timelinePositions.ts
// - the view mode, lib/viewMode.ts; the right panel, rightPanel.ts; the unsent text,
//   lib/composerDraft.ts
//
// A move to another account changes the session's key (`provider:account:id`). rekeySession carries
// every store to the new key, points split view panes and the single view's selection at it (the
// address holds the session id, which a move keeps), and is
// safe to call more than once for the same move: the split view notices a move from the list, the
// view that asked for it from the server's answer, in either order.
import type { SessionSummary } from "@maru/shared";

import { moveTimelinePositions } from "~/components/chat/timelinePositions";
import { paneActions } from "~/components/split/paneStore";
import { fetchSession } from "~/projectsApi";
import { moveRightPanel } from "~/rightPanel";
import { getComposerDraft, setComposerDraft } from "./composerDraft";
import { moveThreadStack, movedFamilyKeys, readThreadStack } from "./threadStack";
import { moveSessionViewMode } from "./viewMode";

const rekeyListeners = new Set<(from: string, to: string) => void>();

/** Hears every move once its state has been carried (the page's `?s=` follows here). */
export function onSessionRekey(listener: (from: string, to: string) => void): () => void {
  rekeyListeners.add(listener);
  return () => {
    rekeyListeners.delete(listener);
  };
}

/**
 * The session `from` now lives under `to`. Each piece moves only when the old key has it and the
 * new key has none, so a second call for the same move changes nothing. `familyIds` are the ids the
 * server says it moved (a Codex thread and its subagent threads, whose keys carry the account too);
 * the subagent threads open in the stack count as well when the move was seen without an answer.
 */
export function rekeySession(from: string, to: string, familyIds: readonly string[] = []): void {
  if (from === to) return;
  const family = movedFamilyKeys(from, to, familyIds, readThreadStack(from));
  carry(from, to);
  for (const [before, after] of family) carry(before, after);
}

function carry(from: string, to: string): void {
  const draft = getComposerDraft(from);
  if (draft && !getComposerDraft(to)) {
    setComposerDraft(to, draft);
    setComposerDraft(from, "");
  }
  moveSessionViewMode(from, to);
  moveRightPanel(from, to);
  moveTimelinePositions(from, to);
  moveThreadStack(from, to);
  paneActions.rekey(from, to);
  for (const l of [...rekeyListeners]) l(from, to);
}

const summaryListeners = new Set<(session: SessionSummary) => void>();

/**
 * Hears a session's fresh summary after a change made from this page. A session off the list
 * (opened from the settings' full list) gets no /ws updates, so its holders take the new one here.
 */
export function onSessionSummary(listener: (session: SessionSummary) => void): () => void {
  summaryListeners.add(listener);
  return () => {
    summaryListeners.delete(listener);
  };
}

/** Reads the server's entry for `key` and hands it to the listeners; nothing when it cannot be read. */
export async function refreshSessionSummary(key: string): Promise<void> {
  const session = await fetchSession(key).catch(() => null);
  // Unreadable (the server is down, the session went): the holders keep what they have.
  if (!session) return;
  for (const l of [...summaryListeners]) l(session);
}
