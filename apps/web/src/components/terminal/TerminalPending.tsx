// The terminal mode's answer to a pending ask (lib/pending.ts), drawn in the input's place as the
// Claude Code CLI (2.1.325) draws it: a colored rule, the question, numbered choices picked with
// the arrow keys and Enter (measured: AskUserQuestion, a Bash permission prompt, plan approval).
// Answers go out as ThreadComposer's do (`thread.answer`): { [question]: labels } for a question,
// { decision, feedback? } for a plan or an approval.
import type { PendingQuestionView } from "@maru/shared";
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { clearQuestionDraft, getQuestionDraft, questionAnswerOf, useQuestionDraft, type QuestionDraft } from "~/lib/composerDraft";
import { socketHub } from "~/lib/socket";
import { askedQuestions, nextReqId, type AskedQuestion } from "../chat/ThreadComposer";
import { TerminalMarkdown } from "./TerminalMarkdown";

export interface Choice {
  label: string;
  description?: string;
  /** Picking it opens a text field (free answer, or feedback with a refusal). */
  input?: boolean;
  dim?: boolean;
}

/** The answer a question sends: the picked labels and the typed text, joined as ThreadComposer does. */
export function questionAnswer(picked: ReadonlyArray<string>, typed: string): string {
  return [...picked, ...(typed.trim() ? [typed.trim()] : [])].join(", ");
}

function send(sessionKey: string, requestId: string, answers: Record<string, string>, onError: (e: string) => void): boolean {
  const ok = socketHub().send({ type: "thread.answer", threadId: sessionKey, requestId, answers, reqId: nextReqId() });
  if (!ok) onError("Disconnected from server, could not answer");
  return ok;
}

/** A numbered list moved with ↑/↓ and picked with Enter or a number key. */
function ChoiceList(props: {
  choices: ReadonlyArray<Choice>;
  active: number;
  checked?: ReadonlySet<number>;
  inputValue: string;
  onInput: (v: string) => void;
  onActivate: (i: number) => void;
  onPick: (i: number) => void;
  onInputDone: () => void;
  /** Leaves the text field with an arrow key (delta) or Esc (0); the list takes the keyboard back. */
  onLeaveInput: (delta: number) => void;
  inputPlaceholder: string;
}) {
  return (
    <div className="term-choices" role="listbox">
      {props.choices.map((c, i) => {
        const on = i === props.active;
        return (
          <div key={i} role="option" aria-selected={on} className="term-choice" onMouseMove={() => props.onActivate(i)} onClick={() => props.onPick(i)}>
            <span className={on ? "term-accent" : undefined}>{on ? "❯ " : "  "}</span>
            <span className="term-dim">{`${i + 1}. `}</span>
            {props.checked ? <span className={on ? "term-accent" : undefined}>{props.checked.has(i) ? "[✔] " : "[ ] "}</span> : null}
            {c.input && on ? (
              <input
                autoFocus
                className="term-inline-input"
                value={props.inputValue}
                placeholder={props.inputPlaceholder}
                onChange={(e) => props.onInput(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    props.onInputDone();
                  }
                  if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    props.onLeaveInput(e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0);
                  }
                }}
              />
            ) : (
              <span className={on ? "term-accent" : c.dim ? "term-dim" : undefined}>{c.label}</span>
            )}
            {c.description ? <div className="term-choice-desc term-dim">{c.description}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

function useListKeys(count: number, onPick: (i: number) => void, onEscape?: () => void) {
  const [active, setActive] = useState(0);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((a) => (a + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onPick(active);
    } else if (/^[1-9]$/.test(event.key) && Number(event.key) <= count) {
      event.preventDefault();
      setActive(Number(event.key) - 1);
      onPick(Number(event.key) - 1);
    } else if (event.key === "Escape" && onEscape) {
      event.preventDefault();
      onEscape();
    }
  };
  return { active, setActive, onKeyDown };
}

/**
 * Whether the terminal picker is past a question: it took an answer there, or (for a one-choice
 * question) the chat composer already holds one. The answers are the ask's draft
 * (lib/composerDraft.ts), so switching to the chat view and back keeps them.
 */
export function questionDone(draft: QuestionDraft, q: AskedQuestion): boolean {
  if (draft.submitted?.includes(q.question)) return true;
  return q.multiSelect !== true && questionAnswerOf(draft, q.question) !== "";
}

function QuestionPicker(props: {
  requestId: string;
  questions: AskedQuestion[];
  onAnswer: (a: Record<string, string>) => void;
  refocus: () => void;
  boxRef: RefObject<HTMLDivElement | null>;
}) {
  const [draft, updateDraft] = useQuestionDraft(props.requestId);
  const index = Math.max(0, props.questions.findIndex((item) => !questionDone(draft, item)));
  const q = props.questions[index];
  const options = q?.options ?? [];
  const multi = q?.multiSelect === true;
  const pickedLabels = q ? (draft.picked[q.question] ?? []) : [];
  const checked = new Set(options.flatMap((o, i) => (pickedLabels.includes(o.label) ? [i] : [])));
  const typed = q ? (draft.typing?.[q.question] ?? (multi ? (draft.other[q.question] ?? "") : "")) : "";
  const choices: Choice[] = [
    ...options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
    { label: "Type something", input: true, dim: true },
    ...(multi ? [{ label: "Submit" }] : []),
  ];
  const setTyped = (value: string) => {
    if (!q) return;
    updateDraft((d) => ({ ...d, typing: { ...d.typing, [q.question]: value } }));
  };
  /** Takes this question's answer and moves on; the last one sends them all. */
  const finish = (labels: readonly string[], other: string) => {
    if (!q || questionAnswer(labels, other) === "") return;
    const before = getQuestionDraft(props.requestId);
    const typing = { ...before.typing };
    delete typing[q.question];
    const next: QuestionDraft = {
      ...before,
      picked: { ...before.picked, [q.question]: labels },
      other: { ...before.other, [q.question]: other.trim() },
      typing,
      submitted: [...(before.submitted ?? []), q.question],
    };
    updateDraft(() => next);
    keys.setActive(0);
    if (props.questions.every((item) => questionDone(next, item))) {
      props.onAnswer(Object.fromEntries(props.questions.map((item) => [item.question, questionAnswerOf(next, item.question)])));
    }
  };
  const checkedLabels = () => options.filter((_, n) => checked.has(n)).map((o) => o.label);
  const pick = (i: number) => {
    if (!q) return;
    if (i < options.length) {
      if (!multi) return finish([options[i]!.label], "");
      const label = options[i]!.label;
      updateDraft((d) => {
        const cur = d.picked[q.question] ?? [];
        return { ...d, picked: { ...d.picked, [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] } };
      });
      return;
    }
    if (i === options.length) return; // the text field takes the focus
    finish(checkedLabels(), typed);
  };
  const keys = useListKeys(choices.length, pick);
  if (!q) return null;
  return (
    <div ref={props.boxRef} tabIndex={0} className="term-pending" aria-label="Question waiting for an answer" onKeyDown={keys.onKeyDown}>
      <div className="term-rule term-dim" aria-hidden />
      <div className="term-chips">
        {props.questions.map((item, i) => (
          <span key={item.question} className={i === index ? "term-chip" : "term-dim"}>
            {` ${questionDone(draft, item) ? "✔" : "☐"} ${item.header || `Q${i + 1}`} `}
          </span>
        ))}
      </div>
      <div className="term-question">{q.question}</div>
      <ChoiceList
        choices={choices}
        active={keys.active}
        {...(multi ? { checked } : {})}
        inputValue={typed}
        inputPlaceholder="Type something"
        onInput={setTyped}
        onActivate={keys.setActive}
        onPick={pick}
        onInputDone={() => finish(multi ? checkedLabels() : [], typed)}
        onLeaveInput={(delta) => {
          keys.setActive((a) => (a + delta + choices.length) % choices.length);
          props.refocus();
        }}
      />
      <div className="term-dim term-hint">{multi ? "Enter to toggle  ↑/↓ to navigate" : "Enter to select  ↑/↓ to navigate"}</div>
    </div>
  );
}

/** Plan approval (ExitPlanMode) and other approvals: yes, or no with what to change. */
function DecisionPicker(props: { question: PendingQuestionView; onAnswer: (a: Record<string, string>) => void; refocus: () => void; boxRef: RefObject<HTMLDivElement | null> }) {
  const { question: q } = props;
  const [feedback, setFeedback] = useState("");
  const plan = typeof (q.input as { plan?: unknown }).plan === "string" ? (q.input as { plan: string }).plan : null;
  const isPlan = q.kind === "plan";
  const choices: Choice[] = [
    { label: "Yes" },
    { label: isPlan ? "No, tell Claude what to change" : "No, and tell Claude what to do differently", input: true },
  ];
  const reject = () => props.onAnswer({ decision: "reject", ...(feedback.trim() ? { feedback: feedback.trim() } : {}) });
  const pick = (i: number) => {
    if (i === 0) props.onAnswer({ decision: "approve" });
  };
  const keys = useListKeys(choices.length, pick, isPlan ? undefined : reject);
  const command = typeof (q.input as { command?: unknown }).command === "string" ? (q.input as { command: string }).command : null;
  return (
    <div ref={props.boxRef} tabIndex={0} className="term-pending" aria-label="Approval request waiting for an answer" onKeyDown={keys.onKeyDown}>
      <div className={`term-rule ${isPlan ? "term-plan" : "term-accent"}`} aria-hidden />
      <div className="term-bold term-accent">{isPlan ? "Ready to code?" : (q.title ?? `${q.toolName} command`)}</div>
      {q.description ? <div className="term-dim">{q.description}</div> : null}
      {isPlan ? <div>{"Here is Claude's plan:"}</div> : null}
      {plan || !isPlan ? (
        <>
          <div className="term-dashed" aria-hidden />
          {plan ? <TerminalMarkdown text={plan} cwd={undefined} /> : <div className="term-pre-wrap">{command ?? JSON.stringify(q.input, null, 2)}</div>}
          <div className="term-dashed" aria-hidden />
        </>
      ) : null}
      <div className={isPlan ? "term-dim" : undefined}>
        {isPlan ? "Claude has written up a plan and is ready to execute. Would you like to proceed?" : "Do you want to proceed?"}
      </div>
      <ChoiceList
        choices={choices}
        active={keys.active}
        inputValue={feedback}
        inputPlaceholder="what to change"
        onInput={setFeedback}
        onActivate={keys.setActive}
        onPick={pick}
        onInputDone={reject}
        onLeaveInput={(delta) => {
          keys.setActive((a) => (a + delta + choices.length) % choices.length);
          props.refocus();
        }}
      />
      <div className="term-dim term-hint">{isPlan ? "Enter to select  ↑/↓ to navigate" : "Esc to cancel"}</div>
    </div>
  );
}

export function TerminalPending(props: { sessionKey: string; question: PendingQuestionView; onError: (e: string) => void }) {
  const { question: q } = props;
  const box = useRef<HTMLDivElement | null>(null);
  // Takes the keyboard when the ask appears, as the CLI's prompt does.
  useEffect(() => {
    box.current?.focus();
  }, [q.requestId]);
  const answer = (answers: Record<string, string>) => {
    if (send(props.sessionKey, q.requestId, answers, props.onError)) clearQuestionDraft(q.requestId);
  };
  // After the text field closes, on the next frame so the field is gone.
  const refocus = () => requestAnimationFrame(() => box.current?.focus());
  return q.kind === "question" ? (
    <QuestionPicker key={q.requestId} requestId={q.requestId} questions={askedQuestions(q)} onAnswer={answer} refocus={refocus} boxRef={box} />
  ) : (
    <DecisionPicker key={q.requestId} question={q} onAnswer={answer} refocus={refocus} boxRef={box} />
  );
}
