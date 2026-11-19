// What a find (DESIGN.md 6u) tells the message row it draws: the query to paint, which occurrence
// of this row is the active one, and whether a fold that hides text opens. FindRow gives each
// timeline row its own value; Markdown and the folded user messages read it.
import { createContext, useContext } from "react";

export interface FindHighlight {
  /** The query the search answered for, as typed. */
  query: string;
  /** The occurrence (0-based, in this row's text) that is the find's current step, or null for another row. */
  active: number | null;
  /** The row is the find's current step: a fold that hides its text opens. */
  revealed: boolean;
}

export const FindHighlightCtx = createContext<FindHighlight | null>(null);

export function useFindHighlight(): FindHighlight | null {
  return useContext(FindHighlightCtx);
}
