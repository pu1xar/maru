import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CHAT_MARKDOWN_REMARK_PLUGINS } from "../../t3-shared/markdownPipeline.ts";
import { createMarkdownRenderer } from "./markdownRenderer.ts";
import { withoutPartialFenceLine } from "./streamingFence.ts";

const render = createMarkdownRenderer({
  remarkPlugins: CHAT_MARKDOWN_REMARK_PLUGINS,
  rehypePlugins: [],
  components: {},
  urlTransform: (url) => url,
});
const html = (text: string) => renderToStaticMarkup(render(text, false));

test("a closing fence still arriving adds no line to the block", () => {
  // Recorded from a streamed Codex answer: the list item's closer had two of its three backticks.
  const streamed = "1. 첫 단계\n\n   ```bash\n   npm install\n   npm test\n   ``";
  assert.equal(withoutPartialFenceLine(streamed), "1. 첫 단계\n\n   ```bash\n   npm install\n   npm test\n");
  assert.match(html(withoutPartialFenceLine(streamed)), /<code class="language-bash">npm install\nnpm test\n<\/code>/);
  assert.match(html(streamed), /npm test\n``\n/);
});

test("an opening fence still arriving is not drawn as backticks in prose", () => {
  for (const streamed of ["예시:\n\n`", "예시:\n\n``", "> 인용\n> ``", "~~"]) {
    assert.doesNotMatch(html(withoutPartialFenceLine(streamed)), /`|~/, JSON.stringify(streamed));
  }
});

test("everything else streams as it is", () => {
  for (const text of ["```js\nconst a = 1;\n```", "a `code` span", "text ``", "```", "line\n```", "a\n``b"]) {
    assert.equal(withoutPartialFenceLine(text), text, JSON.stringify(text));
  }
});
