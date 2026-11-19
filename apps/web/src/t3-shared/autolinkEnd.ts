// Where a bare URL (GFM extended autolink) should end. GFM runs a bare URL on until whitespace or
// `<`, so a Korean particle, `**`, or `(` right after the address joins it. Pure, no imports, so
// the web pipeline (remark) and the Android app (marked) end URLs at the same place.

const SCHEME = /^(?:https?:\/\/|www\.)/i;
const ASCII_HOST_CHAR = /^[A-Za-z0-9.\-:@%]$/;
const NON_ASCII_HOST_CHAR = /^[\p{L}\p{M}\p{N}]$/u;
/** What may follow a closing `__` of bold (a URL's own `__init__` has a letter or `.` after it). */
const AFTER_CLOSING_UNDERSCORES = /^[)\]},;:!?'"]$/;

/**
 * The index in `text` (a bare URL as GFM linked it, trailing text included) where the address ends,
 * or -1 when all of it is the address. The index sits after any `*`, `_` or `~` run at the end mark, so
 * a tab or a split there leaves the run for the emphasis that it closes.
 *
 * - No path (nothing from `/`, `?`, `#` on): the host ends at the first character a host cannot
 *   hold, which is anything but ASCII letters, digits, `.`, `-`, `:`, `@`, `%` and the letters of
 *   an internationalized domain. A non-ASCII letter that follows an ASCII letter, digit or `-` of
 *   the same label is a sentence continuing (`kr은`, `3000에서`), so a label is all ASCII or has no
 *   ASCII before its non-ASCII (`한글.kr`, `www.예제.com`).
 * - With a path: the address ends at `**`, at `__` that closes bold, at a `)` or `]` the path did not
 *   open (`예시(https://example.com/x)와`: the parenthesis is the sentence's), and at a non-ASCII letter
 *   right after a closing `)` or `]` (`.../Foo_(bar)와`). Other non-ASCII in the path stays (`/wiki/서울`).
 */
export function autolinkEndIndex(text: string): number {
  const scheme = SCHEME.exec(text);
  if (!scheme) return -1;
  let i = scheme[0].length;
  if (text[i] === "[") {
    const close = text.indexOf("]", i);
    if (close > 0) i = close + 1;
  }
  let cut = -1;
  for (; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "/" || ch === "?" || ch === "#") {
      cut = pathEnd(text, i);
      break;
    }
    if (ASCII_HOST_CHAR.test(ch)) continue;
    const previous = text.charAt(i - 1);
    if (NON_ASCII_HOST_CHAR.test(ch) && ch.charCodeAt(0) > 0x7f && !/^[A-Za-z0-9-]$/.test(previous)) continue;
    cut = i;
    break;
  }
  if (cut <= 0) return -1;
  while (text[cut] === "*" || text[cut] === "_" || text[cut] === "~") cut++;
  return cut >= text.length ? -1 : cut;
}

function pathEnd(text: string, from: number): number {
  const open = { ")": 0, "]": 0 };
  for (let j = from; j < text.length; j++) {
    const ch = text.charAt(j);
    if (ch === "(") open[")"]++;
    else if (ch === "[") open["]"]++;
    else if (ch === ")" || ch === "]") {
      if (open[ch] === 0) return j;
      open[ch]--;
    } else if (ch.charCodeAt(0) > 0x7f && NON_ASCII_HOST_CHAR.test(ch) && (text[j - 1] === ")" || text[j - 1] === "]")) {
      return j;
    }
    if (ch === "*" && text[j + 1] === "*") return j;
    if (ch === "_" && text[j + 1] === "_") {
      const after = text.charAt(j + 2);
      if (after === "" || after.charCodeAt(0) > 0x7f || AFTER_CLOSING_UNDERSCORES.test(after)) return j;
    }
  }
  return -1;
}
