import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { serializeCodeBlockToMarkdown } from "../../markdown-clipboard.ts";
import { CHAT_MARKDOWN_REMARK_PLUGINS } from "../../t3-shared/markdownPipeline.ts";
import {
  extractCodeBlock,
  extractFenceLanguage,
  isClosedCodeFence,
} from "./MarkdownCodeBlock.logic.ts";
import {
  isMermaidLanguage,
  MERMAID_MIN_SCALE,
  mermaidBlockView,
  mermaidFailureLine,
  mermaidMinWidth,
} from "./MarkdownMermaid.logic.ts";
import { withoutPartialFenceLine } from "./streamingFence.ts";
import { createMarkdownRenderer } from "./markdownRenderer.ts";

// What ChatMarkdown's `pre` sees for each fence: the language it routes on and whether the fence
// has closed, taken from the real parse (not from a hand-built node).
interface Seen {
  language: string;
  code: string;
  closed: boolean;
}
function fencesIn(text: string): Seen[] {
  const seen: Seen[] = [];
  const render = createMarkdownRenderer({
    remarkPlugins: CHAT_MARKDOWN_REMARK_PLUGINS,
    rehypePlugins: [],
    components: {
      pre: ({ node, children }: { node?: unknown; children?: ReactNode }) => {
        const block = extractCodeBlock(children);
        if (block) {
          seen.push({
            language: extractFenceLanguage(block.className),
            code: block.code,
            closed: isClosedCodeFence(node as Parameters<typeof isClosedCodeFence>[0], text, block.code),
          });
        }
        return null;
      },
    },
    urlTransform: (url) => url,
  });
  renderToStaticMarkup(createElement("div", null, render(text, false)));
  return seen;
}

describe("isMermaidLanguage", () => {
  test("names the mermaid fence in any case", () => {
    for (const language of ["mermaid", "Mermaid", "MERMAID", " mermaid "]) {
      assert.equal(isMermaidLanguage(language), true, language);
    }
  });
  test("other languages stay code", () => {
    for (const language of ["text", "mermaidjs", "mmd", "flowchart", "", "js"]) {
      assert.equal(isMermaidLanguage(language), false, language);
    }
  });
});

describe("the fence the parser hands to the block", () => {
  test("a ```mermaid fence reads as mermaid with its source", () => {
    const [fence] = fencesIn("```mermaid\nflowchart LR\n  A --> B\n```\n");
    assert.equal(isMermaidLanguage(fence!.language), true);
    assert.equal(fence!.code, "flowchart LR\n  A --> B\n");
    assert.equal(fence!.closed, true);
  });
  test("a title after the language and a ~~~ fence still read as mermaid", () => {
    assert.equal(isMermaidLanguage(fencesIn('```mermaid title="flow"\ngraph TD\n```\n')[0]!.language), true);
    assert.equal(isMermaidLanguage(fencesIn("~~~mermaid\ngraph TD\n~~~\n")[0]!.language), true);
  });
  test("a fence of four backticks that holds three is one block", () => {
    const fences = fencesIn("````mermaid\ngraph TD\n```\n````\n");
    assert.equal(fences.length, 1);
    assert.equal(fences[0]!.closed, true);
  });
  test("an unfinished fence is open, a finished one is closed", () => {
    assert.equal(fencesIn("```mermaid\nflowchart LR\n  A --> B\n")[0]!.closed, false);
    assert.equal(fencesIn("```mermaid\nflowchart LR\n  A --> B\n```")[0]!.closed, true);
  });
  test("a closer still arriving keeps the block open until it is whole", () => {
    // ChatMarkdown cuts a partial closer before the parse (streamingFence.ts), so the block is open.
    const midStream = "```mermaid\nflowchart LR\n  A --> B\n``";
    assert.equal(fencesIn(withoutPartialFenceLine(midStream))[0]!.closed, false);
    assert.equal(fencesIn(withoutPartialFenceLine(midStream + "`"))[0]!.closed, true);
  });
  test("a fence in a blockquote is judged the same way", () => {
    assert.equal(fencesIn("> ```mermaid\n> graph TD\n> ```\n")[0]!.closed, true);
    assert.equal(fencesIn("> ```mermaid\n> graph TD\n")[0]!.closed, false);
  });
});

describe("mermaidBlockView", () => {
  const base = { code: "graph TD\n A-->B", open: false, showCode: false, failed: false };
  test("a closed block with source draws", () => {
    assert.equal(mermaidBlockView(base), "diagram");
  });
  test("a block still arriving stays code, however much of it parses", () => {
    assert.equal(mermaidBlockView({ ...base, open: true }), "code");
  });
  test("the reader's Code view and a failed draw show code", () => {
    assert.equal(mermaidBlockView({ ...base, showCode: true }), "code");
    assert.equal(mermaidBlockView({ ...base, failed: true }), "code");
  });
  test("an empty or blank source has nothing to draw", () => {
    assert.equal(mermaidBlockView({ ...base, code: "" }), "code");
    assert.equal(mermaidBlockView({ ...base, code: " \n\t\n" }), "code");
  });
});

describe("mermaidFailureLine", () => {
  test("a syntax error names its line", () => {
    const line = mermaidFailureLine({ code: "syntax", line: 3, message: "Parse error on line 3" });
    assert.equal(line.summary, "Mermaid syntax error on line 3");
    assert.equal(line.detail, "Parse error on line 3");
  });
  test("a syntax error with no line stays one short line", () => {
    assert.equal(mermaidFailureLine({ code: "syntax", line: 0, message: "x" }).summary, "Mermaid syntax error");
    assert.equal(mermaidFailureLine({ code: "semantic", message: "x" }).summary, "Mermaid syntax error");
  });
  test("the other reasons say what happened", () => {
    assert.equal(mermaidFailureLine({ code: "unsupported-diagram", message: "m" }).summary, "Mermaid diagram type is not supported");
    assert.equal(mermaidFailureLine({ code: "limit", message: "m" }).summary, "Mermaid diagram is too large to draw");
    assert.equal(mermaidFailureLine(new Error("chunk failed")).summary, "Mermaid diagram could not be drawn");
    assert.equal(mermaidFailureLine("odd").detail, "odd");
  });
});

describe("mermaidMinWidth", () => {
  test("scales the natural width by the floor", () => {
    assert.equal(mermaidMinWidth(1000), Math.round(1000 * MERMAID_MIN_SCALE));
  });
  test("a width that is not a size gives no floor", () => {
    for (const width of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(mermaidMinWidth(width), 0);
    }
  });
});

describe("copying a diagram", () => {
  test("copies as the fenced source, a longer fence when the source holds fences", () => {
    assert.equal(serializeCodeBlockToMarkdown("graph TD\n  A --> B\n", "mermaid"), "```mermaid\ngraph TD\n  A --> B\n```\n\n");
    assert.equal(serializeCodeBlockToMarkdown("A[```]", "mermaid"), "````mermaid\nA[```]\n````\n\n");
  });
});
