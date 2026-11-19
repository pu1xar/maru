// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: components/chat/ChatComposer.tsx (lane, body and footer rows, Enter to send),
// ComposerSurface.tsx (glass card, outline and highlight), the stop and send buttons of
// ComposerPrimaryActions.tsx, ProviderSubagentBar.tsx (the bar that takes the input's place when
// this view cannot send) and ComposerPendingUserInputPanel.tsx with
// ComposerPendingApprovalActions.tsx (the question and the approval asked above the input). Local
// change: a plain textarea instead of T3's rich editor, no queued-draft controls, and the model
// button (ComposerModelButton.tsx) opens the `/model` picker from the footer (DESIGN.md 6m);
// attachments (paste, drop, the paperclip) go through ComposerAttachments.tsx and ride on
// thread.send as upload ids (DESIGN.md 6n); the commands are maru's thread.send, thread.interrupt and thread.answer over /ws
// (DESIGN.md M2). A `/` at the start opens the session's command menu (ComposerCommandMenu.tsx); a
// result the server answers for a command it ran itself shows in the notice above the input.
// `/model` and its kin open maru's picker in the menu's place (SessionPicker.tsx, DESIGN.md 6m);
// a CLI screen maru does not have is not sent, the notice says so. Inside a code block not closed
// yet, Enter adds a line and Cmd or Ctrl with Enter sends (lib/composerText.ts, DESIGN.md 7). Esc
// twice on an empty input, or a message's 되돌리기 button, opens the rewind dialog (RewindDialog.tsx,
// DESIGN.md 6o); a conversation rewind puts the message back into the draft. ↑ and ↓ on the input's
// first and last line walk the messages this session's user sent (lib/composerHistory.logic.ts,
// DESIGN.md 6h).
import type { AskedQuestion, PendingQuestionView, SessionCommand, SessionSummary, ThreadProjectionState, ThreadPromptCache } from "@maru/shared";
import { approvalAnswer, approvalPlan, approvalTitle, askedQuestions, goalDetailText, questionAnswers, questionsComplete, setOtherAnswer, togglePick } from "@maru/shared";
import { ArrowUpLeftIcon, BotIcon, CheckIcon, CircleAlertIcon, InfoIcon, LockIcon, TargetIcon, TerminalIcon, WifiOffIcon, XIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import { attachmentsToSend, restoreComposerAttachments, UPLOADING, useComposerAttachments } from "~/lib/composerAttachments";
import { placeComposerCaret, restoreComposerDraft, useComposerDraft, useQuestionDraft, type QuestionDraft } from "~/lib/composerDraft";
import { caretOnFirstLine, caretOnLastLine } from "~/lib/caretLine";
import { isPlainArrow, liveHistory, NO_HISTORY, stepHistory } from "~/lib/composerHistory.logic";
import { composerEnter, composerKeyOf, FENCE_ENTER_HINT, messageToSend } from "~/lib/composerText";
import { markSent, recallQueued, sendQueuedNow, useQueuedMessages, useRecalling, useSendingNow } from "~/lib/queuedMessages";
import { canSendNow, hasQueuedForSendNow, isSendNowKey, recallableIds } from "~/lib/queuedMessages.logic";
import { fenceOpenAt } from "./userMessageFences";
import { openSession } from "~/lib/openSession";
import { usePendingQuestions } from "~/lib/pending";
import { useServerDown } from "~/lib/serverDown";
import { useSessionCommands } from "~/lib/sessionCommands";
import { interceptMessage, useSessionPicker } from "~/lib/sessionPicker";
import { onForkError } from "~/lib/forkHere";
import { useRewindScreen } from "~/lib/rewind";
import { isDoublePress } from "~/lib/rewind.logic";
import { socketHub } from "~/lib/socket";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerAttachButton, ComposerAttachmentStrip, DropHint, useFileDrop } from "./ComposerAttachments";
import { ComposerCommandMenu, commandOptionId } from "./ComposerCommandMenu";
import { ComposerCacheClock } from "./ComposerCacheClock";
import { ComposerModelButton } from "./ComposerModelButton";
import { pickCommand, searchSlashCommands, slashQuery } from "./composerSlashCommandSearch";
import { RewindDialog } from "./RewindDialog";
import { GoalStatusText } from "../GoalStatusText";
import { SessionPicker, pickerOptionId } from "./SessionPicker";

import { sendBlock, sendBlocker, type SendBlock } from "./sendBlock.logic";

// The rules live in sendBlock.logic.ts (the Android app reads them too); the terminal mode imports them from here.
export { sendBlock, sendBlocker, type SendBlock };

/** What a send does beyond sending, for the send button's tooltip. */
function sendHint(session: SessionSummary): string {
  if (session.owner === "ui") return "Send";
  if (session.status === "closed") return "Sending resumes this session";
  // Codex held by another client but idle (sendBlock lets it through).
  if (session.owner === "terminal") return "Sending takes over this session";
  return "Send";
}

const BLOCK_ICON: Record<SendBlock["kind"], ReactNode> = {
  subagent: <BotIcon aria-hidden className="size-4 shrink-0" />,
  terminal: <TerminalIcon aria-hidden className="size-4 shrink-0" />,
  "other-client": <LockIcon aria-hidden className="size-4 shrink-0" />,
};

/**
 * T3's ComposerSurface: an 80% glass card with a thin outline and, in dark, a top highlight. The
 * outline and highlight mix the foreground token so a light theme gets its own. Local change: the
 * outline steps up while focus is inside, since a textarea shows nothing but its caret (CP-09).
 */
const COMPOSER_SURFACE_CLASS = [
  "relative isolate w-full rounded-2xl shadow-composer dark:shadow-none",
  "[--composer-glass:var(--card)] dark:[--composer-glass:var(--surface-2)]",
  "[--composer-outline:color-mix(in_srgb,var(--foreground)_8%,transparent)] dark:[--composer-outline:color-mix(in_srgb,var(--foreground)_5%,transparent)]",
  "[--composer-outline-focus:color-mix(in_srgb,var(--foreground)_22%,transparent)] dark:[--composer-outline-focus:color-mix(in_srgb,var(--foreground)_16%,transparent)]",
  "[--composer-highlight:color-mix(in_srgb,var(--foreground)_3%,transparent)]",
  "before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-2xl before:bg-(--composer-glass)/(--glass-opacity) before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation)",
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-(--composer-outline) dark:after:inset-shadow-2xs dark:after:inset-shadow-(color:--composer-highlight)",
  "focus-within:after:border-(--composer-outline-focus)",
].join(" ");

const NO_MESSAGES: readonly string[] = [];

let reqSeq = 0;
export function nextReqId(): string {
  reqSeq += 1;
  return `composer-${Date.now().toString(36)}-${reqSeq}`;
}

/**
 * What the server answered for this session's commands: an error, or the result of a command it
 * ran itself (a notice, a session to open). A result also ends the send's wait.
 */
export function useCommandFeedback(sessionKey: string, setSending: (sending: boolean) => void) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Listens for command.error and command.result answers that name this session.
  useEffect(
    () =>
      socketHub().onMessage((msg) => {
        if (msg.type === "command.error" && msg.threadId === sessionKey) {
          setError(msg.error);
          // A refused send comes back into the composer, as an unsent command does below.
          if (msg.unsent) restoreComposerDraft(sessionKey, msg.unsent);
          if (msg.unsentAttachments) restoreComposerAttachments(sessionKey, msg.unsentAttachments);
        } else if (msg.type === "command.result" && msg.threadId === sessionKey) {
          setNotice(msg.notice ?? null);
          setSending(false);
          if (msg.open) openSession(msg.open);
          if (msg.unsent) restoreComposerDraft(sessionKey, msg.unsent);
        }
      }),
    [sessionKey, setSending],
  );
  return { error, setError, notice, setNotice };
}

export function ThreadComposer({
  session,
  isSubagent,
  onOpenParent,
  threadState,
  promptCache,
  history = NO_MESSAGES,
}: {
  session: SessionSummary;
  isSubagent: boolean;
  /** Back to the conversation one level up, for a subagent's read-only bar. */
  onOpenParent?: (() => void) | undefined;
  /** The open thread's state: the pickers show the current model, effort and mode from it. */
  threadState?: ThreadProjectionState | null;
  /** When the conversation's prompt cache was last used and its TTL (Claude only), for the cache clock. */
  promptCache?: ThreadPromptCache | null;
  /** What the user sent in this session, oldest first, for ↑ and ↓ in the input (userHistory). */
  history?: readonly string[];
}) {
  const block = sendBlock(session, isSubagent);
  const blocker = block?.label ?? null;
  // The message can still be written while the server is away; only sending waits for it.
  const serverDown = useServerDown();
  const pending = usePendingQuestions(session.key);
  const [sending, setSending] = useState(false);
  const { error, setError, notice, setNotice } = useCommandFeedback(session.key, setSending);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // The draft is the session's, shared with the terminal mode's input (lib/composerDraft.ts).
  const [text, setText] = useComposerDraft(session.key, textareaRef);
  // Messages that wait for the model: ↑ in an empty input takes them back (DESIGN.md 4.4).
  const queuedSends = useQueuedMessages(session.key);
  const recallable = recallableIds(queuedSends, useRecalling());
  // Esc sends them now while the turn runs (DESIGN.md 4.4); a request already on its way is not sent twice.
  const sendingNow = useSendingNow(session.key);
  const escSendsNow = canSendNow(session, isSubagent) && hasQueuedForSendNow(queuedSends) && !sendingNow && !serverDown;
  // Files and pictures for the next message, shared the same way (lib/composerAttachments.ts).
  const att = useComposerAttachments(session.key);
  const drop = useFileDrop(att.add, block === null);
  const toSend = attachmentsToSend(att.items);
  // The "still uploading" refusal of an Enter goes once the uploads end.
  useEffect(() => {
    if (!toSend.uploading) setError((e) => (e === UPLOADING ? null : e));
  }, [toSend.uploading, setError]);
  const running = session.status === "running" || session.status === "waiting-input";
  const goal = threadState?.goal ?? null;
  const ownRun = session.owner === "ui";
  // Where the caret is, for the hint that Enter adds a line inside a code block.
  const [caret, setCaret] = useState(0);
  const inFence = fenceOpenAt(text, Math.min(caret, text.length));

  // The `/` menu: open while the message is a lone `/word`, until Esc dismisses it for that text.
  const listId = useId();
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  // ↑ and ↓ walk the session's earlier messages; a walk in progress keeps the `/` menu closed so a
  // remembered `/model` does not hand the next ↑ to the menu.
  const [nav, setNav] = useState(NO_HISTORY);
  const walk = liveHistory(nav, history, text);
  const query = blocker === null ? slashQuery(text) : null;
  const menuOpen = query !== null && dismissedFor !== text && walk.at === null;
  const commandList = useSessionCommands(session.key, menuOpen);
  const items = useMemo(
    () => (menuOpen && commandList.commands ? searchSlashCommands(commandList.commands, query ?? "") : []),
    [menuOpen, commandList.commands, query],
  );
  // The highlight belongs to the query it was moved in; a new query starts at the top.
  const [highlight, setHighlight] = useState<{ query: string | null; index: number }>({ query: null, index: 0 });
  const activeIndex = highlight.query === query ? Math.min(highlight.index, Math.max(0, items.length - 1)) : 0;
  const picker = useSessionPicker(session, threadState, { onError: setError });
  const pickerListId = useId();
  // Rewind (DESIGN.md 6o): Esc twice on an empty input, or a message's 되돌리기 button.
  const rewind = useRewindScreen(session.key, {
    enabled: !isSubagent,
    onDone: (result) => {
      setError(null);
      setNotice(result.notice);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
  });
  // A message's 여기서 fork that failed shows its reason here (lib/forkHere.ts, DESIGN.md 6q).
  useEffect(
    () =>
      isSubagent
        ? undefined
        : onForkError(session.key, (message) => {
            setNotice(null);
            setError(message);
          }),
    [session.key, isSubagent, setError, setNotice],
  );
  const lastEsc = useRef(0);

  /** The model button (DESIGN.md 6m): the same picker `/model` opens, keys in the textarea where a keyboard exists. */
  const toggleModelPicker = () => {
    if (picker.kind === "model") {
      picker.close();
      return;
    }
    setNotice(null);
    picker.open("model");
    // A phone keeps its keyboard down; a tap on a row works without the textarea's focus.
    if (window.matchMedia("(pointer: fine)").matches) textareaRef.current?.focus();
  };
  // A press outside the picker, the model button and the textarea closes the picker, also when the
  // textarea never had the focus (the blur handler does it when it had).
  const pickerOpen = picker.kind !== null;
  const closePicker = picker.close;
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-session-picker], [data-composer-model-button], textarea")) return;
      closePicker();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [pickerOpen, closePicker]);

  /**
   * `/model` alone opens its picker; a CLI screen maru does not have only gets the notice, and the
   * text stays for the user to change. Returns true when handled.
   */
  const intercept = (body: string): boolean => {
    const hit = interceptMessage(session.provider, body, commandList.commands);
    if (!hit) return false;
    setError(null);
    if (hit.kind === "unsupported") {
      setNotice(hit.notice);
      return true;
    }
    setText("");
    setNotice(null);
    picker.open(hit.picker);
    return true;
  };

  // A send settles when the session's index entry moves (the run took it) or an error comes back.
  useEffect(() => {
    if (sending && (ownRun || error)) setSending(false);
  }, [sending, ownRun, error, session.updatedAt]);

  const send = (raw: string) => {
    const body = messageToSend(raw);
    if ((body === null && att.items.length === 0) || blocker || serverDown) return;
    if (toSend.blocked) return setError(toSend.blocked);
    if (body !== null && toSend.ids.length === 0 && intercept(body)) return;
    setError(null);
    setNotice(null);
    const ok = socketHub().send({
      type: "thread.send", threadId: session.key, text: body ?? "", reqId: nextReqId(),
      ...(toSend.ids.length > 0 ? { attachments: toSend.ids } : {}),
    });
    if (!ok) {
      setError("Disconnected from server, could not send");
      return;
    }
    markSent(session.key);
    setText("");
    att.clear();
    setSending(!ownRun);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send(text);
  };

  const pick = (item: SessionCommand, how: "enter" | "tab" | "click") => {
    // Enter and a click open maru's picker (or say the command is not supported); Tab puts the
    // name in so an argument can follow.
    if (item.sigil === "/" && item.handling && (how !== "tab" || item.handling.kind === "unsupported")) {
      intercept(`/${item.name}`);
      textareaRef.current?.focus();
      return;
    }
    const picked = pickCommand(item, how);
    if (picked.send) {
      send(picked.text);
      return;
    }
    setText(picked.text);
    textareaRef.current?.focus();
  };

  const interrupt = () => {
    setError(null);
    if (!socketHub().send({ type: "thread.interrupt", threadId: session.key, reqId: nextReqId() })) {
      setError("Disconnected from server, could not stop");
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter while a Korean (or any IME) syllable is composing only commits the syllable.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (picker.onKeyDown(event)) return;
    if (event.key === "ArrowUp" && text === "" && recallable.length > 0) {
      event.preventDefault();
      if (!recallQueued(session.key, recallable)) setError("Disconnected from server, could not move the message back");
      return;
    }
    if (menuOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedFor(text);
        return;
      }
      const item = items[activeIndex];
      if (item) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          setHighlight({ query, index: (activeIndex + step + items.length) % items.length });
          return;
        }
        if (event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          pick(item, "tab");
          return;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          pick(item, "enter");
          return;
        }
      }
    }
    // ↑ on the first visual line and ↓ on the last walk the sent messages (the menu and the pickers
    // took their arrows above; a selection or a modifier keeps the key for the textarea). Visual: a
    // wrapped line counts as several (lib/caretLine.ts).
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !menuOpen && picker.kind === null && isPlainArrow(event)) {
      const el = event.currentTarget;
      const up = event.key === "ArrowUp";
      if (up ? caretOnFirstLine(el) : caretOnLastLine(el)) {
        const step = stepHistory(walk, history, up ? -1 : 1, text);
        if (step) {
          event.preventDefault();
          setNav(step.state);
          setText(step.text);
          setCaret(step.caret);
          placeComposerCaret(session.key, step.caret);
          return;
        }
      }
    }
    // Esc while a message waits in a running turn sends it now (the CLI's Esc with a queue), after
    // the picker and the menu took their Esc; it is not a press of the rewind double press.
    if (escSendsNow && isSendNowKey(event)) {
      event.preventDefault();
      lastEsc.current = 0;
      if (!sendQueuedNow(session.key)) setError("Disconnected from server, could not send now");
      return;
    }
    // Esc twice on an empty input opens the rewind screen (the CLI's double press, after the
    // picker and the menu took their Esc).
    if (event.key === "Escape" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      if (text === "" && !isSubagent && isDoublePress(lastEsc.current, now)) {
        event.preventDefault();
        lastEsc.current = 0;
        // After this key event: the dialog's Esc listener, added as it opens, would get this same
        // Esc as it bubbles to the document and close the dialog again (measured in headless Chromium).
        setTimeout(() => rewind.open(), 0);
      } else {
        lastEsc.current = text === "" ? now : 0;
      }
      return;
    }
    // Inside a code block not closed yet, Enter adds a line (the textarea does it); Cmd or Ctrl
    // with Enter sends anyway.
    if (composerEnter(composerKeyOf(event), text, event.currentTarget.selectionStart) === "send") {
      event.preventDefault();
      send(text);
    }
  };

  // Grows the textarea with its text; past the max height it scrolls.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  return (
    <div className="chat-composer-lane w-full shrink-0 bg-background pt-1.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pt-2">
      {isSubagent ? null : <RewindDialog screen={rewind} provider={session.provider} />}
      <div className="relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2">
        {goal ? (
          // The thread's goal (/goal): the TUI's "Pursuing goal (1m)" (Codex) or "/goal active (5m)" (Claude)
          // as "Goal active (...)", with the objective it works toward; a Claude goal's hover adds the last check.
          <div data-goal-line="" className="flex min-w-0 items-center gap-2 px-1 text-xs text-muted-foreground">
            <TargetIcon aria-hidden className="size-3.5 shrink-0" />
            <GoalStatusText goal={goal} running={running} variant="chat" className="shrink-0 font-medium tabular-nums text-foreground" />
            <span className="min-w-0 truncate" title={goalDetailText(goal)}>{goal.objective}</span>
          </div>
        ) : null}
        {pending.map((q) => (
          <PendingPanel key={q.requestId} sessionKey={session.key} question={q} onError={setError} />
        ))}
        {error ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg bg-error-surface px-3 py-2 text-xs text-error-foreground">
            <CircleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
          </div>
        ) : null}
        {notice ? (
          <div role="status" className="flex items-start gap-2 rounded-lg bg-accent px-3 py-2 text-xs text-foreground">
            <InfoIcon aria-hidden className="mt-px size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{notice}</span>
            <button
              type="button"
              aria-label="Dismiss notice"
              onClick={() => setNotice(null)}
              className="-my-0.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
            >
              <XIcon aria-hidden className="size-3.5" />
            </button>
          </div>
        ) : null}
        <div className="relative">
          {picker.kind && !block ? (
            <div className="absolute inset-x-0 bottom-full z-30 mb-1.5">
              <SessionPicker picker={picker} provider={session.provider} listId={pickerListId} />
            </div>
          ) : menuOpen ? (
            <div className="absolute inset-x-0 bottom-full z-30 mb-1.5">
              <ComposerCommandMenu
                listId={listId}
                items={items}
                isLoading={!commandList.commands && !commandList.error}
                error={commandList.error}
                activeIndex={activeIndex}
                onHighlight={(index) => setHighlight({ query, index })}
                onSelect={(item) => pick(item, "click")}
              />
            </div>
          ) : null}
          {block ? (
            // The input's place says why this view cannot send (DESIGN.md 4.2), in one line.
            <div data-composer-blocked="" className={cn(COMPOSER_SURFACE_CLASS, "flex min-h-12 items-center gap-2.5 py-2 ps-4 pe-2 text-sm text-muted-foreground")}>
              {BLOCK_ICON[block.kind]}
              <span className="min-w-0 flex-1 wrap-anywhere">{block.label}</span>
              {onOpenParent ? (
                <Button size="sm" variant="ghost" onClick={onOpenParent} className="shrink-0">
                  <ArrowUpLeftIcon aria-hidden />
                  Back to parent conversation
                </Button>
              ) : null}
              {running && ownRun ? <StopButton onStop={interrupt} /> : null}
            </div>
          ) : (
            <form onSubmit={submit} className={COMPOSER_SURFACE_CLASS} {...drop.handlers}>
              <DropHint show={drop.over} />
              {/* A click in the padding around the text lands in the text, as on T3's editor. */}
              <div
                className="px-4 pt-3.5 pb-2 sm:pt-4"
                onClick={(event) => {
                  if (event.target === event.currentTarget) textareaRef.current?.focus();
                }}
              >
                {att.items.length > 0 ? (
                  <div className="mb-3">
                    <ComposerAttachmentStrip items={att.items} onRemove={att.remove} />
                  </div>
                ) : null}
                <textarea
                  onPaste={att.onPaste}
                  ref={textareaRef}
                  rows={2}
                  value={text}
                  aria-label="Message"
                  aria-autocomplete="list"
                  aria-controls={picker.list?.rows.length ? pickerListId : menuOpen && items.length > 0 ? listId : undefined}
                  aria-activedescendant={
                    picker.list?.rows.length ? pickerOptionId(pickerListId, picker.active)
                      : menuOpen && items.length > 0 ? commandOptionId(listId, activeIndex) : undefined
                  }
                  placeholder={recallable.length > 0 ? "Press ↑ to move the queued message back" : "Message"}
                  onChange={(event) => {
                    // Typing goes on as a message: the picker gives way.
                    if (picker.kind) picker.close();
                    setText(event.currentTarget.value);
                    setCaret(event.currentTarget.selectionStart);
                    // Esc hides the menu for the text it was pressed on; any edit brings it back
                    // (Claude Code CLI does the same), even when the edit returns to that text.
                    setDismissedFor(null);
                    if (nav.at !== null) setNav(NO_HISTORY);
                  }}
                  onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                  onBlur={() => picker.close()}
                  onKeyDown={onKeyDown}
                  className="block max-h-[40vh] w-full resize-none bg-transparent text-sm leading-relaxed text-foreground outline-none placeholder:text-placeholder"
                />
              </div>
              <div
                className="flex min-w-0 items-center gap-2 px-2 pb-2"
                onClick={(event) => {
                  if (event.target === event.currentTarget) textareaRef.current?.focus();
                }}
              >
                <ComposerAttachButton onFiles={att.add} />
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
                  {serverDown ? (
                    <>
                      <WifiOffIcon aria-hidden className="size-3.5 shrink-0" />
                      <span className="truncate">Disconnected from server</span>
                    </>
                  ) : inFence ? (
                    <span className="truncate" data-fence-enter-hint="">
                      {FENCE_ENTER_HINT}
                    </span>
                  ) : null}
                </span>
                <ComposerCacheClock cache={promptCache} running={running} />
                {threadState !== undefined ? (
                  <ComposerModelButton
                    state={threadState}
                    provider={session.provider}
                    sessionKey={session.key}
                    open={picker.kind === "model"}
                    onToggle={toggleModelPicker}
                  />
                ) : null}
                {running && ownRun ? <StopButton onStop={interrupt} /> : null}
                <Tooltip>
                  {/* The span keeps the tooltip when the button is disabled (T3's submit tooltip). */}
                  <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                    <button
                      type="submit"
                      aria-label="Send"
                      disabled={serverDown || sending || (text.trim() === "" && att.items.length === 0) || toSend.uploading}
                      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground shadow-xs transition-colors enabled:cursor-pointer hover:bg-message-action-hover disabled:pointer-events-none disabled:bg-foreground/12 disabled:text-muted-foreground disabled:shadow-none"
                    >
                      {sending ? (
                        <Spinner size="sm" aria-hidden />
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                          <path d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipPopup side="top">{serverDown ? "Disconnected from server" : (toSend.blocked ?? sendHint(session))}</TooltipPopup>
                </Tooltip>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

/** The stop action: a neutral round button with a rounded square (user request: not T3's red). */
function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Stop"
            onClick={onStop}
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-foreground/12 text-foreground transition-colors hover:bg-foreground/20"
          />
        }
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </TooltipTrigger>
      <TooltipPopup side="top">Stop</TooltipPopup>
    </Tooltip>
  );
}

// The answer format is shared with the Android app (packages/shared/src/pendingAnswers.ts).
export { askedQuestions, type AskedQuestion };

/** One pending ask above the input: AskUserQuestion choices, or an approval (ExitPlanMode). */
function PendingPanel(props: { sessionKey: string; question: PendingQuestionView; onError: (e: string) => void }) {
  const { question: q } = props;
  const answer = (answers: Record<string, string>) => {
    const ok = socketHub().send({
      type: "thread.answer",
      threadId: props.sessionKey,
      requestId: q.requestId,
      answers,
      reqId: nextReqId(),
    });
    if (!ok) props.onError("Disconnected from server, could not answer");
  };
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3 text-sm">
      {q.kind === "question" ? (
        <QuestionForm requestId={q.requestId} questions={askedQuestions(q)} onAnswer={answer} />
      ) : (
        <ApprovalForm question={q} onAnswer={answer} />
      )}
    </div>
  );
}

function OtherAnswerRow(props: { multi: boolean; value: string; onChange: (value: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const on = props.value.trim() !== "";
  return (
    <div className={cn("flex items-center gap-2 rounded-md px-2 py-1", on && "bg-accent")}>
      <button
        type="button"
        aria-label="Type your own answer"
        aria-pressed={on}
        onClick={() => input.current?.focus()}
        className={cn(
          "flex size-4 shrink-0 items-center justify-center border border-input",
          props.multi ? "rounded-sm" : "rounded-full",
          on && "border-primary bg-primary text-primary-foreground",
        )}
      >
        {on ? <CheckIcon aria-hidden className="size-3" /> : null}
      </button>
      <input
        ref={input}
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        placeholder="Type your own"
        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}

function QuestionForm(props: { requestId: string; questions: AskedQuestion[]; onAnswer: (a: Record<string, string>) => void }) {
  // Answers so far are the ask's, shared with the terminal mode's picker (lib/composerDraft.ts).
  const [draft, updateDraft] = useQuestionDraft(props.requestId);
  const { picked, other } = draft;

  const complete = questionsComplete(props.questions, draft);
  const toggle = (q: AskedQuestion, label: string) => updateDraft((d) => ({ ...d, ...togglePick(d, q, label) }));
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete) props.onAnswer(questionAnswers(props.questions, draft));
      }}
    >
      {props.questions.map((q) => (
        <fieldset key={q.question} className="flex flex-col gap-1">
          {q.header ? <legend className="text-xs text-muted-foreground">{q.header}</legend> : null}
          <p className="text-foreground/90">{q.question}</p>
          <div className="flex flex-col">
            {(q.options ?? []).map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(q, o.label)}
                  className={cn(
                    "flex items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent",
                    on && "bg-accent",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center border border-input",
                      q.multiSelect ? "rounded-sm" : "rounded-full",
                      on && "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {on ? <CheckIcon aria-hidden className="size-3" /> : null}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">{o.label}</span>
                    {o.description ? <span className="text-xs text-secondary-label">{o.description}</span> : null}
                  </span>
                </button>
              );
            })}
            {/* The own answer is one more choice in the list, its mark like the options' (user request 2026-11-19:
                "O 1 O 2 O [주관식]"); the mark is on while text is typed and a click on it moves to the field. */}
            <OtherAnswerRow
              multi={q.multiSelect === true}
              value={other[q.question] ?? ""}
              onChange={(v) => updateDraft((d) => ({ ...d, ...setOtherAnswer(d, q, v) }))}
            />
          </div>
        </fieldset>
      ))}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!complete}>
          Answer
        </Button>
      </div>
    </form>
  );
}

function ApprovalForm(props: { question: PendingQuestionView; onAnswer: (a: Record<string, string>) => void }) {
  const { question: q } = props;
  const [feedback, setFeedback] = useState("");
  const plan = approvalPlan(q);
  const title = approvalTitle(q);
  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium text-foreground">{title}</p>
      {q.description ? <p className="text-xs text-secondary-label">{q.description}</p> : null}
      {plan ? (
        <pre className="max-h-[40vh] overflow-auto rounded-md bg-background p-3 font-sans text-xs whitespace-pre-wrap text-foreground/85">
          {plan}
        </pre>
      ) : null}
      <input
        value={feedback}
        onChange={(event) => setFeedback(event.currentTarget.value)}
        placeholder="Note for the decline (optional)"
        className="h-8 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => props.onAnswer(approvalAnswer("reject", feedback))}
        >
          Decline
        </Button>
        <Button size="sm" onClick={() => props.onAnswer(approvalAnswer("approve"))}>
          Approve
        </Button>
      </div>
    </div>
  );
}
