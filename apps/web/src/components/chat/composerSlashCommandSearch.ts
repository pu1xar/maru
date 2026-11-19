// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: apps/web/src/components/chat/composerSlashCommandSearch.ts (a command's name ranks
// before its description: exact, prefix, word boundary, substring, then fuzzy) and
// packages/shared/src/searchRanking.ts (scoreQueryMatch, scoreSubsequenceMatch). Local change:
// one item kind (SessionCommand), aliases rank as names, ":" (a Claude plugin's namespace) is a
// word boundary too, no result cap, and the menu opens only while the message is a lone `/word`.
import type { SessionCommand } from "@maru/shared";

/**
 * What follows the `/` while the message is only a command word being typed ("/comp" -> "comp"),
 * or null when the menu is closed: the message does not start with `/`, or a space or line break
 * already ends the word.
 */
export function slashQuery(text: string): string | null {
  return /^\/\S*$/.test(text) ? text.slice(1) : null;
}

/** The menu's rows for a query: every command when it is empty, else the matches ranked. */
export function searchSlashCommands(commands: readonly SessionCommand[], query: string): SessionCommand[] {
  const q = query.trim().replace(/^[/$]+/, "").toLowerCase();
  if (!q) return [...commands];
  const ranked: Array<{ item: SessionCommand; score: number; tieBreaker: string }> = [];
  for (const item of commands) {
    const score = scoreCommand(item, q);
    if (score === null) continue;
    ranked.push({ item, score, tieBreaker: `${item.sigil === "/" ? 0 : 1}\u0000${item.name}` });
  }
  ranked.sort((a, b) => a.score - b.score || a.tieBreaker.localeCompare(b.tieBreaker));
  return ranked.map((r) => r.item);
}

/**
 * What picking a row does. Claude Code's typeahead (2.1.325): Enter puts `/name ` in and runs it
 * at once when it takes no arguments, Tab only puts it in. Here a row whose argumentHint is empty
 * stands for "takes no arguments". A Codex `$skill` is always put in, as the Codex TUI's `$` menu
 * does, so a request can follow it. A click puts it in, as in T3.
 */
export function pickCommand(item: SessionCommand, how: "enter" | "tab" | "click"): { text: string; send: boolean } {
  const token = `${item.sigil}${item.name}`;
  if (how === "enter" && item.sigil === "/" && item.argumentHint === "") return { text: token, send: true };
  return { text: `${token} `, send: false };
}

function scoreCommand(item: SessionCommand, query: string): number | null {
  const names = [item.name, ...item.aliases].map((n) => n.toLowerCase());
  const scores: number[] = [];
  for (const value of names) {
    const s = scoreQueryMatch({
      value, query, exactBase: 0, prefixBase: 2, boundaryBase: 4, includesBase: 6, fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/", ":"],
    });
    if (s !== null) scores.push(s);
  }
  const d = scoreQueryMatch({
    value: item.description.toLowerCase(), query, exactBase: 20, prefixBase: 22, boundaryBase: 24, includesBase: 26,
  });
  if (d !== null) scores.push(d);
  return scores.length ? Math.min(...scores) : null;
}

function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;
  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;
  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue;
    if (firstMatchIndex === -1) firstMatchIndex = valueIndex;
    if (previousMatchIndex !== -1) gapPenalty += valueIndex - previousMatchIndex - 1;
    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty;
    }
  }
  return null;
}

function findBoundaryMatchIndex(value: string, query: string, boundaryMarkers: readonly string[]): number | null {
  let bestIndex: number | null = null;
  for (const marker of boundaryMarkers) {
    const index = value.indexOf(`${marker}${query}`);
    if (index === -1) continue;
    const matchIndex = index + marker.length;
    if (bestIndex === null || matchIndex < bestIndex) bestIndex = matchIndex;
  }
  return bestIndex;
}

/** value and query must already be trimmed and lowercased. */
function scoreQueryMatch(input: {
  value: string;
  query: string;
  exactBase: number;
  prefixBase?: number;
  boundaryBase?: number;
  includesBase?: number;
  fuzzyBase?: number;
  boundaryMarkers?: readonly string[];
}): number | null {
  const { value, query } = input;
  if (!value || !query) return null;
  const penalty = Math.min(64, Math.max(0, value.length - query.length));
  if (value === query) return input.exactBase;
  if (input.prefixBase !== undefined && value.startsWith(query)) return input.prefixBase + penalty;
  if (input.boundaryBase !== undefined) {
    const boundaryIndex = findBoundaryMatchIndex(value, query, input.boundaryMarkers ?? [" ", "-", "_", "/"]);
    if (boundaryIndex !== null) return input.boundaryBase + boundaryIndex * 2 + penalty;
  }
  if (input.includesBase !== undefined) {
    const includesIndex = value.indexOf(query);
    if (includesIndex !== -1) return input.includesBase + includesIndex * 2 + penalty;
  }
  if (input.fuzzyBase !== undefined) {
    const fuzzyScore = scoreSubsequenceMatch(value, query);
    if (fuzzyScore !== null) return input.fuzzyBase + fuzzyScore;
  }
  return null;
}
