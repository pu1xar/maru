import { test } from "node:test";
import assert from "node:assert/strict";
import { backdropOptions, barHeightAt, macButtonPosition, overlayOptions, titleBarOptions } from "./chrome.ts";

test("title bar: Mac traffic lights centred on the page's top bar, as T3 places them", () => {
  assert.deepEqual(titleBarOptions("darwin", true), { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 15 } });
  // 44 px bar: the 14 px buttons' centre is 15 + 7 = 22, the bar's middle.
  assert.equal(macButtonPosition(44).y + 7, 22);
  // A larger UI scale (125 %: 55 px) moves them with the bar.
  assert.deepEqual(macButtonPosition(55), { x: 16, y: 21 });
});

test("title bar: the bar under the controls sets the height, not the first bar in the document", () => {
  // Sidebar header 0..260 (44 tall) and tab strip 260..1000 (31 tall); collapsed, the header is off to the left.
  const open = [{ left: 0, top: 0, right: 260, bottom: 44 }, { left: 260, top: 0, right: 1000, bottom: 31 }];
  const collapsed = [{ left: -260, top: 0, right: 0, bottom: 44 }, { left: 0, top: 0, right: 1000, bottom: 31 }];
  assert.equal(barHeightAt(open, 8, 4), 44);
  assert.equal(barHeightAt(collapsed, 8, 4), 31);
  assert.equal(barHeightAt(collapsed, 992, 4), 31, "Windows buttons at the top right");
  assert.equal(barHeightAt([], 8, 4), null);
  assert.equal(macButtonPosition(30.8).y, 8, "7px buttons radius keeps the 14px lights inside a 30.8px bar");
});

test("title bar: Windows overlay as tall as the bar, symbols in the page's theme", () => {
  assert.deepEqual(titleBarOptions("win32", false), { titleBarStyle: "hidden", titleBarOverlay: { color: "#01000000", symbolColor: "#1f2937", height: 44 } });
  assert.equal(overlayOptions(true, 58.5).symbolColor, "#f8fafc");
  assert.equal(overlayOptions(true, 58.5).height, 59);
  assert.deepEqual(titleBarOptions("linux", true), {});
});

test("backdrop: vibrancy or acrylic with a see-through window, or the page's own color", () => {
  assert.deepEqual(backdropOptions("darwin", true, true), { backgroundColor: "#00000000", visualEffectState: "followWindow", vibrancy: "sidebar" });
  assert.deepEqual(backdropOptions("darwin", false, true), { backgroundColor: "#000000", visualEffectState: "followWindow" });
  assert.deepEqual(backdropOptions("win32", true, false), { backgroundColor: "#00000000", backgroundMaterial: "acrylic" });
  assert.deepEqual(backdropOptions("win32", false, false), { backgroundColor: "#fcfcfc", backgroundMaterial: "none" });
  assert.deepEqual(backdropOptions("linux", true, false), { backgroundColor: "#fcfcfc" }, "no backdrop to show through on Linux");
});
