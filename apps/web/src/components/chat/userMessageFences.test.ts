import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  remarkEnableOrderedListNumbers,
} from "../../t3-shared/markdownPipeline.ts";
import { normalizeMarkdownLineEndings } from "./markdownLineEndings.ts";
import { createMarkdownRenderer } from "./markdownRenderer.ts";
import { userMessageFenceText } from "./userMessageFences.ts";

// The sent-message settings of TimelineUserMessageRow: line breaks kept, raw HTML as text.
const render = createMarkdownRenderer({
  remarkPlugins: [
    ...CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
    remarkEnableOrderedListNumbers,
  ],
  rehypePlugins: [],
  components: {},
  urlTransform: (url) => url,
});

const decode = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

/** Each fenced block's lines and the text outside blocks, as the bubble draws the message. */
function drawn(text: string) {
  // ChatMarkdown makes every line ending LF before the parse.
  const html = renderToStaticMarkup(render(normalizeMarkdownLineEndings(userMessageFenceText(text)), false));
  const blocks = [...html.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((match) =>
    decode(match[1]!).replace(/\n$/, "").split("\n"),
  );
  const language = [...html.matchAll(/<pre><code(?: class="language-([^"]+)")?/g)].map(
    (match) => match[1] ?? null,
  );
  const prose = decode(html.replace(/<pre>[\s\S]*?<\/pre>/g, "\n"));
  return { blocks, language, prose, html };
}

describe("userMessageFenceText", () => {
  test("leaves text that CommonMark already reads as typed", () => {
    for (const text of [
      "no fences here, just `inline` code",
      "아래 함수 봐줘\n```python\ndef foo(x):\n    return 1\n```\n이거 맞아?",
      "```\n첫 줄 한글\n  들여쓴 줄\n\n\n빈 줄 두 개 뒤\n```",
      "````markdown\n# 제목\n```js\nconst a = 1;\n```\n````",
      "이거 실행해\n```sh\nls -la\ncd /tmp",
      "~~~\na ~ b\n~/path\n~~~",
      "채팅창에서 ```여러 코드줄``` 이게 제대로 보여?",
      "입력창에서 ``` 를 치고 Enter를 누르면 어떻게 돼?",
      "```js\nconst t = '```';\nconst u = `${a}`;\n```",
      "  ```\n  indented fence\n  ```",
      "    indented code ```x\n\n> quoted ```y\n> z```",
      "좋아~~~ 고마워~~~",
    ]) {
      assert.equal(userMessageFenceText(text), text, JSON.stringify(text));
    }
  });

  test("a fence glued to the sentence before it and a closer followed by words", () => {
    const text = "이렇게 보내면 대비 돼?```GET /p/1 HTTP/2\nHost: example.com\nCookie: a=b\n\n``` 이게 실제 요청";
    assert.equal(
      userMessageFenceText(text),
      "이렇게 보내면 대비 돼?\n```\nGET /p/1 HTTP/2\nHost: example.com\nCookie: a=b\n\n```\n이게 실제 요청",
    );
    const view = drawn(text);
    assert.deepEqual(view.blocks, [["GET /p/1 HTTP/2", "Host: example.com", "Cookie: a=b", ""]]);
    assert.doesNotMatch(view.prose, /```/);
    assert.match(view.prose, /이게 실제 요청/);
  });

  test("two blocks whose fences sit inside sentences", () => {
    const text =
      "폰트 이거 써볼래? ```@font-face {\n    font-family: 'Sample';\n}``` 이거랑 ```@font-face {\n  font-family: 'Other';\n}``` 이거 둘 다";
    const view = drawn(text);
    assert.deepEqual(view.blocks, [
      ["@font-face {", "    font-family: 'Sample';", "}"],
      ["@font-face {", "  font-family: 'Other';", "}"],
    ]);
    assert.doesNotMatch(view.prose, /```/);
    assert.match(view.prose, /폰트 이거 써볼래\?[\s\S]*이거랑[\s\S]*이거 둘 다/);
  });

  test("an opener ending the sentence keeps the blank lines of the block", () => {
    const view = drawn("참고로 이렇게 적었어. ```\n\n첫 문단 한 줄\n\n둘째 문단\n\n```");
    assert.deepEqual(view.blocks, [["", "첫 문단 한 줄", "", "둘째 문단", ""]]);
    assert.doesNotMatch(view.prose, /```/);
  });

  test("a closer glued to the last line of code", () => {
    const view = drawn("대상은 ```PC / WEB    페이    pay.example.com\nPC / WEB    블로그    blog.example.com```");
    assert.deepEqual(view.blocks, [["PC / WEB    페이    pay.example.com", "PC / WEB    블로그    blog.example.com"]]);
  });

  test("a language word after a glued opener names the block", () => {
    const view = drawn("이 코드 봐줘 ```ts\nconst a = 1;\n```");
    assert.deepEqual(view.blocks, [["const a = 1;"]]);
    assert.deepEqual(view.language, ["ts"]);
  });

  test("a closer and the next opener on one line, and CR line breaks", () => {
    const view = drawn("대상은 ```a.example.com\rb.example.com``` ```제외 대상\r- 항목 하나```\r끝");
    assert.deepEqual(view.blocks, [["a.example.com", "b.example.com"], ["제외 대상", "- 항목 하나"]]);
    assert.doesNotMatch(view.prose, /```/);
  });

  test("an opener at the start of a line takes the words after it as code", () => {
    const view = drawn("```GET /p HTTP/2\nHost: x\n```");
    assert.deepEqual(view.blocks, [["GET /p HTTP/2", "Host: x"]]);
    assert.deepEqual(view.language, [null]);
  });

  test("a fence at the start of a line that opens nothing reads as the backticks typed", () => {
    const text = "``` 를 치면 어떻게 돼?";
    assert.equal(userMessageFenceText(text), "\\``` 를 치면 어떻게 돼?");
    const view = drawn(text);
    assert.deepEqual(view.blocks, []);
    assert.match(view.prose, /``` 를 치면 어떻게 돼\?/);
  });

  test("a glued run with no closer stays as typed", () => {
    for (const text of ["입력창에서 ```를 치고 Enter", "봐줘 ```const a = 1;\nconst b = 2;"]) {
      assert.equal(userMessageFenceText(text), text);
    }
  });

  test("code with a backtick run inside the block stays in the block", () => {
    const view = drawn("봐줘 ```js\nconst t = '```';\nconst u = 1;\n``` 끝");
    assert.deepEqual(view.blocks, [["const t = '```';", "const u = 1;"]]);
    assert.match(view.prose, /끝/);
  });

  test("two equal runs on the opener's line pair up as inline code, as in CommonMark", () => {
    const text = "봐줘 ```const t = '```';\nconst u = 1;\n``` 끝";
    // The last line would otherwise open an empty block named 끝.
    assert.equal(userMessageFenceText(text), "봐줘 ```const t = '```';\nconst u = 1;\n\\``` 끝");
    const view = drawn(text);
    assert.deepEqual(view.blocks, []);
    assert.match(view.prose, /``` 끝/);
  });

  test("a dotted word after a glued opener is the first code line", () => {
    const view = drawn("대상은 ```pay.example.com\nblog.example.com```");
    assert.deepEqual(view.blocks, [["pay.example.com", "blog.example.com"]]);
    assert.deepEqual(view.language, [null]);
  });

  test("a four-backtick block holds a glued triple run", () => {
    const view = drawn("예시 ````md\n# a\n```js\nx```\n````");
    assert.deepEqual(view.blocks, [["# a", "```js", "x```"]]);
  });
});

test("nothing strikes: lone tildes (date ranges, home paths) and ~~double~~ tildes stay text", async () => {
  const { unified } = await import("unified");
  const { default: remarkParse } = await import("remark-parse");
  const { CHAT_MARKDOWN_REMARK_PLUGINS } = await import("../../t3-shared/markdownPipeline.ts");
  const processor = unified().use(remarkParse).use(CHAT_MARKDOWN_REMARK_PLUGINS);
  const tree = (text: string) => processor.runSync(processor.parse(text));
  const hasDelete = (node: { type: string; children?: unknown[] }): boolean =>
    node.type === "delete" || (node.children ?? []).some((c) => hasDelete(c as { type: string; children?: unknown[] }));
  assert.equal(hasDelete(tree("3월~4월, 5월~6월 동안") as never), false);
  assert.equal(hasDelete(tree("~/a 와 (~/b") as never), false);
  assert.equal(hasDelete(tree("이건 ~~지움~~") as never), false);
  const text = (node: { type: string; value?: string; children?: unknown[] }): string =>
    node.value ?? (node.children ?? []).map((c) => text(c as never)).join("");
  assert.equal(text(tree("이건 ~~지움~~ 끝") as never), "이건 ~~지움~~ 끝");
});
