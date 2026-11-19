// The questions the open session waits on (`session.pending`), above the input, one card each as the
// web's PendingPanel draws them: AskUserQuestion or Codex request_user_input choices, or a
// permission or plan approval. The answers are built by the same shared functions as the web's
// (packages/shared/src/pendingAnswers.ts) and go out as `thread.answer`; a question leaves when the
// server's next session.pending drops it. The list scrolls inside a height the screen gives it,
// since the keyboard takes room the web page does not lose.
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { Text, TextInput } from "./ui/Text.tsx";
import { CheckIcon } from "lucide-react-native";
import type { PendingQuestionView } from "@maru/shared";
import {
  approvalAnswer,
  approvalPlan,
  approvalTitle,
  askedQuestions,
  NO_PICKS,
  questionAnswers,
  questionsComplete,
  setOtherAnswer,
  togglePick,
  type AskedQuestion,
  type QuestionPicks,
  withAlpha,
} from "@maru/shared";
import { usePalette, type Palette } from "../theme.ts";
import { type as t } from "../typography.ts";
import { ComposerError } from "./ComposerNotice.tsx";
import { Press } from "./Press.tsx";
import { useComposerColors } from "./useComposerColors.ts";
import type { ComposerColors } from "../lib/composerColors.ts";

/** Answers picked so far, by request id: closing the drawer or switching sessions keeps them. */
const drafts = new Map<string, QuestionPicks>();

export function PendingPanel(props: {
  questions: readonly PendingQuestionView[];
  maxHeight: number;
  /** The request id of the last drive command that failed; when it is this answer's, it can be sent again. */
  failedReqId: string | null;
  /** Sends the answer; the command's request id, or null when the connection is down. */
  onAnswer: (requestId: string, answers: Record<string, string>) => string | null;
  /** Inside the composer's column, which gives the side padding (Composer `above`). */
  embedded?: boolean;
}) {
  const [offline, setOffline] = useState(false);
  if (props.questions.length === 0) return null;
  return (
    <View style={[props.embedded ? null : styles.panel, { maxHeight: props.maxHeight }]}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list} style={styles.scroll}>
        {props.questions.map((q) => (
          <PendingCard key={q.requestId} q={q} failedReqId={props.failedReqId} onAnswer={props.onAnswer} onOffline={setOffline} />
        ))}
        {offline ? <ComposerError text="Could not answer, disconnected from server" /> : null}
      </ScrollView>
    </View>
  );
}

function PendingCard(props: {
  q: PendingQuestionView;
  failedReqId: string | null;
  onAnswer: (requestId: string, answers: Record<string, string>) => string | null;
  onOffline: (offline: boolean) => void;
}) {
  const p = usePalette();
  const c = useComposerColors();
  const { q } = props;
  const [sent, setSent] = useState<string | null>(null);
  // Only this answer's own failure lets it go out again; another command's error leaves it sent.
  useEffect(() => {
    if (sent !== null && props.failedReqId === sent) setSent(null);
  }, [props.failedReqId, sent]);
  const answer = (answers: Record<string, string>) => {
    const reqId = props.onAnswer(q.requestId, answers);
    props.onOffline(reqId === null);
    if (reqId === null) return;
    drafts.delete(q.requestId);
    setSent(reqId);
  };
  const busy = sent !== null;
  return (
    <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
      {q.kind === "question" ? (
        <QuestionForm p={p} c={c} requestId={q.requestId} questions={askedQuestions(q)} busy={busy} onAnswer={answer} />
      ) : (
        <ApprovalForm p={p} c={c} q={q} busy={busy} onAnswer={answer} />
      )}
    </View>
  );
}

function OtherAnswerRow(props: { p: Palette; c: ComposerColors; multi: boolean; secret: boolean; value: string; onChange: (value: string) => void }) {
  const { p, c } = props;
  const input = useRef<React.ElementRef<typeof TextInput>>(null);
  const on = props.value.trim() !== "";
  return (
    <View style={[styles.option, styles.otherRow, on ? { backgroundColor: c.fill } : null]}>
      <Press
        onPress={() => input.current?.focus()}
        hitSlop={12}
        accessibilityRole={props.multi ? "checkbox" : "radio"}
        accessibilityLabel="Type your own answer"
        accessibilityState={{ checked: on }}
        style={[styles.mark, styles.otherMark, { borderRadius: props.multi ? 4 : 8, borderColor: on ? p.accent : c.input, backgroundColor: on ? p.accent : "transparent" }]}
      >
        {on ? <CheckIcon size={12} color={p.onAccent} /> : null}
      </Press>
      <TextInput
        ref={input}
        value={props.value}
        onChangeText={props.onChange}
        placeholder="Type your own"
        placeholderTextColor={p.muted}
        secureTextEntry={props.secret}
        style={[styles.input, styles.otherInput, { color: p.text, borderColor: c.input }]}
      />
    </View>
  );
}

function QuestionForm(props: { p: Palette; c: ComposerColors; requestId: string; questions: AskedQuestion[]; busy: boolean; onAnswer: (a: Record<string, string>) => void }) {
  const { p, c } = props;
  const [picks, setPicks] = useState<QuestionPicks>(() => drafts.get(props.requestId) ?? NO_PICKS);
  const update = (next: QuestionPicks) => {
    drafts.set(props.requestId, next);
    setPicks(next);
  };
  const complete = questionsComplete(props.questions, picks);
  return (
    <View style={styles.form}>
      {props.questions.map((q) => (
        <View key={q.question} style={styles.fieldset}>
          {q.header ? <Text style={[t.small, { color: p.muted }]}>{q.header}</Text> : null}
          <Text style={[t.row, { color: withAlpha(p.text, 0.9) }]}>{q.question}</Text>
          <View>
            {(q.options ?? []).map((o) => {
              const on = (picks.picked[q.question] ?? []).includes(o.label);
              return (
                <Press
                  key={o.label}
                  onPress={() => update(togglePick(picks, q, o.label))}
                  style={[styles.option, on ? { backgroundColor: c.fill } : null]}
                  accessibilityRole={q.multiSelect ? "checkbox" : "radio"}
                  accessibilityState={{ checked: on }}
                >
                  <View
                    style={[
                      styles.mark,
                      { borderRadius: q.multiSelect ? 4 : 8, borderColor: on ? p.accent : c.input, backgroundColor: on ? p.accent : "transparent" },
                    ]}
                  >
                    {on ? <CheckIcon size={12} color={p.onAccent} /> : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[t.row, { color: p.text, fontWeight: "500" }]}>{o.label}</Text>
                    {o.description ? <Text style={[t.small, { color: p.muted }]}>{o.description}</Text> : null}
                  </View>
                </Press>
              );
            })}
            {/* The own answer is one more choice with the options' mark (the web's OtherAnswerRow). */}
            <OtherAnswerRow
              p={p}
              c={c}
              multi={q.multiSelect === true}
              secret={q.isSecret === true}
              value={picks.other[q.question] ?? ""}
              onChange={(v) => update(setOtherAnswer(picks, q, v))}
            />
          </View>
        </View>
      ))}
      <View style={styles.actions}>
        <Button p={p} c={c} label="Answer" primary disabled={!complete || props.busy} onPress={() => props.onAnswer(questionAnswers(props.questions, picks))} />
      </View>
    </View>
  );
}

function ApprovalForm(props: { p: Palette; c: ComposerColors; q: PendingQuestionView; busy: boolean; onAnswer: (a: Record<string, string>) => void }) {
  const { p, c, q } = props;
  const { height } = useWindowDimensions();
  const [feedback, setFeedback] = useState("");
  const plan = approvalPlan(q);
  return (
    <View style={styles.approval}>
      <Text style={[t.row, { color: p.text, fontWeight: "500" }]}>{approvalTitle(q)}</Text>
      {q.description ? <Text style={[t.small, { color: p.muted }]} selectable>{q.description}</Text> : null}
      {plan ? (
        // web: a pre, max-h-[40vh], bg-background, text-xs at 85%; plain text, the plan is not rendered as markdown
        <ScrollView nestedScrollEnabled style={[styles.plan, { backgroundColor: p.bg, maxHeight: height * 0.4 }]}>
          <Text style={[t.small, { color: withAlpha(p.text, 0.85) }]} selectable>{plan}</Text>
        </ScrollView>
      ) : null}
      <TextInput
        value={feedback}
        onChangeText={setFeedback}
        placeholder="Note to leave when rejecting (optional)"
        placeholderTextColor={p.muted}
        style={[styles.input, { marginTop: 0, color: p.text, borderColor: c.input }]}
      />
      <View style={styles.actions}>
        <Button p={p} c={c} label="Reject" disabled={props.busy} onPress={() => props.onAnswer(approvalAnswer("reject", feedback))} />
        <Button p={p} c={c} label="Approve" primary disabled={props.busy} onPress={() => props.onAnswer(approvalAnswer("approve"))} />
      </View>
    </View>
  );
}

/** The web's Button, size sm: the default variant (primary) or outline; a disabled one is dimmed to 64%. */
function Button(props: { p: Palette; c: ComposerColors; label: string; primary?: boolean; disabled?: boolean; onPress: () => void }) {
  const { p, c } = props;
  return (
    <Press
      onPress={props.onPress}
      disabled={props.disabled}
      hitSlop={6}
      style={[
        styles.button,
        props.primary ? { backgroundColor: p.accent, borderColor: p.accent } : { backgroundColor: c.fill, borderColor: c.input },
        props.disabled ? { opacity: 0.64 } : null,
      ]}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
    >
      <Text style={[styles.buttonText, { color: props.primary ? p.onAccent : p.text }]}>{props.label}</Text>
    </Press>
  );
}

const styles = StyleSheet.create({
  // The lane's 12 at the sides; 6 above is the lane's pt-1.5, 2 below makes the 8 (gap-2) to the input.
  panel: { marginHorizontal: 12, marginTop: 6, marginBottom: 2 },
  scroll: { flexGrow: 0 },
  list: { gap: 8 },
  // web: rounded-2xl border border-border bg-card px-4 py-3 text-sm
  card: { borderRadius: 16, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 12 },
  form: { gap: 12 },
  fieldset: { gap: 4 },
  // web: gap-2 rounded-md px-2 py-1.5, the mark mt-0.5
  option: { flexDirection: "row", alignItems: "flex-start", gap: 8, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6 },
  mark: { width: 16, height: 16, marginTop: 2, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  // web: mt-1 h-8 rounded-md border px-2 text-sm
  otherRow: { alignItems: "center" },
  otherMark: { marginTop: 0 },
  otherInput: { flex: 1, marginTop: 0 },
  input: { minHeight: 32, marginTop: 4, borderRadius: 6, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 0, ...t.row },
  approval: { gap: 8 },
  plan: { borderRadius: 6, padding: 12 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  // web: h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] rounded-(--control-radius) border
  button: { minHeight: 32, minWidth: 32, borderRadius: 8, borderWidth: 1, paddingHorizontal: 9, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  // web: font-medium text-base (16) below the sm width
  buttonText: { fontSize: 16, lineHeight: 22, fontWeight: "500" },
});
