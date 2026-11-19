import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLatches, BAR_ROWS, barKeyData, isModifier, NO_LATCHES, type BarKeyId } from "./keyBar.ts";

const ctrl = { ctrl: true, alt: false };
const alt = { ctrl: false, alt: true };
const both = { ctrl: true, alt: true };

test("the bar has two rows of ten keys, twenty distinct ids, each with a name", () => {
  assert.equal(BAR_ROWS.length, 2);
  assert.deepEqual(BAR_ROWS.map((r) => r.length), [10, 10]);
  const ids = BAR_ROWS.flat().map((k) => k.id);
  assert.equal(new Set(ids).size, 20);
  for (const k of BAR_ROWS.flat()) {
    assert.ok(k.name.length > 0 && k.label.length > 0, k.id);
  }
  // The keys the phone's keyboard lacks that the request names.
  for (const id of ["esc", "tab", "ctrl", "up", "down", "left", "right", "pipe", "tilde"] as const) assert.ok(ids.includes(id), id);
  assert.deepEqual(BAR_ROWS.flat().filter((k) => isModifier(k.id)).map((k) => k.id), ["ctrl", "alt"]);
});

test("keys send the bytes a terminal reads", () => {
  const send = (id: BarKeyId, appCursor = false) => barKeyData(id, NO_LATCHES, appCursor);
  assert.equal(send("esc"), "\x1b");
  assert.equal(send("tab"), "\t");
  assert.equal(send("ctrl-c"), "\x03");
  assert.equal(send("ctrl-d"), "\x04");
  assert.equal(send("pipe"), "|");
  assert.equal(send("tilde"), "~");
  assert.equal(send("slash"), "/");
  assert.equal(send("dash"), "-");
  assert.equal(send("backslash"), "\\");
  assert.equal(send("up"), "\x1b[A");
  assert.equal(send("down"), "\x1b[B");
  assert.equal(send("right"), "\x1b[C");
  assert.equal(send("left"), "\x1b[D");
  assert.equal(send("home"), "\x1b[H");
  assert.equal(send("end"), "\x1b[F");
  assert.equal(send("pgup"), "\x1b[5~");
  assert.equal(send("pgdn"), "\x1b[6~");
  // The modifiers and Paste send nothing themselves.
  for (const id of ["ctrl", "alt", "paste"] as const) assert.equal(send(id), null, id);
});

test("arrows, Home and End follow the shell's cursor key mode (vim and less switch it)", () => {
  assert.equal(barKeyData("up", NO_LATCHES, true), "\x1bOA");
  assert.equal(barKeyData("left", NO_LATCHES, true), "\x1bOD");
  assert.equal(barKeyData("home", NO_LATCHES, true), "\x1bOH");
  assert.equal(barKeyData("end", NO_LATCHES, true), "\x1bOF");
  // The web's key bar rule (shellKeys.ts keySequence) is the same for the arrows.
  assert.equal(barKeyData("down", NO_LATCHES, false), "\x1b[B");
});

test("a latched Ctrl or Alt gives the modified forms (CSI 1;m X, m = 1 + 2 Alt + 4 Ctrl)", () => {
  assert.equal(barKeyData("left", ctrl, false), "\x1b[1;5D", "ctrl+left");
  assert.equal(barKeyData("right", alt, false), "\x1b[1;3C", "alt+right");
  assert.equal(barKeyData("up", both, true), "\x1b[1;7A", "the modified form ignores the cursor key mode");
  assert.equal(barKeyData("home", ctrl, false), "\x1b[1;5H");
  assert.equal(barKeyData("end", alt, true), "\x1b[1;3F");
  assert.equal(barKeyData("pgup", ctrl, false), "\x1b[5;5~");
  assert.equal(barKeyData("pgdn", alt, false), "\x1b[6;3~");
  // Alt puts Escape in front of a symbol key and Tab; Ctrl turns a symbol that has a control code into it.
  assert.equal(barKeyData("pipe", alt, false), "\x1b|");
  assert.equal(barKeyData("backslash", ctrl, false), "\x1c", "ctrl+\\ is FS");
  assert.equal(barKeyData("slash", ctrl, false), "/", "no control code: the key sends as it is");
  assert.equal(barKeyData("tab", alt, false), "\x1b\t");
  assert.equal(barKeyData("tab", ctrl, false), "\t");
  // ^C, ^D and Esc are fixed.
  assert.equal(barKeyData("ctrl-c", alt, false), "\x03");
  assert.equal(barKeyData("esc", ctrl, false), "\x1b");
});

test("a latch changes what the keyboard typed next: Ctrl to a control code, Alt to an Escape prefix", () => {
  assert.equal(applyLatches("c", ctrl), "\x03");
  assert.equal(applyLatches("C", ctrl), "\x03");
  assert.equal(applyLatches("[", ctrl), "\x1b");
  assert.equal(applyLatches("a", alt), "\x1ba");
  assert.equal(applyLatches("d", both), "\x1b\x04", "ctrl then alt: Escape then the control code");
  assert.equal(applyLatches("a", NO_LATCHES), "a");
  // Text that is not one character (a composed word, an escape sequence) is not changed by Ctrl.
  assert.equal(applyLatches("hello", ctrl), "hello");
  assert.equal(applyLatches("\x1b[A", ctrl), "\x1b[A");
  assert.equal(applyLatches("hello", alt), "\x1bhello");
  // A character with no control code is sent as it is.
  assert.equal(applyLatches("1", ctrl), "1");
  assert.equal(applyLatches("한", ctrl), "한");
});
