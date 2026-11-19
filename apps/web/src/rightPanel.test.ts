import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENTS_TAB,
  EXPLORER_TAB,
  activateTab,
  closeTab,
  currentFileTab,
  openTab,
  panelFitsInline,
  panelMaxWidth,
  panelShownWidth,
  setTabKind,
  filesShown,
  shownPanelTab,
  toggleFilesTab,
  type PanelState,
} from "./rightPanel.ts";

const base: PanelState = { open: true, tabs: [{ path: "/a" }, { path: "/b", kind: "directory" }], active: "/a" };

test("reopening a tab keeps the kind it was read as unless the target names one", () => {
  const again = openTab(base, { path: "/b", line: 3 });
  assert.deepEqual(again.tabs[1], { path: "/b", line: 3, kind: "directory" });
  assert.equal(again.active, "/b");
  const named = openTab(base, { path: "/b", kind: "file" });
  assert.deepEqual(named.tabs[1], { path: "/b", kind: "file" });
});

test("a path with . or .. segments opens the same tab as its plain form", () => {
  const once = openTab({ open: false, tabs: [], active: null }, { path: "/p/./src/../a.ts" });
  assert.deepEqual(once.tabs, [{ path: "/p/a.ts" }]);
  const again = openTab(once, { path: "/p/a.ts", line: 4 });
  assert.equal(again.tabs.length, 1);
  assert.equal(again.active, "/p/a.ts");
});

test("setTabKind changes only the named tab and returns the same state when nothing changes", () => {
  const next = setTabKind(base, "/a", "file");
  assert.deepEqual(next.tabs, [{ path: "/a", kind: "file" }, { path: "/b", kind: "directory" }]);
  assert.equal(setTabKind(next, "/a", "file"), next);
  assert.equal(setTabKind(next, "/missing", "file"), next);
});

test("closing the shown tab shows a neighbor, then the agents tab", () => {
  assert.equal(closeTab(base, "/a").active, "/b");
  assert.equal(closeTab({ ...base, active: "/b" }, "/b").active, "/a");
  assert.equal(closeTab({ open: true, tabs: [{ path: "/a" }], active: "/a" }, "/a").active, AGENTS_TAB);
});

test("the explorer shows by default and for a tab that is gone; a chosen tab shows otherwise", () => {
  assert.equal(shownPanelTab({ open: true, tabs: [], active: null }), "explorer");
  assert.equal(shownPanelTab({ ...base, active: EXPLORER_TAB }), "explorer");
  assert.equal(shownPanelTab({ ...base, active: "/gone" }), "explorer");
  assert.equal(shownPanelTab({ ...base, active: AGENTS_TAB }), "agents");
  assert.deepEqual(shownPanelTab(base), { path: "/a" });
});

test("the explorer marks the shown file tab, else the file tab shown last", () => {
  const opened = openTab({ open: false, tabs: [], active: null }, { path: "/x" });
  assert.equal(opened.lastFile, "/x");
  const onExplorer = activateTab(opened, EXPLORER_TAB);
  assert.equal(onExplorer.active, EXPLORER_TAB);
  assert.equal(currentFileTab(onExplorer)?.path, "/x");
  assert.equal(activateTab(onExplorer, EXPLORER_TAB), onExplorer, "unchanged state when nothing changes");
  const two = openTab(onExplorer, { path: "/y" });
  assert.equal(currentFileTab(activateTab(two, AGENTS_TAB))?.path, "/y");
  assert.equal(activateTab(two, "/x").lastFile, "/x");
  // Closing the last file while the explorer shows leaves nothing marked; closing the shown file
  // marks the tab shown in its place.
  assert.equal(currentFileTab(closeTab(activateTab(two, EXPLORER_TAB), "/y")), null);
  assert.equal(closeTab(two, "/y").lastFile, "/x");
  assert.equal(closeTab(activateTab(two, EXPLORER_TAB), "/x").lastFile, "/y");
  assert.equal(currentFileTab({ open: true, tabs: [], active: null }), null);
});

test("the panel cap leaves the conversation 360px and stays within 70% of the viewport", () => {
  // 1024 viewport with the default 256px sidebar: a 768px row.
  assert.equal(panelMaxWidth(1024, 768), 408);
  assert.equal(panelMaxWidth(1440, 1184), 824);
  assert.equal(panelMaxWidth(1280, 1024), 664);
  // A cap below the minimum still lets the panel be its minimum.
  assert.equal(panelMaxWidth(1024, 640), 360);
  assert.equal(panelMaxWidth(1600, null), 1120);
});

test("the shown width is the chosen width clamped, and the chosen width is not changed by it", () => {
  assert.equal(panelShownWidth(540, 408), 408);
  assert.equal(panelShownWidth(540, 824), 540);
  assert.equal(panelShownWidth(200, 824), 360);
});

test("the panel sits inline only when the row holds both minimums", () => {
  assert.equal(panelFitsInline(1024, 768), true);
  assert.equal(panelFitsInline(1024, 720), true);
  assert.equal(panelFitsInline(1024, 719), false);
  assert.equal(panelFitsInline(980, 980), false);
  assert.equal(panelFitsInline(1440, null), true);
});

test("the header Files button opens the panel on the Files tab, switches to it from another tab, and closes it while it shows", () => {
  const closed: PanelState = { open: false, tabs: [{ path: "/a" }], active: "/a" };
  const opened = toggleFilesTab(closed);
  assert.deepEqual([opened.open, opened.active, filesShown(opened)], [true, EXPLORER_TAB, true]);
  assert.deepEqual(opened.tabs, closed.tabs, "the file tabs stay");
  const fromAgents = toggleFilesTab({ ...closed, open: true, active: AGENTS_TAB });
  assert.deepEqual([fromAgents.open, fromAgents.active], [true, EXPLORER_TAB]);
  const fromFile = toggleFilesTab({ ...closed, open: true });
  assert.deepEqual([fromFile.open, fromFile.active], [true, EXPLORER_TAB]);
  const shut = toggleFilesTab(opened);
  assert.deepEqual([shut.open, filesShown(shut)], [false, false]);
  assert.equal(shut.active, EXPLORER_TAB);
  assert.equal(filesShown({ open: false, tabs: [], active: null }), false);
  assert.equal(filesShown({ open: true, tabs: [], active: null }), true, "no chosen tab shows the explorer");
});
