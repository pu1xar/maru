import assert from "node:assert/strict";
import { test } from "node:test";

import { EMPTY_LAYOUT, describeLayout, openSession, serializeLayout, splitPane, type PaneLayout } from "./paneLayout.ts";
import {
  activeLayout,
  activeTab,
  addTab,
  allPanes,
  closeTab,
  cycleTab,
  describeTabs,
  dropSessionInTabs,
  EMPTY_TAB_LABEL,
  firstSessionKey,
  loadTabs,
  moveTab,
  openSessionInTabs,
  parseTabs,
  reconcileTabs,
  renameTab,
  selectTab,
  selectTabAt,
  serializeTabs,
  tabLabel,
  tabsOf,
  updateActiveLayout,
  type PaneTabs,
} from "./paneTabs.ts";

/** Ids n1, n2, ... in creation order, so ids read the same in every run. */
function ids(prefix = "n") {
  let n = 0;
  return () => `${prefix}${++n}`;
}

const layoutText = (l: PaneLayout) => describeLayout(l.root, (p) => `${p.id}:${p.sessionKey ?? "-"}`);
const show = (t: PaneTabs) => describeTabs(t, layoutText);

/** Tab 1: A | B (focus B). Tab 2: C. Tab 3: empty. Tab 2 is shown. */
function threeTabs(): PaneTabs {
  const id = ids("p");
  const tid = ids("t");
  let first = openSession(EMPTY_LAYOUT, "A", id); // p1
  first = splitPane(first, "p1", "right", "B", id); // p2 in split p3
  const second = openSession(EMPTY_LAYOUT, "C", id); // p4
  return {
    tabs: [
      { id: tid(), name: null, layout: first },
      { id: tid(), name: "docs", layout: second },
      { id: tid(), name: null, layout: EMPTY_LAYOUT },
    ],
    active: "t2",
  };
}

test("a new tab goes last, is empty and shown; the others keep their layout and focus", () => {
  const t = threeTabs();
  const added = addTab(t, ids("x"));
  assert.equal(added.tabs.length, 4);
  assert.equal(added.active, "x1");
  assert.equal(show(added), "1:row(0.50,[p1:A],[p2:B])|2(docs):[p4:C]|3:empty|*4:empty");
  assert.equal(added.tabs[0]!.layout.focused, "p2", "tab 1 still has B focused");
});

test("closing: the right neighbour takes over, then the left; the last tab stays", () => {
  const t = threeTabs();
  const closedShown = closeTab(t, "t2");
  assert.deepEqual(closedShown.tabs.map((x) => x.id), ["t1", "t3"]);
  assert.equal(closedShown.active, "t3", "the tab to the right");
  const last = closeTab(selectTab(t, "t3"), "t3");
  assert.equal(last.active, "t2", "no tab to the right: the left one");
  const other = closeTab(t, "t1");
  assert.equal(other.active, "t2", "closing another tab leaves the shown one");
  const one = closeTab(closeTab(t, "t1"), "t3");
  assert.equal(one.tabs.length, 1);
  assert.equal(closeTab(one, "t2"), one, "the last tab is not closed");
  assert.equal(closeTab(t, "nope"), t);
});

test("switching shows another tab and keeps every layout; by number and around", () => {
  const t = threeTabs();
  const s = selectTab(t, "t1");
  assert.equal(s.active, "t1");
  assert.equal(activeLayout(s).focused, "p2", "the focused pane came back with the tab");
  assert.equal(selectTab(s, "t1"), s);
  assert.equal(selectTab(s, "nope"), s);
  assert.equal(selectTabAt(t, 0).active, "t1");
  assert.equal(selectTabAt(t, 5), t, "past the last tab nothing happens");
  assert.equal(cycleTab(t, 1).active, "t3");
  assert.equal(cycleTab(cycleTab(t, 1), 1).active, "t1", "wraps");
  assert.equal(cycleTab(t, -1).active, "t1");
  assert.equal(cycleTab(selectTab(t, "t1"), -1).active, "t3");
  const single = tabsOf(EMPTY_LAYOUT, ids("t"));
  assert.equal(cycleTab(single, 1), single);
});

test("renaming trims; blank text returns to the default name", () => {
  const t = threeTabs();
  assert.equal(renameTab(t, "t1", "  logs  ").tabs[0]!.name, "logs");
  assert.equal(renameTab(t, "t2", "   ").tabs[1]!.name, null);
  assert.equal(renameTab(t, "t2", "docs"), t, "same name: no change");
  assert.equal(renameTab(t, "t1", ""), t, "already default");
  assert.equal(renameTab(t, "nope", "x"), t);
});

test("default label: the name, else the first session in reading order, else the empty-tab label", () => {
  const t = threeTabs();
  const [a, b, c] = t.tabs;
  assert.equal(firstSessionKey(a!), "A");
  assert.equal(firstSessionKey(c!), null);
  assert.equal(tabLabel(a!, "Alpha"), "Alpha");
  assert.equal(tabLabel(b!, "Gamma"), "docs", "a name beats the session");
  assert.equal(tabLabel(c!, null), EMPTY_TAB_LABEL);
  assert.equal(tabLabel(a!, null), EMPTY_TAB_LABEL, "a session whose name is not known yet");
});

test("moving a tab ends it at the target index; the shown tab stays shown", () => {
  const t = threeTabs();
  assert.deepEqual(moveTab(t, "t1", 2).tabs.map((x) => x.id), ["t2", "t3", "t1"]);
  assert.deepEqual(moveTab(t, "t3", 0).tabs.map((x) => x.id), ["t3", "t1", "t2"]);
  assert.deepEqual(moveTab(t, "t2", 99).tabs.map((x) => x.id), ["t1", "t3", "t2"], "clamped");
  assert.equal(moveTab(t, "t2", 1), t);
  assert.equal(moveTab(t, "nope", 0), t);
  assert.equal(moveTab(t, "t1", 2).active, "t2");
});

test("layout changes apply to the shown tab only", () => {
  const t = threeTabs();
  const split = updateActiveLayout(t, (l) => splitPane(l, "p4", "bottom", "D", ids("q")));
  assert.equal(show(split), "1:row(0.50,[p1:A],[p2:B])|*2(docs):column(0.50,[p4:C],[q1:D])|3:empty");
  assert.equal(updateActiveLayout(t, (l) => l), t);
  assert.equal(split.tabs[0], t.tabs[0], "other tabs are the same objects");
  assert.equal(allPanes(split).length, 4);
});

test("a click in the sidebar: the tab that shows the session comes up with that pane focused", () => {
  const t = threeTabs();
  const toA = openSessionInTabs(t, "A");
  assert.equal(toA.active, "t1");
  assert.equal(activeLayout(toA).focused, "p1");
  const inShown = openSessionInTabs(t, "C");
  assert.equal(inShown, t, "already shown and focused");
  const fresh = openSessionInTabs(t, "Z", ids("q"));
  assert.equal(show(fresh), "1:row(0.50,[p1:A],[p2:B])|*2(docs):[p4:Z]|3:empty", "the focused pane of the shown tab takes it");
  const intoEmpty = openSessionInTabs(selectTab(t, "t3"), "Z", ids("q"));
  assert.equal(show(intoEmpty), "1:row(0.50,[p1:A],[p2:B])|2(docs):[p4:C]|*3:[q1:Z]");
});

test("a drop in the shown tab takes the session out of the tab that had it", () => {
  const t = threeTabs();
  const moved = dropSessionInTabs(t, "A", "p4", "right", ids("q"));
  assert.equal(moved.active, "t2");
  assert.equal(show(moved), "1:[p2:B]|*2(docs):row(0.50,[p4:C],[q1:A])|3:empty");
  assert.equal(allPanes(moved).filter((p) => p.sessionKey === "A").length, 1, "still one pane for A");
  const center = dropSessionInTabs(t, "B", "p4", "center");
  assert.equal(show(center), "1:[p1:A]|*2(docs):[p4:B]|3:empty","a centre drop replaces C, which leaves the view");
  const own = dropSessionInTabs(t, "C", "p4", "right", ids("q"));
  assert.equal(own, t, "dropping a session on its own pane changes nothing");
});

test("sessions that moved or vanished are followed in every tab", () => {
  const t = threeTabs();
  const r = reconcileTabs(t, (k) => (k === "A" ? "A2" : k === "C" ? null : k));
  assert.equal(show(r), "1:row(0.50,[p1:A2],[p2:B])|*2(docs):empty|3:empty");
  assert.equal(reconcileTabs(t, (k) => k), t);
  assert.equal(reconcileTabs(t, () => undefined), t);
});

test("stored tabs round-trip with names, order, focus and the shown tab", () => {
  const t = threeTabs();
  const back = parseTabs(serializeTabs(t))!;
  assert.deepEqual(back, t);
  assert.equal(JSON.parse(serializeTabs(t)).v, 1);
  assert.equal(parseTabs(null), null);
  assert.equal(parseTabs("{"), null);
  assert.equal(parseTabs(JSON.stringify({ v: 2, tabs: [], active: "x" })), null, "other version");
  assert.equal(parseTabs(JSON.stringify({ v: 1, tabs: [], active: "x" })), null, "no tab left");
  assert.equal(parseTabs(JSON.stringify({ v: 1, tabs: "x" })), null);
});

test("stored tabs: a missing shown tab falls to the first; a broken layout stays as an empty tab; repeats are cleaned", () => {
  const t = threeTabs();
  const raw = JSON.parse(serializeTabs(t));
  assert.equal(parseTabs(JSON.stringify({ ...raw, active: "gone" }))!.active, "t1");
  const broken = structuredClone(raw);
  broken.tabs[0].root = { kind: "split", id: "s", dir: "diagonal", ratio: 0.5 };
  const b = parseTabs(JSON.stringify(broken))!;
  assert.equal(show(b), "1:empty|*2(docs):[p4:C]|3:empty", "tab 1 survives as an empty tab");
  const dupId = structuredClone(raw);
  dupId.tabs[2].id = "t1";
  dupId.tabs.push({ id: "", name: null, root: null, focused: null }, 7);
  assert.deepEqual(parseTabs(JSON.stringify(dupId))!.tabs.map((x) => x.id), ["t1", "t2"], "a repeated, empty or non-object entry is skipped");
  const dupSession = structuredClone(raw);
  dupSession.tabs[1].root = { kind: "pane", id: "p9", sessionKey: "A" };
  const d = parseTabs(JSON.stringify(dupSession))!;
  assert.equal(show(d), "1:row(0.50,[p1:A],[p2:B])|*2(docs):empty|3:empty", "a session an earlier tab shows closes the later pane");
  const blankName = structuredClone(raw);
  blankName.tabs[0].name = "  ";
  assert.equal(parseTabs(JSON.stringify(blankName))!.tabs[0]!.name, null);
});

test("an old single layout (maru_pane_layout) becomes the first tab", () => {
  const id = ids("p");
  let old = openSession(EMPTY_LAYOUT, "A", id);
  old = splitPane(old, "p1", "bottom", "B", id);
  const t = loadTabs(null, serializeLayout(old), ids("t"))!;
  assert.equal(t.tabs.length, 1);
  assert.equal(t.active, "t1");
  assert.equal(t.tabs[0]!.name, null);
  assert.deepEqual(activeTab(t).layout, old, "panes, sessions, ratios and focus carry over");
  assert.equal(loadTabs(null, null), null, "nothing stored");
  assert.equal(loadTabs(null, "{"), null, "a broken old value");
  assert.equal(loadTabs(null, serializeLayout(EMPTY_LAYOUT), ids("t"))!.tabs[0]!.layout.root, null, "an empty old layout is an empty tab");
});

test("a stored tab list wins over the old layout, and a broken one does not fall back to it", () => {
  const id = ids("p");
  const old = openSession(EMPTY_LAYOUT, "OLD", id);
  const stored = serializeTabs(threeTabs());
  assert.deepEqual(loadTabs(stored, serializeLayout(old)), threeTabs());
  assert.equal(loadTabs("{", serializeLayout(old)), null);
});
