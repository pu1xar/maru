import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineSpans, listMarker, terminalMarkdownBlocks } from "./terminalMarkdown.logic.ts";

const text = (spans: ReadonlyArray<{ t: string }>) => spans.map((s) => s.t).join("");

test("a heading is bold without its marks, and h1 is also italic and underlined", () => {
  const [h1, h2] = terminalMarkdownBlocks("# Title\n\n## Part", 80);
  assert.equal(h1?.k, "heading");
  if (h1?.k !== "heading" || h2?.k !== "heading") return assert.fail("not headings");
  assert.equal(text(h1.spans), "Title");
  assert.deepEqual(h1.spans[0], { t: "Title", bold: true, italic: true, underline: true });
  assert.deepEqual(h2.spans[0], { t: "Part", bold: true });
});

test("bold and inline code lose their marks, code takes the accent role", () => {
  const [p] = terminalMarkdownBlocks("a **b** and `c` d", 80);
  if (p?.k !== "p") return assert.fail("not a paragraph");
  assert.equal(text(p.spans), "a b and c d");
  assert.equal(p.spans.find((s) => s.t === "b")?.bold, true);
  assert.equal(p.spans.find((s) => s.t === "c")?.code, true);
});

test("a single newline in a paragraph stays a line break", () => {
  const [p] = terminalMarkdownBlocks("first\nsecond", 80);
  if (p?.k !== "p") return assert.fail("not a paragraph");
  assert.equal(text(p.spans), "first\nsecond");
});

test("a block right under the previous one is tight, a block after a blank line is not", () => {
  const blocks = terminalMarkdownBlocks("Sources:\n- a\n- b\n\nnext\n# H\nafter heading", 80);
  assert.deepEqual(
    blocks.map((b) => [b.k, b.tight]),
    [
      ["p", false],
      ["list", true],
      ["p", false],
      ["heading", true],
      ["p", true],
    ],
  );
});

test("lists keep their markers as text, ordered ones count from their start", () => {
  const [ul, ol] = terminalMarkdownBlocks("- a\n- b\n\n3. x\n4. y", 80);
  if (ul?.k !== "list" || ol?.k !== "list") return assert.fail("not lists");
  assert.equal(ul.items.length, 2);
  assert.equal(listMarker(ul.ordered, ul.start, 0), "- ");
  assert.equal(ol.start, 3);
  assert.equal(listMarker(ol.ordered, ol.start, 1), "4. ");
});

test("a task item starts with its box", () => {
  const [list] = terminalMarkdownBlocks("- [x] done\n- [ ] todo", 80);
  if (list?.k !== "list") return assert.fail("not a list");
  const first = list.items[0]?.[0];
  const second = list.items[1]?.[0];
  assert.equal(first?.k === "p" ? text(first.spans) : "", "[x] done");
  assert.equal(second?.k === "p" ? text(second.spans) : "", "[ ] todo");
});

test("a fenced block is its code without the fences", () => {
  const [pre] = terminalMarkdownBlocks("```ts\nconst a = 1;\nconst b = 2;\n```", 80);
  assert.deepEqual(pre, { k: "pre", text: "const a = 1;\nconst b = 2;", tight: false });
});

test("a link is its text and then its address, unless the text is the address", () => {
  const [p] = terminalMarkdownBlocks("see [the docs](https://example.com/docs) and https://example.com/x here", 80);
  if (p?.k !== "p") return assert.fail("not a paragraph");
  assert.equal(text(p.spans), "see the docs (https://example.com/docs) and https://example.com/x here");
  assert.equal(p.spans.find((s) => s.t === "the docs")?.link, "https://example.com/docs");
});

test("a table is laid out in box lines for the terminal's width", () => {
  const [table] = terminalMarkdownBlocks("| a | bb |\n|---|---|\n| 1 | 2 |", 80);
  if (table?.k !== "table") return assert.fail("not a table");
  assert.equal(table.layout.kind, "box");
  if (table.layout.kind !== "box") return;
  assert.equal(table.layout.lines[0]?.[0], "┌");
  assert.equal(table.layout.lines.at(-1)?.[0], "└");
});

test("a quote holds blocks of its own", () => {
  const [quote] = terminalMarkdownBlocks("> one\n>\n> two", 80);
  if (quote?.k !== "quote") return assert.fail("not a quote");
  assert.equal(quote.blocks.length, 2);
});

test("inline spans join neighbors with the same style", () => {
  const spans = inlineSpans([
    { type: "text", raw: "a", text: "a" },
    { type: "text", raw: "b", text: "b" },
  ] as never);
  assert.deepEqual(spans, [{ t: "ab" }]);
});
