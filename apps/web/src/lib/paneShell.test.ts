import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_LAYOUT,
  closeShellPane,
  contentOf,
  describeLayout,
  dropShell,
  dropSession,
  openSession,
  openShellPane,
  paneKind,
  panesOf,
  parseLayout,
  reconcileShells,
  serializeLayout,
  splitPane,
  type PaneLayout,
} from "./paneLayout.ts";
import {
  closeShellInTabs,
  dropShellInTabs,
  loadTabs,
  openShellInTabs,
  parseTabs,
  reconcileShellTabs,
  serializeTabs,
  tabLabel,
  tabOfShell,
  tabsOf,
  addTab,
  activeLayout,
  allPanes,
  SHELL_TAB_LABEL,
  EMPTY_TAB_LABEL,
} from "./paneTabs.ts";

const SH1 = "sh-aaaaaaaaaaaa";
const SH2 = "sh-bbbbbbbbbbbb";
const SH3 = "sh-cccccccccccc";

function ids() {
  let n = 0;
  return () => `p${++n}`;
}
const show = (l: PaneLayout) => describeLayout(l.root);

test("pane kind: session, shell or empty", () => {
  assert.equal(paneKind({ sessionKey: "claude:a:1", shellId: null }), "session");
  assert.equal(paneKind({ sessionKey: null, shellId: SH1 }), "shell");
  assert.equal(paneKind({ sessionKey: null, shellId: null }), "empty");
  assert.deepEqual(contentOf({ sessionKey: null, shellId: SH1 }), { type: "shell", id: SH1 });
  assert.equal(contentOf({ sessionKey: null, shellId: null }), null);
});

test("a shell dropped on an empty view is the first pane; on an edge it splits; in the middle it replaces the pane's content", () => {
  const id = ids();
  let l = dropShell(EMPTY_LAYOUT, SH1, null, "center", id);
  assert.equal(show(l), `[${SH1}]`);
  l = dropShell(openSession(l, "A", id), SH2, "p1", "right", id);
  assert.equal(panesOf(l.root).length, 3);
  const before = panesOf(l.root).map((p) => paneKind(p)).sort();
  assert.deepEqual(before, ["session", "shell", "shell"]);
  // the middle of the session pane shows the shell there; the session only leaves the pane
  const sessionPane = panesOf(l.root).find((p) => p.sessionKey === "A")!;
  const centered = dropShell(l, SH3, sessionPane.id, "center", id);
  assert.equal(panesOf(centered.root).find((p) => p.id === sessionPane.id)!.shellId, SH3);
  assert.equal(panesOf(centered.root).find((p) => p.id === sessionPane.id)!.sessionKey, null);
});

test("a shell shows in one pane: dropping a shown shell moves its pane", () => {
  const id = ids();
  let l = splitPane(openSession(EMPTY_LAYOUT, "A", id), "p1", "right", "B", id);
  l = dropShell(l, SH1, "p1", "bottom", id);
  const shellPane = panesOf(l.root).find((p) => p.shellId === SH1)!;
  const moved = dropShell(l, SH1, "p2", "left", id);
  assert.equal(panesOf(moved.root).filter((p) => p.shellId === SH1).length, 1);
  assert.equal(panesOf(moved.root).find((p) => p.shellId === SH1)!.id, shellPane.id, "the pane keeps its id");
  assert.equal(moved.focused, shellPane.id);
});

test("dropping a session on a shell pane's middle replaces the shell pane's content and the shell lives on in the list", () => {
  const id = ids();
  const l = dropShell(EMPTY_LAYOUT, SH1, null, "center", id);
  const next = dropSession(l, "A", "p1", "center", id);
  assert.equal(show(next), "[A]");
});

test("opening a shell as a pane: focus where shown, first pane, fill an empty focused pane, else split right", () => {
  const id = ids();
  assert.equal(show(openShellPane(EMPTY_LAYOUT, SH1, id)), `[${SH1}]`);
  const one = openSession(EMPTY_LAYOUT, "A", id);
  const split = openShellPane(one, SH1, id);
  assert.equal(show(split).startsWith("row(0.50,[p1"), false);
  assert.deepEqual(panesOf(split.root).map((p) => paneKind(p)), ["session", "shell"]);
  assert.equal(split.focused, panesOf(split.root)[1]!.id);
  // already shown: only focus moves
  const back = { ...split, focused: panesOf(split.root)[0]!.id };
  const again = openShellPane(back, SH1, id);
  assert.equal(again.focused, panesOf(split.root)[1]!.id);
  assert.equal(panesOf(again.root).length, 2);
  // an empty focused pane takes it
  const emptyPane = splitPane(one, "p1", "right", null, id);
  const filled = openShellPane(emptyPane, SH2, id);
  assert.equal(panesOf(filled.root).length, 2);
  assert.equal(panesOf(filled.root)[1]!.shellId, SH2);
});

test("a session opened from elsewhere does not replace a focused shell pane", () => {
  const id = ids();
  const l = openShellPane(EMPTY_LAYOUT, SH1, id);
  const next = openSession(l, "A", id);
  assert.deepEqual(panesOf(next.root).map((p) => paneKind(p)), ["shell", "session"]);
  assert.equal(panesOf(next.root)[0]!.shellId, SH1);
});

test("a shell that ended closes its pane; panes of shells still listed stay", () => {
  const id = ids();
  let l = openShellPane(EMPTY_LAYOUT, SH1, id);
  l = openShellPane(l, SH2, id);
  assert.equal(panesOf(closeShellPane(l, SH1).root).length, 1);
  assert.equal(closeShellPane(l, SH3), l, "no pane for it: unchanged");
  const kept = reconcileShells(l, new Set([SH1, SH2]));
  assert.equal(kept, l);
  const left = reconcileShells(l, new Set([SH2]));
  assert.deepEqual(panesOf(left.root).map((p) => p.shellId), [SH2]);
  assert.equal(left.root !== null && reconcileShells(left, new Set()).root, null);
});

test("storage keeps a shell pane, and a layout stored before shell panes reads unchanged", () => {
  const id = ids();
  let l = openSession(EMPTY_LAYOUT, "claude:a:1", id);
  l = openShellPane(l, SH1, id);
  const back = parseLayout(serializeLayout(l))!;
  assert.deepEqual(back, l);
  const legacy = JSON.stringify({
    v: 1,
    root: { kind: "split", id: "s1", dir: "row", ratio: 0.4, a: { kind: "pane", id: "p1", sessionKey: "claude:a:1" }, b: { kind: "pane", id: "p2", sessionKey: null } },
    focused: "p2",
  });
  const parsed = parseLayout(legacy)!;
  assert.deepEqual(panesOf(parsed.root).map((p) => [p.sessionKey, p.shellId]), [["claude:a:1", null], [null, null]]);
  assert.equal(parsed.focused, "p2");
});

test("stored shell ids that are not valid, repeat, or sit beside a session are dropped", () => {
  const raw = {
    v: 1,
    root: {
      kind: "split", id: "s1", dir: "row", ratio: 0.5,
      a: { kind: "pane", id: "p1", sessionKey: null, shellId: SH1 },
      b: {
        kind: "split", id: "s2", dir: "column", ratio: 0.5,
        a: { kind: "pane", id: "p2", sessionKey: null, shellId: SH1 },
        b: {
          kind: "split", id: "s3", dir: "column", ratio: 0.5,
          a: { kind: "pane", id: "p3", sessionKey: null, shellId: "not-a-shell" },
          b: { kind: "pane", id: "p4", sessionKey: "claude:a:1", shellId: SH2 },
        },
      },
    },
    focused: "p1",
  };
  const parsed = parseLayout(JSON.stringify(raw))!;
  assert.deepEqual(panesOf(parsed.root).map((p) => [p.sessionKey, p.shellId]), [[null, SH1], ["claude:a:1", null]]);
  assert.equal(show(parsed), `row(0.50,[${SH1}],[claude:a:1])`, "the panes that lost their shell close; a pane that never had content stays");
});

test("tabs: a shell shows in one pane of the whole view", () => {
  let t = tabsOf(openShellPane(EMPTY_LAYOUT, SH1, ids()), () => "t1");
  t = addTab(t, () => "t2");
  // t2 is shown and empty; opening SH1 brings tab t1 up instead of making a second pane
  const opened = openShellInTabs(t, SH1);
  assert.equal(opened.active, "t1");
  assert.equal(allPanes(opened).filter((p) => p.shellId === SH1).length, 1);
  // dropping it on t2 takes it out of t1
  const dropped = dropShellInTabs(t, SH1, null, "center", ids());
  assert.equal(allPanes(dropped).filter((p) => p.shellId === SH1).length, 1);
  assert.equal(tabOfShell(dropped, SH1)!.tab.id, "t2");
  assert.equal(activeLayout(dropped).root !== null, true);
});

test("tabs: a drop whose target pane is gone opens the shell as a pane of its own", () => {
  const t = tabsOf(openSession(EMPTY_LAYOUT, "A", ids()), () => "t1");
  const out = dropShellInTabs(t, SH1, "p-gone", "right", ids());
  assert.deepEqual(allPanes(out).map((p) => paneKind(p)), ["session", "shell"]);
  const out2 = dropShellInTabs(t, SH1, null, "center", ids());
  assert.deepEqual(allPanes(out2).map((p) => paneKind(p)), ["session", "shell"], "an empty-view drop onto a view with panes");
});

test("tabs: ended shells close in every tab, unlisted ones are reconciled", () => {
  let t = tabsOf(openShellPane(EMPTY_LAYOUT, SH1, ids()), () => "t1");
  t = addTab(t, () => "t2");
  t = dropShellInTabs(t, SH2, null, "center", ids());
  assert.equal(allPanes(closeShellInTabs(t, SH1)).length, 1);
  assert.equal(allPanes(reconcileShellTabs(t, new Set([SH1, SH2]))).length, 2);
  assert.deepEqual(allPanes(reconcileShellTabs(t, new Set([SH2]))).map((p) => p.shellId), [SH2]);
  assert.equal(reconcileShellTabs(t, new Set([SH1, SH2])), t);
});

test("tabs: storage round trip, cross-tab duplicate shells keep the first", () => {
  let t = tabsOf(openShellPane(EMPTY_LAYOUT, SH1, ids()), () => "t1");
  t = addTab(t, () => "t2");
  t = dropShellInTabs(t, SH2, null, "center", ids());
  assert.deepEqual(parseTabs(serializeTabs(t)), t);
  const text = JSON.parse(serializeTabs(t));
  text.tabs[1].root.shellId = SH1;
  const dup = parseTabs(JSON.stringify(text))!;
  assert.equal(allPanes(dup).filter((p) => p.shellId === SH1).length, 1);
  assert.equal(loadTabs(null, JSON.stringify({ v: 1, root: null, focused: null }))!.tabs.length, 1);
});

test("a tab with only shell panes is labeled 터미널, an empty one 새 탭, a named one by its name", () => {
  const shellTab = tabsOf(openShellPane(EMPTY_LAYOUT, SH1, ids())).tabs[0]!;
  assert.equal(tabLabel(shellTab, null), SHELL_TAB_LABEL);
  assert.equal(tabLabel({ ...shellTab, layout: EMPTY_LAYOUT }, null), EMPTY_TAB_LABEL);
  assert.equal(tabLabel({ ...shellTab, name: "work" }, null), "work");
  assert.equal(tabLabel(shellTab, "Session A"), "Session A");
});
