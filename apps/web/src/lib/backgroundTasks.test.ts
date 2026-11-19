import assert from "node:assert/strict";
import { test } from "node:test";

import { matchPaneKey } from "./paneKeys.ts";
import {
  BACKGROUND_OFFER_AFTER_MS,
  backgroundKeyAction,
  BACKGROUND_KEY_LABEL,
  canBackground,
  isBackgroundKey,
  offerShown,
  toolUseIdOfItem,
  type BackgroundKeyLike,
} from "./backgroundTasks.logic.ts";

const key = (mods: Partial<BackgroundKeyLike> = {}, code = "KeyB"): BackgroundKeyLike => ({
  code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods,
});

test("the tool_use id is what follows :tool: in an item id", () => {
  assert.equal(toolUseIdOfItem("claude:a:s:tool:toolu_01"), "toolu_01");
  assert.equal(toolUseIdOfItem("claude:a:s:msg:1"), null);
  assert.equal(toolUseIdOfItem("claude:a:s:tool:"), null);
});

test("a Bash call offers it once the server names it; an Agent call also waits 2 s from the announcement", () => {
  const now = 100_000;
  assert.equal(offerShown({ kind: "command", announced: false, since: null, now }), false, "the CLI does not hold it in the foreground");
  assert.equal(offerShown({ kind: "command", announced: true, since: now, now }), true, "the CLI registered the Bash call only after its own 2 s");
  assert.equal(offerShown({ kind: "agent", announced: true, since: now, now }), false);
  assert.equal(offerShown({ kind: "agent", announced: true, since: now - BACKGROUND_OFFER_AFTER_MS + 1, now }), false);
  assert.equal(offerShown({ kind: "agent", announced: true, since: now - BACKGROUND_OFFER_AFTER_MS, now }), true);
  assert.equal(offerShown({ kind: "agent", announced: false, since: now - 10_000, now }), false);
  assert.equal(offerShown({ kind: "agent", announced: true, since: null, now }), false);
});

test("ctrl+b sends on every system and leaves the sidebar's cmd+b (Mac) and ctrl+shift+b (elsewhere) alone", () => {
  assert.equal(isBackgroundKey(key({ ctrlKey: true })), true);
  assert.equal(isBackgroundKey(key({ metaKey: true })), false, "cmd+b is the Mac sidebar");
  assert.equal(isBackgroundKey(key({ ctrlKey: true, shiftKey: true })), false, "ctrl+shift+b is the sidebar elsewhere");
  assert.equal(isBackgroundKey(key({ ctrlKey: true, altKey: true })), false);
  assert.equal(isBackgroundKey(key({ ctrlKey: true, isComposing: true })), false);
  assert.equal(isBackgroundKey(key({ ctrlKey: true }, "KeyN")), false);
  assert.equal(BACKGROUND_KEY_LABEL, "ctrl+b");
});

test("no pane key or other window key takes the background key", () => {
  for (const mac of [true, false]) {
    assert.equal(isBackgroundKey(key({ ctrlKey: true })), true);
    assert.equal(matchPaneKey(key({ ctrlKey: true }), mac), null);
  }
});

test("a press right after a send is swallowed, and a press with nothing in the foreground passes", () => {
  const now = 10_000;
  assert.equal(backgroundKeyAction({ enabled: true, foregroundCount: 2, now, quietUntil: 0 }), "send");
  assert.equal(backgroundKeyAction({ enabled: true, foregroundCount: 0, now, quietUntil: 0 }), "pass");
  assert.equal(backgroundKeyAction({ enabled: false, foregroundCount: 2, now, quietUntil: 0 }), "pass");
  assert.equal(backgroundKeyAction({ enabled: true, foregroundCount: 0, now, quietUntil: now + 500 }), "swallow", "the second press of a double press");
  assert.equal(backgroundKeyAction({ enabled: true, foregroundCount: 2, now, quietUntil: now + 500 }), "swallow");
  assert.equal(backgroundKeyAction({ enabled: true, foregroundCount: 2, now, quietUntil: now }), "send", "the quiet time is over");
});

test("only a Claude session this server runs offers it", () => {
  assert.equal(canBackground({ provider: "claude", owner: "ui" }, false), true);
  assert.equal(canBackground({ provider: "claude", owner: "terminal" }, false), false);
  assert.equal(canBackground({ provider: "claude", owner: "ui" }, true), false);
  assert.equal(canBackground({ provider: "codex", owner: "ui" }, false), false);
});
