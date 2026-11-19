import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_MODE_KEY,
  DEFAULT_TERMINAL_PREFS,
  FONT_SIZE_KEY,
  SESSION_MODE_PREFIX,
  normalizeTerminalPrefs,
  readTerminalPrefsFrom,
  resolveViewMode,
  terminalCell,
  terminalFontStack,
  terminalPrefEntries,
  terminalRootStyle,
} from "./viewMode.ts";

test("the stored terminal settings read from JSON text and write back as the same keys", () => {
  const raw = (values: Record<string, string>) => (key: string) => values[key] ?? null;
  assert.deepEqual(readTerminalPrefsFrom(raw({})), DEFAULT_TERMINAL_PREFS);
  assert.deepEqual(readTerminalPrefsFrom(raw({ [DEFAULT_MODE_KEY]: '"terminal"', [FONT_SIZE_KEY]: "16" })), { defaultMode: "terminal", fontSize: 16 });
  // Text that is not JSON, or not an offered value, is the default.
  assert.deepEqual(readTerminalPrefsFrom(raw({ [DEFAULT_MODE_KEY]: "{", [FONT_SIZE_KEY]: "99" })), DEFAULT_TERMINAL_PREFS);
  assert.deepEqual(terminalPrefEntries({ defaultMode: "terminal", fontSize: 16 }), [
    [DEFAULT_MODE_KEY, '"terminal"'],
    [FONT_SIZE_KEY, "16"],
  ]);
  assert.deepEqual(terminalPrefEntries(DEFAULT_TERMINAL_PREFS), [
    [DEFAULT_MODE_KEY, null],
    [FONT_SIZE_KEY, null],
  ]);
  assert.equal(SESSION_MODE_PREFIX, "maru_view_mode:");
});

test("a session's own mode wins over the default; anything else falls back", () => {
  assert.equal(resolveViewMode("terminal", "chat"), "terminal");
  assert.equal(resolveViewMode("chat", "terminal"), "chat");
  assert.equal(resolveViewMode(null, "terminal"), "terminal");
  assert.equal(resolveViewMode("tui", "chat"), "chat");
});

test("stored terminal settings keep only offered values", () => {
  assert.deepEqual(normalizeTerminalPrefs({}), DEFAULT_TERMINAL_PREFS);
  assert.deepEqual(normalizeTerminalPrefs({ defaultMode: "terminal", fontSize: 13 }), {
    defaultMode: "terminal",
    fontSize: 13,
  });
  assert.deepEqual(normalizeTerminalPrefs({ defaultMode: "x", fontSize: 13.5 }), DEFAULT_TERMINAL_PREFS);
  // A typed whole size is kept from 11 to 22 and nothing else is.
  assert.equal(normalizeTerminalPrefs({ fontSize: 11 }).fontSize, 11);
  assert.equal(normalizeTerminalPrefs({ fontSize: 22 }).fontSize, 22);
  assert.equal(normalizeTerminalPrefs({ fontSize: 10 }).fontSize, DEFAULT_TERMINAL_PREFS.fontSize);
  assert.equal(normalizeTerminalPrefs({ fontSize: 23 }).fontSize, DEFAULT_TERMINAL_PREFS.fontSize);
});

test("the default font starts with the installed Bon Google Sans Code and falls back to the web copy", () => {
  assert.match(terminalFontStack("bon"), /^"Bon Google Sans Code", "Maru Bon Google Sans Code"/);
});

test("the terminal cell follows iTerm2's formula for the profile (101% rows): 9 x 20 at 15px", () => {
  // Expected rows from a Swift copy of iTerm2's code over CoreText metrics of the installed font.
  const rows = Object.fromEntries([11, 12, 13, 14, 15, 16, 17, 18, 20].map((n) => [n, terminalCell("bon", n).height]));
  assert.deepEqual(rows, { 11: 15, 12: 17, 13: 18, 14: 19, 15: 20, 16: 22, 17: 23, 18: 24, 20: 27 });
  assert.deepEqual(terminalCell("bon", 15), { width: 9, height: 20, letterSpacing: 0 });
  assert.deepEqual(terminalCell("bon-web", 12), { width: 7, height: 17, letterSpacing: -0.2 });
  assert.equal(terminalCell("bon", 20).width, 12);
  assert.deepEqual(terminalRootStyle({ font: "bon", fontSize: 15 }), {
    "--term-font": terminalFontStack("bon"),
    "--term-font-size": "15px",
    "--term-line-height": "20px",
    "--term-cell": "9px",
    "--term-letter-spacing": "0px",
  });
});
