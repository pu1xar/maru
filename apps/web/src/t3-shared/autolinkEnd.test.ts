import assert from "node:assert/strict";
import { test } from "node:test";
import type { Root, RootContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { autolinkEndIndex } from "./autolinkEnd.ts";
import { CHAT_MARKDOWN_REMARK_PLUGINS, CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS } from "./markdownPipeline.ts";

/** The address part of `text` (up to where the URL ends). */
const addressOf = (text: string) => {
  const end = autolinkEndIndex(text);
  return end < 0 ? text : text.slice(0, end);
};

test("autolinkEndIndex ends a host at what a host cannot hold", () => {
  const cases: Array<[string, string]> = [
    ["www.example.com**(일부만", "www.example.com**"],
    ["www.example.com(일부만", "www.example.com"],
    ["www.example.com은", "www.example.com"],
    ["https://example.com에서", "https://example.com"],
    ["http://localhost:3000에서", "http://localhost:3000"],
    ["http://localhost:3000)", "http://localhost:3000"],
    ["https://example.com]", "https://example.com"],
    ["www.a.com_b", "www.a.com_"],
    ["www.예제.com", "www.예제.com"],
    ["https://한글.kr", "https://한글.kr"],
    ["https://한글.kr은", "https://한글.kr"],
    ["https://example.com/wiki/서울", "https://example.com/wiki/서울"],
    ["https://example.com/a?b=1", "https://example.com/a?b=1"],
    ["https://example.com/a_(b)", "https://example.com/a_(b)"],
    ["https://example.com/a**는", "https://example.com/a**"],
    ["https://example.com/a__는", "https://example.com/a__"],
    ["https://example.com/a__init__.py", "https://example.com/a__init__.py"],
    ["https://example.com/a**", "https://example.com/a**"],
    ["http://[::1]:3000/x", "http://[::1]:3000/x"],
    ["https://example.com/x)와", "https://example.com/x"],
    ["https://example.com/x)", "https://example.com/x"],
    ["https://example.com/a]는", "https://example.com/a"],
    ["https://en.wikipedia.org/wiki/Foo_(bar)와", "https://en.wikipedia.org/wiki/Foo_(bar)"],
    ["https://en.wikipedia.org/wiki/Foo_(bar)", "https://en.wikipedia.org/wiki/Foo_(bar)"],
    ["https://example.com/a?q=(1)", "https://example.com/a?q=(1)"],
  ];
  for (const [text, address] of cases) assert.equal(addressOf(text), address, text);
});

for (const [name, plugins] of [
  ["default", CHAT_MARKDOWN_REMARK_PLUGINS],
  ["with breaks", CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS],
] as const) {
  test(`ends bare URLs at Korean text, emphasis marks and parentheses (${name})`, () => {
    const processor = unified().use(remarkParse).use(plugins);
    const shape = (node: Root | RootContent): string => {
      if (node.type === "text") return node.value.replaceAll("*", "\\*");
      if (node.type === "inlineCode") return `\`${node.value}\``;
      const children = "children" in node ? node.children.map(shape).join("") : "";
      if (node.type === "link") return `[${children}](${node.url})`;
      if (node.type === "emphasis") return `*${children}*`;
      if (node.type === "strong") return `**${children}**`;
      return children;
    };
    const cases: Array<[string, string]> = [
      [
        "**www.example.com**(일부만 보고 중단)이",
        "**[www.example.com](http://www.example.com)**(일부만 보고 중단)이",
      ],
      ["www.example.com(일부만)", "[www.example.com](http://www.example.com)(일부만)"],
      ["www.example.com은 좋다", "[www.example.com](http://www.example.com)은 좋다"],
      ["**https://x.com**는", "**[https://x.com](https://x.com)**는"],
      ["~~https://x.com~~는", "~~[https://x.com](https://x.com)~~는"],
      ["*https://x.com*는", "*[https://x.com](https://x.com)*는"],
      ["**https://x.com/a/b**는", "**[https://x.com/a/b](https://x.com/a/b)**는"],
      ["www.example.com/path?a=1", "[www.example.com/path?a=1](http://www.example.com/path?a=1)"],
      [
        "https://ko.wikipedia.org/wiki/서울",
        "[https://ko.wikipedia.org/wiki/서울](https://ko.wikipedia.org/wiki/서울)",
      ],
      [
        "https://ko.wikipedia.org/wiki/서울은",
        "[https://ko.wikipedia.org/wiki/서울은](https://ko.wikipedia.org/wiki/서울은)",
      ],
      ["https://example.com/a_(b)", "[https://example.com/a_(b)](https://example.com/a_(b))"],
      ["예시(https://example.com/x)와", "예시([https://example.com/x](https://example.com/x))와"],
      ["(see https://x.com/a)", "(see [https://x.com/a](https://x.com/a))"],
      ["see https://example.com.", "see [https://example.com](https://example.com)."],
      ["https://한글.kr 입니다", "[https://한글.kr](https://한글.kr) 입니다"],
      [
        "http://localhost:3000에서 열림",
        "[http://localhost:3000](http://localhost:3000)에서 열림",
      ],
      [
        "**www.a.com**(x) 그리고 **www.b.com**(y)",
        "**[www.a.com](http://www.a.com)**(x) 그리고 **[www.b.com](http://www.b.com)**(y)",
      ],
      ["- 항목 **www.a.com**(x)", "항목 **[www.a.com](http://www.a.com)**(x)"],
    ];
    for (const [markdown, expected] of cases) {
      assert.equal(shape(processor.runSync(processor.parse(markdown), markdown) as Root), expected, markdown);
    }
  });
}
