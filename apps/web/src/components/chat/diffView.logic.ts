// A file change's unified diff (`diffStr`: Claude's formatHunks, Codex's unifiedDiff) read into
// rows with line numbers, and colored per hunk side so a construct spanning lines (a block
// comment, a template string) keeps its color on every line it covers.
import { syntaxLanguageForPath, type SyntaxLanguage } from "../../lib/syntaxLanguages.ts";
import { splitSyntaxLines, type SyntaxToken } from "../../lib/syntaxTokens.ts";

export type DiffLineType = "context" | "add" | "del";

export type DiffRow =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "hunk"; readonly text: string }
  | {
      readonly kind: "line";
      readonly type: DiffLineType;
      readonly oldNumber: number | null;
      readonly newNumber: number | null;
      readonly text: string;
      /** Index of the hunk this line belongs to, in `ParsedDiff.hunks`. */
      readonly hunk: number;
    }
  /** Lines outside a hunk (`\ No newline at end of file`, git headers, a snippet that is no diff). */
  | { readonly kind: "note"; readonly text: string };

export interface ParsedDiff {
  readonly rows: ReadonlyArray<DiffRow>;
  /** The file each hunk belongs to, by hunk index (null when the diff names none). */
  readonly hunks: ReadonlyArray<{ readonly path: string | null }>;
  readonly fileCount: number;
  /** The widest line number, for the number columns. */
  readonly maxLineNumber: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function headerPath(line: string): string {
  const path = line.slice(4).replace(/\t.*$/, "").trim();
  return path.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines = diff.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const rows: DiffRow[] = [];
  const hunks: Array<{ path: string | null }> = [];
  let path: string | null = null;
  let fileCount = 0;
  let maxLineNumber = 0;
  let oldNumber = 0;
  let newNumber = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (inHunk) {
      const marker = line[0];
      // `\ No newline at end of file` can sit between the removed and the added side.
      if (marker === "\\") {
        rows.push({ kind: "note", text: line });
        continue;
      }
      const type: DiffLineType | null =
        marker === "+" ? "add" : marker === "-" ? "del" : marker === " " || line === "" ? "context" : null;
      if (type !== null) {
        rows.push({
          kind: "line",
          type,
          oldNumber: type === "add" ? null : oldNumber,
          newNumber: type === "del" ? null : newNumber,
          text: line.slice(1),
          hunk: hunks.length - 1,
        });
        if (type !== "add") {
          maxLineNumber = Math.max(maxLineNumber, oldNumber);
          oldNumber += 1;
          oldLeft -= 1;
        }
        if (type !== "del") {
          maxLineNumber = Math.max(maxLineNumber, newNumber);
          newNumber += 1;
          newLeft -= 1;
        }
        continue;
      }
      // A line the counts did not announce ends the hunk; read it as a header line below.
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      const oldPath = headerPath(line);
      const newPath = headerPath(lines[index + 1]!);
      path = newPath === "/dev/null" ? oldPath : newPath;
      fileCount += 1;
      rows.push({ kind: "file", path });
      index += 1;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldNumber = Number(header[1]);
      newNumber = Number(header[3]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      // A zero-length side prints start - 1 (`@@ -0,0 +1,3 @@`).
      if (oldLeft === 0) oldNumber += 1;
      if (newLeft === 0) newNumber += 1;
      hunks.push({ path });
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    rows.push({ kind: "note", text: line });
  }
  return { rows, hunks, fileCount, maxLineNumber };
}

/** The grammar of each hunk: its file's, else the change's own file name. */
export function diffHunkLanguages(
  parsed: ParsedDiff,
  fallbackPath: string | null | undefined,
): Array<SyntaxLanguage | null> {
  return parsed.hunks.map(
    (hunk) => syntaxLanguageForPath(hunk.path) ?? syntaxLanguageForPath(fallbackPath),
  );
}

/**
 * Tokens for every diff line, by row index. Each hunk's old side (context and removed lines) and
 * new side (context and added lines) highlight as one text each; context lines take the new side.
 */
export function highlightDiffRows(
  parsed: ParsedDiff,
  languages: ReadonlyArray<SyntaxLanguage | null>,
  highlight: (code: string, language: SyntaxLanguage) => ReadonlyArray<SyntaxToken> | null,
): Map<number, SyntaxToken[]> {
  const byRow = new Map<number, SyntaxToken[]>();
  const sides = parsed.hunks.map(() => ({
    old: [] as number[],
    new: [] as number[],
  }));
  parsed.rows.forEach((row, rowIndex) => {
    if (row.kind !== "line") return;
    const side = sides[row.hunk]!;
    if (row.type !== "add") side.old.push(rowIndex);
    if (row.type !== "del") side.new.push(rowIndex);
  });
  const lineText = (rowIndex: number) => {
    const row = parsed.rows[rowIndex];
    return row?.kind === "line" ? row.text : "";
  };
  sides.forEach((side, hunk) => {
    const language = languages[hunk] ?? null;
    if (language === null) return;
    for (const [rowIndexes, onlyType] of [
      [side.old, "del"],
      [side.new, null],
    ] as const) {
      if (rowIndexes.length === 0) continue;
      const tokens = highlight(rowIndexes.map(lineText).join("\n"), language);
      if (tokens === null) continue;
      const split = splitSyntaxLines(tokens);
      rowIndexes.forEach((rowIndex, lineIndex) => {
        const row = parsed.rows[rowIndex];
        if (row?.kind !== "line") return;
        // The old side only colors removed lines; context lines take the new side.
        if (onlyType !== null && row.type !== onlyType) return;
        byRow.set(rowIndex, split[lineIndex] ?? []);
      });
    }
  });
  return byRow;
}
