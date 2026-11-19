// The terminal mode's input (DESIGN.md 6i), shaped as the Claude Code CLI (2.1.325) draws it in the
// user's fullscreen TUI (measured): a rule above and below a `❯` prompt, the permission mode line
// under it, the `/` menu as rows over the top rule, and the `?` shortcut grid. It sends and answers
// through the same commands as ThreadComposer (thread.send, thread.interrupt, thread.answer) and
// shows the same pending asks (lib/pending.ts), drawn as the CLI's pickers (TerminalPending.tsx).
// The text is the session's draft (lib/composerDraft.ts), the same one the chat composer edits.
// `/model` and its kin open the session picker in the menu's place (TerminalSessionPicker.tsx,
// DESIGN.md 6m), with the chat composer's hook; a CLI screen maru does not have only gets the notice.
// Enter follows the chat composer's rule (lib/composerText.ts): inside a code block not closed
// yet it adds a line, and Cmd or Ctrl with Enter sends. Esc follows the CLI: it stops this app's
// run; on a typed input the first press says "Esc again to clear" and the second clears; on an
// empty input two presses open the rewind screen (TerminalRewind.tsx, DESIGN.md 6o) in the
// input's place.
import type { ClientMessage, SessionCommand, SessionSummary, ThreadSnapshot } from "@maru/shared";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { attachmentsToSend, UPLOADING, useComposerAttachments } from "~/lib/composerAttachments";
import { useComposerDraft } from "~/lib/composerDraft";
import { markSent, recallQueued, sendQueuedNow, useQueuedMessages, useRecalling, useSendingNow } from "~/lib/queuedMessages";
import { canSendNow, hasQueuedForSendNow, recallableIds } from "~/lib/queuedMessages.logic";
import { caretOnFirstLine, caretOnLastLine } from "~/lib/caretLine";
import { stepHistory } from "~/lib/composerHistory.logic";
import { composerEnter, composerKeyOf, FENCE_ENTER_HINT, messageToSend } from "~/lib/composerText";
import { useRewindScreen } from "~/lib/rewind";
import { CLEAR_HINT_MS, isDoublePress } from "~/lib/rewind.logic";
import { useWindowKeysRef } from "~/lib/windowKeys";
import { usePendingQuestions } from "~/lib/pending";
import { refreshSessionAgents } from "~/lib/sessionAgents";
import { describeError, resumeSessionWorkflow, stopSessionAgent } from "~/projectsApi";
import { useSessionCommands } from "~/lib/sessionCommands";
import { interceptMessage, useSessionPicker } from "~/lib/sessionPicker";
import { socketHub } from "~/lib/socket";
import { nextReqId, sendBlocker, useCommandFeedback } from "../chat/ThreadComposer";
import { fenceOpenAt } from "../chat/userMessageFences";
import { pickCommand, searchSlashCommands, slashQuery } from "../chat/composerSlashCommandSearch";
import { useFileDrop } from "../chat/ComposerAttachments";
import { GoalStatusText } from "../GoalStatusText";
import { TerminalAttachButton, TerminalAttachmentLines } from "./TerminalAttachments";
import { TerminalPending } from "./TerminalPending";
import { rewindKey, TerminalRewind } from "./TerminalRewind";
import { TerminalSessionPicker, terminalPickerOptionId } from "./TerminalSessionPicker";
import { panelWindow, selectionHint, taskRows, workflowBar, type TaskRow } from "./terminalTasks";
import { useTerminalTasks } from "./useTerminalTasks";
import {
  effectivePermissionMode,
  menuWindowStart,
  nextPermissionMode,
  oneLine,
  permissionModeLabel,
  planSignal,
  statusParts,
  type PermissionMode,
} from "./terminalModel";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MODE_SHORTCUT_LABEL = IS_MAC ? "⌥⌘T" : "ctrl + alt + t";
/** Rows of the `/` menu shown at once, one line each. */
export const MENU_ROWS = 5;

/** The `/ws` request for shift+tab; the server answers with state.permissionMode or command.error (DESIGN.md 4.3). */
function setPermissionModeMessage(threadId: string, mode: PermissionMode, reqId: string): ClientMessage {
  return { type: "thread.setPermissionMode", threadId, mode, reqId };
}

/**
 * Whether an Esc that reached the window belongs to this input (nothing else took it). A key on the
 * page (focus on the body or a view toggle) is this view's only while it hears the window's keys
 * (`pageKeys`, lib/windowKeys.ts): in the split view, the focused pane's.
 */
function escapeIsOurs(target: EventTarget | null, root: HTMLElement | null, pageKeys: boolean): boolean {
  if (!(target instanceof HTMLElement) || target === document.body || target === document.documentElement) return pageKeys;
  // Fields and popups handle their own Esc.
  if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog'], [role='menu']")) return false;
  if (root?.closest(".term-root")?.contains(target)) return true;
  return pageKeys && target.closest("[data-view-mode-toggle]") !== null;
}

function SlashMenu(props: {
  listId: string;
  items: readonly SessionCommand[];
  query: string;
  active: number;
  status: string | null;
  onHighlight: (i: number) => void;
  onPick: (item: SessionCommand) => void;
}) {
  const start = menuWindowStart(props.active, props.items.length, MENU_ROWS);
  const shown = props.items.slice(start, start + MENU_ROWS);
  if (props.items.length === 0) return <div className="term-dim term-menu-status">{props.status ?? "No matching commands"}</div>;
  return (
    <div id={props.listId} role="listbox" aria-label="Commands" className="term-menu">
      {shown.map((item, i) => {
        const index = start + i;
        const on = index === props.active;
        const name = `${item.sigil}${item.name}`;
        const q = props.query.toLowerCase();
        const match = q && item.name.toLowerCase().startsWith(q) ? q.length : 0;
        const description = oneLine(item.description);
        return (
          <div
            key={name}
            id={`${props.listId}-${index}`}
            role="option"
            aria-selected={on}
            className={on ? "term-menu-row term-accent" : "term-menu-row term-dim"}
            onMouseMove={() => props.onHighlight(index)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.onPick(item)}
          >
            <span className="term-menu-name">
              {on ? "❯ " : "  "}
              {item.sigil}
              <b className={on ? undefined : "term-fg"}>{item.name.slice(0, match)}</b>
              {item.name.slice(match)}
              {item.argumentHint ? ` ${item.argumentHint}` : ""}
            </span>
            <span className="term-menu-desc" title={description}>
              {description}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ShortcutHelp(props: { modes: boolean }) {
  // The CLI's `?` grid (measured), with the keys this mode has. Columns wrap on a narrow screen.
  const cols = [
    ["/ for commands", "\\⏎ for newline", "shift + ⏎ for newline"],
    ["double tap esc to clear input", "esc to interrupt", ...(props.modes ? ["shift + tab to auto-accept edits"] : []), "↑ ↓ for history", "↓ to manage agents"],
    ["ctrl + o for verbose output", `${MODE_SHORTCUT_LABEL} to switch to chat`, "? to close this list"],
  ];
  return (
    <div className="term-help term-dim">
      {cols.map((col, i) => (
        <div key={i}>
          {col.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The agent panel under the footer (terminalTasks.ts): main, then running agents and workflows. */
function TaskPanel(props: { rows: readonly TaskRow[]; selected: number | null; onPick: (index: number) => void }) {
  const agentRows = props.rows.slice(1);
  const win = panelWindow(agentRows.length, props.selected);
  const visible = [props.rows[0]!, ...agentRows.slice(win.start, win.end)];
  const indexOf = (row: TaskRow) => props.rows.indexOf(row);
  return (
    <div className="term-tasks" role="listbox" aria-label="Activity">
      {win.start > 0 ? <div className="term-dim term-task-more">{`  ↑ ${win.start} more`}</div> : null}
      {visible.map((row) => {
        const index = indexOf(row);
        const on = index === props.selected;
        const glyphClass = row.tone === "stopped" ? "term-err" : row.tone === "done" ? "term-ok" : row.tone === "viewing" ? "term-fg" : "term-dim";
        const bar = row.bar ? workflowBar(row.bar.done, row.bar.total) : null;
        return (
          <div
            key={row.key}
            role="option"
            aria-selected={on}
            className={`term-task ${on ? "term-fg" : row.kind === "main" ? "term-fg" : "term-dim"}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.onPick(index)}
          >
            <span className="term-task-name">
              {on ? "❯ " : "  "}
              <span className={glyphClass}>{row.glyph}</span> {row.kind === "main" ? <b>{row.name}</b> : row.name}
              {row.detail ? `  ${row.detail}` : ""}
              {bar ? (
                <>
                  {"  "}
                  <span className="term-fg">{bar.filled}</span>
                  <span className="term-dim">{bar.empty}</span>
                  {row.right ? `  ${row.right}` : ""}
                </>
              ) : null}
            </span>
            {!bar && row.right ? <span className="term-task-right">{row.right}</span> : null}
          </div>
        );
      })}
      {win.end < agentRows.length ? <div className="term-dim term-task-more">{`  ↓ ${agentRows.length - win.end} more`}</div> : null}
    </div>
  );
}

export function TerminalComposer(props: {
  session: SessionSummary;
  isSubagent: boolean;
  snapshot: ThreadSnapshot | null;
  /** The user's earlier messages in this thread, oldest first (↑ walks back through them). */
  history: readonly string[];
  onToggleVerbose: () => void;
  /** The thread on screen: the session, or a subagent's transcript. */
  viewingThreadId: string;
  /** Shows a thread from the agent panel: the session's own, or an agent's. */
  onShowThread: (threadId: string, title: string | null) => void;
}) {
  const { session } = props;
  const blocker = sendBlocker(session, props.isSubagent);
  const pending = usePendingQuestions(session.key);
  const [sending, setSending] = useState(false);
  const { error, setError, notice, setNotice } = useCommandFeedback(session.key, setSending);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const windowKeys = useWindowKeysRef();
  const [text, setText] = useComposerDraft(session.key, textareaRef);
  // Messages that wait for the model: ↑ takes them back into the input, as in the CLI (DESIGN.md 4.4).
  const queuedSends = useQueuedMessages(session.key);
  const recallable = recallableIds(queuedSends, useRecalling());
  const sendingNow = useSendingNow(session.key);
  // The same waiting attachments as the chat composer (lib/composerAttachments.ts, DESIGN.md 6n).
  const att = useComposerAttachments(session.key);
  const drop = useFileDrop(att.add, blocker === null);
  const toSend = attachmentsToSend(att.items);
  useEffect(() => {
    if (!toSend.uploading) setError((e) => (e === UPLOADING ? null : e));
  }, [toSend.uploading, setError]);
  const [help, setHelp] = useState(false);
  const lastEsc = useRef(0);
  // "Esc again to clear" after the first Esc on a typed input (CLI: a notice of 1 s; the second
  // press counts within the 800 ms double press window).
  const [clearHint, setClearHint] = useState(false);
  useEffect(() => {
    if (!clearHint) return;
    const t = setTimeout(() => setClearHint(false), CLEAR_HINT_MS);
    return () => clearTimeout(t);
  }, [clearHint]);
  const rewind = useRewindScreen(session.key, {
    enabled: !props.isSubagent,
    onDone: (result) => {
      setError(null);
      setNotice(result.notice);
    },
  });
  // The input takes the keyboard back when the rewind screen closes.
  const rewindWasOpen = useRef(false);
  useEffect(() => {
    if (rewindWasOpen.current && !rewind.state.open) textareaRef.current?.focus({ preventScroll: true });
    rewindWasOpen.current = rewind.state.open;
  }, [rewind.state.open]);
  const running = session.status === "running" || session.status === "waiting-input";
  const ownRun = session.owner === "ui";
  /** Where the caret goes after a key that rewrote the text (newline keys). */
  const caretAfter = useRef<number | null>(null);
  // Where the caret is, for the hint that Enter adds a line inside a code block.
  const [caret, setCaret] = useState(0);
  const inFence = fenceOpenAt(text, Math.min(caret, text.length));

  // ↑/↓ history: index into the list from the end; null while editing a new message.
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const draft = useRef("");

  const listId = useId();
  // Esc hides the `/` menu for the text it was pressed on; any edit brings it back.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const query = blocker === null ? slashQuery(text) : null;
  const menuOpen = query !== null && dismissedFor !== text;
  const commandList = useSessionCommands(session.key, menuOpen);
  const items = useMemo(
    () => (menuOpen && commandList.commands ? searchSlashCommands(commandList.commands, query ?? "") : []),
    [menuOpen, commandList.commands, query],
  );
  const [highlight, setHighlight] = useState<{ query: string | null; index: number }>({ query: null, index: 0 });
  const activeIndex = highlight.query === query ? Math.min(highlight.index, Math.max(0, items.length - 1)) : 0;
  const picker = useSessionPicker(session, props.snapshot?.state ?? null, { onError: setError });
  const pickerListId = useId();
  /** `/model` alone opens its picker; a CLI screen maru does not have gets the notice and the text stays. True when handled. */
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

  // ---- agent panel (↓ to manage) ----
  const tasks = useTerminalTasks(session.key);
  const [now, setNow] = useState(() => Date.now());
  const rows = useMemo(() => taskRows(tasks.agents, now, session.key, props.viewingThreadId), [tasks.agents, now, session.key, props.viewingThreadId]);
  // The rows' times count up, and an ended row leaves after its while.
  useEffect(() => {
    if (tasks.agents.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [tasks.agents.length]);
  const [taskSel, setTaskSel] = useState<number | null>(null);
  const selected = taskSel !== null && taskSel < rows.length ? taskSel : null;
  if (taskSel !== null && selected === null) setTaskSel(null);
  const selectedRow = selected !== null ? rows[selected] : undefined;

  const openRow = (row: TaskRow) => {
    if (!row.threadId) return;
    setTaskSel(null);
    props.onShowThread(row.threadId, row.kind === "main" ? null : row.detail || row.name);
  };
  const stopRow = (row: TaskRow) => {
    const a = row.agent;
    if (!a?.stop?.enabled) return;
    setError(null);
    stopSessionAgent({ key: session.key, kind: a.kind, id: a.id })
      .then(() => refreshSessionAgents(session.key))
      .catch((err: unknown) => setError(describeError(err)));
  };
  const resumeRow = (row: TaskRow) => {
    const a = row.agent;
    if (!a?.resume?.enabled) return;
    setError(null);
    resumeSessionWorkflow({ key: session.key, id: a.id })
      .then(() => refreshSessionAgents(session.key))
      .catch((err: unknown) => setError(describeError(err)));
  };
  /** Keys while a panel row is selected (measured): ↑/↓ move, Enter view, x stop, Esc leave. True when used. */
  const panelKey = (key: string): boolean => {
    if (selected === null || !selectedRow) return false;
    if (key === "ArrowDown") setTaskSel(Math.min(selected + 1, rows.length - 1));
    else if (key === "ArrowUp") setTaskSel(selected === 0 ? null : selected - 1);
    else if (key === "Enter") openRow(selectedRow);
    else if (key === "x") stopRow(selectedRow);
    else if (key === "r") resumeRow(selectedRow);
    else if (key === "Escape") setTaskSel(null);
    else return false;
    return true;
  };
  const panelKeyRef = useRef(panelKey);
  panelKeyRef.current = panelKey;
  /** ↓ into the panel (its "main" row first, as the CLI does without a task pill). */
  const enterPanel = (): boolean => {
    if (rows.length === 0 || selected !== null) return false;
    setTaskSel(0);
    return true;
  };
  const enterPanelRef = useRef(enterPanel);
  enterPanelRef.current = enterPanel;

  // ---- permission mode (shift+tab) ----
  const stateMode = props.snapshot?.state.permissionMode;
  // The key works where the server can change the mode: a Claude session whose process this
  // server runs (DESIGN.md 4.3), with a mode reported. Elsewhere the key is off.
  const modesKnown = session.provider === "claude" && stateMode !== undefined;
  const canCycle = modesKnown && blocker === null && session.owner === "ui";
  const visibleItems = props.snapshot?.visibleTurnItems;
  const signal = useMemo(() => planSignal(visibleItems ?? []), [visibleItems]);
  // When this page last saw the server's value change, to order it against EnterPlanMode.
  const [modeSeen, setModeSeen] = useState<{ mode: string | undefined; at: number | null }>({ mode: stateMode, at: null });
  if (modeSeen.mode !== stateMode) setModeSeen({ mode: stateMode, at: Date.now() });
  // A request on its way: shown at once, and the next shift+tab cycles from it.
  const [pendingMode, setPendingMode] = useState<PermissionMode | null>(null);
  if (pendingMode !== null && pendingMode === stateMode) setPendingMode(null);
  const effectiveMode = effectivePermissionMode(stateMode, session.provider === "claude" ? signal : null, modeSeen.at);
  const shownMode = pendingMode ?? effectiveMode;
  // An error from the server ends the wait; the mode line goes back to the server's value.
  useEffect(() => {
    if (error) setPendingMode(null);
  }, [error]);

  const cycleMode = () => {
    if (!canCycle) return;
    const next = nextPermissionMode(shownMode);
    setError(null);
    if (!socketHub().send(setPermissionModeMessage(session.key, next, nextReqId()))) {
      setError("Disconnected from server, could not change mode");
      return;
    }
    setPendingMode(next);
  };

  // A send settles when the run takes the session or an error comes back (ThreadComposer's rule).
  useEffect(() => {
    if (sending && (ownRun || error)) setSending(false);
  }, [sending, ownRun, error, session.updatedAt]);

  // Grows the input with its text, then puts the caret where a newline key left it.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (caretAfter.current !== null) {
      el.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = null;
    }
  }, [text]);

  // The input takes the keyboard when it appears or opens again (a view switch, an answered
  // question, back from a subagent's view), as the CLI's prompt always has it, unless the user is
  // typing somewhere else.
  const inputReady = pending.length === 0 && blocker === null;
  useEffect(() => {
    if (!inputReady) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [inputReady, props.viewingThreadId]);

  const send = (raw: string) => {
    const body = messageToSend(raw);
    if ((body === null && att.items.length === 0) || blocker) return;
    if (toSend.blocked) return setError(toSend.blocked);
    // maru's picker for `/model` and its kin; with attachments the server refuses and both come back.
    if (body !== null && toSend.ids.length === 0 && intercept(body)) return;
    setError(null);
    setNotice(null);
    const attachments = toSend.ids.length > 0 ? { attachments: toSend.ids } : {};
    if (!socketHub().send({ type: "thread.send", threadId: session.key, text: body ?? "", reqId: nextReqId(), ...attachments })) {
      setError("Disconnected from server, could not send");
      return;
    }
    markSent(session.key);
    setText("");
    att.clear();
    setHistoryAt(null);
    setSending(!ownRun);
  };

  const pick = (item: SessionCommand, how: "enter" | "tab" | "click") => {
    // As in the chat composer: Enter and a click open the picker (or say it is not supported), Tab puts the name in.
    if (item.sigil === "/" && item.handling && (how !== "tab" || item.handling.kind === "unsupported")) {
      intercept(`/${item.name}`);
      textareaRef.current?.focus();
      return;
    }
    const picked = pickCommand(item, how);
    if (picked.send) return send(picked.text);
    setText(picked.text);
    textareaRef.current?.focus();
  };

  const interrupt = () => {
    setError(null);
    if (!socketHub().send({ type: "thread.interrupt", threadId: session.key, reqId: nextReqId() })) {
      setError("Disconnected from server, could not stop");
    }
  };

  /**
   * Esc anywhere in this view: close help, stop this app's run, or the CLI's double press: on a
   * typed input the first says "Esc again to clear" and the second clears; on an empty input two
   * open the rewind screen (the CLI: Esc twice with messages and no turn running).
   */
  const escape = () => {
    // The rewind screen is up but the focus left it (a click on the transcript): Esc is its own.
    if (rewind.state.open) return rewind.escape();
    if (selected !== null) return setTaskSel(null);
    if (help) return setHelp(false);
    if (running && ownRun) {
      // With a message waiting in a running turn, Esc sends it now, as the CLI's Esc does (DESIGN.md 4.4).
      if (canSendNow(session, props.isSubagent) && hasQueuedForSendNow(queuedSends)) {
        if (!sendingNow && !sendQueuedNow(session.key)) setError("Disconnected from server, could not send now");
        return;
      }
      return interrupt();
    }
    const now = Date.now();
    const double = isDoublePress(lastEsc.current, now);
    // The CLI's [Image #n] placeholders are part of its input, so its clear takes the pictures too.
    if (text || att.items.length > 0) {
      if (double) {
        setText("");
        att.clear();
        setHistoryAt(null);
        setClearHint(false);
        lastEsc.current = 0;
        return;
      }
      setClearHint(true);
      lastEsc.current = now;
      return;
    }
    if (double && !props.isSubagent) {
      lastEsc.current = 0;
      rewind.open();
      return;
    }
    lastEsc.current = now;
  };
  const escapeRef = useRef(escape);
  escapeRef.current = escape;
  const rewindRef = useRef(rewind);
  rewindRef.current = rewind;

  // Esc that no field or popup took (the focus on the page, a block, the view toggle) works as in
  // the input, and gives the keyboard back to the input.
  // The agent panel's keys work the same way there (and in a subagent's view, whose input is off).
  // While the rewind screen is up, those keys are the screen's (the focus may have left it).
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!escapeIsOurs(event.target, rootRef.current, windowKeys.current)) return;
      if (rewindRef.current.state.open) {
        if (rewindKey(rewindRef.current, event.key)) event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        escapeRef.current();
        textareaRef.current?.focus({ preventScroll: true });
        return;
      }
      if (panelKeyRef.current(event.key) || (event.key === "ArrowDown" && enterPanelRef.current())) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const walkHistory = (step: -1 | 1): boolean => {
    const next = stepHistory({ at: historyAt, draft: draft.current }, props.history, step, text);
    if (!next) return false;
    draft.current = next.state.draft;
    setHistoryAt(next.state.at);
    setText(next.text);
    caretAfter.current = next.caret;
    return true;
  };

  /** Replaces the selection with a newline (or the `\` before the caret with one) and keeps the caret after it. */
  const insertNewline = (el: HTMLTextAreaElement, dropBackslash: boolean) => {
    const start = el.selectionStart - (dropBackslash ? 1 : 0);
    caretAfter.current = start + 1;
    setText(`${text.slice(0, start)}\n${text.slice(el.selectionEnd)}`);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // A key that finishes an IME syllable only commits the syllable.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    // An open picker takes its keys first (number keys pick a row, as in the CLI's lists).
    if (picker.onKeyDown(event, { digits: true })) return;
    const el = event.currentTarget;
    // A panel row is selected: its keys first; any other key goes back to typing.
    if (selected !== null) {
      if (!event.metaKey && !event.ctrlKey && !event.altKey && panelKey(event.key)) {
        event.preventDefault();
        return;
      }
      setTaskSel(null);
    }
    if (event.key === "o" && event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      props.onToggleVerbose();
      return;
    }
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      cycleMode();
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
        if (event.key === "Tab") {
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
    if (event.key === "?" && text === "") {
      event.preventDefault();
      setHelp((h) => !h);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      escape();
      return;
    }
    if (event.key === "ArrowUp" && caretOnFirstLine(el)) {
      if (historyAt === null && recallable.length > 0) {
        event.preventDefault();
        if (!recallQueued(session.key, recallable)) setError("Disconnected from server, could not move the message back");
        return;
      }
      if (walkHistory(-1)) event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" && caretOnLastLine(el)) {
      // Measured: on the last line, ↓ first walks history back to the draft, then enters the panel.
      if (historyAt !== null) {
        if (walkHistory(1)) event.preventDefault();
      } else if (enterPanel()) event.preventDefault();
      return;
    }
    if (event.key === "Enter") {
      if (event.altKey) {
        // Option+Enter adds a line, as Shift+Enter does in the textarea itself.
        event.preventDefault();
        insertNewline(el, false);
        return;
      }
      // Shift, or a code block not closed yet before the caret: the textarea adds the line. Cmd or
      // Ctrl with Enter sends anyway (lib/composerText.ts).
      if (composerEnter(composerKeyOf(event), text, el.selectionStart) !== "send") return;
      event.preventDefault();
      const at = el.selectionStart;
      // CLI: a backslash right before Enter makes a new line instead of sending.
      if (!event.metaKey && !event.ctrlKey && at > 0 && text[at - 1] === "\\" && at === el.selectionEnd) {
        insertNewline(el, true);
        return;
      }
      send(text);
    }
  };

  const mode = permissionModeLabel(shownMode);
  // The mode line: the server's mode, or plan mode the thread's items show while it has none.
  const showMode = session.provider === "claude" && (modesKnown || shownMode === "plan");
  const status = statusParts(props.snapshot, session.cwd);
  const goal = props.snapshot?.state.goal ?? null;
  const placeholder = blocker ?? (recallable.length > 0 ? "Press up to edit queued messages" : 'Try "how does <filepath> work?"');
  // Measured: "◉ xhigh" and "/effort" (a middle dot between) right-aligned over the top rule (dim), when the model takes an
  // effort; the server sends it as state.effort (null otherwise, DESIGN.md 6i).
  const effortValue = (props.snapshot?.state as { effort?: unknown } | undefined)?.effort;
  const effort = session.provider === "claude" && typeof effortValue === "string" && effortValue ? effortValue : null;
  const menuStatus = !commandList.commands && !commandList.error ? "Loading commands" : commandList.error ? `Could not load commands: ${commandList.error}` : null;

  return (
    <div ref={rootRef} className={drop.over ? "term-composer term-composer-drop" : "term-composer"} {...drop.handlers}>
      {error ? (
        <div role="alert" className="term-err term-pre-wrap">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="term-dim term-pre-wrap term-notice">
          {notice}
          <button type="button" className="term-link-row" onClick={() => setNotice(null)} aria-label="Dismiss notice">
            {" "}
            [x]
          </button>
        </div>
      ) : null}
      {rewind.state.open ? (
        // The CLI's selector hides the prompt and its footer while it is up.
        <TerminalRewind screen={rewind} />
      ) : pending.length > 0 ? (
        pending.map((q) => <TerminalPending key={q.requestId} sessionKey={session.key} question={q} onError={setError} />)
      ) : (
        <>
          {picker.kind ? (
            <TerminalSessionPicker picker={picker} provider={session.provider} listId={pickerListId} />
          ) : menuOpen ? (
            <SlashMenu
              listId={listId}
              items={items}
              query={query ?? ""}
              active={activeIndex}
              status={menuStatus}
              onHighlight={(index) => setHighlight({ query, index })}
              onPick={(item) => pick(item, "click")}
            />
          ) : null}
          {clearHint ? (
            // Measured: the hint takes the effort line's place over the top rule.
            <div className="term-dim term-effort" data-esc-clear-hint="">
              {"Esc again to clear"}
            </div>
          ) : effort ? (
            <div className="term-dim term-effort">{`◉ ${effort}  /effort`}</div>
          ) : null}
          <TerminalAttachmentLines items={att.items} onRemove={att.remove} />
          <div className="term-rule" aria-hidden />
          <div className={`term-input-row ${blocker ? "term-input-blocked" : ""}`}>
            <span className={text ? "term-prompt" : "term-prompt term-dim"} aria-hidden>
              {"❯ "}
            </span>
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              disabled={blocker !== null}
              spellCheck={false}
              aria-label="Message"
              aria-autocomplete="list"
              aria-controls={picker.list?.rows.length ? pickerListId : menuOpen && items.length > 0 ? listId : undefined}
              aria-activedescendant={
                picker.list?.rows.length ? terminalPickerOptionId(pickerListId, picker.active)
                  : menuOpen && items.length > 0 ? `${listId}-${activeIndex}` : undefined
              }
              placeholder={placeholder}
              onPaste={att.onPaste}
              onBlur={() => picker.close()}
              onChange={(event) => {
                // Typing goes on as a message: the picker gives way.
                if (picker.kind) picker.close();
                setText(event.currentTarget.value);
                setCaret(event.currentTarget.selectionStart);
                if (dismissedFor !== null) setDismissedFor(null);
                if (historyAt !== null) setHistoryAt(null);
              }}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
              onKeyDown={onKeyDown}
              className="term-textarea"
            />
            {sending ? <span className="term-dim term-sending">sending…</span> : null}
          </div>
          <div className="term-rule" aria-hidden />
        </>
      )}
      {rewind.state.open ? null : help ? (
        <ShortcutHelp modes={canCycle} />
      ) : (
        <div className="term-footer">
          {inFence && !selectedRow ? (
            <div className="term-dim" data-fence-enter-hint="">
              {FENCE_ENTER_HINT}
            </div>
          ) : null}
          {selectedRow ? (
            <div className="term-dim">{selectionHint(selectedRow, props.viewingThreadId)}</div>
          ) : (
          <div className="term-footer-row">
            <div>
              {showMode ? (
                <>
                  <span className={`term-mode-${mode.tone}`}>{mode.label}</span>
                  {canCycle ? <span className="term-dim">{" (shift+tab to cycle)"}</span> : null}
                  <span className="term-dim">{"  "}</span>
                </>
              ) : null}
              <span className="term-dim">? for shortcuts</span>
              {blocker === null ? (
                <>
                  <span className="term-dim">{"  "}</span>
                  <TerminalAttachButton onFiles={att.add} />
                </>
              ) : null}
            </div>
            {/* The TUI's goal indicator: right end of the footer, in its own words ("Pursuing goal (1m)" for Codex, "/goal active (5m)" for Claude). */}
            {goal ? <GoalStatusText goal={goal} running={session.status === "running"} variant="tui" className="term-goal" /> : null}
          </div>
          )}
          {status.length > 0 ? <div className="term-dim">{status.join("  ")}</div> : null}
        </div>
      )}
      {rows.length > 0 ? (
        <TaskPanel
          rows={rows}
          selected={selected}
          onPick={(index) => {
            const row = rows[index];
            if (row) openRow(row);
          }}
        />
      ) : null}
    </div>
  );
}
