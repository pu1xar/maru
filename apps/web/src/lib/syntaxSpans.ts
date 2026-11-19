// Highlighted code as spans over the text, for files too large to hold one token object per piece.
// The highlighter (`syntaxHighlight.ts`) reads the whole file once, so a block comment or template
// string that crosses lines is colored from the grammar's own state. That result travels as two
// typed arrays (start offsets and role numbers), and a line's tokens are cut out of the text on
// demand, so memory stays proportional to the number of tokens and only visible lines pay for
// slicing.
import { SYNTAX_ROLES, type SyntaxRole, type SyntaxToken } from "./syntaxTokens.ts";

/** Role number of a span drawn in the surrounding code color. */
export const PLAIN_ROLE = 255;

/** Span `i` covers `[starts[i], starts[i + 1])`, the last one up to the end of the text. */
export interface SyntaxSpans {
  readonly starts: Uint32Array;
  readonly roles: Uint8Array;
}

const ROLE_NUMBER = new Map<SyntaxRole, number>(SYNTAX_ROLES.map((role, index) => [role, index]));

/** Packs flat tokens (their text joins to the code) into spans. */
export function encodeSpans(tokens: ReadonlyArray<SyntaxToken>): SyntaxSpans {
  const starts = new Uint32Array(tokens.length);
  const roles = new Uint8Array(tokens.length);
  let offset = 0;
  tokens.forEach((token, index) => {
    starts[index] = offset;
    roles[index] = token.role === null ? PLAIN_ROLE : ROLE_NUMBER.get(token.role)!;
    offset += token.text.length;
  });
  return { starts, roles };
}

/** The start offset of every line in `text` (lines split at `\n`), plus `text.length + 1` as the end sentinel. */
export function lineStartOffsets(text: string): Uint32Array {
  let count = 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count++;
  const starts = new Uint32Array(count + 1);
  let line = 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) starts[line++] = at + 1;
  starts[count] = text.length + 1;
  return starts;
}

/** The index of the span that holds `offset`. */
function spanAt(starts: Uint32Array, offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The tokens of `text.slice(from, to)`: the spans cut at the range's edges. */
export function tokensInRange(
  text: string,
  spans: SyntaxSpans,
  from: number,
  to: number,
): SyntaxToken[] {
  const out: SyntaxToken[] = [];
  if (from >= to || spans.starts.length === 0) return out;
  for (let i = spanAt(spans.starts, from); i < spans.starts.length; i++) {
    const start = Math.max(from, spans.starts[i]!);
    if (start >= to) break;
    const end = Math.min(to, i + 1 < spans.starts.length ? spans.starts[i + 1]! : to);
    if (end <= start) continue;
    const role = spans.roles[i]!;
    out.push({
      text: text.slice(start, end),
      role: role === PLAIN_ROLE ? null : SYNTAX_ROLES[role]!,
    });
  }
  return out;
}

/** The tokens of line `index`, given `lineStartOffsets(text)` (the line's break is not included). */
export function lineTokens(
  text: string,
  spans: SyntaxSpans,
  lineStarts: Uint32Array,
  index: number,
): SyntaxToken[] {
  const from = lineStarts[index]!;
  // The next line starts one past this line's break (the end sentinel is length + 1).
  const to = lineStarts[index + 1]! - 1;
  return tokensInRange(text, spans, from, to);
}
