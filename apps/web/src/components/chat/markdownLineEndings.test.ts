import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CHAT_MARKDOWN_REMARK_PLUGINS } from "../../t3-shared/markdownPipeline.ts";
import { normalizeMarkdownLineEndings } from "./markdownLineEndings.ts";
import { createMarkdownRenderer } from "./markdownRenderer.ts";

const render = createMarkdownRenderer({
  remarkPlugins: CHAT_MARKDOWN_REMARK_PLUGINS,
  rehypePlugins: [],
  components: {},
  urlTransform: (url) => url,
});

test("code from text with CR or CRLF breaks holds LF breaks only", () => {
  for (const text of ["```\ra\rb\r```", "```\r\na\r\nb\r\n```", "```\na\rb\r\n```"]) {
    const html = renderToStaticMarkup(render(normalizeMarkdownLineEndings(text), false));
    assert.equal(html, "<pre><code>a\nb\n</code></pre>", JSON.stringify(text));
  }
});

test("LF text is returned as is", () => {
  const text = "a\n\n```\nb\n```";
  assert.equal(normalizeMarkdownLineEndings(text), text);
});
