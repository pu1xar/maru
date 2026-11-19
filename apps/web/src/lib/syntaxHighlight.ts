// The syntax highlighter: highlight.js core with the grammars `syntaxLanguages.ts` lists, read
// back as flat tokens that carry one color role each (`syntaxTokens.ts`). The colors are theme
// tokens, so nothing here knows a color. Components load this module on demand
// (`components/chat/SyntaxHighlight.tsx`), so a page without code never fetches it.
import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import dos from "highlight.js/lib/languages/dos";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import groovy from "highlight.js/lib/languages/groovy";
import http from "highlight.js/lib/languages/http";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nginx from "highlight.js/lib/languages/nginx";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import properties from "highlight.js/lib/languages/properties";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import vbscript from "highlight.js/lib/languages/vbscript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

import { SYNTAX_LANGUAGES, type SyntaxLanguage } from "./syntaxLanguages.ts";
import type { SyntaxRole, SyntaxToken } from "./syntaxTokens.ts";

const GRAMMARS: Readonly<Record<SyntaxLanguage, LanguageFn>> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  dos,
  go,
  graphql,
  groovy,
  http,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  makefile,
  markdown,
  nginx,
  php,
  powershell,
  properties,
  python,
  ruby,
  rust,
  shell,
  sql,
  typescript,
  vbscript,
  xml,
  yaml,
};

// Its own instance, so grammars registered elsewhere never change what this one parses.
const highlighter = hljs.newInstance();
for (const name of SYNTAX_LANGUAGES) highlighter.registerLanguage(name, GRAMMARS[name]);

/**
 * highlight.js scopes (its "Scope Reference") to color roles. Null resets to the plain code color
 * for the scope's own text (`${}` inside a template string, a tag's brackets); a scope missing
 * here keeps its parent's role.
 */
const SCOPE_ROLES: Readonly<Record<string, SyntaxRole | null>> = {
  comment: "comment",
  quote: "comment",
  doctag: "keyword",
  keyword: "keyword",
  bullet: "keyword",
  "template-tag": "keyword",
  built_in: "function",
  function: "function",
  title: "function",
  "title.function": "function",
  "title.function.invoke": "function",
  type: "type",
  class: "type",
  "title.class": "type",
  "title.class.inherited": "type",
  literal: "number",
  number: "number",
  symbol: "number",
  "variable.constant": "number",
  string: "string",
  char: "string",
  code: "string",
  formula: "string",
  link: "string",
  regexp: "regexp",
  "char.escape": "regexp",
  variable: "variable",
  "variable.language": "variable",
  "template-variable": "variable",
  property: "property",
  attr: "property",
  attribute: "attribute",
  "selector-id": "attribute",
  "selector-class": "attribute",
  "selector-attr": "attribute",
  "selector-pseudo": "attribute",
  name: "tag",
  "selector-tag": "tag",
  meta: "meta",
  "meta.prompt": "meta",
  section: "heading",
  addition: "inserted",
  deletion: "deleted",
  emphasis: "emphasis",
  strong: "strong",
  subst: null,
  params: null,
  tag: null,
  operator: null,
  punctuation: null,
};

function scopeRole(scope: string, parent: SyntaxRole | null): SyntaxRole | null {
  if (scope.startsWith("language:")) return null;
  if (Object.hasOwn(SCOPE_ROLES, scope)) return SCOPE_ROLES[scope]!;
  const head = scope.split(".")[0]!;
  return Object.hasOwn(SCOPE_ROLES, head) ? SCOPE_ROLES[head]! : parent;
}

/** highlight.js's token tree (`TokenTree` in its core): text leaves under scoped nodes. */
interface TokenNode {
  readonly scope?: string;
  readonly children: ReadonlyArray<string | TokenNode>;
}

function collectTokens(node: TokenNode, role: SyntaxRole | null, out: SyntaxToken[]) {
  const own = node.scope === undefined ? role : scopeRole(node.scope, role);
  for (const child of node.children) {
    if (typeof child !== "string") {
      collectTokens(child, own, out);
      continue;
    }
    if (!child) continue;
    const last = out[out.length - 1];
    if (last && last.role === own) out[out.length - 1] = { text: last.text + child, role: own };
    else out.push({ text: child, role: own });
  }
}

/**
 * The tokens of `code` in `language`, or null when the grammar could not read all of it (the
 * caller then draws the plain text). The tokens' text joins back to exactly `code`.
 */
export function highlightSyntax(code: string, language: SyntaxLanguage): SyntaxToken[] | null {
  const result = highlighter.highlight(code, { language, ignoreIllegals: true });
  // highlight.js recovers from a grammar error by returning what it read so far; the length
  // check turns that partial result into plain text instead of dropping the rest.
  const root = (result._emitter as unknown as { rootNode?: TokenNode }).rootNode;
  if (!root || result.errorRaised) return null;
  const tokens: SyntaxToken[] = [];
  collectTokens(root, null, tokens);
  let length = 0;
  for (const token of tokens) length += token.text.length;
  return length === code.length ? tokens : null;
}

const CACHE_MAX_ENTRIES = 500;
const CACHE_MAX_CHARS = 8 * 1024 * 1024;
const cache = new Map<string, SyntaxToken[] | null>();
let cachedChars = 0;

/**
 * `highlightSyntax` through a cache, so virtualized rows that mount again and blocks that render
 * again reuse their tokens. The oldest entries leave first; a miss only costs a re-highlight.
 */
export function highlightSyntaxCached(
  code: string,
  language: SyntaxLanguage,
): SyntaxToken[] | null {
  const key = `${language}\0${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const tokens = highlightSyntax(code, language);
  cache.set(key, tokens);
  cachedChars += key.length;
  while (cache.size > CACHE_MAX_ENTRIES || cachedChars > CACHE_MAX_CHARS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
    cachedChars -= oldest.length;
  }
  return tokens;
}
