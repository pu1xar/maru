import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_REGISTRY, applyLeanMessage, dragOutcome, isLeanSearch, leanKeys, leanPath, parseLeanSizes,
  pointerOutside, popupFeatures, popupName, rekeyRegistry, rememberLeanSize, windowIdFor,
} from "./leanWindow.logic.ts";

const NONE = new Set<string>();

test("address: the lean window is `?window=lean` with the session's id", () => {
  assert.equal(leanPath("claude:acct:abc-123"), "/?s=abc-123&window=lean");
  assert.equal(leanPath("bare"), "/?s=bare&window=lean");
  assert.equal(isLeanSearch("?s=abc&window=lean"), true);
  assert.equal(isLeanSearch("?s=abc"), false);
  assert.equal(isLeanSearch("?window=other"), false);
  assert.equal(isLeanSearch(""), false);
});

test("outside the window: any coordinate beyond the viewport, none yet is inside", () => {
  const vp = { w: 1000, h: 700 };
  assert.equal(pointerOutside({ x: 10, y: 10 }, vp), false);
  assert.equal(pointerOutside({ x: 0, y: 0 }, vp), false);
  assert.equal(pointerOutside({ x: 999, y: 699 }, vp), false);
  assert.equal(pointerOutside({ x: -1, y: 10 }, vp), true);
  assert.equal(pointerOutside({ x: 10, y: -1 }, vp), true);
  assert.equal(pointerOutside({ x: 1000, y: 10 }, vp), true);
  assert.equal(pointerOutside({ x: 10, y: 700 }, vp), true);
  assert.equal(pointerOutside(null, vp), false);
});

test("drag result: sidebar row out opens a window and leaves the original alone", () => {
  assert.deepEqual(dragOutcome({ kind: "sidebar", sessionKey: "claude:a:1" }, true, NONE), { type: "open", sessionKey: "claude:a:1", closePaneId: null });
});

test("drag result: a pane out opens a window and removes the pane", () => {
  assert.deepEqual(dragOutcome({ kind: "pane", sessionKey: "claude:a:1", paneId: "p1" }, true, NONE), { type: "open", sessionKey: "claude:a:1", closePaneId: "p1" });
});

test("drag result: a drop inside the window is not this feature's", () => {
  assert.deepEqual(dragOutcome({ kind: "sidebar", sessionKey: "claude:a:1" }, false, NONE), { type: "none" });
  assert.deepEqual(dragOutcome({ kind: "pane", sessionKey: "claude:a:1", paneId: "p1" }, false, NONE), { type: "none" });
});

test("drag result: a session with a lean window already brings it forward instead of a second one", () => {
  const open = new Set(["claude:a:1"]);
  assert.deepEqual(dragOutcome({ kind: "sidebar", sessionKey: "claude:a:1" }, true, open), { type: "focus", sessionKey: "claude:a:1", closePaneId: null });
  // A pane still leaves the split view; its session is already in the lean window.
  assert.deepEqual(dragOutcome({ kind: "pane", sessionKey: "claude:a:1", paneId: "p1" }, true, open), { type: "focus", sessionKey: "claude:a:1", closePaneId: "p1" });
  assert.deepEqual(dragOutcome({ kind: "sidebar", sessionKey: "claude:a:2" }, true, open), { type: "open", sessionKey: "claude:a:2", closePaneId: null });
});

test("drag result: a pane that holds no session (a shell) does nothing", () => {
  assert.deepEqual(dragOutcome({ kind: "pane", sessionKey: null, paneId: "p1" }, true, NONE), { type: "none" });
});

test("registry: open, close, list and no-op messages keep identity", () => {
  let reg = EMPTY_REGISTRY;
  reg = applyLeanMessage(reg, { type: "open", id: "w1", key: "claude:a:1" });
  reg = applyLeanMessage(reg, { type: "open", id: "w2", key: "codex:b:2" });
  assert.deepEqual([...leanKeys(reg)].sort(), ["claude:a:1", "codex:b:2"]);
  assert.equal(windowIdFor(reg, "codex:b:2"), "w2");
  assert.equal(windowIdFor(reg, "claude:a:9"), null);
  assert.equal(applyLeanMessage(reg, { type: "open", id: "w1", key: "claude:a:1" }), reg);
  assert.equal(applyLeanMessage(reg, { type: "close", id: "nope" }), reg);
  const closed = applyLeanMessage(reg, { type: "close", id: "w1" });
  assert.deepEqual([...leanKeys(closed)], ["codex:b:2"]);
  assert.equal(applyLeanMessage(closed, { type: "list", entries: [{ id: "w2", key: "codex:b:2" }] }), closed);
  const listed = applyLeanMessage(closed, { type: "list", entries: [{ id: "7", key: "claude:a:1" }] });
  assert.deepEqual([...listed], [["7", "claude:a:1"]]);
  assert.deepEqual([...applyLeanMessage(listed, { type: "list", entries: [] })], []);
});

test("registry: a moved session's lean window follows the new key", () => {
  const reg = applyLeanMessage(EMPTY_REGISTRY, { type: "open", id: "w1", key: "claude:a:1" });
  assert.deepEqual([...rekeyRegistry(reg, "claude:a:1", "claude:b:1")], [["w1", "claude:b:1"]]);
  assert.equal(rekeyRegistry(reg, "claude:z:9", "claude:b:9"), reg);
});

test("popup: size per session, features for a popup without a bar", () => {
  assert.equal(popupFeatures(undefined, null), "popup=yes,width=480,height=680");
  assert.equal(popupFeatures({ w: 500, h: 600 }, { x: 1000, y: 300 }), "popup=yes,width=500,height=600,left=750,top=284");
  assert.equal(popupFeatures({ w: 500, h: 600 }, { x: 10, y: 5 }), "popup=yes,width=500,height=600,left=0,top=0");
  assert.equal(popupName("claude:a:1/x"), "maru-lean-claude_a_1_x");
});

test("sizes: kept per session, tiny or malformed values are ignored", () => {
  let sizes = rememberLeanSize({}, "claude:a:1", { w: 500.4, h: 640 });
  assert.deepEqual(sizes, { "claude:a:1": { w: 500, h: 640 } });
  assert.equal(rememberLeanSize(sizes, "claude:a:1", { w: 500, h: 640 }), sizes);
  assert.equal(rememberLeanSize(sizes, "claude:a:1", { w: 100, h: 100 }), sizes);
  sizes = rememberLeanSize(sizes, "codex:b:2", { w: 400, h: 400 });
  assert.deepEqual(parseLeanSizes(JSON.stringify(sizes)), sizes);
  assert.deepEqual(parseLeanSizes("not json"), {});
  assert.deepEqual(parseLeanSizes(null), {});
  assert.deepEqual(parseLeanSizes(JSON.stringify({ a: { w: 10, h: 10 }, b: "x", c: { w: 400, h: 400 } })), { c: { w: 400, h: 400 } });
});
