import assert from "node:assert/strict";
import { test } from "node:test";

import { highlightSyntax, highlightSyntaxCached } from "./syntaxHighlight.ts";
import { resolveSyntaxLanguage, syntaxLanguageForPath } from "./syntaxLanguages.ts";
import { splitSyntaxLines, type SyntaxRole, type SyntaxToken } from "./syntaxTokens.ts";

function rolesOf(tokens: ReadonlyArray<SyntaxToken> | null): Array<[string, SyntaxRole]> {
  assert.ok(tokens);
  return tokens.flatMap((token) =>
    token.role === null ? [] : [[token.text, token.role] as [string, SyntaxRole]],
  );
}

function joined(tokens: ReadonlyArray<SyntaxToken> | null): string {
  assert.ok(tokens);
  return tokens.map((token) => token.text).join("");
}

test("fence names and paths resolve to registered grammars, plain text to none", () => {
  assert.equal(resolveSyntaxLanguage("ts"), "typescript");
  assert.equal(resolveSyntaxLanguage("TSX"), "typescript");
  assert.equal(resolveSyntaxLanguage("sh"), "bash");
  assert.equal(resolveSyntaxLanguage("console"), "shell");
  assert.equal(resolveSyntaxLanguage("jsonl"), "json");
  assert.equal(resolveSyntaxLanguage("html"), "xml");
  assert.equal(resolveSyntaxLanguage("gitignore"), "ini");
  assert.equal(resolveSyntaxLanguage("app.config.py"), "python");
  for (const plain of ["text", "plaintext", "mermaid", "", undefined, "cypher"]) {
    assert.equal(resolveSyntaxLanguage(plain), null, String(plain));
  }
  assert.equal(syntaxLanguageForPath("/w/src/a.test.ts"), "typescript");
  assert.equal(syntaxLanguageForPath("Dockerfile"), "dockerfile");
  assert.equal(syntaxLanguageForPath("docker/Dockerfile.dev"), "dockerfile");
  assert.equal(syntaxLanguageForPath(".env.local"), "properties");
  assert.equal(syntaxLanguageForPath("README"), null);
});

test("typescript: keywords, strings, comments and the code inside a template string", () => {
  const code = "const a = `x ${b}`; // note\nfunction f(n = 1) { return /r/g; }";
  const tokens = highlightSyntax(code, "typescript");
  assert.equal(joined(tokens), code);
  const roles = rolesOf(tokens);
  assert.deepEqual(roles.find(([text]) => text === "const"), ["const", "keyword"]);
  assert.deepEqual(roles.find(([text]) => text === "// note"), ["// note", "comment"]);
  assert.deepEqual(roles.find(([text]) => text === "/r/g"), ["/r/g", "regexp"]);
  assert.deepEqual(roles.find(([text]) => text === "f"), ["f", "function"]);
  // `${b}` resets to plain code inside the string.
  assert.ok(!roles.some(([text, role]) => text.includes("b") && role === "string"));
});

test("python, bash, json and diff take their roles", () => {
  const python = rolesOf(highlightSyntax('# 지금\n@cache\ndef f(x="a"):\n    return 1', "python"));
  assert.deepEqual(python, [
    ["# 지금", "comment"],
    ["@cache", "meta"],
    ["def", "keyword"],
    ["f", "function"],
    ['"a"', "string"],
    ["return", "keyword"],
    ["1", "number"],
  ]);
  const bash = rolesOf(highlightSyntax('#!/bin/sh\necho "$HOME" # c', "bash"));
  assert.deepEqual(bash, [
    ["#!/bin/sh", "meta"],
    ["echo", "function"],
    ['"', "string"],
    ["$HOME", "variable"],
    ['"', "string"],
    ["# c", "comment"],
  ]);
  const json = rolesOf(highlightSyntax('{"a": 1, "b": "s"}', "json"));
  assert.deepEqual(json, [
    ['"a"', "property"],
    ["1", "number"],
    ['"b"', "property"],
    ['"s"', "string"],
  ]);
  const diff = rolesOf(highlightSyntax("@@ -1,1 +1,1 @@\n-old\n+new", "diff"));
  assert.deepEqual(diff, [
    ["@@ -1,1 +1,1 @@", "meta"],
    ["-old", "deleted"],
    ["+new", "inserted"],
  ]);
});

test("unfinished code still joins back to the whole text", () => {
  for (const code of ["const s = `abc ${\nfoo", '{"a": [1, 2', "def f(:\n  '''open"]) {
    for (const language of ["typescript", "json", "python"] as const) {
      const tokens = highlightSyntax(code, language);
      if (tokens !== null) assert.equal(joined(tokens), code);
    }
  }
});

test("the cache returns the same tokens for the same code", () => {
  const first = highlightSyntaxCached("let x = 1", "javascript");
  assert.equal(highlightSyntaxCached("let x = 1", "javascript"), first);
});

test("tokens split into lines keep their roles", () => {
  const lines = splitSyntaxLines([
    { text: "/* a\nb */", role: "comment" },
    { text: "\nx", role: null },
  ]);
  assert.deepEqual(lines, [
    [{ text: "/* a", role: "comment" }],
    [{ text: "b */", role: "comment" }],
    [{ text: "x", role: null }],
  ]);
});
