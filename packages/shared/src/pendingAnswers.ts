// Answers to a pending question (`session.pending`, DESIGN.md 3.1 canUseTool) in the form the
// server's `thread.answer` reads. The web's chat view and the Android app build them here; the
// web's terminal view (TerminalPending.tsx) builds the same format in its own picker flow.
//   kind "question"            { [question text]: picked labels and typed text, joined by ", " }
//   kind "plan" | "approval"   { decision: "approve" } or { decision: "reject", feedback? }
// The Claude driver (apps/server/src/claude/driver.ts resultForAnswer) and the Codex driver
// (apps/server/src/drive/codexRuns.ts askResult) turn these into the provider's own answer.
import type { PendingQuestionView } from "./index.ts";

/** One question of an AskUserQuestion (Claude) or request_user_input (Codex) ask. */
export interface AskedQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
  /** Codex: the answer is a secret (a password or a key), so a client hides what is typed. */
  isSecret?: boolean;
}

/** The questions of a kind "question" ask; empty for anything else. */
export function askedQuestions(q: Pick<PendingQuestionView, "input">): AskedQuestion[] {
  const raw = (q.input as { questions?: unknown }).questions;
  return Array.isArray(raw)
    ? (raw.filter((x) => x && typeof x === "object" && typeof (x as AskedQuestion).question === "string") as AskedQuestion[])
    : [];
}

/** Answers to one pending ask so far: picked option labels and typed text, by question text. */
export interface QuestionPicks {
  picked: Readonly<Record<string, readonly string[]>>;
  other: Readonly<Record<string, string>>;
}

export const NO_PICKS: QuestionPicks = { picked: {}, other: {} };

/** The answer a question sends: the picked labels, then the typed text. */
export function questionAnswerOf(picks: QuestionPicks, question: string): string {
  const free = picks.other[question]?.trim();
  return [...(picks.picked[question] ?? []), ...(free ? [free] : [])].join(", ");
}

/**
 * Picks one option: a multi-select question toggles it, any other question takes only it, and its
 * typed answer goes (one answer per single-select question, user request 2026-11-16).
 */
export function togglePick(picks: QuestionPicks, q: AskedQuestion, label: string): QuestionPicks {
  const cur = picks.picked[q.question] ?? [];
  if (q.multiSelect) {
    const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
    return { ...picks, picked: { ...picks.picked, [q.question]: next } };
  }
  return { ...picks, picked: { ...picks.picked, [q.question]: [label] }, other: { ...picks.other, [q.question]: "" } };
}

/**
 * The typed answer of a question. On a single-select question, text there takes the place of the
 * picked option (the option is unpicked); a multi-select question keeps both.
 */
export function setOtherAnswer(picks: QuestionPicks, q: AskedQuestion, text: string): QuestionPicks {
  const other = { ...picks.other, [q.question]: text };
  if (q.multiSelect || text.trim() === "") return { ...picks, other };
  return { ...picks, other, picked: { ...picks.picked, [q.question]: [] } };
}

/** Every question has an answer, so the ask can be sent. */
export function questionsComplete(questions: readonly AskedQuestion[], picks: QuestionPicks): boolean {
  return questions.length > 0 && questions.every((q) => questionAnswerOf(picks, q.question) !== "");
}

/** The `thread.answer` answers of a kind "question" ask. */
export function questionAnswers(questions: readonly AskedQuestion[], picks: QuestionPicks): Record<string, string> {
  return Object.fromEntries(questions.map((q) => [q.question, questionAnswerOf(picks, q.question)]));
}

/** The `thread.answer` answers of a kind "plan" or "approval" ask. Blank feedback is left out. */
export function approvalAnswer(decision: "approve" | "reject", feedback?: string): Record<string, string> {
  const text = feedback?.trim();
  return decision === "reject" && text ? { decision, feedback: text } : { decision };
}

/** The heading a client shows for a plan or an approval. */
export function approvalTitle(q: Pick<PendingQuestionView, "kind" | "title" | "toolName">): string {
  return q.title ?? (q.kind === "plan" ? "Approve the plan?" : `Allow ${q.toolName}?`);
}

/** The plan text an ExitPlanMode ask carries, if any. */
export function approvalPlan(q: Pick<PendingQuestionView, "input">): string | null {
  const plan = (q.input as { plan?: unknown }).plan;
  return typeof plan === "string" ? plan : null;
}

/** One line that says what the ask wants: the first question, or the approval's heading. */
export function pendingSummary(q: Pick<PendingQuestionView, "kind" | "title" | "toolName" | "input">): string {
  if (q.kind === "question") return askedQuestions(q)[0]?.question ?? "Answer the question";
  return approvalTitle(q);
}
