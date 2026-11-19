// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: apps/web/src/components/chat/markdownTextDirection.ts and packages/shared/src/textDirection.ts.
// Local change: textDirection, which T3 keeps in its shared package, sits next to the plugin.
export type TextDirection = "ltr" | "rtl";

// Hebrew through Arabic Extended-A, their presentation forms, and the
// supplementary right-to-left blocks.
const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const LETTER = /\p{L}/u;
const SENTENCE_END = /(?<=[.!?؟])(?<!\b(?:e\.g|i\.e)\.)\s+|\n+/i;

function majority(
  units: Iterable<TextDirection | undefined>,
  tieDirection?: () => TextDirection | undefined,
): TextDirection | undefined {
  let rtl = 0;
  let ltr = 0;
  let first: TextDirection | undefined;
  for (const direction of units) {
    if (!direction) continue;
    first ??= direction;
    if (direction === "rtl") rtl += 1;
    else ltr += 1;
  }
  if (rtl === ltr) return tieDirection ? tieDirection() : first;
  return rtl > ltr ? "rtl" : "ltr";
}

function wordDirection(word: string): TextDirection | undefined {
  const letter = LETTER.exec(word)?.[0];
  if (!letter) return undefined;
  return RTL_LETTER.test(letter) ? "rtl" : "ltr";
}

/**
 * `dir="auto"` misreads Arabic prose that opens with an English term.
 * Each sentence follows its main language by word count, and the text follows most of its
 * sentences, so one long English sentence cannot outvote the Arabic ones around it.
 * Sentence ties use the whole-text word majority, then the first word.
 */
export function textDirection(text: string): TextDirection | undefined {
  if (!RTL_LETTER.test(text)) return LETTER.test(text) ? "ltr" : undefined;
  return majority(
    text.split(SENTENCE_END).map((sentence) => majority(sentence.split(/\s+/).map(wordDirection))),
    () => majority(text.split(/\s+/).map(wordDirection)),
  );
}

const MARKDOWN_CODE_OR_URL =
  /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`{1,2})(?!`)[\s\S]*?(?<!`)\2(?!`)|https?:\/\/\S+/g;

export function markdownProseDirection(markdown: string): TextDirection | undefined {
  return textDirection(markdown.replace(MARKDOWN_CODE_OR_URL, " "));
}

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

// Raw HTML such as `<li>a</li><li>b</li>` has no whitespace between its
// blocks, so they add their own to keep the words apart.
const BLOCK_TAGS = new Set([
  "blockquote",
  "br",
  "details",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "summary",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

function proseText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "code") return " ";
  const text = (node.children ?? []).map(proseText).join("");
  return node.tagName && BLOCK_TAGS.has(node.tagName) ? ` ${text} ` : text;
}

function isolateInlineCode(node: HastNode): void {
  if (node.tagName === "pre") return;
  if (node.tagName === "code") {
    node.properties = { ...node.properties, dir: "ltr" };
    return;
  }
  node.children?.forEach(isolateInlineCode);
}

/**
 * Gives each top-level block the direction of its own words, so an Arabic or
 * Hebrew reply reads right to left beside English ones. Lines inside a list or
 * quote follow it, keeping markers and rules on one side. Inline code is left
 * out of the count and isolated left to right, so its punctuation stays put.
 */
export function rehypeTextDirection() {
  return (tree: HastNode) => {
    for (const block of tree.children ?? []) {
      if (block.type !== "element" || block.tagName === "pre") continue;
      const dir = textDirection(proseText(block));
      if (dir) block.properties = { ...block.properties, dir };
    }
    isolateInlineCode(tree);
  };
}
