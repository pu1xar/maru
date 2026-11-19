// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: packages/shared/src/markdownPipeline.test.ts (vitest cases on node:test).
// Local changes: T3's in-app thread link case now checks that those schemes are dropped, since this
// pipeline leaves them out; added cases for GFM tables, task lists, GitHub alerts and raw HTML.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Link, Root, RootContent } from "mdast";
import rehypeRaw from "rehype-raw";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type PluggableList, unified } from "unified";

import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  remarkAssistantInsights,
  remarkEnableOrderedListNumbers,
} from "./markdownPipeline.ts";

/** vitest's toMatchObject: objects match on the expected keys, arrays element by element. */
function assertMatches(actual: unknown, expected: unknown, path = "$"): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected an array`);
    assert.equal(actual.length, expected.length, `${path}: length`);
    expected.forEach((item, index) => assertMatches(actual[index], item, `${path}[${index}]`));
    return;
  }
  if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object", `${path}: expected an object`);
    for (const [key, value] of Object.entries(expected)) {
      assertMatches((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
    return;
  }
  assert.equal(actual, expected, path);
}

const htmlProcessor = () =>
  unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);

for (const [name, plugins] of [
  ["default", CHAT_MARKDOWN_REMARK_PLUGINS],
  ["with breaks", CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS],
] as const) {
  test(`preserves bare URL boundaries (${name})`, () => {
    const processor = unified().use(remarkParse).use(plugins);
    const shape = (node: Root | RootContent): string => {
      if (node.type === "text") return node.value;
      if (node.type === "inlineCode") return `\`${node.value}\``;
      if (node.type === "code") return `\`\`\`${node.value}\`\`\``;
      const children = "children" in node ? node.children.map(shape).join("") : "";
      if (node.type === "link") return `[${children}](${node.url})`;
      if (node.type === "linkReference") return `[${children}][${node.identifier}]`;
      if (node.type === "emphasis") return `*${children}*`;
      if (node.type === "strong") return `**${children}**`;
      if (node.type === "delete") return `~~${children}~~`;
      return children;
    };
    const link = (url: string) => `[${url}](${/^www\./i.test(url) ? `http://${url}` : url})`;
    for (const url of [
      "https://x.com/dimasike_",
      "http://example.com/name__",
      "HTTPS://example.com/name_",
      "https://example.com/a_(b)_",
      "https://example.com/?name=value_",
      "https://example.com/#section_",
      "https://example.com/a_?name=value_#section_",
      "https://example.com/name~",
      "https://example.com/name~~",
      "https://example.com/name_~",
      "https://example.com/name~_",
      "https://example.com/name__~~_",
      "https://example.com/?name=value~",
      "https://example.com/#section~",
      "www.example.com/name_",
      "www.example.com/name~_",
      "WWW.example.com/name~~",
      "https://example.com/name-",
      "https://example.com/name/",
      "https://example.com/name%5F",
      "https://example.com/name%7E",
    ]) {
      for (const punctuation of ["", ".", ",", "!", "?", ":", ";", ")", "]", '"']) {
        const markdown = `See ${url}${punctuation} next`;
        assert.equal(
          shape(processor.runSync(processor.parse(markdown), markdown) as Root),
          `See ${link(url)}${punctuation} next`,
          markdown,
        );
      }
    }
    for (const [markdown, expected] of [
      ["*https://x.com/dimasike_*", `*${link("https://x.com/dimasike_")}*`],
      ["**https://x.com/dimasike_**", `**${link("https://x.com/dimasike_")}**`],
      ["_https://x.com/dimasike_", `*${link("https://x.com/dimasike")}*`],
      ["__https://x.com/dimasike__", `**${link("https://x.com/dimasike")}**`],
      ["~~https://example.com/name_~~", `~~${link("https://example.com/name_")}~~`],
      ["~~https://example.com/name~~", `~~${link("https://example.com/name")}~~`],
      // A lone tilde pair is text, not a strike (singleTilde: false): the second tilde stays in the URL.
      ["~https://example.com/name~", `~${link("https://example.com/name~")}`],
      ["*https://example.com/name~*", `*${link("https://example.com/name~")}*`],
      ["_https://example.com/name~_", `*${link("https://example.com/name~")}*`],
      ["[test](https://example.com/name~)", "[test](https://example.com/name~)"],
      ["[https://x.com/a](https://x.com/a)~_", `${link("https://x.com/a")}~_`],
      ["<https://x.com/a>~_", `${link("https://x.com/a")}~_`],
      ["[test][ref]~_\n\n[ref]: https://x.com/a~_", "[test][ref]~_"],
      ["`https://example.com/name~_`", "`https://example.com/name~_`"],
      ["```\nhttps://example.com/name~_\n```", "```https://example.com/name~_```"],
      ["https\\://example.com/name~_", link("https://example.com/name~_")],
      ["https://example.com/name. _~", `${link("https://example.com/name")}. _~`],
      ["Mail person@example.com_", "Mail person@example.com_"],
      ["Mail person@example.com ~_", "Mail [person@example.com](mailto:person@example.com) ~_"],
      ["[test](https://x.com/dimasike_)", "[test](https://x.com/dimasike_)"],
      ["[https://x.com/a](https://x.com/a)_", `${link("https://x.com/a")}_`],
      ["<https://x.com/a>_", `${link("https://x.com/a")}_`],
      ["[test][ref]_\n\n[ref]: https://x.com/a_", "[test][ref]_"],
      ["`https://x.com/dimasike_`", "`https://x.com/dimasike_`"],
      ["```\nhttps://x.com/dimasike_\n```", "```https://x.com/dimasike_```"],
      ["https://x.com/a. _", `${link("https://x.com/a")}. _`],
      ["https\\://x.com/dimasike_", link("https://x.com/dimasike_")],
      ["https://x.com/a\\_", link("https://x.com/a\\_")],
      ["https://x.com/a&#95;", `${link("https://x.com/a&#95")};`],
      [
        "可以看了：**http://localhost:18780**（已重启）。",
        `可以看了：**${link("http://localhost:18780")}**（已重启）。`,
      ],
      ["打开 http://localhost:18780，然后刷新", `打开 ${link("http://localhost:18780")}，然后刷新`],
      ["URL：https://example.com/a。下一句", `URL：${link("https://example.com/a")}。下一句`],
      ["（预览：http://localhost:18780）", `（预览：${link("http://localhost:18780")}）`],
      [
        "能打开 http://localhost:3000？见 http://localhost:3001；「www.example.com」",
        `能打开 ${link("http://localhost:3000")}？见 ${link("http://localhost:3001")}；「${link("www.example.com")}」`,
      ],
      [
        "__http://localhost:18780__，*http://localhost:3000*，~~http://localhost:3001~~。",
        `**${link("http://localhost:18780")}**，*${link("http://localhost:3000")}*，~~${link("http://localhost:3001")}~~。`,
      ],
      [
        "foo**http://localhost:18780**（bar）***http://localhost:3000***。",
        `foo**${link("http://localhost:18780")}**（bar）***${link("http://localhost:3000")}***。`,
      ],
      [
        "http://a.com。http://b.com，www.c.com、person@example.com。",
        `${link("http://a.com")}。${link("http://b.com")}，${link("www.c.com")}、[person@example.com](mailto:person@example.com)。`,
      ],
      [
        "**http://localhost:18780**（重启）。 https://example.com/a。结束",
        `**${link("http://localhost:18780")}**（重启）。 ${link("https://example.com/a")}。结束`,
      ],
      ["# **http://localhost:3000**，刷新", `**${link("http://localhost:3000")}**，刷新`],
      [
        "| a |\n| - |\n| **http://localhost:3000**，刷新 |",
        `a**${link("http://localhost:3000")}**，刷新`,
      ],
      ["www.example.com/preview。下一句", `${link("www.example.com/preview")}。下一句`],
      ["https://example.com/a_。下一句", `${link("https://example.com/a_")}。下一句`],
      ["https://example.com/a.，下一句", `${link("https://example.com/a")}.，下一句`],
      [
        "https://example.com/search?q=hello，world",
        `${link("https://example.com/search?q=hello")}，world`,
      ],
      ["https://example.com/日本語，続き", link("https://example.com/日本語，続き")],
      [
        "https://zh.wikipedia.org/wiki/北京（城市）",
        link("https://zh.wikipedia.org/wiki/北京（城市）"),
      ],
      ["https://example.com/a%EF%BC%8Cb", link("https://example.com/a%EF%BC%8Cb")],
      ["<https://example.com/日本語，続き>", link("https://example.com/日本語，続き")],
      ["[記事](https://example.com/a，b)", "[記事](https://example.com/a，b)"],
      ["[http://example.com/a，b](http://example.com/a，b)", link("http://example.com/a，b")],
      ["`https://example.com/a。次`", "`https://example.com/a。次`"],
      [
        "https://x.com/a_ https://x.com/b_",
        `${link("https://x.com/a_")} ${link("https://x.com/b_")}`,
      ],
    ] as const) {
      assert.equal(
        shape(processor.runSync(processor.parse(markdown), markdown) as Root),
        expected,
        markdown,
      );
    }
    for (const url of ["https://x.com/dimasike_", "www.example.com/name~_"]) {
      const markdown = `${url}, next`;
      const boundary = { line: 1, column: url.length + 1, offset: url.length };
      assertMatches(processor.runSync(processor.parse(markdown), markdown), {
        children: [
          {
            children: [
              {
                type: "link",
                url: /^www\./i.test(url) ? `http://${url}` : url,
                position: { end: boundary },
                children: [{ type: "text", value: url, position: { end: boundary } }],
              },
              { type: "text", value: ", next", position: { start: boundary } },
            ],
          },
        ],
      });
    }
  });
}

test("ends bare URLs at CJK punctuation with source positions", () => {
  const processor = unified().use(remarkParse).use(CHAT_MARKDOWN_REMARK_PLUGINS);
  const parse = (markdown: string) => processor.runSync(processor.parse(markdown), markdown);
  const at = (line: number, column: number, offset: number) => ({ line, column, offset });
  const url = "http://localhost:18780";
  assertMatches(parse(`第一行\n可以看了：**${url}**（已重启）。`), {
    children: [
      {
        children: [
          { type: "text", value: "第一行\n可以看了：", position: { end: at(2, 6, 9) } },
          {
            type: "strong",
            position: { start: at(2, 6, 9), end: at(2, 32, 35) },
            children: [
              {
                type: "link",
                url,
                position: { start: at(2, 8, 11), end: at(2, 30, 33) },
                children: [{ type: "text", value: url, position: { end: at(2, 30, 33) } }],
              },
            ],
          },
          {
            type: "text",
            value: "（已重启）。",
            position: { start: at(2, 32, 35), end: at(2, 38, 41) },
          },
        ],
      },
    ],
  });
  // Markup the URL swallowed comes back once the URL ends.
  assertMatches(parse(`打开 ${url}，然后运行\`pnpm dev\``), {
    children: [
      {
        children: [
          { type: "text", value: "打开 " },
          { type: "link", url },
          { type: "text", value: "，然后运行" },
          { type: "inlineCode", value: "pnpm dev" },
        ],
      },
    ],
  });
  // Every URL in one paragraph ends at its mark.
  const lines = Array.from({ length: 300 }, (_, index) => `接口：http://localhost:${index}，`);
  const [paragraph] = (parse(lines.join("\n")) as Root).children;
  const links =
    paragraph?.type === "paragraph"
      ? paragraph.children.filter((node): node is Link => node.type === "link")
      : [];
  assert.deepEqual(
    links.map((node) => node.url),
    lines.map((_, index) => `http://localhost:${index}`),
  );
  const lastLine = lines.slice(0, -1).join("\n").length + 1;
  assertMatches(links.at(-1), {
    position: { start: at(300, 4, lastLine + 3), end: at(300, 24, lastLine + 23) },
  });
  // Only a table unescapes `\|` in code, so that cell keeps its parse and the URL is cut.
  const descendants = (node: Root | RootContent): RootContent[] =>
    "children" in node
      ? (node.children as RootContent[]).flatMap((child) => [child, ...descendants(child)])
      : [];
  const cell = descendants(parse("| a |\n| - |\n| http://example.com， `a\\|b` |") as Root);
  assert.deepEqual(
    cell.flatMap((node) => (node.type === "link" ? [node.url] : [])),
    ["http://example.com"],
  );
  assert.deepEqual(
    cell.flatMap((node) => (node.type === "inlineCode" ? [node.value] : [])),
    ["a|b"],
  );
  // A task item's checkbox is not part of its paragraph's text.
  const task = descendants(parse("- [x] http://example.com，刷新") as Root);
  assert.deepEqual(
    task.flatMap((node) => (node.type === "text" ? [node.value] : [])),
    ["http://example.com", "，刷新"],
  );
  // A list item's indentation stays out of a code span that crosses lines.
  const code = descendants(parse("- `echo\n  hello` http://example.com，结束") as Root);
  assert.deepEqual(
    code.flatMap((node) => (node.type === "link" ? [node.url] : [])),
    ["http://example.com"],
  );
  assert.deepEqual(
    code.flatMap((node) => (node.type === "inlineCode" ? [node.value] : [])),
    ["echo\nhello"],
  );
  // A list item's continuation line parses the same on its own.
  assertMatches(parse(`- 第一行\n  **${url}**（已重启）`), {
    children: [
      {
        children: [
          {
            children: [
              {
                children: [
                  { type: "text", value: "第一行\n" },
                  { type: "strong", children: [{ type: "link", url }] },
                  { type: "text", value: "（已重启）" },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  // A quote's continuation line does not, so the URL ends and the asterisks stay as text.
  assertMatches(parse(`> 第一行\n> **${url}**（已重启）`), {
    children: [
      {
        children: [
          {
            children: [
              { type: "text", value: "第一行\n**" },
              { type: "link", url, position: { end: at(2, 27, 32) } },
              { type: "text", value: "**（已重启）", position: { start: at(2, 27, 32) } },
            ],
          },
        ],
      },
    ],
  });
});

const insightRule = "─".repeat(20);
const insightFence = (body: string, wrap = "") =>
  [`${wrap}★ Insight ${insightRule}${wrap}`, body, `${wrap}${insightRule}${wrap}`].join("\n");

for (const wrap of ["", "`"]) {
  test(`groups ${JSON.stringify(wrap)} insight fences while preserving surrounding markdown`, () => {
    const markdown = [
      "Before **bold** and [reference][src].",
      "",
      insightFence("- Also [reference][src].", wrap),
      "",
      "After.",
      "",
      '[src]:\n  https://example.com\n  "Source"',
    ].join("\n");
    const processor = unified()
      .use(remarkParse)
      .use(CHAT_MARKDOWN_REMARK_PLUGINS)
      .use(remarkAssistantInsights)
      .use(remarkRehype)
      .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
    const tree = processor.runSync(processor.parse(markdown), markdown) as {
      children: Array<{ type: string; tagName?: string; properties?: unknown }>;
    };
    assert.deepEqual(
      tree.children.filter((node) => node.type === "element").map((node) => node.tagName),
      ["p", "blockquote", "p"],
    );
    assertMatches(
      tree.children.find((node) => node.type === "element" && node.tagName === "blockquote"),
      { properties: { dataAlert: "insight" } },
    );
    assert.equal(JSON.stringify(tree).match(/"href":"https:\/\/example.com"/g)?.length, 2);
    assert.ok(JSON.stringify(tree).includes('"tagName":"strong"'));
    assert.ok(!JSON.stringify(tree).includes(insightRule));
  });
}

for (const markdown of [
  ["```text", "★ Insight " + insightRule, "literal", insightRule, "```"].join("\n"),
  ["- ```text", "  ★ Insight " + insightRule, "  literal", "  " + insightRule, "  ```"].join("\n"),
  ["    ★ Insight " + insightRule, "    literal", "    " + insightRule].join("\n"),
  ["Paragraph.", "    ★ Insight " + insightRule, "    literal", "    " + insightRule].join("\n"),
  ["`example", "★ Insight " + insightRule, "literal", insightRule, "`"].join("\n"),
  insightFence("quoted")
    .split("\n")
    .map((line) => "> " + line)
    .join("\n"),
]) {
  test(`leaves literal and nested insight examples unchanged: ${JSON.stringify(markdown)}`, () => {
    const processor = unified().use(remarkParse).use(remarkAssistantInsights);
    const tree = processor.parse(markdown);
    assert.deepEqual(processor.runSync(structuredClone(tree), markdown), tree);
  });
}

test("groups streaming bodies and several insights without losing code or headings", () => {
  const markdown = [
    "## Setup",
    "",
    insightFence("```text\n" + insightRule + "\n```"),
    "",
    "## Setup",
    "",
    "★ Insight " + insightRule,
    "Still **streaming**",
  ].join("\n");
  const processor = unified().use(remarkParse).use(remarkAssistantInsights);
  const tree = processor.parse(markdown);
  processor.runSync(tree, markdown);
  assert.deepEqual(
    tree.children.map((node) => node.type),
    ["heading", "blockquote", "heading", "blockquote"],
  );
  assertMatches(tree.children[1], { children: [{ type: "code", value: insightRule }] });
  assertMatches(tree.children[3], {
    children: [
      { type: "paragraph", children: [{ type: "text", value: "Still " }, { type: "strong" }] },
    ],
  });
});

test("keeps reference definitions out of unfinished streaming code", () => {
  const markdown = `[src]: https://example.com\n\n★ Insight ${insightRule}\n\`\`\`ts\nconst value = 1`;
  const processor = unified().use(remarkParse).use(remarkAssistantInsights);
  const tree = processor.parse(markdown);
  processor.runSync(tree, markdown);
  assertMatches(
    tree.children.find((node) => node.type === "blockquote"),
    { children: [{ type: "code", value: "const value = 1" }] },
  );
});

test("preserves footnotes and original code positions across a callout", () => {
  const code = "```sh\necho hello\n```";
  const markdown = ["Before[^n].", "", insightFence(code), "", "[^n]: Footnote."].join("\n");
  const processor = unified()
    .use(remarkParse)
    .use(remarkAssistantInsights)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS);
  const tree = processor.parse(markdown);
  processor.runSync(tree, markdown);
  assertMatches(tree.children[0], {
    children: [
      { type: "text", value: "Before" },
      { type: "footnoteReference", identifier: "n" },
      { type: "text", value: "." },
    ],
  });
  assertMatches(tree.children.at(-1), { type: "footnoteDefinition", identifier: "n" });
  const note = tree.children.find((node) => node.type === "blockquote");
  const block = note?.type === "blockquote" ? note.children[0] : undefined;
  assert.equal(markdown.slice(block?.position?.start.offset, block?.position?.end.offset), code);
});

test("drops T3's in-app link schemes and unsafe links through the Markdown sanitizer", () => {
  const processor = htmlProcessor();
  const tree = processor.runSync(
    processor.parse(
      '[Open thread](t3-thread://v1/thread)\n\n<a href="javascript:alert(1)">Unsafe</a> <script>alert(1)</script>',
    ),
  );
  assertMatches(tree.children[0], {
    tagName: "p",
    children: [{ tagName: "a", properties: {}, children: [{ type: "text", value: "Open thread" }] }],
  });
  const json = JSON.stringify(tree);
  assert.ok(!json.includes("t3-thread:"));
  assert.ok(!json.includes("javascript:"));
  assert.ok(!json.includes('"tagName":"script"'));
});

test("keeps raw HTML the sanitizer allows: details, summary and inline markup", () => {
  const processor = htmlProcessor();
  type Node = { type: string; tagName?: string; children?: Node[] };
  const tags = (node: Node): string[] => [
    ...(node.tagName ? [node.tagName] : []),
    ...(node.children ?? []).flatMap(tags),
  ];
  const tree = processor.runSync(
    processor.parse(
      '<details><summary>More</summary>\n\nHidden <b>bold</b> <img src="x" onerror="alert(1)">\n\n</details>',
    ),
  ) as Node;
  assert.deepEqual(tags(tree), ["details", "summary", "p", "b", "img"]);
  assert.ok(!JSON.stringify(tree).includes("onerror"));
});

test("builds the tree rehype-raw builds for markdown without HTML", () => {
  type Node = {
    type: string;
    tagName?: string;
    value?: string;
    position?: unknown;
    data?: unknown;
    children?: Node[];
  };
  // What the round trip changes that renders the same; see `needsHtmlParser`.
  const comparable = (node: Node): Node => {
    const { position, children, data, ...rest } = node;
    const result: Node =
      node.type === "text" || node.type === "root" ? rest : { ...rest, position, data };
    if (!children) return result;
    const merged: Node[] = [];
    for (const child of children.map(comparable)) {
      const last = merged.at(-1);
      if (child.type === "text" && last?.type === "text") last.value += child.value ?? "";
      else merged.push(child);
    }
    // Blank text inside a table moves in front of it; the JSX runtime drops it in tables.
    const inTable = /^(?:table|thead|tbody|tfoot|tr)$/.test(node.tagName ?? "");
    result.children = merged.filter(
      (child, index) =>
        child.type !== "text" ||
        child.value?.trim() ||
        !(inTable || merged[index + 1]?.tagName === "table"),
    );
    return result;
  };
  const tree = (rehypePlugins: PluggableList, markdown: string) => {
    const processor = unified()
      .use(remarkParse)
      .use(CHAT_MARKDOWN_REMARK_PLUGINS)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypePlugins);
    return comparable(processor.runSync(processor.parse(markdown)) as Node);
  };
  const [first, , ...rest] = CHAT_MARKDOWN_REHYPE_PLUGINS;
  const withRaw: PluggableList = [first!, rehypeRaw, ...rest];
  for (const markdown of [
    "- [ ] open\n- [x] done\n\nNote[^1]\n\n[^1]: The note.",
    "| a | b |\n| :- | -: |\n| `c` | ![d](./d.png) |\n\n```ts title=x\nconst a = 1;\n```",
    // The HTML parser moves the footnote's link out of the label's link.
    "[note[^x]](https://example.com)\n\n[^x]: text",
    "**a** **b**\r\n> - | a |\r\n>   | - |\r\n>   | b |\r\n\n-\tx\n\n  y",
  ]) {
    assert.deepEqual(tree(CHAT_MARKDOWN_REHYPE_PLUGINS, markdown), tree(withRaw, markdown));
  }
});

test("renders GFM tables, task lists and GitHub alerts as the renderer expects them", () => {
  const processor = htmlProcessor();
  type Node = {
    type: string;
    tagName?: string;
    value?: string;
    properties?: Record<string, unknown>;
    children?: Node[];
  };
  const find = (node: Node, tagName: string): Node[] => [
    ...(node.tagName === tagName ? [node] : []),
    ...(node.children ?? []).flatMap((child) => find(child, tagName)),
  ];
  const tree = processor.runSync(
    processor.parse(
      "| a | b |\n| :- | -: |\n| 1 | 2 |\n\n- [ ] open\n- [x] done\n\n> [!WARNING]\n> careful\n\n> plain quote",
    ),
  ) as Node;
  const [table] = find(tree, "table");
  assert.deepEqual(
    find(table!, "th").map((cell) => cell.properties?.align),
    ["left", "right"],
  );
  assert.equal(find(table!, "td").length, 2);
  assert.deepEqual(
    find(tree, "input").map((input) => [input.properties?.type, input.properties?.checked]),
    // A false property is dropped, as hast-util-to-parse5 drops it.
    [
      ["checkbox", undefined],
      ["checkbox", true],
    ],
  );
  assert.deepEqual(
    find(tree, "blockquote").map((quote) => quote.properties?.dataAlert),
    ["warning", undefined],
  );
});

test("keeps local editor file links but not other schemes through the shared Markdown sanitizer", () => {
  const processor = htmlProcessor();
  const tree = processor.runSync(
    processor.parse(
      [
        "[cursor](cursor://file/Users/me/repo/file.md:3)",
        "[code](vscode://file/Users/me/repo/file.md:3:7)",
        "[insiders](vscode-insiders://file/Users/me/repo/file.md)",
        "[unknown](foo://file/Users/me/repo/file.md)",
        "[zed](zed://file/Users/me/repo/file.md)",
        "[upper](VSCODE://file/Users/me/repo/file.md:3:7)",
      ].join(" "),
    ),
  );
  type Node = { tagName?: string; properties?: { href?: string }; children?: Node[] };
  const hrefs = ((tree.children[0] as Node).children ?? [])
    .filter((node) => node.tagName === "a")
    .map((node) => node.properties?.href);
  assert.deepEqual(hrefs, [
    "cursor://file/Users/me/repo/file.md:3",
    "vscode://file/Users/me/repo/file.md:3:7",
    "vscode-insiders://file/Users/me/repo/file.md",
    undefined,
    undefined,
    "vscode://file/Users/me/repo/file.md:3:7",
  ]);
});

test("keeps backslashes that CommonMark would read as escapes in prose Windows paths", () => {
  const processor = htmlProcessor();
  type Node = { type: string; value?: string; tagName?: string; children?: Node[] };
  const text = (node: Node): string =>
    node.type === "text"
      ? (node.value ?? "")
      : node.tagName === "code"
        ? `<code>${(node.children ?? []).map(text).join("")}</code>`
        : (node.children ?? []).map(text).join("");
  const render = (markdown: string) => text(processor.runSync(processor.parse(markdown)) as Node);

  assert.equal(
    render(String.raw`Saved to C:\Users\me\.t3\_build and (C:\.scratch) and C:/work\.config.`),
    String.raw`Saved to C:\Users\me\.t3\_build and (C:\.scratch) and C:/work\.config.`,
  );
  assert.equal(render(String.raw`Escaped C:\\Users\\me`), String.raw`Escaped C:\\Users\\me`);
  assert.equal(
    render(String.raw`See C:\x and \*this\* and Note:\*that\*.`),
    String.raw`See C:\x and *this* and Note:*that*.`,
  );
  assert.equal(
    render(String.raw`${"`"}C:\me\.t3${"`"} and C:\me\.t3`),
    String.raw`<code>C:\me\.t3</code> and C:\me\.t3`,
  );
});

test("keeps an image on its own line under a label but leaves inline images inline", () => {
  const processor = htmlProcessor();
  type Node = { type: string; value?: string; tagName?: string; children?: Node[] };
  const shape = (node: Node): string =>
    node.type === "text"
      ? (node.value ?? "")
      : node.tagName === "br" || node.tagName === "img"
        ? `<${node.tagName}>`
        : (node.children ?? []).map(shape).join("");
  const render = (markdown: string) => shape(processor.runSync(processor.parse(markdown)) as Node);

  assert.equal(
    render("**Palette**\n![Palette](/tmp/palette.png)\n**Hero** (dark)\n![Hero](/tmp/hero.png)"),
    "Palette<br>\n<img><br>\nHero (dark)<br>\n<img>",
  );
  assert.equal(render("Built [![CI](/ci.svg)](/ci)\nand wrapped"), "Built <img>\nand wrapped");
  assert.equal(render("Hard-wrapped\nprose"), "Hard-wrapped\nprose");
});

test("keeps the number written on each ordered list item only when enabled", () => {
  type Node = { tagName?: string; properties?: { value?: unknown }; children?: Node[] };
  const values = (node: Node): unknown[] => [
    ...(node.tagName === "li" ? [node.properties?.value] : []),
    ...(node.children ?? []).flatMap(values),
  ];
  const renderer = (plugins: PluggableList) => {
    const processor = unified()
      .use(remarkParse)
      .use(plugins)
      .use(remarkRehype, { allowDangerousHtml: true });
    return (markdown: string) =>
      values(processor.runSync(processor.parse(markdown), markdown) as Node);
  };
  const render = renderer([
    ...CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
    remarkEnableOrderedListNumbers,
  ]);

  assert.deepEqual(render("3. first\n5. second\n6. third"), [undefined, "5", undefined]);
  assert.deepEqual(render("1. one\n1. one again"), [undefined, "1"]);
  assert.deepEqual(render("> 1. quoted\n> 4. skipped"), [undefined, "4"]);
  assert.deepEqual(render("1. outer\n   1. nested\n   7. jump\n9. back"), [
    undefined,
    undefined,
    "7",
    "9",
  ]);
  assert.deepEqual(render("1. one\n2. two\n- bullet"), [undefined, undefined, undefined]);
  assert.deepEqual(render("-       first block\n\n        3. first\n        5. second"), [
    undefined,
    undefined,
    "5",
  ]);
  assert.deepEqual(
    renderer(CHAT_MARKDOWN_REMARK_PLUGINS)(
      "3. first\n5. second\n\n-       first block\n\n        3. first\n        5. second",
    ),
    [undefined, undefined, undefined, undefined, undefined],
  );
});

test("moves a <picture>'s color-scheme sources onto its <img>, which the renderer resolves", () => {
  const processor = htmlProcessor();
  type Node = { type: string; tagName?: string; properties?: object; children?: Node[] };
  const tags = (node: Node): string[] => [
    ...(node.tagName ? [node.tagName] : []),
    ...(node.children ?? []).flatMap(tags),
  ];
  const images = (node: Node): Node[] =>
    node.tagName === "img" ? [node] : (node.children ?? []).flatMap(images);
  const tree = processor.runSync(
    processor.parse(
      [
        "<picture>",
        '  <source media="(prefers-color-scheme: dark)" srcset="docs/dark.webp 1x, docs/dark@2x.webp 2x">',
        '  <source media="(prefers-color-scheme: dark)" srcset="docs/dark-unused.webp">',
        '  <source media="(min-width: 600px)" srcset="docs/wide.webp">',
        '  <img src="docs/light.webp" alt="Studio">',
        "</picture>",
        "",
        '<picture><source media="(prefers-color-scheme: light)" srcset="javascript:alert(1)"><img src="docs/dark.webp"></picture>',
        "",
        String.raw`<picture><source media="(prefers-color-scheme: dark)" srcset="C:\shots\dark.png"><img src="C:\shots\light.png"></picture>`,
      ].join("\n"),
    ),
  ) as Node;

  assert.deepEqual(tags(tree), ["picture", "img", "p", "picture", "img", "p", "picture", "img"]);
  assert.deepEqual(
    images(tree).map((image) => image.properties),
    [
      { src: "docs/light.webp", alt: "Studio", dataDarkSrc: "docs/dark.webp" },
      { src: "docs/dark.webp" },
      { dataLocalSrc: String.raw`C:\shots\light.png`, dataDarkSrc: "file:///C:/shots/dark.png" },
    ],
  );
});

test("links complete absolute paths in prose and skips shortened ones", () => {
  const path =
    "/tmp/claude-1000/-home-user--t3-worktrees-app-t3-abc123/session/scratchpad/notes.md";
  const processor = unified().use(remarkParse).use(CHAT_MARKDOWN_REMARK_PLUGINS);
  const links = (markdown: string) => {
    const urls: string[] = [];
    const visit = (node: Root | RootContent) => {
      if (node.type === "link") urls.push(node.url);
      if ("children" in node) node.children.forEach(visit);
    };
    visit(processor.runSync(processor.parse(markdown), markdown) as Root);
    return urls;
  };
  assert.deepEqual(links(`Saved to ${path} and /tmp/other.txt.`), [path, "/tmp/other.txt"]);
  assert.deepEqual(links(`See (${path}:12).`), [`${path}:12`]);
  assert.deepEqual(links("See /tmp/report(1).txt. and /tmp/app/[id]/page.tsx."), [
    "/tmp/report(1).txt",
    "/tmp/app/[id]/page.tsx",
  ]);
  assert.deepEqual(links("(see /tmp/claude-1000/...). and /tmp/claude-1000/…."), []);
  assert.deepEqual(links("Served at /index.html; GET /api/users.json; see /tmp/x.md:3."), [
    "/tmp/x.md:3",
  ]);
  assert.deepEqual(
    links(
      '<a title="</a>" href="https://example.com">/tmp/notes.md</a> and **<a href="x">/tmp/a.md</a>**',
    ),
    [],
  );
  assert.deepEqual(
    links("Config lives in /Users/me/Library/Application Support/T3 Code/settings.json now."),
    [],
  );
  assert.deepEqual(links(`/chat/settings and https://example.com${path}`), [
    `https://example.com${path}`,
  ]);
  assert.deepEqual(links(`[notes](${path}) and \`${path}\``), [path]);
  assert.deepEqual(links(`\`\`\`\n${path}\n\`\`\``), []);
});
