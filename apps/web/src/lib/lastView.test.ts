import assert from "node:assert/strict";
import { test } from "node:test";

import { LAST_VIEW_KEY, lastViewOf, parseLastView, readLastView, restoredAddress, sameLastView, writeLastView, type LastView } from "./lastView.ts";

const base = { selected: null, panesView: false, settings: false, settingsTab: "sessions", dashboard: false, terminal: false, panesBase: false };

function single(selected: string | null, extra: Partial<LastView> = {}): LastView {
  return { selected, view: "single", tab: null, panesBase: false, ...extra };
}

test("lastViewOf names the screen and keeps the session as its id", () => {
  assert.deepEqual(lastViewOf({ ...base, selected: "claude:acc:abc" }), single("abc"));
  assert.deepEqual(lastViewOf({ ...base, selected: "abc", panesView: true, panesBase: true }), { selected: "abc", view: "panes", tab: null, panesBase: true });
  assert.deepEqual(lastViewOf({ ...base, settings: true, settingsTab: "usage" }), { selected: null, view: "settings", tab: "usage", panesBase: false });
  assert.equal(lastViewOf({ ...base, dashboard: true }).view, "dashboard");
  assert.equal(lastViewOf({ ...base, terminal: true, panesBase: true }).panesBase, true);
});

test("a cover wins over the base it covers", () => {
  const v = lastViewOf({ ...base, panesView: true, panesBase: true, dashboard: true });
  assert.equal(v.view, "dashboard");
  assert.equal(v.panesBase, true);
});

test("parseLastView rejects anything that is not a stored screen", () => {
  assert.equal(parseLastView(null), null);
  assert.equal(parseLastView("nope"), null);
  assert.equal(parseLastView('{"view":"elsewhere"}'), null);
  assert.deepEqual(parseLastView('{"view":"panes","panesBase":true,"selected":"x","tab":""}'), { selected: "x", view: "panes", tab: null, panesBase: true });
});

test("a stored usage tab reads as the tab that holds usage now", () => {
  const stored = parseLastView('{"view":"settings","tab":"usage","selected":"x","panesBase":false}');
  assert.equal(stored?.tab, "sessions");
  assert.deepEqual(restoredAddress("", stored), { search: "?view=settings&tab=sessions&s=x", panesBase: false });
  assert.equal(parseLastView('{"view":"settings","tab":"display"}')?.tab, "display");
});

test("a bare address takes the stored screen", () => {
  assert.deepEqual(restoredAddress("", single("abc")), { search: "?s=abc", panesBase: false });
  assert.deepEqual(restoredAddress("", single(null)), { search: "", panesBase: false });
  assert.deepEqual(restoredAddress("", { selected: "abc", view: "panes", tab: null, panesBase: true }), { search: "?view=panes&s=abc", panesBase: true });
  assert.deepEqual(restoredAddress("", { selected: "abc", view: "settings", tab: "usage", panesBase: true }), { search: "?view=settings&tab=usage&s=abc", panesBase: true });
  assert.deepEqual(restoredAddress("", { selected: null, view: "dashboard", tab: null, panesBase: false }), { search: "?view=dashboard", panesBase: false });
  assert.deepEqual(restoredAddress("", { selected: null, view: "terminal", tab: null, panesBase: false }), { search: "?view=terminal", panesBase: false });
});

test("other parameters on a bare address are kept", () => {
  assert.deepEqual(restoredAddress("?utm=1", single("abc")), { search: "?utm=1&s=abc", panesBase: false });
});

test("an address that names a session or a view wins", () => {
  const last: LastView = { selected: "old", view: "panes", tab: null, panesBase: true };
  assert.equal(restoredAddress("?s=link", last), null);
  assert.equal(restoredAddress("?view=panes&s=link", last), null);
});

test("a view without a session takes the stored session, which the address leaves out", () => {
  const last: LastView = { selected: "abc", view: "dashboard", tab: null, panesBase: false };
  assert.deepEqual(restoredAddress("?view=dashboard", last), { search: "?view=dashboard&s=abc", panesBase: false });
  assert.deepEqual(restoredAddress("?view=panes", last), { search: "?view=panes&s=abc", panesBase: false });
  assert.equal(restoredAddress("?view=panes", single(null)), null);
});

test("nothing stored leaves the address", () => {
  assert.equal(restoredAddress("", null), null);
  assert.equal(restoredAddress("?view=panes", null), null);
});

function fake(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

test("a reload reads the tab's own screen before the device's", () => {
  const tab = fake();
  const device = fake();
  writeLastView(single("a"), tab, device);
  // Another tab changes the device's screen.
  device.map.set(LAST_VIEW_KEY, JSON.stringify(single("b")));
  assert.equal(readLastView(tab, device)?.selected, "a");
  // A new tab has no screen of its own and takes the device's.
  assert.equal(readLastView(fake(), device)?.selected, "b");
  assert.equal(readLastView(null, null), null);
});

test("sameLastView compares every field", () => {
  assert.equal(sameLastView(single("a"), single("a")), true);
  assert.equal(sameLastView(single("a"), single("a", { panesBase: true })), false);
  assert.equal(sameLastView(null, single("a")), false);
});
