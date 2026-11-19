import assert from "node:assert/strict";
import { test } from "node:test";

import { matchPaneKey, type KeyLike } from "./paneKeys.ts";

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});
const cmd = { metaKey: true };

test("iTerm's pane keys on a Mac", () => {
  assert.deepEqual(matchPaneKey(key("KeyD", cmd), true), { type: "split", edge: "right" });
  assert.deepEqual(matchPaneKey(key("KeyD", { ...cmd, shiftKey: true }), true), { type: "split", edge: "bottom" });
  assert.deepEqual(matchPaneKey(key("KeyW", cmd), true), { type: "close", onlyWithPanes: true });
  assert.deepEqual(matchPaneKey(key("KeyW", { ...cmd, altKey: true }), true), { type: "close", onlyWithPanes: false });
  assert.deepEqual(matchPaneKey(key("ArrowLeft", { ...cmd, altKey: true }), true), { type: "focus", dir: "left" });
  assert.deepEqual(matchPaneKey(key("ArrowDown", { ...cmd, altKey: true }), true), { type: "focus", dir: "down" });
  assert.deepEqual(matchPaneKey(key("BracketLeft", cmd), true), { type: "cycle", delta: -1 });
  assert.deepEqual(matchPaneKey(key("BracketRight", cmd), true), { type: "cycle", delta: 1 });
  assert.deepEqual(matchPaneKey(key("KeyT", { ...cmd, altKey: true }), true), { type: "toggleMode" });
  assert.deepEqual(matchPaneKey(key("KeyB", { ...cmd, altKey: true }), true), { type: "togglePanel" });
});

test("keys the app or the browser keeps for themselves are not pane keys", () => {
  assert.equal(matchPaneKey(key("KeyB", cmd), true), null, "⌘B is the sidebar");
  assert.equal(matchPaneKey(key("KeyD"), true), null);
  assert.equal(matchPaneKey(key("KeyD", { ctrlKey: true }), true), null, "ctrl+D stays with the terminal-like input");
  assert.equal(matchPaneKey(key("KeyD", { ...cmd, ctrlKey: true }), true), null);
  assert.equal(matchPaneKey(key("KeyD", { ...cmd, altKey: true }), true), null);
  assert.equal(matchPaneKey(key("ArrowLeft", cmd), true), null, "⌘← is line start");
  assert.equal(matchPaneKey(key("ArrowLeft", { ...cmd, altKey: true, shiftKey: true }), true), null);
  assert.equal(matchPaneKey(key("KeyO", { ctrlKey: true }), true), null, "ctrl+o is the terminal mode's transcript");
  assert.equal(matchPaneKey(key("KeyD", { ...cmd, repeat: true }), true), null);
  assert.equal(matchPaneKey(key("KeyD", { ...cmd, isComposing: true }), true), null);
});

test("other platforms use Ctrl where a Mac uses ⌘", () => {
  assert.deepEqual(matchPaneKey(key("KeyD", { ctrlKey: true }), false), { type: "split", edge: "right" });
  assert.deepEqual(matchPaneKey(key("ArrowUp", { ctrlKey: true, altKey: true }), false), { type: "focus", dir: "up" });
  assert.equal(matchPaneKey(key("KeyD", cmd), false), null);
});

test("tab keys: iTerm's, each with a twin Chrome leaves to the page", () => {
  assert.deepEqual(matchPaneKey(key("KeyT", cmd), true), { type: "newTab" });
  assert.deepEqual(matchPaneKey(key("KeyN", { ...cmd, altKey: true }), true), { type: "newTab" });
  assert.deepEqual(matchPaneKey(key("BracketLeft", { ...cmd, shiftKey: true }), true), { type: "tab", delta: -1 });
  assert.deepEqual(matchPaneKey(key("BracketRight", { ...cmd, shiftKey: true }), true), { type: "tab", delta: 1 });
  assert.deepEqual(matchPaneKey(key("BracketLeft", { ...cmd, altKey: true }), true), { type: "tab", delta: -1 });
  assert.deepEqual(matchPaneKey(key("BracketRight", { ...cmd, altKey: true }), true), { type: "tab", delta: 1 });
  const opt = { ...cmd, altKey: true };
  assert.deepEqual(matchPaneKey(key("Digit1", opt), true), { type: "tabAt", index: 0 });
  assert.deepEqual(matchPaneKey(key("Digit9", opt), true), { type: "tabAt", index: 8 });
  assert.deepEqual(matchPaneKey(key("KeyW", { ...cmd, altKey: true, shiftKey: true }), true), { type: "closeTab" });
  assert.deepEqual(matchPaneKey(key("KeyT", { ctrlKey: true }), false), { type: "newTab" });
  assert.deepEqual(matchPaneKey(key("Digit2", { ctrlKey: true, altKey: true }), false), { type: "tabAt", index: 1 });
});

test("pane number keys: cmd+1..9 by event.code, the tab number key is the same with alt", () => {
  assert.deepEqual(matchPaneKey(key("Digit1", cmd), true), { type: "paneAt", index: 0 });
  assert.deepEqual(matchPaneKey(key("Digit9", cmd), true), { type: "paneAt", index: 8 });
  assert.deepEqual(matchPaneKey(key("Digit3", { ctrlKey: true }), false), { type: "paneAt", index: 2 });
  assert.equal(matchPaneKey(key("Digit1", { ...cmd, shiftKey: true }), true), null);
  assert.equal(matchPaneKey(key("Digit1", { ctrlKey: true }), true), null, "ctrl+1 on a Mac is not cmd+1");
});

test("cmd+shift+T reopens the last closed pane", () => {
  assert.deepEqual(matchPaneKey(key("KeyT", { ...cmd, shiftKey: true }), true), { type: "reopenPane" });
  assert.deepEqual(matchPaneKey(key("KeyT", { ctrlKey: true, shiftKey: true }), false), { type: "reopenPane" });
  assert.equal(matchPaneKey(key("KeyT", { ...cmd, shiftKey: true, altKey: true }), true), null);
});

test("tab keys leave the pane keys and the app's keys alone", () => {
  // The pane keys keep their meaning: ⌘[ ⌘] are panes, ⌥⌘T is the chat and terminal switch, ⌘W closes a pane.
  assert.deepEqual(matchPaneKey(key("BracketLeft", cmd), true), { type: "cycle", delta: -1 });
  assert.deepEqual(matchPaneKey(key("KeyT", { ...cmd, altKey: true }), true), { type: "toggleMode" });
  assert.deepEqual(matchPaneKey(key("KeyW", cmd), true), { type: "close", onlyWithPanes: true });
  assert.equal(matchPaneKey(key("BracketLeft", { ...cmd, altKey: true, shiftKey: true }), true), null, "⌥⇧⌘[ is nobody's");
  assert.equal(matchPaneKey(key("Digit0", cmd), true), null);
  assert.equal(matchPaneKey(key("Digit1", { ...cmd, altKey: true, shiftKey: true }), true), null);
  assert.equal(matchPaneKey(key("Digit1"), true), null, "a bare digit is typing");
  assert.equal(matchPaneKey(key("KeyT", { ctrlKey: true }), true), null, "ctrl+T on a Mac is not ⌘T");
  assert.equal(matchPaneKey(key("KeyN", cmd), true), null, "⌘N stays Chrome's new window");
  assert.equal(matchPaneKey(key("Digit1", { ...cmd, repeat: true }), true), null);
});
