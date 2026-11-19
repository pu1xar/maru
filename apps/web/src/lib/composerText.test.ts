import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { fenceOpenAt } from "../components/chat/userMessageFences.ts";
import { composerEnter, FENCE_ENTER_HINT, messageToSend, type ComposerKey } from "./composerText.ts";

test("keeps the start as typed and drops the trailing whitespace, as Claude Code does", () => {
  // Measured on Claude Code 2.1.325: "    a\n    b" and "\n  \n  x  \n  \n" were stored as below.
  assert.equal(messageToSend("    a\n    b"), "    a\n    b");
  assert.equal(messageToSend("\n  \n  x  \n  \n"), "\n  \n  x");
  assert.equal(messageToSend("```\ncode\n```\n"), "```\ncode\n```");
});

test("nothing but whitespace sends nothing", () => {
  for (const raw of ["", "   ", "\n\n", " \t\n "]) assert.equal(messageToSend(raw), null);
});

const ENTER: ComposerKey = { key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: false };
/** Enter with the caret at the end of the text. */
const enterAtEnd = (text: string, key: Partial<ComposerKey> = {}) => composerEnter({ ...ENTER, ...key }, text, text.length);

describe("composerEnter", () => {
  test("an open fence makes Enter a line break", () => {
    for (const text of ["```", "```ts", "```\nconst a = 1;", "````md\n# a\n```js", "  ```\n  x"]) {
      assert.equal(enterAtEnd(text), "newline", JSON.stringify(text));
    }
  });

  test("after the closing fence Enter sends", () => {
    for (const text of ["```\nconst a = 1;\n```", "```ts\nx\n``` 이거 봐줘", "봐줘 ```x\ny``` 끝", "```\na\n```\n다음 글"]) {
      assert.equal(enterAtEnd(text), "send", JSON.stringify(text));
    }
  });

  test("a fence glued to the sentence before it", () => {
    // Ends its line: open. Followed by code: open once the caret has left that line.
    for (const text of ["봐줘 ```", "봐줘 ```python", "봐줘?```GET /p HTTP/2\nHost: x", "대상은 ```a.example.com\n"]) {
      assert.equal(enterAtEnd(text), "newline", JSON.stringify(text));
    }
    // On its own line a glued run with words after it may be a mention.
    for (const text of ["입력창에서 ```를 치면 어떻게 돼?", "봐줘 ```const a = 1;", "입력창에서 ``` 를 치면"]) {
      assert.equal(enterAtEnd(text), "send", JSON.stringify(text));
    }
  });

  test("the caret before the fence reads only the text before it", () => {
    const text = "앞 글\n```\ncode";
    assert.equal(composerEnter(ENTER, text, 3), "send");
    assert.equal(composerEnter(ENTER, text, text.length), "newline");
    // Between an opener and its closer the caret is inside.
    const closed = "```\nab\n```";
    assert.equal(composerEnter(ENTER, closed, 5), "newline");
    assert.equal(composerEnter(ENTER, closed, closed.length), "send");
  });

  test("tilde fences and inline ```x``` leave Enter sending", () => {
    for (const text of ["~~~", "~~~\ncode", "좋아~~~", "채팅창에서 ```여러 코드줄``` 이게", "```x```"]) {
      assert.equal(enterAtEnd(text), "send", JSON.stringify(text));
    }
  });

  test("Cmd+Enter and Ctrl+Enter always send", () => {
    for (const key of [{ metaKey: true }, { ctrlKey: true }]) {
      assert.equal(enterAtEnd("```\ncode", key), "send");
      assert.equal(enterAtEnd("plain", key), "send");
    }
  });

  test("Shift and Alt add a line, IME composition and other keys do nothing", () => {
    assert.equal(enterAtEnd("plain", { shiftKey: true }), "newline");
    assert.equal(enterAtEnd("plain", { altKey: true }), "newline");
    assert.equal(enterAtEnd("```", { isComposing: true }), "none");
    assert.equal(enterAtEnd("plain", { isComposing: true }), "none");
    assert.equal(composerEnter({ ...ENTER, key: "a" }, "```", 3), "none");
  });

  test("fenceOpenAt agrees at every caret of a typed message", () => {
    const text = "봐줘 ```\nconst a = 1;\n``` 이거";
    const open = [...Array(text.length + 1).keys()].filter((caret) => fenceOpenAt(text, caret));
    // From the end of the opener line to the closer's first backtick.
    assert.equal(open[0], text.indexOf("```") + 3);
    assert.equal(open.at(-1), text.lastIndexOf("```") + 2);
  });

  test("the hint has no sentence period and names a send key", () => {
    assert.match(FENCE_ENTER_HINT, /^Inside a code block: Enter for a new line, (⌘Enter|Ctrl\+Enter) to send$/);
  });
});
