// What the user is writing to a session, shared by the chat composer and the terminal mode's input
// (DESIGN.md 6i): switching the view keeps the text, a reload keeps it, and another tab of this
// browser follows it.
//
// - One draft per session key, in memory first and in localStorage a moment later (writes are
//   batched; an empty draft, as after a send, is removed at once).
// - Another tab's change arrives as a storage event. An input that has the keyboard in a focused
//   window keeps what it shows: the other tab's text waits until that input loses focus, and is
//   dropped if this tab changed the draft in the meantime (this tab's text is then saved and
//   goes to the other tab). So a caret the user is moving never jumps.
// - The caret follows the draft within the page: the input that appears after a view switch puts
//   it where the previous one left it (at the end after a reload).
// - Answers picked so far for a pending question (by request id) live here too, in memory only:
//   both views draw the same question, and switching keeps the half-answered state.
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";

const DRAFT_PREFIX = "maru_composer_draft:";
/** Typing settles this long before the draft is written to localStorage. */
export const DRAFT_SAVE_DELAY_MS = 300;

type Listener = () => void;

const drafts = new Map<string, string>();
const listeners = new Map<string, Set<Listener>>();
/** Inputs that show a key's draft, to tell whether one has the keyboard. */
const inputs = new Map<string, Set<RefObject<HTMLElement | null>>>();
/** Local edits per key; a held-back remote value applies only if this did not move. */
const editSeq = new Map<string, number>();
const dirty = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let windowHooked = false;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Storage blocked: drafts live in memory only.
    return null;
  }
}

function readStored(key: string): string {
  try {
    return storage()?.getItem(DRAFT_PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

function writeStored(key: string, text: string): void {
  try {
    const store = storage();
    if (!store) return;
    if (text === "") store.removeItem(DRAFT_PREFIX + key);
    else store.setItem(DRAFT_PREFIX + key, text);
  } catch {
    // Full or blocked storage: the draft stays in memory for this page.
  }
}

function notify(key: string): void {
  for (const l of [...(listeners.get(key) ?? [])]) l();
}

function flush(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  for (const key of dirty) writeStored(key, drafts.get(key) ?? "");
  dirty.clear();
}

function hasKeyboard(key: string): HTMLElement | null {
  if (typeof document === "undefined" || !document.hasFocus()) return null;
  for (const ref of inputs.get(key) ?? []) {
    if (ref.current && ref.current === document.activeElement) return ref.current;
  }
  return null;
}

function applyRemote(key: string, text: string): void {
  const el = hasKeyboard(key);
  if (!el) {
    drafts.set(key, text);
    notify(key);
    return;
  }
  // Held back until the input lets go of the keyboard (it, or the whole window, loses focus).
  const seq = editSeq.get(key) ?? 0;
  const release = () => {
    el.removeEventListener("focusout", release);
    window.removeEventListener("blur", release);
    if ((editSeq.get(key) ?? 0) !== seq) return;
    if (readStored(key) !== text) return;
    drafts.set(key, text);
    notify(key);
  };
  el.addEventListener("focusout", release);
  window.addEventListener("blur", release);
}

function onStorage(event: StorageEvent): void {
  if (event.storageArea !== storage()) return;
  if (event.key === null) {
    // Storage cleared in another tab.
    for (const key of [...drafts.keys()]) applyRemote(key, "");
    return;
  }
  if (!event.key.startsWith(DRAFT_PREFIX)) return;
  const key = event.key.slice(DRAFT_PREFIX.length);
  if (!drafts.has(key) && !listeners.has(key)) return;
  applyRemote(key, event.newValue ?? "");
}

function hookWindow(): void {
  if (windowHooked || typeof window === "undefined") return;
  windowHooked = true;
  window.addEventListener("storage", onStorage);
  // A reload or a closed tab must not lose the last keystrokes still waiting for the timer.
  window.addEventListener("pagehide", flush);
}

export function getComposerDraft(key: string): string {
  if (!drafts.has(key)) drafts.set(key, readStored(key));
  return drafts.get(key) ?? "";
}

export function setComposerDraft(key: string, text: string): void {
  if (getComposerDraft(key) === text) return;
  drafts.set(key, text);
  editSeq.set(key, (editSeq.get(key) ?? 0) + 1);
  notify(key);
  dirty.add(key);
  if (text === "") {
    flush();
    return;
  }
  if (saveTimer === null) saveTimer = setTimeout(flush, DRAFT_SAVE_DELAY_MS);
}

/**
 * Puts back a message the server did not send (command.result `unsent`), while the draft is still
 * empty: text typed since the send is kept as it is.
 */
export function restoreComposerDraft(key: string, text: string): void {
  if (getComposerDraft(key) === "") setComposerDraft(key, text);
}

/** Calls `listener` when the key's draft changes (here or in another tab). */
export function subscribeComposerDraft(key: string, listener: Listener): () => void {
  hookWindow();
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/** Where the caret was in the last input that showed a key's draft (this page only). */
const carets = new Map<string, { start: number; end: number }>();
const CARET_EVENTS = ["keyup", "mouseup", "input", "select", "blur"] as const;

/** The caret a new input for this draft starts with: where the last one left it, else the end. */
export function caretFor(key: string, length: number): { start: number; end: number } {
  const saved = carets.get(key);
  return saved && saved.start <= length && saved.end <= length ? saved : { start: length, end: length };
}

/** Where the caret is in the session's draft now: in the input that shows it, else where one left it. */
export function composerCaret(key: string): number {
  for (const ref of inputs.get(key) ?? []) {
    const el = ref.current;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.selectionStart ?? el.value.length;
  }
  return caretFor(key, getComposerDraft(key).length).start;
}

/**
 * Puts the caret at `at` in the session's draft (after a change made from outside the input, such
 * as queued messages coming back), and gives the input the keyboard.
 */
export function placeComposerCaret(key: string, at: number): void {
  carets.set(key, { start: at, end: at });
  if (typeof requestAnimationFrame === "undefined") return;
  // After React has drawn the new text.
  requestAnimationFrame(() => {
    for (const ref of inputs.get(key) ?? []) {
      const el = ref.current;
      if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) || el.disabled) continue;
      el.focus({ preventScroll: true });
      el.setSelectionRange(at, at);
      return;
    }
  });
}

/**
 * Keeps the caret with the draft: an input that appears (the other view's, or this one after a
 * question closed it) puts the caret where the previous input left it.
 */
function useCaret(key: string, inputRef: RefObject<HTMLElement | null> | undefined): void {
  const attached = useRef<{ el: HTMLElement; off: () => void } | null>(null);
  // Every commit: a new element under the ref takes the caret and starts reporting it.
  useLayoutEffect(() => {
    const el = inputRef?.current ?? null;
    if (attached.current?.el === el) return;
    attached.current?.off();
    attached.current = null;
    if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return;
    const at = caretFor(key, el.value.length);
    el.setSelectionRange(at.start, at.end);
    const save = () => carets.set(key, { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 });
    for (const type of CARET_EVENTS) el.addEventListener(type, save);
    attached.current = {
      el,
      off: () => {
        save();
        for (const type of CARET_EVENTS) el.removeEventListener(type, save);
      },
    };
  });
  // Unmount: keep the last caret for the next input.
  useLayoutEffect(
    () => () => {
      attached.current?.off();
      attached.current = null;
    },
    [],
  );
}

/**
 * The session's draft and its setter. Pass the input's ref so another tab's change waits while
 * that input has the keyboard, and so the caret follows the draft from one view to the other.
 */
export function useComposerDraft(key: string, inputRef?: RefObject<HTMLElement | null>): [string, (text: string) => void] {
  useCaret(key, inputRef);
  const subscribeKey = useCallback(
    (listener: Listener) => {
      const unsubscribe = subscribeComposerDraft(key, listener);
      if (!inputRef) return unsubscribe;
      let refs = inputs.get(key);
      if (!refs) inputs.set(key, (refs = new Set()));
      refs.add(inputRef);
      return () => {
        unsubscribe();
        refs.delete(inputRef);
        if (refs.size === 0) inputs.delete(key);
      };
    },
    [key, inputRef],
  );
  const text = useSyncExternalStore(subscribeKey, () => getComposerDraft(key), () => "");
  const set = useCallback((next: string) => setComposerDraft(key, next), [key]);
  return [text, set];
}

// ---- pending question answers ----

/** Answers to one pending ask so far: picked option labels and typed text, by question text. */
export interface QuestionDraft {
  picked: Readonly<Record<string, readonly string[]>>;
  other: Readonly<Record<string, string>>;
  /** Questions the terminal picker moved past (it asks one at a time). */
  submitted?: readonly string[];
  /** Text in the terminal picker's field before Enter takes it as the answer. */
  typing?: Readonly<Record<string, string>>;
}

const EMPTY_QUESTION_DRAFT: QuestionDraft = { picked: {}, other: {} };
const questionDrafts = new Map<string, QuestionDraft>();
const questionListeners = new Map<string, Set<Listener>>();

/** The answer a question sends: picked labels, then the typed text (packages/shared pendingAnswers.ts). */
export { questionAnswerOf } from "@maru/shared";

export function getQuestionDraft(requestId: string): QuestionDraft {
  return questionDrafts.get(requestId) ?? EMPTY_QUESTION_DRAFT;
}

export function updateQuestionDraft(requestId: string, change: (draft: QuestionDraft) => QuestionDraft): void {
  questionDrafts.set(requestId, change(getQuestionDraft(requestId)));
  for (const l of [...(questionListeners.get(requestId) ?? [])]) l();
}

/** Forgets an ask's answers once they are sent. */
export function clearQuestionDraft(requestId: string): void {
  questionDrafts.delete(requestId);
}

export function useQuestionDraft(requestId: string): [QuestionDraft, (change: (draft: QuestionDraft) => QuestionDraft) => void] {
  const subscribeRequest = useCallback(
    (listener: Listener) => {
      let set = questionListeners.get(requestId);
      if (!set) questionListeners.set(requestId, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) questionListeners.delete(requestId);
      };
    },
    [requestId],
  );
  const draft = useSyncExternalStore(subscribeRequest, () => getQuestionDraft(requestId), () => EMPTY_QUESTION_DRAFT);
  const update = useCallback((change: (draft: QuestionDraft) => QuestionDraft) => updateQuestionDraft(requestId, change), [requestId]);
  return [draft, update];
}
