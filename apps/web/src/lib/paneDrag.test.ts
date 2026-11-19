import assert from "node:assert/strict";
import { test } from "node:test";

import { dragSourceOf, paneTargetOf, sourcePaneId } from "./paneDrag.ts";
import { EMPTY_LAYOUT, openSession, openShellPane } from "./paneLayout.ts";
import { matchPaneKey, type KeyLike } from "./paneKeys.ts";
import { leaveToShell, SHELL_TERMINAL_ATTR } from "./shellKeys.ts";

test("drag sources: a pane (session or shell), a sidebar session row, the terminal row; anything else is not ours", () => {
  assert.deepEqual(dragSourceOf({ kind: "pane", paneId: "p1", sessionKey: "claude:a:1", title: "T" }), {
    kind: "pane", paneId: "p1", sessionKey: "claude:a:1", shellId: null, title: "T",
  });
  assert.deepEqual(dragSourceOf({ kind: "pane", paneId: "p1", sessionKey: null, shellId: "sh-aaaaaaaaaaaa", title: "zsh" }), {
    kind: "pane", paneId: "p1", sessionKey: null, shellId: "sh-aaaaaaaaaaaa", title: "zsh",
  });
  assert.deepEqual(dragSourceOf({ kind: "shell-new" }), { kind: "shell-new" });
  const s = { key: "claude:a:1" };
  assert.deepEqual(dragSourceOf({ session: s, groupKey: "g" }), { kind: "session", sessionKey: "claude:a:1", session: s });
  assert.equal(dragSourceOf(null), null);
  assert.equal(dragSourceOf({ kind: "split-tab", tabId: "t" }), null);
  assert.equal(dragSourceOf({}), null);
});

test("drop targets: a pane or the empty view", () => {
  assert.deepEqual(paneTargetOf({ kind: "pane-target", paneId: "p1" }), { kind: "pane-target", paneId: "p1" });
  assert.deepEqual(paneTargetOf({ kind: "pane-target", paneId: null }), { kind: "pane-target", paneId: null });
  assert.equal(paneTargetOf({ groupKey: "g" }), null);
});

test("the pane a drag already is: a pane's own, the session's pane, none for a new shell", () => {
  const l = openSession(EMPTY_LAYOUT, "A", () => "p1");
  assert.equal(sourcePaneId(l, { kind: "pane", paneId: "p9", sessionKey: null, shellId: null, title: "" }), "p9");
  assert.equal(sourcePaneId(l, { kind: "session", sessionKey: "A", session: { key: "A" } as never }), "p1");
  assert.equal(sourcePaneId(l, { kind: "session", sessionKey: "B", session: { key: "B" } as never }), null);
  assert.equal(sourcePaneId(openShellPane(l, "sh-aaaaaaaaaaaa", () => "p2"), { kind: "shell-new" }), null);
});

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const inShell = { closest: (selector: string) => (selector === `[${SHELL_TERMINAL_ATTR}]` ? {} : null) };

test("a focused shell pane keeps Ctrl keys: every pane or tab key left to the shell off a Mac, none on a Mac", () => {
  const codes = [
    "KeyD", "KeyW", "KeyT", "KeyN", "KeyB", "BracketLeft", "BracketRight", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
    ...Array.from({ length: 9 }, (_, i) => `Digit${i + 1}`),
  ];
  let matched = 0;
  for (const code of codes) {
    for (const altKey of [false, true]) {
      for (const shiftKey of [false, true]) {
        const win = key(code, { ctrlKey: true, altKey, shiftKey });
        if (matchPaneKey(win, false)) {
          matched++;
          assert.equal(leaveToShell({ target: inShell as never, ctrlKey: true, metaKey: false }, false), true, `${code} alt=${altKey} shift=${shiftKey}`);
        }
        const mac = key(code, { metaKey: true, altKey, shiftKey });
        if (matchPaneKey(mac, true)) {
          assert.equal(leaveToShell({ target: inShell as never, ctrlKey: false, metaKey: true }, true), false, `mac ${code}`);
        }
      }
    }
  }
  assert.ok(matched > 20, `checked ${matched} pane and tab key combinations`);
});
