// Syntax colors for code in the conversation: markdown code blocks, and the JSON, commands and
// diffs a tool row shows when opened. The highlighter (`lib/syntaxHighlight.ts`, highlight.js)
// loads on the first code that needs it; until then the same text draws plain, so nothing moves
// when the colors arrive. Every color is a `--syntax-*` theme token (index.css).
import { useEffect, useSyncExternalStore, type ReactNode } from "react";

import type { SyntaxLanguage } from "~/lib/syntaxLanguages";
import type { SyntaxRole, SyntaxToken } from "~/lib/syntaxTokens";

type SyntaxEngine = typeof import("~/lib/syntaxHighlight");

let engine: SyntaxEngine | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function loadSyntaxEngine() {
  loading ??= import("~/lib/syntaxHighlight").then(
    (module) => {
      engine = module;
      for (const listener of listeners) listener();
    },
    (error: unknown) => {
      // A failed chunk load (offline, a deploy that removed it) leaves code plain; the next code
      // block to mount asks again.
      loading = null;
      console.warn("syntax highlighter failed to load", error);
    },
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const readEngine = () => engine;

/** The highlighter once loaded; `wanted` starts the load. Null before it arrives. */
export function useSyntaxEngine(wanted: boolean): SyntaxEngine | null {
  const loaded = useSyncExternalStore(subscribe, readEngine, readEngine);
  useEffect(() => {
    // Fetches the highlighter chunk once, for the first code that needs it.
    if (wanted && engine === null) loadSyntaxEngine();
  }, [wanted]);
  return wanted ? loaded : null;
}

/** The tokens of `code`, or null while the highlighter loads or for plain text. */
export function useSyntaxTokens(
  code: string,
  language: SyntaxLanguage | null,
): ReadonlyArray<SyntaxToken> | null {
  const loaded = useSyntaxEngine(language !== null && code.length > 0);
  if (loaded === null || language === null) return null;
  return loaded.highlightSyntaxCached(code, language);
}

/** One class per role. Literal strings, so Tailwind finds every one of them. */
export const SYNTAX_ROLE_CLASS_NAMES: Readonly<Record<SyntaxRole, string>> = {
  comment: "text-(color:--syntax-comment)",
  keyword: "text-(color:--syntax-keyword)",
  string: "text-(color:--syntax-string)",
  number: "text-(color:--syntax-number)",
  function: "text-(color:--syntax-function)",
  type: "text-(color:--syntax-type)",
  variable: "text-(color:--syntax-variable)",
  property: "text-(color:--syntax-property)",
  attribute: "text-(color:--syntax-attribute)",
  tag: "text-(color:--syntax-tag)",
  regexp: "text-(color:--syntax-regexp)",
  meta: "text-(color:--syntax-meta)",
  heading: "font-semibold text-(color:--syntax-heading)",
  inserted: "text-(color:--syntax-inserted)",
  deleted: "text-(color:--syntax-deleted)",
  emphasis: "italic",
  strong: "font-semibold",
};

function tokenNode(text: string, role: SyntaxRole | null, key: string): ReactNode {
  return role === null ? (
    text
  ) : (
    <span key={key} className={SYNTAX_ROLE_CLASS_NAMES[role]}>
      {text}
    </span>
  );
}

/**
 * Draws tokens as colored spans. `wordClassName` wraps every whitespace-separated word in one span,
 * as the plain rendering of a shell command does, so the highlighted command breaks lines at the
 * same places (a word like `"$HOME"` spans three tokens but stays one unit).
 */
export function SyntaxTokens({
  tokens,
  wordClassName,
}: {
  tokens: ReadonlyArray<SyntaxToken>;
  wordClassName?: string;
}) {
  // Keys are positions, which are stable for one token list.
  if (wordClassName === undefined) {
    return tokens.map((token, index) => tokenNode(token.text, token.role, String(index)));
  }
  const nodes: ReactNode[] = [];
  let word: ReactNode[] = [];
  const flushWord = () => {
    if (word.length === 0) return;
    nodes.push(
      <span key={nodes.length} className={wordClassName}>
        {word}
      </span>,
    );
    word = [];
  };
  tokens.forEach((token, index) => {
    token.text.split(/(\s+)/u).forEach((part, partIndex) => {
      if (part === "") return;
      if (partIndex % 2 === 1) {
        flushWord();
        nodes.push(part);
      } else {
        word.push(tokenNode(part, token.role, `${index}:${partIndex}`));
      }
    });
  });
  flushWord();
  return nodes;
}

/** `code` in `language`, colored once the highlighter is loaded and plain before that. */
export function HighlightedText({
  code,
  language,
}: {
  code: string;
  language: SyntaxLanguage | null;
}) {
  const tokens = useSyntaxTokens(code, language);
  return tokens === null ? code : <SyntaxTokens tokens={tokens} />;
}
