import { test } from "node:test";
import assert from "node:assert/strict";
import type { PendingQuestionView } from "./index.ts";
import {
  approvalAnswer,
  approvalPlan,
  approvalTitle,
  askedQuestions,
  NO_PICKS,
  pendingSummary,
  questionAnswerOf,
  questionAnswers,
  questionsComplete,
  setOtherAnswer,
  togglePick,
  type AskedQuestion,
} from "./pendingAnswers.ts";

const ask = (over: Partial<PendingQuestionView>): PendingQuestionView => ({
  requestId: "r1",
  toolUseId: "t1",
  toolName: "AskUserQuestion",
  kind: "question",
  input: {},
  title: null,
  description: null,
  ...over,
});

test("questions are read from the ask's input, ignoring malformed entries", () => {
  const q = ask({ input: { questions: [{ question: "Which?", options: [{ label: "A" }] }, { header: "no text" }, null, "x"] } });
  assert.deepEqual(askedQuestions(q), [{ question: "Which?", options: [{ label: "A" }] }]);
  assert.deepEqual(askedQuestions(ask({ input: { questions: "nope" } })), []);
});

test("an answer is the picked labels then the typed text, keyed by question text", () => {
  const single = { question: "Color?", options: [{ label: "Red" }, { label: "Blue" }] };
  const multi = { question: "Parts?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] };
  let picks = togglePick(NO_PICKS, single, "Red");
  picks = togglePick(picks, single, "Blue");
  assert.deepEqual(picks.picked["Color?"], ["Blue"]);
  picks = togglePick(togglePick(togglePick(picks, multi, "A"), multi, "B"), multi, "A");
  assert.deepEqual(picks.picked["Parts?"], ["B"]);
  picks = { ...picks, other: { "Parts?": "  also C " } };
  assert.equal(questionAnswerOf(picks, "Parts?"), "B, also C");
  assert.equal(questionsComplete([single, multi], picks), true);
  assert.equal(questionsComplete([single, multi, { question: "Empty?" }], picks), false);
  assert.equal(questionsComplete([], picks), false);
  assert.deepEqual(questionAnswers([single, multi], picks), { "Color?": "Blue", "Parts?": "B, also C" });
});

test("an approval answers approve, or reject with the feedback when there is any", () => {
  assert.deepEqual(approvalAnswer("approve", "ignored"), { decision: "approve" });
  assert.deepEqual(approvalAnswer("reject", "  too risky "), { decision: "reject", feedback: "too risky" });
  assert.deepEqual(approvalAnswer("reject", "   "), { decision: "reject" });
});

test("titles, plans and the one-line summary a notification or a client shows", () => {
  assert.equal(approvalTitle(ask({ kind: "plan", toolName: "ExitPlanMode" })), "Approve the plan?");
  assert.equal(approvalTitle(ask({ kind: "approval", toolName: "Bash" })), "Allow Bash?");
  assert.equal(approvalTitle(ask({ kind: "approval", title: "Allow running the command?" })), "Allow running the command?");
  assert.equal(approvalPlan(ask({ kind: "plan", input: { plan: "# Plan" } })), "# Plan");
  assert.equal(approvalPlan(ask({ kind: "plan", input: {} })), null);
  assert.equal(pendingSummary(ask({ input: { questions: [{ question: "Which?" }] } })), "Which?");
  assert.equal(pendingSummary(ask({ input: {} })), "Answer the question");
  assert.equal(pendingSummary(ask({ kind: "approval", toolName: "Write" })), "Allow Write?");
});

test("single select: typing unpicks the option and picking clears the typing; multi select keeps both", () => {
  const single = { question: "Q", options: [{ label: "A" }, { label: "B" }], multiSelect: false } as AskedQuestion;
  const multi = { question: "M", options: [{ label: "A" }, { label: "B" }], multiSelect: true } as AskedQuestion;
  let p = togglePick(NO_PICKS, single, "A");
  p = setOtherAnswer(p, single, "my own");
  assert.deepEqual(p.picked.Q, []);
  assert.equal(questionAnswerOf(p, "Q"), "my own");
  p = togglePick(p, single, "B");
  assert.equal(p.other.Q, "");
  assert.equal(questionAnswerOf(p, "Q"), "B");
  // Blank typing leaves the pick alone.
  assert.deepEqual(setOtherAnswer(p, single, "  ").picked.Q, ["B"]);
  let m = togglePick(NO_PICKS, multi, "A");
  m = setOtherAnswer(m, multi, "extra");
  m = togglePick(m, multi, "B");
  assert.equal(questionAnswerOf(m, "M"), "A, B, extra");
});
