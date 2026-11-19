// How a sent message's code fences are read for display (DESIGN.md 7). People type a backtick
// fence glued to the sentence around it, "봐줘 ```const a = 1;\n}``` 이거", and Claude reads the
// part between the fences as code. CommonMark opens a fence only at the start of a line and closes
// it only on a line of its own, so the same text renders as one inline code span with the line
// breaks turned into spaces, or as literal backticks next to an empty block named after the next
// word. This moves such fences onto their own lines before the markdown parse, so the bubble shows
// the block the model saw. The transcript and the copy button keep the text as sent. The composers
// read the same rules for Enter (fenceOpenAt, lib/composerText.ts): inside a block it adds a line.
//
// Rules, applied line by line:
// - A backtick run opens a block when it starts the line with no info or a language word after it
//   (CommonMark's own opener, the line is kept), or when it is glued to the code after it or ends
//   the line and a closing run comes later in the message.
// - Inside a block, the first run at least as long as the opener that is followed by a space, a tab
//   or the end of the line closes it. Code before it stays a code line; words after it start a new
//   line of prose.
// - A run paired with an equal run on the same line is an inline code span, as in CommonMark.
// - A run at the start of a line that opens nothing (no closer, words after a space) is escaped,
//   so it reads as the backticks typed instead of an empty block named after the next word.
// - Tilde fences, indented code and quoted lines are left to CommonMark: people type `~~~` as an
//   expression, and moving a fence out of a quote would end the quote.

/**
 * An info string kept on the opening line: one word such as a language name. Not a dotted word,
 * which in a paste is the first host name of a list.
 */
const LANGUAGE = /^[A-Za-z][\w#+-]*$/;

/** Backtick runs that could close a block: followed by a space, a tab or the end of a line. */
const CLOSER_CANDIDATE = /(?<!`)`{3,}(?=[ \t]|$)/gm;

const TILDE_OPENER = /^ {0,3}(~{3,})[^~]*$/;
const UP_TO_THREE_SPACES = /^ {0,3}$/;

type Block = { readonly char: "`" | "~"; readonly length: number };

/** Whether a run at least `length` long that could close a block starts at or after `from`. */
function closerLookup(text: string): (from: number, length: number) => boolean {
  const starts: number[] = [];
  const longest: number[] = [];
  for (const match of text.matchAll(CLOSER_CANDIDATE)) {
    starts.push(match.index);
    longest.push(match[0].length);
  }
  // Longest run from each candidate to the end, so one search answers any length.
  for (let index = longest.length - 2; index >= 0; index--) {
    longest[index] = Math.max(longest[index]!, longest[index + 1]!);
  }
  return (from, length) => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[middle]! < from) low = middle + 1;
      else high = middle;
    }
    return low < starts.length && longest[low]! >= length;
  };
}

/** The run that closes a backtick block of `length` in this line, or null. */
function findCloser(line: string, length: number): { index: number; run: string } | null {
  for (const match of line.matchAll(/`+/g)) {
    if (match[0].length < length) continue;
    const after = line.slice(match.index + match[0].length);
    if (after === "" || /^[ \t]/.test(after)) return { index: match.index, run: match[0] };
  }
  return null;
}

/** A glued run that opened nothing for want of a closer: ending its line, or followed by code. */
type Unopened = "end" | "code";

type ProseScan =
  | { kind: "text"; text: string; unopened: Unopened | undefined }
  | { kind: "fence"; run: string }
  | { kind: "open"; prose: string; run: string; info: string; code: string; codeAt: number };

/**
 * Reads prose (outside any block) for the run that opens a block. `at` is the line's offset in the
 * message, for the search for a closer.
 */
function scanProse(line: string, at: number, closerAfter: (from: number, length: number) => boolean): ProseScan {
  const runs = [...line.matchAll(/`+/g)];
  let text = line;
  let inserted = 0;
  let unopened: Unopened | undefined;
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]![0];
    const start = runs[index]!.index;
    const pair = runs.findIndex((other, next) => next > index && other[0].length === run.length);
    if (pair !== -1) {
      index = pair;
      continue;
    }
    if (run.length < 3) continue;
    const before = line.slice(0, start);
    const after = line.slice(start + run.length);
    const info = after.trim();
    const language = info === "" || LANGUAGE.test(info);
    const lineStart = UP_TO_THREE_SPACES.test(before);
    if (lineStart && language) return { kind: "fence", run };
    const glued = after === "" || /^\S/.test(after) || language;
    if (glued && closerAfter(at + start + run.length, run.length)) {
      const code = language ? "" : after.trimStart();
      return {
        kind: "open",
        prose: text.slice(0, start + inserted).trimEnd(),
        run,
        info: language ? info : "",
        code,
        codeAt: at + line.length - code.length,
      };
    }
    if (glued) unopened = language ? "end" : "code";
    if (lineStart) {
      text = `${text.slice(0, start + inserted)}\\${text.slice(start + inserted)}`;
      inserted += 1;
    }
  }
  return { kind: "text", text, unopened };
}

/**
 * Walks the message line by line with the rules above. Returns the text for the parse, the block
 * still open at the end, and the last glued run that opened nothing only for want of a closer.
 */
function walkFences(text: string, closerAfter: (from: number, length: number) => boolean) {
  let block: Block | null = null;
  let unopened: { kind: Unopened; line: number } | null = null;
  let lineIndex = 0;

  const fenceLine = (line: string, lineAt: number): string => {
    const lines: string[] = [];
    let rest = line;
    let at = lineAt;
    for (;;) {
      if (block?.char === "~") {
        if (new RegExp(`^ {0,3}~{${block.length},}[ \\t]*$`).test(rest)) block = null;
        lines.push(rest);
        break;
      }
      if (block) {
        const close = findCloser(rest, block.length);
        if (!close) {
          lines.push(rest);
          break;
        }
        block = null;
        const before = rest.slice(0, close.index);
        const after = rest.slice(close.index + close.run.length);
        if (UP_TO_THREE_SPACES.test(before) && after.trim() === "") {
          // A closing line as CommonMark reads it.
          lines.push(rest);
          break;
        }
        if (before.trim() !== "") lines.push(before.trimEnd());
        lines.push(close.run);
        const next = after.trimStart();
        if (next === "") break;
        at += rest.length - next.length;
        rest = next;
        continue;
      }
      if (/^(?: {4}|\t)/.test(rest) || /^ {0,3}>/.test(rest)) {
        lines.push(rest);
        break;
      }
      const tilde = TILDE_OPENER.exec(rest);
      if (tilde) {
        block = { char: "~", length: tilde[1]!.length };
        unopened = null;
        lines.push(rest);
        break;
      }
      const scan = scanProse(rest, at, closerAfter);
      if (scan.kind === "text") {
        if (scan.unopened) unopened = { kind: scan.unopened, line: lineIndex };
        lines.push(scan.text);
        break;
      }
      block = { char: "`", length: scan.run.length };
      unopened = null;
      if (scan.kind === "fence") {
        lines.push(rest);
        break;
      }
      if (scan.prose !== "") lines.push(scan.prose);
      lines.push(scan.run + scan.info);
      if (scan.code === "") break;
      rest = scan.code;
      at = scan.codeAt;
    }
    return lines.join("\n");
  };

  // Separators stay as typed; only the lines this moves gain a "\n".
  const parts = text.split(/(\r\n|\r|\n)/);
  let out = "";
  let offset = 0;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]!;
    const separator = parts[index + 1] ?? "";
    lineIndex = index / 2;
    out += fenceLine(line, offset) + separator;
    offset += line.length + separator.length;
  }
  // Both are set inside fenceLine, which the checker does not follow.
  return {
    out,
    block: block as Block | null,
    unopened: unopened as { kind: Unopened; line: number } | null,
    lastLine: lineIndex,
  };
}

/** The message with each glued backtick fence on a line of its own, for the markdown parse. */
export function userMessageFenceText(text: string): string {
  if (!text.includes("```")) return text;
  return walkFences(text, closerLookup(text)).out;
}

/**
 * Whether the caret of a message being typed sits inside a backtick code block, by the same rules
 * read over the text before the caret. The closer is not typed yet, so the last glued run that
 * opened nothing counts as open when it ends its line ("봐줘 ```", "봐줘 ```ts"), or when code
 * follows it and the caret has moved past that line: on its own line, "```를 치면" is a mention.
 */
export function fenceOpenAt(text: string, caret: number): boolean {
  const before = text.slice(0, caret);
  if (!before.includes("```")) return false;
  const walk = walkFences(before, closerLookup(before));
  if (walk.block) return walk.block.char === "`";
  const pending = walk.unopened;
  return pending !== null && (pending.kind === "end" || pending.line < walk.lastLine);
}
