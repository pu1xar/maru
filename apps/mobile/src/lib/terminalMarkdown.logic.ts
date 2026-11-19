// Markdown as the Claude Code CLI prints it, for the app's terminal mode (DESIGN.md 6i, measured on
// CLI 2.1.325; the web's counterpart is components/terminal/TerminalMarkdown.tsx): headings and bold as
// bold text without their marks, inline code in the accent color without backticks, "- " and "1. "
// list markers, fenced code without fences, tables in box lines (terminalModel.ts layoutTable),
// quotes behind a bar, links as "text (address)". A single newline inside a paragraph stays a line
// break (the web pipeline's remark-breaks), and a block that starts on the line right under the
// previous one is "tight": no empty line between them. React Native-free, so a node test runs it.
import { Marked, type Token, type Tokens } from "marked";
import markedCjkFriendly from "marked-cjk-friendly";
import { layoutTable, type TableLayout } from "../../../web/src/components/terminal/terminalModel.ts";
import { endAutolinks, tildesAsText } from "../components/markdownModel.ts";

/** One styled run of inline text. `code` is the accent color; `link` makes it tappable. */
export interface TermSpan {
  t: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  code?: boolean;
  dim?: boolean;
  link?: string;
}

export type TermMdBlock = { tight: boolean } & (
  | { k: "heading"; level: number; spans: TermSpan[] }
  | { k: "p"; spans: TermSpan[] }
  | { k: "list"; ordered: boolean; start: number; items: TermMdBlock[][] }
  | { k: "pre"; text: string }
  | { k: "table"; layout: TableLayout }
  | { k: "quote"; blocks: TermMdBlock[] }
  | { k: "hr" }
);

// The same emphasis rules as the chat's Markdown (markdownModel.ts), with line breaks kept.
const { del: _del, ...cjkEmphasis } = markedCjkFriendly().tokenizer ?? {};
const marked = new Marked({ gfm: true, breaks: true }, { tokenizer: cjkEmphasis });

type Nested = Token & { tokens?: Token[] };

/** The plain text of inline tokens (a table cell). */
function plainOf(tokens: readonly Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const t of tokens as Nested[]) {
    if (t.type === "br") out += " ";
    else if (t.tokens) out += plainOf(t.tokens);
    else if ("text" in t && typeof t.text === "string") out += t.text;
    else out += t.raw;
  }
  return out.replace(/\s+/g, " ").trim();
}

type Style = Omit<TermSpan, "t" | "link">;

/** Inline tokens as styled runs; adjacent runs with the same style are joined. */
export function inlineSpans(tokens: readonly Token[] | undefined, style: Style = {}): TermSpan[] {
  const out: TermSpan[] = [];
  const push = (span: TermSpan) => {
    if (span.t === "") return;
    const last = out.at(-1);
    if (last && last.link === span.link && last.bold === span.bold && last.italic === span.italic && last.underline === span.underline && last.code === span.code && last.dim === span.dim) {
      last.t += span.t;
    } else out.push(span);
  };
  const walk = (list: readonly Token[], s: Style, link?: string) => {
    for (const t of list as Nested[]) {
      const withLink = (span: TermSpan): TermSpan => (link ? { ...span, link } : span);
      switch (t.type) {
        case "strong":
          walk(t.tokens ?? [], { ...s, bold: true }, link);
          break;
        case "em":
          walk(t.tokens ?? [], { ...s, italic: true }, link);
          break;
        case "codespan":
          push(withLink({ ...s, t: (t as Tokens.Codespan).text, code: true }));
          break;
        case "br":
          push(withLink({ ...s, t: "\n" }));
          break;
        case "link": {
          const l = t as Tokens.Link;
          const label = plainOf(l.tokens);
          walk(l.tokens ?? [], s, l.href);
          // The CLI prints a link as its text and then the address (measured).
          const same = !l.href || label === l.href || label === l.href.replace(/^mailto:/, "");
          if (!same) push({ ...s, t: ` (${l.href})` });
          break;
        }
        case "image":
          push({ ...s, t: `[${(t as Tokens.Image).text || "image"}]`, dim: true });
          break;
        case "escape":
        case "text":
        case "html":
        default: {
          const text = t.tokens ? undefined : "text" in t && typeof t.text === "string" ? t.text : t.raw;
          if (t.tokens) walk(t.tokens, s, link);
          else if (text !== undefined) push(withLink({ ...s, t: text }));
        }
      }
    }
  };
  walk(tokens ?? [], style);
  return out;
}

function blocksOf(tokens: readonly Token[], columns: number): TermMdBlock[] {
  const out: TermMdBlock[] = [];
  let sinceBlank = false;
  let prevBlock = false;
  for (const t of tokens as Nested[]) {
    if (t.type === "space") {
      sinceBlank = true;
      continue;
    }
    // A block right under the previous one (no blank line in the source) is tight.
    const tight = prevBlock && !sinceBlank;
    sinceBlank = false;
    let block: TermMdBlock | null = null;
    switch (t.type) {
      case "heading": {
        const h = t as Tokens.Heading;
        block = { k: "heading", level: h.depth, spans: inlineSpans(h.tokens, { bold: true, ...(h.depth === 1 ? { italic: true, underline: true } : {}) }), tight };
        break;
      }
      case "paragraph":
      case "text": {
        const spans = inlineSpans(t.tokens ?? [{ type: "text", raw: t.raw, text: "text" in t ? String(t.text) : t.raw } as Token]);
        block = { k: "p", spans, tight };
        break;
      }
      case "code":
        block = { k: "pre", text: (t as Tokens.Code).text.replace(/\n$/, ""), tight };
        break;
      case "blockquote":
        block = { k: "quote", blocks: blocksOf((t as Tokens.Blockquote).tokens, columns), tight };
        break;
      case "hr":
        block = { k: "hr", tight };
        break;
      case "list": {
        const l = t as Tokens.List;
        const items = l.items.map((item) => {
          const inner = blocksOf(item.tokens, columns);
          // A task item starts with its box, as the CLI prints "[x] " and "[ ] ".
          if (item.task) {
            const box: TermSpan = { t: item.checked ? "[x] " : "[ ] " };
            const first = inner[0];
            if (first && first.k === "p") first.spans.unshift(box);
            else inner.unshift({ k: "p", spans: [box], tight: false });
          }
          return inner;
        });
        block = { k: "list", ordered: l.ordered, start: typeof l.start === "number" ? l.start : 1, items, tight };
        break;
      }
      case "table": {
        const tb = t as Tokens.Table;
        const rows = [tb.header.map((c) => plainOf(c.tokens)), ...tb.rows.map((r) => r.map((c) => plainOf(c.tokens)))];
        block = { k: "table", layout: layoutTable(rows, columns, tb.align), tight };
        break;
      }
      case "html":
        block = { k: "p", spans: [{ t: t.raw.trimEnd() }], tight };
        break;
      default:
        break;
    }
    if (block) {
      out.push(block);
      prevBlock = true;
    }
  }
  return out;
}

/** The blocks of a message: `columns` is the terminal's width in cells (tables fit in it). */
export function terminalMarkdownBlocks(text: string, columns: number): TermMdBlock[] {
  const tokens = endAutolinks(tildesAsText(marked.lexer(text)));
  return blocksOf(tokens, columns);
}

/** The marker text of list item `index` ("- " or "1. "). */
export function listMarker(ordered: boolean, start: number, index: number): string {
  return ordered ? `${start + index}. ` : "- ";
}
