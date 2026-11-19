// The terminal mode's answer to a pending ask (the web's TerminalPending.tsx), drawn in the input's
// place as the CLI draws it: a colored rule, the question, numbered choices. The CLI moves with the
// arrow keys and Enter; here a tap on a row picks it (a choice row is 44dp tall, the touch minimum).
// The answers go out in the chat panel's format (packages/shared pendingAnswers.ts): { [question]:
// labels } for a question, { decision, feedback? } for a plan or an approval.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { PendingQuestionView } from "@maru/shared";
import {
  approvalAnswer,
  approvalPlan,
  askedQuestions,
  NO_PICKS,
  questionAnswerOf,
  questionAnswers,
  togglePick,
  type AskedQuestion,
  type QuestionPicks,
} from "@maru/shared";
import { Blank, Rule, T, TermInput, roleColor, useTerm, type Role } from "./term.tsx";
import { TerminalMarkdown } from "./TerminalMarkdown.tsx";

interface Choice {
  label: string;
  description?: string;
  /** Picking it opens a text field (a free answer, or feedback with a refusal). */
  input?: boolean;
  dim?: boolean;
}

/** A numbered row: `❯` on the active one, the number, a box for a multi-select, then the label or its text field. */
function ChoiceRows(props: {
  choices: readonly Choice[];
  active: number;
  checked?: ReadonlySet<number>;
  inputValue: string;
  inputPlaceholder: string;
  secret?: boolean;
  onInput: (v: string) => void;
  onPick: (i: number) => void;
  onInputDone: () => void;
}) {
  const { grid, tokens } = useTerm();
  const inputRef = useRef<React.ComponentRef<typeof TermInput>>(null);
  const pad = Math.max(0, (44 - grid.lineHeight) / 2);
  // The text field takes the keyboard when its row becomes the active one.
  const inputIndex = props.choices.findIndex((c) => c.input);
  useEffect(() => {
    if (props.active === inputIndex && inputIndex >= 0) inputRef.current?.focus();
  }, [props.active, inputIndex]);
  return (
    <View accessibilityRole="list">
      {props.choices.map((c, i) => {
        const on = i === props.active;
        const role: Role | undefined = on ? "accent" : c.dim ? "dim" : undefined;
        return (
          <Pressable key={i} accessibilityRole="button" accessibilityLabel={c.label} onPress={() => props.onPick(i)} style={{ paddingVertical: pad }}>
            <View style={styles.row}>
              <T c={on ? "accent" : undefined}>{on ? "❯ " : "  "}</T>
              <T c="dim">{`${i + 1}. `}</T>
              {props.checked ? <T c={on ? "accent" : undefined}>{props.checked.has(i) ? "[✔] " : "[ ] "}</T> : null}
              {c.input && on ? (
                <TermInput
                  ref={inputRef}
                  value={props.inputValue}
                  onChangeText={props.onInput}
                  placeholder={props.inputPlaceholder}
                  secureTextEntry={props.secret === true}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  submitBehavior="blurAndSubmit"
                  onSubmitEditing={props.onInputDone}
                  style={[styles.fill, { color: tokens.accent }]}
                />
              ) : (
                <T c={role} style={styles.fill}>
                  {c.label}
                </T>
              )}
            </View>
            {c.description ? (
              <T c="dim">
                {`     ${c.description}`}
              </T>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function QuestionPicker(props: { questions: AskedQuestion[]; onAnswer: (a: Record<string, string>) => void }) {
  const { tokens } = useTerm();
  const [picks, setPicks] = useState<QuestionPicks>(NO_PICKS);
  const [submitted, setSubmitted] = useState<readonly string[]>([]);
  const [typing, setTyping] = useState<Record<string, string>>({});
  const [active, setActive] = useState(0);
  const done = (item: AskedQuestion, s = submitted, p = picks) => s.includes(item.question) || (item.multiSelect !== true && questionAnswerOf(p, item.question) !== "");
  const index = Math.max(0, props.questions.findIndex((item) => !done(item)));
  const q = props.questions[index];
  if (!q) return null;
  const options = q.options ?? [];
  const multi = q.multiSelect === true;
  const pickedLabels = picks.picked[q.question] ?? [];
  const checked = new Set(options.flatMap((o, i) => (pickedLabels.includes(o.label) ? [i] : [])));
  const typed = typing[q.question] ?? (multi ? (picks.other[q.question] ?? "") : "");
  const choices: Choice[] = [
    ...options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
    { label: "Type something", input: true, dim: true },
    ...(multi ? [{ label: "Submit" }] : []),
  ];
  /** Takes this question's answer and moves on; the last one sends them all. */
  const finish = (labels: readonly string[], other: string) => {
    const answer = [...labels, ...(other.trim() ? [other.trim()] : [])].join(", ");
    if (answer === "") return;
    const nextPicks: QuestionPicks = { picked: { ...picks.picked, [q.question]: labels }, other: { ...picks.other, [q.question]: other.trim() } };
    const nextSubmitted = [...submitted, q.question];
    setPicks(nextPicks);
    setSubmitted(nextSubmitted);
    setActive(0);
    if (props.questions.every((item) => nextSubmitted.includes(item.question))) props.onAnswer(questionAnswers(props.questions, nextPicks));
  };
  const checkedLabels = () => options.filter((_, n) => checked.has(n)).map((o) => o.label);
  const pick = (i: number) => {
    setActive(i);
    if (i < options.length) {
      if (!multi) return finish([options[i]!.label], "");
      setPicks((cur) => togglePick(cur, q, options[i]!.label));
      return;
    }
    if (i === options.length) return; // the text field takes the keyboard
    finish(checkedLabels(), typed);
  };
  return (
    <View accessibilityLabel="Question waiting for an answer">
      <Rule role="dim" />
      <View style={styles.row}>
        {props.questions.map((item, i) => (
          <T
            key={item.question}
            c={i === index ? undefined : "dim"}
            style={i === index ? { backgroundColor: tokens.accent, color: tokens.chipFg } : undefined}
          >
            {` ${done(item) ? "✔" : "☐"} ${item.header || `Q${i + 1}`} `}
          </T>
        ))}
      </View>
      <Blank />
      <T bold c="strong">
        {q.question}
      </T>
      <Blank />
      <ChoiceRows
        choices={choices}
        active={active}
        {...(multi ? { checked } : {})}
        inputValue={typed}
        inputPlaceholder="Type something"
        secret={q.isSecret === true}
        // The typed text waits in its own state until the row is finished: a question counts as answered only then.
        onInput={(v) => setTyping((cur) => ({ ...cur, [q.question]: v }))}
        onPick={pick}
        onInputDone={() => finish(multi ? checkedLabels() : [], typed)}
      />
      <Blank />
      <T c="dim">{multi ? "Tap to toggle, then Submit" : "Tap to select"}</T>
    </View>
  );
}

/** Plan approval (ExitPlanMode) and other approvals: yes, or no with what to change. */
function DecisionPicker(props: { question: PendingQuestionView; onAnswer: (a: Record<string, string>) => void }) {
  const { question: q } = props;
  const [feedback, setFeedback] = useState("");
  const [active, setActive] = useState(0);
  const plan = approvalPlan(q);
  const isPlan = q.kind === "plan";
  const command = typeof (q.input as { command?: unknown }).command === "string" ? (q.input as { command: string }).command : null;
  const choices: Choice[] = [{ label: "Yes" }, { label: isPlan ? "No, tell Claude what to change" : "No, and tell Claude what to do differently", input: true }];
  const reject = () => props.onAnswer(approvalAnswer("reject", feedback));
  const pick = (i: number) => {
    setActive(i);
    if (i === 0) props.onAnswer(approvalAnswer("approve"));
  };
  const { columns } = useTerm();
  return (
    <View accessibilityLabel="Approval request waiting for an answer">
      <Rule role={isPlan ? "plan" : "accent"} />
      <T bold c="accent">
        {isPlan ? "Ready to code?" : (q.title ?? `${q.toolName} command`)}
      </T>
      {q.description ? <T c="dim">{q.description}</T> : null}
      {isPlan ? <T>{"Here is Claude's plan:"}</T> : null}
      {plan || !isPlan ? (
        <>
          <Dashed />
          {plan ? <TerminalMarkdown text={plan} columns={columns} /> : <T>{command ?? JSON.stringify(q.input, null, 2)}</T>}
          <Dashed />
        </>
      ) : null}
      <T c={isPlan ? "dim" : undefined}>{isPlan ? "Claude has written up a plan and is ready to execute. Would you like to proceed?" : "Do you want to proceed?"}</T>
      <ChoiceRows choices={choices} active={active} inputValue={feedback} inputPlaceholder="what to change" onInput={setFeedback} onPick={pick} onInputDone={reject} />
      <Blank />
      <T c="dim">{isPlan ? "Tap to select" : "Tap to select, a No with a note sends it"}</T>
    </View>
  );
}

/** A dashed rule: one row with a dashed line through it (index.css .term-dashed). */
function Dashed() {
  const { tokens, grid } = useTerm();
  return (
    <View style={{ height: grid.lineHeight, justifyContent: "center" }}>
      <View style={{ borderTopWidth: 1, borderStyle: "dashed", borderColor: roleColor(tokens, "subtle") }} />
    </View>
  );
}

export function TerminalPending(props: {
  question: PendingQuestionView;
  /** Sends the answer; the command's request id, or null when the connection is down. */
  onAnswer: (requestId: string, answers: Record<string, string>) => string | null;
  /** The request id of the last command that failed; when it is this answer's, the answer can go again. */
  failedReqId: string | null;
  onOffline: (offline: boolean) => void;
}): ReactNode {
  const { question: q } = props;
  const [sent, setSent] = useState<string | null>(null);
  // Only this answer's own failure lets it go out again; another command's error leaves it sent.
  useEffect(() => {
    if (sent !== null && props.failedReqId === sent) setSent(null);
  }, [props.failedReqId, sent]);
  const answer = (answers: Record<string, string>) => {
    if (sent !== null) return;
    const reqId = props.onAnswer(q.requestId, answers);
    props.onOffline(reqId === null);
    if (reqId !== null) setSent(reqId);
  };
  // A new ask starts fresh (its own pickers are keyed by the request).
  return q.kind === "question" ? (
    <QuestionPicker key={q.requestId} questions={askedQuestions(q)} onAnswer={answer} />
  ) : (
    <DecisionPicker key={q.requestId} question={q} onAnswer={answer} />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row" },
  fill: { flex: 1, minWidth: 0 },
});

