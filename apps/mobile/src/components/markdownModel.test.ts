import { test } from "node:test";
import assert from "node:assert/strict";
import { Lexer, type Token, type Tokens } from "marked";
import { CJK_EMPHASIS_CASES } from "../../../web/src/t3-shared/cjkEmphasisCases.ts";
import { lexMarkdown, blockGaps, codeLanguage, codeMeta, inlineCodeBox, inlineCodeFitsBox, listGutter, listItemGap, listMarker, lowerAlpha, lowerRoman, markdownLeafStarts, tableColumnWidths, tildesAsText, withAlpha } from "./markdownModel.ts";

test("inline code box takes the web's border, radius and padding at the text size", () => {
  const b = inlineCodeBox(15);
  assert.equal(b.radius, 4);
  assert.equal(b.border, 1);
  assert.equal(b.paddingHorizontal, 5);
  assert.equal(b.paddingVertical, 2);
  assert.ok(b.lineHeight + 2 * b.paddingVertical + 2 * b.border <= 24, "the box stays inside the 15pt line");
  assert.ok(b.drop > 0);
});

test("a short span is a box, a long or multi-line one stays tinted text", () => {
  assert.equal(inlineCodeFitsBox("npm test", 15, 320), true);
  assert.equal(inlineCodeFitsBox("apps/mobile/src/components/Markdown.tsx", 15, 320), false);
  assert.equal(inlineCodeFitsBox("a\nb", 15, 320), false);
  assert.equal(inlineCodeFitsBox("한글한글한글한글한글한글한글한글한글한글", 15, 320), false);
});

/** What the inline renderer draws as plain text for a paragraph: text tokens joined, nested ones included. */
function plain(tokens: Token[]): string {
  return tokens
    .map((t) => {
      const n = t as Token & { tokens?: Token[]; text?: string };
      if (n.type === "del") throw new Error("a del token survived");
      if (n.tokens) return plain(n.tokens);
      return n.text ?? n.raw;
    })
    .join("");
}

function paragraphOf(src: string): Token[] {
  const [p] = tildesAsText(Lexer.lex(src, { gfm: true }));
  assert.equal(p?.type, "paragraph");
  return (p as Tokens.Paragraph).tokens;
}

test("marked itself reads single and double tildes as del (the reason for tildesAsText)", () => {
  const raw = (src: string) => ((Lexer.lex(src, { gfm: true })[0] as Tokens.Paragraph).tokens).some((t) => t.type === "del");
  assert.equal(raw("~a~"), true);
  assert.equal(raw("~~a~~"), true);
  assert.equal(raw("a~b c~d"), true);
});

test("tilde pairs stay as typed text, no del token", () => {
  assert.equal(plain(paragraphOf("~a~")), "~a~");
  assert.equal(plain(paragraphOf("~~a~~")), "~~a~~");
  assert.equal(plain(paragraphOf("a~b c~d")), "a~b c~d");
  assert.equal(plain(paragraphOf("5/1~5/3, 6/1~6/3")), "5/1~5/3, 6/1~6/3");
  assert.equal(plain(paragraphOf("~/a and (~/b)")), "~/a and (~/b)");
});

test("content inside tildes keeps its inline formatting", () => {
  const tokens = paragraphOf("~~**bold**~~");
  assert.deepEqual(tokens.map((t) => t.type), ["text", "strong", "text"]);
  assert.equal(plain(tokens), "~~bold~~");
});

test("del inside headings, list items, quotes and table cells is converted too", () => {
  const src = "# h ~a~\n\n- item ~~b~~\n\n> quote ~c~\n\n| x | y |\n|---|---|\n| ~d~ | e |\n";
  const out = tildesAsText(Lexer.lex(src, { gfm: true }));
  const json = JSON.stringify(out);
  assert.equal(json.includes('"type":"del"'), false);
  const table = out.find((t) => t.type === "table") as Tokens.Table;
  assert.equal(plain(table.rows[0]![0]!.tokens), "~d~");
  const list = out.find((t) => t.type === "list") as Tokens.List;
  assert.equal(plain((list.items[0]!.tokens[0] as Tokens.Text).tokens ?? []), "item ~~b~~");
});

test("tildesAsText leaves the input tokens unchanged", () => {
  const lexed = Lexer.lex("~a~", { gfm: true });
  const before = JSON.stringify(lexed);
  tildesAsText(lexed);
  assert.equal(JSON.stringify(lexed), before);
});

test("blockGaps collapses margins: heading 20 above and 8 below, others 10", () => {
  assert.deepEqual(blockGaps([]), []);
  assert.deepEqual(blockGaps(["paragraph"]), [0]);
  assert.deepEqual(blockGaps(["paragraph", "paragraph"]), [0, 10]);
  assert.deepEqual(blockGaps(["paragraph", "heading", "paragraph"]), [0, 20, 10]);
  assert.deepEqual(blockGaps(["heading", "heading"]), [0, 20]);
});

test("codeLanguage takes the first word of the info string", () => {
  assert.equal(codeLanguage("ts"), "ts");
  assert.equal(codeLanguage("ts title=a.ts"), "ts");
  assert.equal(codeLanguage("  python  "), "python");
  assert.equal(codeLanguage(""), "text");
  assert.equal(codeLanguage(undefined), "text");
});

test("withAlpha reads the theme's hex and rgba forms", () => {
  assert.equal(withAlpha("#18181b", 0.35), "rgba(24, 24, 27, 0.35)");
  assert.equal(withAlpha("#fff", 0.5), "rgba(255, 255, 255, 0.5)");
  assert.equal(withAlpha("#ffffff80", 0.5), "rgba(255, 255, 255, 0.251)");
  assert.equal(withAlpha("rgba(255, 255, 255, 0.08)", 0.6), "rgba(255, 255, 255, 0.048)");
  assert.equal(withAlpha("rgb(1, 2, 3)", 0.5), "rgba(1, 2, 3, 0.5)");
  assert.equal(withAlpha("red", 0.5), "red");
});

test("a find numbers the occurrences along the leaves a message draws, in drawing order", () => {
  const text = "foo **bold foo** and `code foo`\n\n- one foo\n- two\n\n> quoted foo\n\n```\nfenced foo foo\n```\n\n| h foo | x |\n|---|---|\n| foo | y |";
  const tokens = tildesAsText(Lexer.lex(text, { gfm: true }));
  const { starts, total } = markdownLeafStarts(tokens, "FOO");
  // paragraph 3 (plain, bold, code span), list 1, quote 1, fence 2, table 2
  assert.equal(total, 9);
  const order = [...starts.values()];
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the starts grow with the drawing order");
  assert.equal(order[0], 0);
});

test("a find counts a leaf as drawn: entities decoded, a code span as typed", () => {
  const tokens = Lexer.lex("a &amp; b `a&b`", { gfm: true });
  assert.equal(markdownLeafStarts(tokens, "& ").total, 1, "the entity is read as the character it draws");
  assert.equal(markdownLeafStarts(tokens, " a").total, 0, "a code span has no padding spaces of its own");
  assert.equal(markdownLeafStarts(tokens, "a&b").total, 1, "the code reads as typed");
  assert.equal(markdownLeafStarts(tokens, "   ").total, 0, "whitespace only is not a query");
});

test("a find over a message without the query draws no paint", () => {
  const { total } = markdownLeafStarts(Lexer.lex("nothing here", { gfm: true }), "zzz");
  assert.equal(total, 0);
});

test("a bullet list takes disc, circle, square by its depth among bullet lists", () => {
  const at = (ul: number, ol = 0) => listMarker({ ordered: false, number: 1, ancestors: { ul, ol } });
  assert.deepEqual([at(0), at(1), at(2), at(5)], ["•", "◦", "▪", "▪"]);
  // Ordered ancestors do not change a bullet (css ul ul).
  assert.equal(at(0, 2), "•");
});

test("an ordered list takes decimal, lower-alpha, lower-roman by its depth among ordered lists, and the bubble keeps decimal", () => {
  const at = (ol: number, number: number, decimalOnly = false) => listMarker({ ordered: true, number, ancestors: { ul: 3, ol }, decimalOnly });
  assert.deepEqual([at(0, 3), at(1, 3), at(2, 4)], ["3.", "c.", "iv."]);
  assert.equal(at(2, 4, true), "4.");
  assert.equal(lowerAlpha(26), "z");
  assert.equal(lowerAlpha(27), "aa");
  assert.equal(lowerAlpha(28), "ab");
  assert.equal(lowerRoman(1994), "mcmxciv");
  assert.equal(lowerRoman(4000), "4000");
});

test("the marker column is 20 wide, wider for multi-digit numbers, and items part by 4 or 10", () => {
  assert.equal(listGutter(1, true), 20);
  assert.equal(listGutter(2, false), 20);
  assert.equal(listGutter(2, true), 33);
  assert.equal(listItemGap("text", "text"), 4);
  assert.equal(listItemGap("list", "text"), 10);
  assert.equal(listItemGap("text", "paragraph"), 10);
  assert.equal(listItemGap(undefined, undefined), 4);
});

test("a fence's info string after the language is its meta", () => {
  assert.equal(codeMeta("ts title=a.ts"), "title=a.ts");
  assert.equal(codeMeta("ts"), undefined);
  assert.equal(codeMeta(undefined), undefined);
});

/** A paragraph's inline tokens as `[label](href)` links, `**strong**` and plain text. */
function shapeOf(tokens: Token[]): string {
  return tokens
    .map((t) => {
      const n = t as Token & { tokens?: Token[]; text?: string; href?: string };
      const inner = n.tokens ? shapeOf(n.tokens) : (n.text ?? n.raw).replaceAll("*", "\\*");
      if (n.type === "link") return `[${inner}](${n.href})`;
      if (n.type === "strong") return `**${inner}**`;
      if (n.type === "em") return `*${inner}*`;
      return inner;
    })
    .join("");
}

test("a bare URL ends where the web ends it: at Korean text, emphasis marks and parentheses", () => {
  const cases: Array<[string, string]> = [
    ["**www.example.com**(일부만 보고 중단)이", "**[www.example.com](http://www.example.com)**(일부만 보고 중단)이"],
    ["www.example.com(일부만)", "[www.example.com](http://www.example.com)(일부만)"],
    ["www.example.com은 좋다", "[www.example.com](http://www.example.com)은 좋다"],
    ["**https://x.com**는", "**[https://x.com](https://x.com)**는"],
    ["*https://x.com*는", "*[https://x.com](https://x.com)*는"],
    ["www.example.com/path?a=1", "[www.example.com/path?a=1](http://www.example.com/path?a=1)"],
    ["https://ko.wikipedia.org/wiki/서울", "[https://ko.wikipedia.org/wiki/서울](https://ko.wikipedia.org/wiki/서울)"],
    ["https://example.com/a_(b)", "[https://example.com/a_(b)](https://example.com/a_(b))"],
    ["예시(https://example.com/x)와", "예시([https://example.com/x](https://example.com/x))와"],
    ["see https://example.com.", "see [https://example.com](https://example.com)."],
    ["http://localhost:3000에서 열림", "[http://localhost:3000](http://localhost:3000)에서 열림"],
    ["https://example.com/a**는", "[https://example.com/a](https://example.com/a)\\*\\*는"],
    ["[라벨](https://example.com/a은)", "[라벨](https://example.com/a은)"],
    ["<https://example.com/a은>", "[https://example.com/a은](https://example.com/a은)"],
  ];
  for (const [src, expected] of cases) {
    const [p] = lexMarkdown(src);
    assert.equal(p?.type, "paragraph", src);
    assert.equal(shapeOf((p as Tokens.Paragraph).tokens), expected, src);
  }
});

test("autolinks in lists and table cells end the same way", () => {
  const [list] = lexMarkdown("- www.a.com은 좋다");
  const text = (list as Tokens.List).items[0]!.tokens[0] as Tokens.Text;
  assert.equal(shapeOf(text.tokens ?? []), "[www.a.com](http://www.a.com)은 좋다");
  const table = lexMarkdown("| a |\n| - |\n| www.a.com은 |").find((t) => t.type === "table") as Tokens.Table;
  assert.equal(shapeOf(table.rows[0]![0]!.tokens), "[www.a.com](http://www.a.com)은");
});

test("emphasis next to CJK text and the cases the web test runs give the same shape", () => {
  for (const [src, expected] of CJK_EMPHASIS_CASES) {
    const [p] = lexMarkdown(src);
    assert.equal(p?.type, "paragraph", src);
    assert.equal(shapeOf((p as Tokens.Paragraph).tokens), expected, src);
  }
});

test("tildes stay text and lone tildes are not a strike next to CJK text", () => {
  for (const src of ["기간 5/1~5/3, 6/1~6/3", "~~삭제~~는", "~/a 와 ~/b"]) {
    const [p] = tildesAsText(lexMarkdown(src));
    assert.equal(plain((p as Tokens.Paragraph).tokens), src);
  }
});

// ---- table columns ----

const tableOf = (src: string): Tokens.Table => lexMarkdown(src).find((t) => t.type === "table") as Tokens.Table;
const total = (w: number[]) => w.reduce((a, b) => a + b, 0);

test("table tokens match marked's own lexer (header, rows, align, cell tokens)", () => {
  const src = "| 이름 | 값 | 설명 |\n|:--|--:|:-:|\n| **a** | `x` | [l](http://a.b) |\n| short |\n| a | b | c | d |\n";
  const ours = tableOf(src);
  const base = new Lexer({ gfm: true }).lex(src).find((t) => t.type === "table") as Tokens.Table;
  assert.deepEqual(ours.align, base.align);
  assert.deepEqual(ours.header.map((c) => c.text), base.header.map((c) => c.text));
  assert.deepEqual(ours.rows.map((r) => r.map((c) => c.text)), base.rows.map((r) => r.map((c) => c.text)));
  assert.deepEqual(ours.rows.map((r) => r.map((c) => c.tokens.map((t) => t.type))), base.rows.map((r) => r.map((c) => c.tokens.map((t) => t.type))));
});

test("marked fills short rows and cuts long ones to the header's column count", () => {
  const t = tableOf("| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |\n");
  assert.deepEqual(t.rows.map((r) => r.length), [3, 3]);
  assert.equal(tableColumnWidths(t, 14, 320).length, 3);
});

test("a table narrower than the lane fills it, shared in proportion to the content", () => {
  const w = tableColumnWidths(tableOf("| a | bbbbbbbbbb |\n|---|---|\n| 1 | 2 |\n"), 14, 320);
  assert.ok(Math.abs(total(w) - 320) < 0.01);
  assert.ok(w[1]! > w[0]!, "the longer column is wider");
});

test("a table wider than the lane keeps its minimums and scrolls", () => {
  const cols = 8;
  const head = `| ${Array.from({ length: cols }, (_, i) => `column${i}`).join(" | ")} |\n|${"---|".repeat(cols)}\n`;
  const body = `| ${Array.from({ length: cols }, () => "alpha beta gamma").join(" | ")} |\n`;
  const w = tableColumnWidths(tableOf(head + body), 14, 300);
  assert.ok(total(w) > 300);
  assert.ok(w.every((x) => x >= 6 * 14 * 0.6), "no column is narrower than its longest word");
});

test("between minimum and maximum the long column gets the room, the short one keeps its content", () => {
  const long = "word ".repeat(30).trim();
  const w = tableColumnWidths(tableOf(`| id | text |\n|---|---|\n| 1 | ${long} |\n`), 14, 300);
  assert.ok(Math.abs(total(w) - 300) < 0.01);
  assert.ok(w[1]! > 3 * w[0]!);
  assert.ok(w[0]! < 60, "a two-character id column is not stretched to half the lane");
});

test("a column is capped at 24rem however long the cell", () => {
  const w = tableColumnWidths(tableOf(`| a | b |\n|---|---|\n| x | ${"y".repeat(200)} |\n`), 14, 2000);
  assert.ok(total(w) >= 2000 - 0.01);
  const small = tableColumnWidths(tableOf(`| a | b |\n|---|---|\n| x | ${"y".repeat(200)} |\n`), 14, 10);
  assert.equal(small[1], 384);
});

test("Korean cells may break anywhere, so a long Korean cell has a narrow minimum", () => {
  const korean = "한글로 길게 쓴 설명이 칸 안에서 줄바꿈된다 ".repeat(6).trim();
  const w = tableColumnWidths(tableOf(`| 이름 | 설명 |\n|---|---|\n| 가 | ${korean} |\n`), 14, 280);
  assert.ok(Math.abs(total(w) - 280) < 0.01, "fits the lane without scrolling");
  assert.ok(w[1]! > w[0]!);
});

test("a code span counts at monospace width plus its box", () => {
  const plain = tableColumnWidths(tableOf("| a | b |\n|---|---|\n| x | abcdefgh |\n"), 14, 5000);
  const code = tableColumnWidths(tableOf("| a | b |\n|---|---|\n| x | `abcdefgh` |\n"), 14, 5000);
  assert.ok(code[1]! > 0 && plain[1]! > 0);
  assert.ok(code[1]! * (5000 / total(code)) >= 0 && total(code) > 0);
  // Compare unscaled: a lane too narrow to fill returns the minimums.
  const a = tableColumnWidths(tableOf("| a | b |\n|---|---|\n| x | abcdefgh |\n"), 14, 1);
  const b = tableColumnWidths(tableOf("| a | b |\n|---|---|\n| x | `abcdefgh` |\n"), 14, 1);
  assert.ok(b[1]! > a[1]!);
});

test("empty cells and an all-empty table give finite widths", () => {
  const w = tableColumnWidths(tableOf("| a | b |\n|---|---|\n|  |  |\n"), 14, 300);
  assert.ok(w.every(Number.isFinite));
  const e = tableColumnWidths(tableOf("|  |\n|---|\n|  |\n"), 14, 300);
  assert.ok(e.every(Number.isFinite) && e.length === 1);
});
