import assert from "node:assert/strict";
import { test } from "node:test";

import type { ShellInfo } from "@maru/shared";
import { dragSourceOf, sourcePaneId } from "./paneDrag.ts";
import type { ShellDragData } from "./paneDrag.ts";
import { EMPTY_LAYOUT, openSession, openShellPane } from "./paneLayout.ts";
import { addTab, dropShellInTabs, openShellInTabs, tabsOf } from "./paneTabs.ts";
import { isShellSelected, shellRowTarget, TERMINAL_GROUP_KEY } from "./shellGroup.ts";
import { lastActiveShell, onActiveShellChange, planShellEnd, rememberActiveShell } from "./shellTabs.ts";

const SH1 = "sh-aaaaaaaaaaaa";
const SH2 = "sh-bbbbbbbbbbbb";
const SH3 = "sh-cccccccccccc";
const sh = (id: string): ShellInfo => ({ id, cwd: "/", createdAt: 0, command: "zsh", path: "/", clients: 0 });

function ids() {
  let n = 0;
  return () => `p${++n}`;
}

test("a click on a shell that a pane shows, with the split view as the base, focuses that pane (and its tab)", () => {
  const newId = ids();
  // tab 1 shows SH1, tab 2 (shown) shows SH2
  const one = tabsOf(openShellPane(EMPTY_LAYOUT, SH1, newId), () => "t1");
  const tabs = openShellInTabs(addTab(one, () => "t2"), SH2, newId);
  assert.equal(tabs.active, "t2");
  const at1 = shellRowTarget(SH1, tabs, true);
  assert.equal(at1.kind, "pane");
  assert.deepEqual(at1, { kind: "pane", tabId: "t1", paneId: "p1" });
  assert.deepEqual(shellRowTarget(SH2, tabs, true), { kind: "pane", tabId: "t2", paneId: "p2" });
});

test("a click goes to the terminal screen's tab when no pane shows the shell or the split view is not the base", () => {
  const tabs = tabsOf(openShellPane(EMPTY_LAYOUT, SH1, ids()), () => "t1");
  assert.deepEqual(shellRowTarget(SH3, tabs, true), { kind: "terminal", shellId: SH3 });
  assert.deepEqual(shellRowTarget(SH1, tabs, false), { kind: "terminal", shellId: SH1 });
  // tabs unread (the split view was never the base)
  assert.deepEqual(shellRowTarget(SH1, null, false), { kind: "terminal", shellId: SH1 });
  assert.deepEqual(shellRowTarget(SH1, null, true), { kind: "terminal", shellId: SH1 });
  // a session pane is not a shell pane
  const session = tabsOf(openSession(EMPTY_LAYOUT, "claude:a:1", ids()), () => "t1");
  assert.deepEqual(shellRowTarget(SH1, session, true), { kind: "terminal", shellId: SH1 });
});

test("selection: the terminal screen's shown tab while it is open, else the split view's focused shell pane", () => {
  const base = { terminalOpen: false, terminalShell: SH2, panesShown: false, focusedPaneShell: null };
  // screen open: its tab, whatever the panes say
  assert.equal(isShellSelected({ ...base, shellId: SH2, terminalOpen: true }), true);
  assert.equal(isShellSelected({ ...base, shellId: SH1, terminalOpen: true }), false);
  assert.equal(isShellSelected({ ...base, shellId: SH1, terminalOpen: true, panesShown: true, focusedPaneShell: SH1 }), false);
  // split view showing: the focused pane's shell
  assert.equal(isShellSelected({ ...base, shellId: SH1, panesShown: true, focusedPaneShell: SH1 }), true);
  assert.equal(isShellSelected({ ...base, shellId: SH2, panesShown: true, focusedPaneShell: SH1 }), false, "the screen's remembered tab is not shown");
  assert.equal(isShellSelected({ ...base, shellId: SH1, panesShown: true, focusedPaneShell: null }), false, "a session pane has focus");
  // single view, screen closed: nothing is selected
  assert.equal(isShellSelected({ ...base, shellId: SH2 }), false);
  assert.equal(isShellSelected({ ...base, shellId: SH1, focusedPaneShell: SH1 }), false, "panes not showing");
});

test("a shell row drags as { kind: shell }; the split view reads it, and a drop on the shell's own pane is no change", () => {
  const data: ShellDragData = { kind: "shell", shellId: SH1, title: "zsh 1" };
  assert.deepEqual(dragSourceOf(data), { kind: "shell", shellId: SH1, title: "zsh 1" });
  assert.equal(dragSourceOf({ kind: "shell" }), null, "no id is not a shell");
  const layout = openShellPane(openSession(EMPTY_LAYOUT, "claude:a:1", () => "p1"), SH1, () => "p2");
  const source = dragSourceOf(data)!;
  assert.equal(sourcePaneId(layout, source), "p2");
  assert.equal(sourcePaneId(layout, { kind: "shell", shellId: SH3, title: "" }), null);
});

test("dropping a shell row on a pane opens it there; a shell another tab shows leaves that tab (one shell, one pane)", () => {
  const newId = ids();
  const one = tabsOf(openShellPane(EMPTY_LAYOUT, SH1, newId), () => "t1");
  const two = addTab(one, () => "t2");
  // tab 2 is shown and empty: dropping SH1 on the empty view takes it from tab 1
  const moved = dropShellInTabs(two, SH1, null, "center", newId);
  assert.equal(moved.tabs[0]!.layout.root, null, "tab 1 lost its pane");
  assert.equal(shellRowTarget(SH1, moved, true).kind, "pane");
  assert.equal((shellRowTarget(SH1, moved, true) as { tabId: string }).tabId, "t2");
});

test("ending a shell: the shown tab moves to its right neighbor, else left; the screen closes after the last", () => {
  const list = [sh(SH1), sh(SH2), sh(SH3)];
  assert.deepEqual(planShellEnd(list, SH2, SH2), { remaining: [sh(SH1), sh(SH3)], active: SH3, closeScreen: false });
  assert.equal(planShellEnd(list, SH3, SH3).active, SH2);
  assert.equal(planShellEnd(list, SH1, SH3).active, SH3, "another tab shows: it stays");
  assert.equal(planShellEnd(list, SH1, null).active, null);
  const last = planShellEnd([sh(SH1)], SH1, SH1);
  assert.deepEqual(last, { remaining: [], active: null, closeScreen: true });
});

test("the shown shell is one value the screen and the sidebar share: a change tells every listener once, a repeat tells none", () => {
  rememberActiveShell(null);
  let told = 0;
  const off = onActiveShellChange(() => {
    told++;
  });
  rememberActiveShell(SH1);
  assert.equal(lastActiveShell(), SH1);
  assert.equal(told, 1);
  rememberActiveShell(SH1);
  assert.equal(told, 1);
  rememberActiveShell(SH2);
  assert.equal(told, 2);
  off();
  rememberActiveShell(null);
  assert.equal(told, 2, "an unsubscribed listener hears nothing");
});

test("the fold key is none of the session Groups' keys, so one list holds both", () => {
  assert.equal(TERMINAL_GROUP_KEY, "view:terminal");
  for (const k of ["unassigned", "archive:open", "pinned"]) assert.notEqual(TERMINAL_GROUP_KEY, k);
  assert.ok(!TERMINAL_GROUP_KEY.startsWith("project:"));
});
