// The small pure rules of the app's terminal mode (DESIGN.md 6i): the grid a font size makes, how many
// columns a width holds, the empty line between blocks, the store key of a session's own view mode
// and how a sent message's attachments are labeled. React Native-free, so a node test runs them.
import type { TermBlock } from "../../../web/src/components/terminal/terminalModel.ts";
import { terminalCell, type TerminalFontId } from "../../../web/src/lib/viewMode.logic.ts";
import { SESSION_MODE_PREFIX } from "../../../web/src/lib/viewMode.logic.ts";

export interface TerminalGrid {
  fontSize: number;
  /** One row's height (dp). */
  lineHeight: number;
  /** Extra space after each glyph so an advance fills the cell (dp; 0 outside the Bon fonts). */
  letterSpacing: number;
}

/**
 * The text style of a terminal row for a font and size, the web's iTerm cell (viewMode.logic.ts
 * terminalCell): the row height and the letter spacing that makes a glyph advance the cell's width.
 * 1pt is 1dp here as it is 1 CSS px on the web.
 */
export function terminalGrid(font: TerminalFontId, fontSize: number): TerminalGrid {
  const cell = terminalCell(font, fontSize);
  return { fontSize, lineHeight: cell.height, letterSpacing: cell.letterSpacing };
}

/** The profile's window margins (iTerm TerminalMargin 10 and TerminalVMargin 3), as dp. */
export const TERMINAL_MARGIN = { x: 10, y: 3 } as const;

/** Columns that fit `innerWidth` dp when ten cells measured `tenCells` dp (the web's probe), at least 20. */
export function columnsFor(innerWidth: number, tenCells: number): number {
  const cell = tenCells / 10;
  if (!(cell > 0) || !(innerWidth > 0)) return 120;
  return Math.max(20, Math.floor(innerWidth / cell));
}

/**
 * The empty lines before a block (index.css `.term-block + .term-block`: one line between blocks;
 * a time stamp sits right on its answer, an interrupt line right under what it stopped, a
 * command's output right under the command).
 */
export function linesBefore(prev: TermBlock | undefined, block: TermBlock): 0 | 1 {
  if (!prev) return 0;
  if (prev.kind === "stamp") return 0;
  if (block.kind === "interrupted" || block.kind === "command-output") return 0;
  return 1;
}

/**
 * The secure-store key of a session's own view mode. The web keeps it under
 * `maru_view_mode:<session key>`; the store accepts only letters, digits, ".", "-" and "_", so
 * every other UTF-16 unit of the session key (":" and "_" among them) becomes "_" and four hex
 * digits, which keeps two session keys from sharing a key.
 */
export function sessionModeStoreKey(sessionKey: string): string {
  let out = SESSION_MODE_PREFIX.replace(":", ".");
  for (let i = 0; i < sessionKey.length; i++) {
    const ch = sessionKey[i]!;
    out += /[A-Za-z0-9.-]/.test(ch) ? ch : `_${sessionKey.charCodeAt(i).toString(16).padStart(4, "0")}`;
  }
  return out;
}
