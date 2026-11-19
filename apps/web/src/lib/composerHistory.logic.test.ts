import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ThreadSnapshot } from "@maru/shared";

import { isPlainArrow, liveHistory, NO_HISTORY, onFirstLine, onLastLine, stepHistory, userHistory, type HistoryState } from "./composerHistory.logic.ts";

const LIST = ["first", "second", "third"];

const userRow = (text: string, createdBy = "user") => ({ item: { type: "user_message", text, createdBy } });
const snap = (rows: unknown[]) => ({ visibleTurnItems: rows }) as unknown as ThreadSnapshot;

describe("userHistory", () => {
  test("the user's messages in order, nothing from the model, steers or empty text", () => {
    const history = userHistory(
      snap([
        userRow("one"),
        { item: { type: "assistant_message", text: "answer" } },
        userRow("injected", "system"),
        userRow("   "),
        userRow("two"),
      ]),
    );
    assert.deepEqual(history, ["one", "two"]);
  });

  test("a message equal to the one before it is listed once; the same text later is listed again", () => {
    assert.deepEqual(userHistory(snap([userRow("a"), userRow("a"), userRow("b"), userRow("a")])), ["a", "b", "a"]);
  });

  test("no snapshot yet: empty list", () => {
    assert.deepEqual(userHistory(null), []);
  });
});

describe("first and last line", () => {
  test("empty text is both", () => {
    assert.equal(onFirstLine("", 0), true);
    assert.equal(onLastLine("", 0), true);
  });

  test("the caret before the first newline is on the first line, after the last newline on the last", () => {
    const text = "ab\ncd\nef";
    assert.equal(onFirstLine(text, 0), true);
    assert.equal(onFirstLine(text, 2), true); // right before the newline
    assert.equal(onFirstLine(text, 3), false); // start of line two
    assert.equal(onLastLine(text, 5), false); // end of line two, the newline follows
    assert.equal(onLastLine(text, 6), true); // start of the last line
    assert.equal(onLastLine(text, text.length), true);
  });

  test("a trailing newline makes the empty line after it the last line", () => {
    assert.equal(onLastLine("ab\n", 2), false);
    assert.equal(onLastLine("ab\n", 3), true);
  });

  test("a single line is both from any caret", () => {
    for (let at = 0; at <= 5; at++) {
      assert.equal(onFirstLine("hello", at), true);
      assert.equal(onLastLine("hello", at), true);
    }
  });
});

describe("isPlainArrow", () => {
  test("any modifier keeps the key out of history", () => {
    const none = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
    assert.equal(isPlainArrow(none), true);
    for (const k of ["shiftKey", "altKey", "ctrlKey", "metaKey"] as const) assert.equal(isPlainArrow({ ...none, [k]: true }), false);
  });
});

describe("stepHistory", () => {
  test("nothing to walk: an empty list is not history's key", () => {
    assert.equal(stepHistory(NO_HISTORY, [], -1, "draft"), null);
    assert.equal(stepHistory(NO_HISTORY, [], 1, "draft"), null);
  });

  test("↓ while the user's own text is shown is not history's key", () => {
    assert.equal(stepHistory(NO_HISTORY, LIST, 1, "draft"), null);
  });

  test("the first ↑ shows the newest message and keeps the draft", () => {
    const step = stepHistory(NO_HISTORY, LIST, -1, "half typed");
    assert.deepEqual(step, { state: { at: 2, draft: "half typed" }, text: "third", caret: 5 });
  });

  test("↑ walks to older messages one at a time and stops at the oldest", () => {
    let state: HistoryState = NO_HISTORY;
    let text = "draft";
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const step = stepHistory(state, LIST, -1, text);
      assert.ok(step);
      state = step.state;
      text = step.text;
      seen.push(text);
    }
    assert.deepEqual(seen, ["third", "second", "first", "first", "first"]);
    assert.equal(state.draft, "draft");
  });

  test("↓ walks back to newer messages, and past the newest it brings back the draft", () => {
    let state: HistoryState = { at: 0, draft: "my draft" };
    const seen: string[] = [];
    let text = "first";
    for (let i = 0; i < 3; i++) {
      const step = stepHistory(state, LIST, 1, text);
      assert.ok(step);
      state = step.state;
      text = step.text;
      seen.push(text);
    }
    assert.deepEqual(seen, ["second", "third", "my draft"]);
    assert.deepEqual(state, NO_HISTORY);
  });

  test("an empty draft comes back as empty text", () => {
    const up = stepHistory(NO_HISTORY, LIST, -1, "");
    assert.ok(up);
    const down = stepHistory(up.state, LIST, 1, up.text);
    assert.deepEqual(down, { state: NO_HISTORY, text: "", caret: 0 });
  });

  test("a several-line message: ↑ puts the caret at the start so the next ↑ keeps going, ↓ at the end", () => {
    const list = ["one", "line a\nline b"];
    const up = stepHistory(NO_HISTORY, list, -1, "");
    assert.ok(up);
    assert.equal(up.text, "line a\nline b");
    assert.equal(up.caret, 0);
    assert.equal(onFirstLine(up.text, up.caret), true);
    const older = stepHistory(up.state, list, -1, up.text);
    assert.equal(older?.text, "one");
    const back = stepHistory(older!.state, list, 1, older!.text);
    assert.equal(back?.text, "line a\nline b");
    assert.equal(back?.caret, "line a\nline b".length);
    assert.equal(onLastLine(back!.text, back!.caret), true);
  });
});

describe("liveHistory", () => {
  test("the walk goes on while the input still shows the entry", () => {
    const state: HistoryState = { at: 1, draft: "d" };
    assert.equal(liveHistory(state, LIST, "second"), state);
  });

  test("typed over, cleared by a send or replaced from elsewhere: the walk is over", () => {
    const state: HistoryState = { at: 1, draft: "d" };
    assert.deepEqual(liveHistory(state, LIST, "second!"), NO_HISTORY);
    assert.deepEqual(liveHistory(state, LIST, ""), NO_HISTORY);
  });

  test("an entry index that the list no longer has ends the walk", () => {
    assert.deepEqual(liveHistory({ at: 5, draft: "" }, LIST, "third"), NO_HISTORY);
  });

  test("not walking stays not walking", () => {
    assert.deepEqual(liveHistory(NO_HISTORY, LIST, "third"), NO_HISTORY);
  });
});
