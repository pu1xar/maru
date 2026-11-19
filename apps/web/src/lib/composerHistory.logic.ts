// Pure rules of the input's message history (↑ and ↓ in the chat and terminal inputs, DESIGN.md 6h).
import type { ThreadSnapshot } from "@maru/shared";
import { splitAttachmentNotes } from "@maru/shared";

/**
 * The user's earlier messages in this session, oldest first. Attachment notes (DESIGN.md 6n) are
 * not what they typed; a message equal to the one before it is listed once.
 */
export function userHistory(snapshot: ThreadSnapshot | null): string[] {
  if (!snapshot) return [];
  const out: string[] = [];
  for (const row of snapshot.visibleTurnItems) {
    const item = row.item;
    if (item.type !== "user_message" || item.createdBy !== "user") continue;
    const text = splitAttachmentNotes(item.text).text;
    if (text.trim() && out.at(-1) !== text) out.push(text);
  }
  return out;
}

/** The keys that change the caret or the selection themselves are never history keys. */
export function isPlainArrow(event: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean {
  return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}

/** The caret (or the selection's start) is on the first line: nothing above it to move to. */
export function onFirstLine(value: string, selectionStart: number): boolean {
  return !value.slice(0, selectionStart).includes("\n");
}

/** The caret (or the selection's end) is on the last line. */
export function onLastLine(value: string, selectionEnd: number): boolean {
  return !value.slice(selectionEnd).includes("\n");
}

/** Where history stands: the entry shown (index into the list) and the draft it replaced. */
export interface HistoryState {
  /** Index into the list, or null while the user's own text is in the input. */
  at: number | null;
  /** What was in the input before the first ↑. */
  draft: string;
}

export const NO_HISTORY: HistoryState = { at: null, draft: "" };

export interface HistoryStep {
  state: HistoryState;
  /** The text the input shows after the step. */
  text: string;
  /** Where the caret goes: the start after ↑ into a several-line entry (the next ↑ keeps going), else the end. */
  caret: number;
}

function placed(state: HistoryState, text: string, step: -1 | 1): HistoryStep {
  return { state, text, caret: step === -1 && text.includes("\n") ? 0 : text.length };
}

/**
 * One ↑ (step -1, older) or ↓ (step 1, newer). Returns null when the key is not history's: an
 * empty list, or ↓ while the user's own text is shown. The oldest entry stays on ↑, and ↓ past the
 * newest one brings back the draft that was in the input before the first ↑.
 */
export function stepHistory(state: HistoryState, list: readonly string[], step: -1 | 1, text: string): HistoryStep | null {
  if (list.length === 0) return null;
  if (state.at === null) {
    if (step === 1) return null;
    const at = list.length - 1;
    return placed({ at, draft: text }, list[at]!, step);
  }
  const next = state.at + step;
  if (next >= list.length) return { state: NO_HISTORY, text: state.draft, caret: state.draft.length };
  if (next < 0) return placed(state, list[state.at]!, step);
  return placed({ at: next, draft: state.draft }, list[next]!, step);
}

/**
 * The history state that still describes the input: once the text is no longer the entry that
 * history put there (typed over, restored, replaced from another tab), the walk is over.
 */
export function liveHistory(state: HistoryState, list: readonly string[], text: string): HistoryState {
  return state.at !== null && list[state.at] === text ? state : NO_HISTORY;
}
