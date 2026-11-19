import { test } from "node:test";
import assert from "node:assert/strict";
import { controlChar, inShellTerminal, keySequence, leaveToShell, matchShellKey, SHELL_TERMINAL_ATTR, shellKeyLabels, terminalKeyStep } from "./shellKeys.ts";
import { matchPaneKey, type KeyLike } from "./paneKeys.ts";

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("Mac: ⌘J toggles the terminal screen, ⌘⇧J makes a shell, ⌥⇧⌘[ ⌥⇧⌘] move between tabs", () => {
  assert.equal(matchShellKey(key("KeyJ", { metaKey: true }), true), "toggle");
  assert.equal(matchShellKey(key("KeyJ", { metaKey: true, shiftKey: true }), true), "new");
  assert.equal(matchShellKey(key("BracketLeft", { metaKey: true, altKey: true, shiftKey: true }), true), "prev");
  assert.equal(matchShellKey(key("BracketRight", { metaKey: true, altKey: true, shiftKey: true }), true), "next");
  assert.equal(matchShellKey(key("KeyJ", { ctrlKey: true }), true), null, "ctrl+j is the shell's");
  assert.equal(matchShellKey(key("KeyJ", { metaKey: true, repeat: true }), true), null);
  assert.equal(matchShellKey(key("KeyJ", { metaKey: true, isComposing: true }), true), null);
});

test("Windows and Linux: Ctrl+` toggles, Ctrl+Shift+` makes a shell; Ctrl+J stays the shell's line feed", () => {
  assert.equal(matchShellKey(key("Backquote", { ctrlKey: true }), false), "toggle");
  assert.equal(matchShellKey(key("Backquote", { ctrlKey: true, shiftKey: true }), false), "new");
  assert.equal(matchShellKey(key("KeyJ", { ctrlKey: true }), false), null);
  assert.equal(matchShellKey(key("BracketLeft", { ctrlKey: true, altKey: true, shiftKey: true }), false), "prev");
});

test("no shell key is a key of the split view (6k)", () => {
  const codes = ["KeyJ", "Backquote", "BracketLeft", "BracketRight"];
  for (const isMac of [true, false]) {
    for (const code of codes) {
      for (const altKey of [false, true]) {
        for (const shiftKey of [false, true]) {
          const k = key(code, { altKey, shiftKey, ...(isMac ? { metaKey: true } : { ctrlKey: true }) });
          if (matchShellKey(k, isMac)) assert.equal(matchPaneKey(k, isMac), null, `${code} alt=${altKey} shift=${shiftKey} mac=${isMac}`);
        }
      }
    }
  }
});

test("what a key does to the terminal screen: toggle opens or closes, new opens when closed, tab keys need it open", () => {
  assert.equal(terminalKeyStep("toggle", false), "open");
  assert.equal(terminalKeyStep("toggle", true), "close");
  assert.equal(terminalKeyStep("new", false), "open-new");
  assert.equal(terminalKeyStep("new", true), "new");
  assert.equal(terminalKeyStep("prev", true), "prev");
  assert.equal(terminalKeyStep("next", true), "next");
  assert.equal(terminalKeyStep("prev", false), null);
  assert.equal(terminalKeyStep("next", false), null);
});

test("tooltip labels name the same keys the matcher accepts", () => {
  assert.deepEqual(shellKeyLabels(true), { toggle: "⌘J", create: "⌘⇧J", cycle: "⌥⇧⌘[ ⌥⇧⌘]" });
  assert.deepEqual(shellKeyLabels(false), { toggle: "Ctrl+`", create: "Ctrl+Shift+`", cycle: "Ctrl+Alt+Shift+[ ]" });
});

test("key bar: arrows follow the cursor key mode; the latched Ctrl makes control codes", () => {
  assert.equal(keySequence("up", false), "\x1b[A");
  assert.equal(keySequence("up", true), "\x1bOA");
  assert.equal(keySequence("esc", false), "\x1b");
  assert.equal(keySequence("ctrl-c", false), "\x03");
  assert.equal(controlChar("c"), "\x03");
  assert.equal(controlChar("D"), "\x04");
  assert.equal(controlChar("["), "\x1b");
  assert.equal(controlChar("1"), null);
  assert.equal(controlChar("한"), null);
});

test("keys typed in a shell: Ctrl keys are the shell's; a Mac's ⌘ keys stay the app's", () => {
  const inside = { closest: (s: string) => (s === `[${SHELL_TERMINAL_ATTR}]` ? {} : null) };
  const outside = { closest: () => null };
  assert.equal(inShellTerminal(inside as unknown as EventTarget), true);
  assert.equal(inShellTerminal(outside as unknown as EventTarget), false);
  assert.equal(inShellTerminal(null), false);
  const ev = (target: unknown, ctrlKey: boolean, metaKey: boolean) => ({ target: target as EventTarget, ctrlKey, metaKey });
  assert.equal(leaveToShell(ev(inside, true, false), true), true, "ctrl+b in the shell on a Mac");
  assert.equal(leaveToShell(ev(inside, true, false), false), true, "ctrl+d in the shell elsewhere");
  assert.equal(leaveToShell(ev(inside, false, true), true), false, "⌘D in the shell on a Mac is the split view's");
  assert.equal(leaveToShell(ev(outside, true, false), true), false, "ctrl+b in the composer");
});
