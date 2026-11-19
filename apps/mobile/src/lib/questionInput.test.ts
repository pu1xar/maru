// The question card's input path (PendingPanel): picking an option and typing an answer go through
// the shared functions the web uses, so a single-select question sends one answer. A node test
// cannot resolve @maru/shared from this folder, so the file is read by path (as palette.ts does).
import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_PICKS, questionAnswers, questionsComplete, setOtherAnswer, togglePick, type AskedQuestion } from "../../../../packages/shared/src/pendingAnswers.ts";

const single: AskedQuestion = { question: "Which?", options: [{ label: "A" }, { label: "B" }] };
const multi: AskedQuestion = { question: "Which all?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] };

test("typing after a pick on a single-select question leaves one answer", () => {
  let picks = togglePick(NO_PICKS, single, "A");
  picks = setOtherAnswer(picks, single, "something else");
  assert.deepEqual(questionAnswers([single], picks), { "Which?": "something else" });
  // Picking an option again clears the typed text.
  picks = togglePick(picks, single, "B");
  assert.deepEqual(questionAnswers([single], picks), { "Which?": "B" });
});

test("a multi-select question keeps the picks and the typed text", () => {
  let picks = togglePick(NO_PICKS, multi, "A");
  picks = setOtherAnswer(picks, multi, "and more");
  assert.deepEqual(questionAnswers([multi], picks), { "Which all?": "A, and more" });
  assert.equal(questionsComplete([multi], picks), true);
});

test("clearing the typed text keeps the pick that was made after it", () => {
  let picks = setOtherAnswer(NO_PICKS, single, "typed");
  picks = togglePick(picks, single, "A");
  picks = setOtherAnswer(picks, single, "");
  assert.deepEqual(questionAnswers([single], picks), { "Which?": "A" });
});
