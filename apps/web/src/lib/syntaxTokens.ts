// The shape highlighted code takes between the highlighter (`syntaxHighlight.ts`, loaded on
// demand) and the components that draw it. Each role is one theme token, `--syntax-<role>` in
// index.css, so a theme recolors code without touching the highlighter.

export const SYNTAX_ROLES = [
  "comment",
  "keyword",
  "string",
  "number",
  "function",
  "type",
  "variable",
  "property",
  "attribute",
  "tag",
  "regexp",
  "meta",
  "heading",
  "inserted",
  "deleted",
  "emphasis",
  "strong",
] as const;

export type SyntaxRole = (typeof SYNTAX_ROLES)[number];

export interface SyntaxToken {
  readonly text: string;
  /** Null draws in the surrounding code color (punctuation, operators, plain names). */
  readonly role: SyntaxRole | null;
}

/** Splits tokens at line breaks: one array per line, without the break itself. */
export function splitSyntaxLines(tokens: ReadonlyArray<SyntaxToken>): SyntaxToken[][] {
  const lines: SyntaxToken[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ text: part, role: token.role });
    });
  }
  return lines;
}
