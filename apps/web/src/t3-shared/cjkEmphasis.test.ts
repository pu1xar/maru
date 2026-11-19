import assert from "node:assert/strict";
import { test } from "node:test";
import type { Root, RootContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { CJK_EMPHASIS_CASES } from "./cjkEmphasisCases.ts";
import { CHAT_MARKDOWN_REMARK_PLUGINS, CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS } from "./markdownPipeline.ts";

for (const [name, plugins] of [
  ["default", CHAT_MARKDOWN_REMARK_PLUGINS],
  ["with breaks", CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS],
] as const) {
  test(`emphasis next to CJK text and the shared cases (${name})`, () => {
    const processor = unified().use(remarkParse).use(plugins);
    const shape = (node: Root | RootContent): string => {
      if (node.type === "text") return node.value.replaceAll("*", "\\*");
      const children = "children" in node ? node.children.map(shape).join("") : "";
      if (node.type === "link") return `[${children}](${node.url})`;
      if (node.type === "emphasis") return `*${children}*`;
      if (node.type === "strong") return `**${children}**`;
      return children;
    };
    for (const [markdown, expected] of CJK_EMPHASIS_CASES) {
      assert.equal(shape(processor.runSync(processor.parse(markdown), markdown) as Root), expected, markdown);
    }
  });
}
