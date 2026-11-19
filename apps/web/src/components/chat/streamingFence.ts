// A streamed answer can stop in the middle of a fence: "   ``" before the third backtick of a
// closing fence arrives. CommonMark reads that as a line of code (or as backticks in a sentence),
// so the block grew a line of backticks for one update and lost it on the next. While the answer
// streams, a last line that holds only a fence that is still arriving waits for the next update.
const PARTIAL_FENCE_LINE = /(?:^|\n)[ \t>]*(?:`{1,2}|~{1,2})$/;

/** The streamed text without a last line that is a fence still arriving. */
export function withoutPartialFenceLine(text: string): string {
  const match = PARTIAL_FENCE_LINE.exec(text);
  if (!match) return text;
  return text.slice(0, match.index + (match[0].startsWith("\n") ? 1 : 0));
}
