// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/markdownStreamBlocks.test.tsx (vitest cases on node:test).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";

import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  remarkAssistantInsights,
} from "../../t3-shared/markdownPipeline.ts";
import { splitMarkdownBlocks } from "./markdownStreamBlocks.ts";

// Whitespace between top-level blocks collapses in the rendered message.
const html = (source: string) =>
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkAssistantInsights, ...CHAT_MARKDOWN_REMARK_PLUGINS],
      rehypePlugins: CHAT_MARKDOWN_REHYPE_PLUGINS,
      children: source,
    }),
  )
    .replace(/>\s+</g, "><")
    .trim();

describe("splitMarkdownBlocks", () => {
  for (const text of [
    "# Title\n\nFirst paragraph with `code` and **bold**.\n\nSecond [link](https://example.com).",
    "- one\n- two\n\n- loose three\n\n  continued\n\nAfter the list.",
    "1. first\n\n2. second\n\nText\n\n3) restarted",
    "```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nafter\n\n~~~\nx\n\n~~~~\n\ny\n~~~\n\nend",
    "> quote\n\n> another quote\n\n> [!NOTE]\n> alert",
    "| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter the table.",
    "para\n\n    indented code\n\nnext",
    "Setext\n===\n\nnext\n---\n\n- [ ] task\n- [x] done",
    "- a\n\n  ```\n  x\n\n```\n\nb",
    "- a\n\n  ```\n  x\n\ny\n\n  ```\n\nb",
    "intro\n\n★ Insight ─────\nfirst\n\n```\n─────\n```\n\n- point\n─────\n\nafter\n\n`★ Insight ─────`\nsecond\n`─────`\n\nend",
  ]) {
    test(`renders each block as the whole text renders it, at every streamed prefix: ${JSON.stringify(text)}`, () => {
      for (let end = 0; end <= text.length; end++) {
        const source = text.slice(0, end);
        const blocks = splitMarkdownBlocks(source);
        assert.equal(blocks?.join(""), source);
        assert.equal(blocks!.map(html).join(""), html(source), JSON.stringify(source));
      }
    });
  }

  test("splits only between closed blocks", () => {
    assert.deepEqual(splitMarkdownBlocks("a\n\n```\nb\n\nc\n```\n\n- d\n\n- e\n\nf"), [
      "a\n\n",
      "```\nb\n\nc\n```\n\n- d\n\n- e\n\n",
      "f",
    ]);
  });

  test("keeps an open code fence in the last block while it streams", () => {
    // The fence is still open: its blank lines must not cut the block.
    assert.deepEqual(splitMarkdownBlocks("intro\n\n```ts\nconst a = 1;\n\n\nconst b"), [
      "intro\n\n",
      "```ts\nconst a = 1;\n\n\nconst b",
    ]);
  });

  for (const text of [
    "[ref]\n\n[ref]: /later",
    "a[^x]\n\n[^x]: note",
    "<details>\n\nbody\n\n</details>",
    ":::note\n\ncontent\n\n:::",
    "$$\na\n\nb\n$$",
    "a\r\n\r\nb",
  ]) {
    test(`keeps text with document-wide syntax whole: ${JSON.stringify(text)}`, () => {
      assert.equal(splitMarkdownBlocks(text), null);
    });
  }
});
