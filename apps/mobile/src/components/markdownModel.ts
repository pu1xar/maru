// The pure rules behind Markdown.tsx (no React Native), so a node test can check them: which
// tokens the conversation draws, the space between blocks, a code fence's label, and a color
// at a fraction of its strength.
import { Marked, type Token, type Tokens } from "marked";
import markedCjkFriendly from "marked-cjk-friendly";
import { autolinkEndIndex } from "../../../web/src/t3-shared/autolinkEnd.ts";
import { headingSpace } from "../typography.ts";
import { occurrencesIn } from "../lib/threadFind.ts";

/** The web's inline code box (index.css `.chat-markdown :not(pre) > code`): 1px border, radius 0.25rem, padding 0.1em 0.35em. */
export function inlineCodeBox(fontSize: number) {
  const lineHeight = Math.round(fontSize * 1.17);
  const paddingVertical = Math.round(fontSize * 0.1);
  return {
    radius: 4,
    border: 1,
    paddingHorizontal: Math.round(fontSize * 0.35),
    paddingVertical,
    lineHeight,
    /** An inline view sits with its bottom edge on the line's baseline; this moves it down so the text inside shares the baseline. */
    drop: Math.round(1 + paddingVertical + fontSize * 0.2 + (lineHeight - fontSize * 1.17) / 2),
  };
}

/**
 * Whether inline code is drawn as a box (an inline view) or as tinted text. A view cannot wrap, so
 * a span longer than a share of the line (`lineWidth`, the text column) stays tinted text, which
 * breaks across lines like prose. Width is estimated: a wide (CJK, full-width) character is one em,
 * the rest 0.62 em (wider than the average Latin glyph, so the estimate errs toward text).
 */
export function inlineCodeFitsBox(text: string, fontSize: number, lineWidth: number): boolean {
  if (text.includes("\n")) return false;
  let em = 0;
  for (const ch of text) em += (ch.codePointAt(0) ?? 0) >= 0x1100 ? 1 : 0.62;
  const box = inlineCodeBox(fontSize);
  return em * fontSize + 2 * (box.paddingHorizontal + box.border) <= lineWidth * 0.7;
}

// The web's remark-cjk-friendly counterpart: `**` and `*` close and open next to Korean and CJK
// text and punctuation ("**중요**는", "**注意：**请看"), which CommonMark's flanking rules refuse.
// Only its emphasis tokenizer is used: its `del` tokenizer reads `delLDelim`, a rule newer marked
// versions have (the app's 16.4.2 does not), and the conversation draws no strikethrough anyway
// (`tildesAsText`).
const { del: _del, ...cjkEmphasis } = markedCjkFriendly().tokenizer ?? {};
const markedInstance = new Marked({ gfm: true }, { tokenizer: cjkEmphasis });

/** The block tokens of a message, with emphasis and bare URLs ending where the web's pipeline ends them. */
export function lexMarkdown(text: string): Token[] {
  return endAutolinks(markedInstance.lexer(text));
}

/** A token that may carry nested tokens (inline children, list items, table cells). */
type Nested = Token & { tokens?: Token[]; items?: Token[]; header?: Tokens.TableCell[]; rows?: Tokens.TableCell[][] };

const cell = (c: Tokens.TableCell): Tokens.TableCell => ({ ...c, tokens: tildesAsText(c.tokens) });

/**
 * The conversation draws no strikethrough (the web's markdownPipeline: singleTilde false plus
 * remarkTildesAsText). marked reads `~a~` and `~~a~~` as a `del`, which would hide the text between
 * two lone tildes ("5/1~5/3, 6/1~6/3", "~/a and ~/b"). Every `del` becomes its own tildes around
 * its content, so the tildes stay as typed and the content keeps its inline formatting.
 */
export function tildesAsText(tokens: Token[]): Token[] {
  return tokens.flatMap((t): Token[] => {
    const n = t as Nested;
    if (n.type === "del") {
      const tildes = /^~+/.exec(n.raw)?.[0] ?? "~~";
      return [textToken(tildes), ...tildesAsText(n.tokens ?? []), textToken(tildes)];
    }
    const out: Nested = { ...n };
    if (n.tokens) out.tokens = tildesAsText(n.tokens);
    if (n.items) out.items = tildesAsText(n.items);
    if (n.header) out.header = n.header.map(cell);
    if (n.rows) out.rows = n.rows.map((r) => r.map(cell));
    return [out];
  });
}

const cellEnding = (c: Tokens.TableCell): Tokens.TableCell => ({ ...c, tokens: endAutolinks(c.tokens) });

/**
 * A bare URL (marked's GFM autolink) runs on until whitespace, so a Korean particle, `**` or `(` right
 * after the address joins it ("www.example.com(일부만"). Each such link ends where the web's
 * pipeline ends it (`autolinkEndIndex`, shared) and the rest becomes plain text after it.
 */
export function endAutolinks(tokens: Token[]): Token[] {
  return tokens.flatMap((t): Token[] => {
    const n = t as Nested;
    if (n.type === "link" && isBareLink(n as Tokens.Link)) return splitBareLink(n as Tokens.Link);
    const out: Nested = { ...n };
    if (n.tokens) out.tokens = endAutolinks(n.tokens);
    if (n.items) out.items = endAutolinks(n.items);
    if (n.header) out.header = n.header.map(cellEnding);
    if (n.rows) out.rows = n.rows.map((r) => r.map(cellEnding));
    return [out];
  });
}

/** A link marked made from loose text: its source is its own label, not `[label](url)` or `<url>`. */
function isBareLink(link: Tokens.Link): boolean {
  const label = link.tokens?.length === 1 ? link.tokens[0] : undefined;
  return label?.type === "text" && link.raw === link.text && /^(?:https?:\/\/|www\.)/i.test(link.raw);
}

function splitBareLink(link: Tokens.Link): Token[] {
  const end = autolinkEndIndex(link.raw);
  if (end < 0) return [link];
  // GFM drops this punctuation from the end of a URL.
  const length = link.raw.slice(0, end).replace(/[!"'*,.:;?_~]+$/, "").length;
  if (length <= 0) return [link];
  const head = link.raw.slice(0, length);
  const www = /^www\./i.test(head);
  return [
    { ...link, raw: head, text: head, href: www ? `http://${head}` : head, tokens: [textToken(head)] },
    textToken(link.raw.slice(length)),
  ];
}

function textToken(text: string): Token {
  return { type: "text", raw: text, text } as Token;
}

/** Space above and below a block, in dp (web index.css: p, lists, quotes, code 0.65rem; headings 1.25rem above and 0.5rem below). */
const BLOCK_SPACE = { top: 10, bottom: 10 };

function spaceOf(type: string) {
  return type === "heading" ? headingSpace : BLOCK_SPACE;
}

/**
 * The gap before each block. Adjoining margins collapse as on the web, so the gap between two
 * blocks is the larger of the first's bottom and the second's top (a heading after a paragraph is
 * 20, a paragraph after a heading 10). The first block has no gap.
 */
export function blockGaps(types: string[]): number[] {
  return types.map((type, i) => {
    const prev = types[i - 1];
    if (prev === undefined) return 0;
    return Math.max(spaceOf(prev).bottom, spaceOf(type).top);
  });
}

/** A fence's language label: the first word of its info string ("ts title=a.ts" gives "ts"), or "text". */
export function codeLanguage(info: string | undefined): string {
  const word = (info ?? "").trim().split(/\s+/)[0] ?? "";
  return word === "" ? "text" : word;
}

/** A fence's info string after the language word (web extractPreCodeMeta), or undefined. */
export function codeMeta(info: string | undefined): string | undefined {
  const rest = (info ?? "").trim().split(/\s+/).slice(1).join(" ");
  return rest === "" ? undefined : rest;
}

// ---- list markers (web index.css: ul disc, circle, square by depth; ol decimal, lower-alpha, lower-roman)

const BULLETS = ["•", "◦", "▪"] as const;

/** `n` (1-based) as lowercase letters: a..z, aa, ab (CSS lower-alpha). */
export function lowerAlpha(n: number): string {
  let out = "";
  let k = n;
  while (k > 0) {
    k -= 1;
    out = String.fromCharCode(97 + (k % 26)) + out;
    k = Math.floor(k / 26);
  }
  return out;
}

/** `n` as a lowercase roman numeral (CSS lower-roman); outside 1..3999 CSS falls back to decimal. */
export function lowerRoman(n: number): string {
  if (n < 1 || n > 3999) return String(n);
  const steps: Array<[number, string]> = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let rest = n;
  let out = "";
  for (const [value, glyph] of steps) {
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  }
  return out;
}

/**
 * The marker of a list item. `ancestors` counts the lists of each kind the list sits inside:
 * a bullet list takes disc, circle, square by its depth among bullet lists, an ordered list decimal,
 * lower-alpha, lower-roman by its depth among ordered lists. The user's bubble keeps decimal
 * (index.css .user-message-markdown ol).
 */
export function listMarker(list: { ordered: boolean; number: number; ancestors: { ul: number; ol: number }; decimalOnly?: boolean }): string {
  if (!list.ordered) return BULLETS[Math.min(list.ancestors.ul, BULLETS.length - 1)]!;
  const depth = list.decimalOnly ? 0 : list.ancestors.ol;
  const label = depth === 0 ? String(list.number) : depth === 1 ? lowerAlpha(list.number) : lowerRoman(list.number);
  return `${label}.`;
}

/** The width of an ordered list's marker column in dp: 20 (1.25rem) or room for its widest number (web orderedListGutterStyle, `digits + 2` ch). */
export function listGutter(maxDigits: number, ordered: boolean): number {
  return ordered && maxDigits > 1 ? Math.round((maxDigits + 2) * 8.2) : 20;
}

/** The gap between two list items: 4 (li + li), 10 where a block's margin meets it (a paragraph, a nested list, code). */
export function listItemGap(previous: string | undefined, next: string | undefined): number {
  const block = (type: string | undefined) => type !== undefined && type !== "text";
  return block(previous) || block(next) ? 10 : 4;
}

/**
 * `color` at `alpha` (0..1) of its own strength, for the hex and rgb forms the theme uses. A form
 * it cannot read comes back unchanged.
 */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim());
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length === 6 || h.length === 8) {
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return rgba(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a * alpha);
    }
    return color;
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(color.trim());
  if (fn) return rgba(Number(fn[1]), Number(fn[2]), Number(fn[3]), (fn[4] === undefined ? 1 : Number(fn[4])) * alpha);
  return color;
}

function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

// ---- find (DESIGN.md 6u) ----
// A find paints the query where the message draws it. A message draws several texts (leaves) in
// order; the leaves are numbered along, so the n-th occurrence of the find is a place in one leaf.

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/** A text token's HTML entities (marked leaves them escaped) as plain characters. */
export function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
}

/** The text an inline token without children draws; null for a token that only holds others. */
export function inlineLeafText(t: Token): string | null {
  switch (t.type) {
    case "strong":
    case "em":
    case "link":
    case "br":
      return null;
    case "codespan":
      // The code as typed: the box draws the padding (an inline view), so no spaces stand for it.
      return (t as Tokens.Codespan).text;
    case "text": {
      const tt = t as Tokens.Text;
      return tt.tokens ? null : decodeEntities(tt.text);
    }
    case "escape":
      return (t as Tokens.Escape).text;
    default:
      return "raw" in t ? String(t.raw) : "";
  }
}

/** The leaves of a message in the order Markdown.tsx draws them, each with the occurrence number it starts at. */
export interface LeafStarts {
  starts: Map<Token, number>;
  /** Occurrences the message draws over all leaves. */
  total: number;
}

export function markdownLeafStarts(tokens: Token[], query: string): LeafStarts {
  const starts = new Map<Token, number>();
  let total = 0;
  const leaf = (t: Token, text: string) => {
    starts.set(t, total);
    total += occurrencesIn(text, query);
  };
  const inline = (list: Token[] | undefined) => {
    for (const t of list ?? []) {
      const text = inlineLeafText(t);
      if (text !== null) {
        leaf(t, text);
        continue;
      }
      inline((t as Nested).tokens);
    }
  };
  const blocks = (list: Token[]) => {
    for (const t of list) if (t.type !== "space") block(t);
  };
  const block = (t: Token) => {
    switch (t.type) {
      case "paragraph":
      case "heading":
        inline((t as Nested).tokens);
        return;
      case "code":
        leaf(t, (t as Tokens.Code).text);
        return;
      case "blockquote":
        blocks((t as Tokens.Blockquote).tokens);
        return;
      case "list":
        for (const item of (t as Tokens.List).items) {
          for (const c of item.tokens) {
            if (c.type === "text" && (c as Tokens.Text).tokens) inline((c as Tokens.Text).tokens);
            else block(c);
          }
        }
        return;
      case "table": {
        const table = t as Tokens.Table;
        for (const c of table.header) inline(c.tokens);
        for (const r of table.rows) for (const c of r) inline(c.tokens);
        return;
      }
      case "hr":
        return;
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens) inline(tt.tokens);
        else leaf(t, tt.text);
        return;
      }
      default:
        leaf(t, "raw" in t ? String(t.raw) : "");
    }
  };
  blocks(tokens);
  return { starts, total };
}

// ---- table columns (web index.css `.chat-markdown table`, DESIGN.md 2d) ----
// A browser sizes table columns together: each column is as wide as its longest content within a
// minimum (its longest unbreakable word) and a maximum (24rem), every row shares those widths, and
// the table fills the lane (`width: 100%`) or scrolls when even the minimums do not fit. The app
// computes the same widths without measuring text, from per-character estimates.

/** A cell's width cap (web max-width 24rem on th and td). */
export const TABLE_CELL_MAX = 384;
/** Space inside a cell on each side (web padding 0.75rem); the outer columns are flush with the prose. */
export const TABLE_CELL_PAD = 12;

const isWide = (ch: string): boolean => (ch.codePointAt(0) ?? 0) >= 0x1100;

/** Width of one character in em: CJK and full-width forms 1, others 0.6 (a little over the average Latin glyph so a column errs wide; monospace is 0.6 too). */
function emOf(ch: string): number {
  return isWide(ch) ? 1 : 0.6;
}

/** A browser breaks between CJK characters, so each is its own piece; a run of others (a word) is one. */
function pieces(word: string): number[] {
  const out: number[] = [];
  let run = 0;
  for (const ch of word) {
    if (isWide(ch)) {
      if (run > 0) out.push(run);
      run = 0;
      out.push(1);
    } else run += emOf(ch);
  }
  if (run > 0) out.push(run);
  return out;
}

type CellPart = [text: string, code: boolean];

/** The text a cell shows, as lines of parts. A `br` starts a new line; an image draws its alt text. */
function cellLines(tokens: Token[]): CellPart[][] {
  const lines: CellPart[][] = [[]];
  const add = (text: string, code: boolean) => lines[lines.length - 1]!.push([text, code]);
  const walk = (list: Token[]) => {
    for (const t of list) {
      const n = t as Nested & { text?: string };
      if (t.type === "br") lines.push([]);
      else if (t.type === "codespan") add((t as Tokens.Codespan).text, true);
      else if (n.tokens) walk(n.tokens);
      else if (t.type === "text" || t.type === "escape") add(decodeEntities(n.text ?? ""), false);
      else if (t.type === "image") add((t as Tokens.Image).text, false);
      else if ("raw" in t) add(String(t.raw), false);
    }
  };
  walk(tokens);
  return lines;
}

/**
 * A cell's narrowest and widest content in dp at `fontSize`: the longest unbreakable piece, and the
 * longest line with no wrapping. A code span adds the inline box's padding and border.
 */
export function cellExtent(tokens: Token[], fontSize: number): { min: number; max: number } {
  const box = inlineCodeBox(fontSize);
  const boxSpace = 2 * (box.paddingHorizontal + box.border);
  let min = 0;
  let max = 0;
  for (const line of cellLines(tokens)) {
    let width = 0;
    for (const [text, code] of line) {
      if (code) {
        let em = 0;
        for (const ch of text) em += emOf(ch);
        width += em * fontSize + boxSpace;
        min = Math.max(min, em * fontSize + boxSpace);
        continue;
      }
      // Words split at whitespace; a gap between words is one space (0.3 em).
      for (const word of text.split(/(\s+)/)) {
        if (word === "") continue;
        if (/^\s+$/.test(word)) {
          width += 0.3 * fontSize;
          continue;
        }
        const em = pieces(word);
        width += em.reduce((a, b) => a + b, 0) * fontSize;
        min = Math.max(min, Math.max(...em) * fontSize);
      }
    }
    max = Math.max(max, width);
  }
  return { min, max };
}

/**
 * The column widths (dp) of a table in a lane `available` wide, the way a browser's auto layout
 * with `width: 100%` sizes them. Each column's minimum and maximum come from its cells (header
 * included) plus the cell padding, both capped at TABLE_CELL_MAX. When the maximums fit, the extra
 * width is shared in proportion to them; when only the minimums fit, columns sit between the two in
 * proportion to how much each can grow; when not even the minimums fit, the minimums are used and the
 * table is wider than the lane (it scrolls sideways). A row shorter than the header counts as empty
 * cells (marked already pads rows to the header's width).
 */
export function tableColumnWidths(table: Tokens.Table, fontSize: number, available: number): number[] {
  const count = table.header.length;
  if (count === 0) return [];
  const mins = new Array<number>(count).fill(0);
  const maxs = new Array<number>(count).fill(0);
  for (const row of [table.header, ...table.rows]) {
    for (let i = 0; i < count; i++) {
      const cell = row[i];
      const extent = cell ? cellExtent(cell.tokens, fontSize) : { min: 0, max: 0 };
      const pad = (i === 0 ? 0 : TABLE_CELL_PAD) + (i === count - 1 ? 0 : TABLE_CELL_PAD);
      mins[i] = Math.max(mins[i]!, Math.min(TABLE_CELL_MAX, Math.ceil(extent.min) + pad));
      maxs[i] = Math.max(maxs[i]!, Math.min(TABLE_CELL_MAX, Math.ceil(extent.max) + pad));
    }
  }
  for (let i = 0; i < count; i++) maxs[i] = Math.max(maxs[i]!, mins[i]!);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const minSum = sum(mins);
  const maxSum = sum(maxs);
  if (maxSum === 0) return mins.map(() => available / count);
  if (available >= maxSum) {
    // The lane is wider than the content: fill it in proportion to the content widths.
    return maxs.map((w) => w * (available / maxSum));
  }
  if (available <= minSum) return mins;
  const grow = (available - minSum) / (maxSum - minSum);
  return mins.map((w, i) => w + (maxs[i]! - w) * grow);
}
