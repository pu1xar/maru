// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/markdownRenderer.test.tsx (vitest cases on node:test).
// Local addition: the streamed-reply case also covers an unfinished code fence and a GitHub alert.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";

import { createIncrementalMarkdownPlugin } from "../../markdown-incremental.ts";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "../../t3-shared/markdownPipeline.ts";
import { createMarkdownRenderer } from "./markdownRenderer.ts";

// Visible in the markup, so every URL attribute must pass through it.
const urlTransform = (url: string) => `${url}#seen`;

const reactMarkdown = (source: string) =>
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: CHAT_MARKDOWN_REMARK_PLUGINS,
      rehypePlugins: CHAT_MARKDOWN_REHYPE_PLUGINS,
      urlTransform,
      children: source,
    }),
  );

describe("createMarkdownRenderer", () => {
  const render = createMarkdownRenderer({
    remarkPlugins: CHAT_MARKDOWN_REMARK_PLUGINS,
    rehypePlugins: CHAT_MARKDOWN_REHYPE_PLUGINS,
    components: {},
    urlTransform,
  });

  for (const source of [
    '# Title\n\nText with `code`, **bold**, [a link](https://example.com "t") and https://bare.example.com.',
    "![shot](./shot.png) and [file](file:///C:/repo/a.ts) and [bad](javascript:alert(1))",
    "<details><summary>More</summary>\n\nHidden <b>bold</b> <script>x()</script>\n\n</details>",
    "| a | b |\n| - | - |\n| <br> | [x](#frag) |\n\n- [ ] task\n- [x] done",
    '```ts title="a.ts"\nconst a = 1;\n```\n\n> [!WARNING]\n> careful <a>bare</a>',
    "Footnote[^1] and ~~strike~~\n\n[^1]: the note",
    // Each GFM construct the parser skips when its text cannot match, next to one that can.
    "Mail me@example.com, see www.example.com and HTTPS://example.com/a, not [x](https://y.z).",
    "a.b-c_d+e@x.io and @user\n\n`me@x.io` <me@x.io>",
    "A table without pipes\n:--",
    "> | quoted |\n> | - |\n> | body |\n\n- [ ] open\n- [X] done",
    "Escaped www\\.example.com and me&#64;example.com",
    "\ufeffA byte order mark\n\n| a |\n| - |\n| b |",
    "> - | a |\r\n>   | - |\r\n>   | me@x.io |\r\n\n-\t[ ] tab\n\n  ~~lazy~~",
  ]) {
    test(`renders what react-markdown renders: ${JSON.stringify(source)}`, () => {
      const element = render(source, true);
      assert.equal(renderToStaticMarkup(element), reactMarkdown(source));
      assert.equal(render(source, true), element);
    });
  }

  test("renders what react-markdown renders while a reply streams through the incremental parser", () => {
    const reply =
      "```ts\nconst a = 1;\n```\n\n| a | b |\n| - | - |\n| me@x.io | www.x.io |\n\nDone ~~now~~.\n\n> [!NOTE]\n> after\n\n```sh\necho open";
    // As ChatMarkdown streams: one incremental plugin for the reply, a fresh renderer per update.
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 1; end <= reply.length; end++) {
      const source = reply.slice(0, end);
      const streamed = createMarkdownRenderer({
        remarkPlugins: [...CHAT_MARKDOWN_REMARK_PLUGINS, incremental],
        rehypePlugins: CHAT_MARKDOWN_REHYPE_PLUGINS,
        components: {},
        urlTransform,
      })(source, false);
      assert.equal(renderToStaticMarkup(streamed), reactMarkdown(source), JSON.stringify(source));
    }
  });

  test("keeps cached messages when one far larger than the cache is rendered", () => {
    const element = render("Kept *message*", true);
    render("x".repeat(600_000), true);
    assert.equal(render("Kept *message*", true), element);
  });
});
