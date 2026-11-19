import { test } from "node:test";
import assert from "node:assert/strict";
import { SETTINGS_TABS, parseMainRoute, settingsTabOf, writeMainRoute } from "./settingsRoute.ts";

test("parseMainRoute reads the view, the tab and the focus; unknown values fall back", () => {
  assert.deepEqual(parseMainRoute(""), { view: "chat", tab: "sessions", focus: null });
  assert.deepEqual(parseMainRoute("?view=settings&tab=display"), { view: "settings", tab: "display", focus: null });
  // Earlier tabs open the session management, which now holds them; the focus stays.
  assert.deepEqual(parseMainRoute("?view=settings&tab=units&focus=claude-a:x"), {
    view: "settings", tab: "sessions", focus: "claude-a:x",
  });
  assert.equal(parseMainRoute("?view=settings&tab=trash").tab, "sessions");
  assert.deepEqual(parseMainRoute("?view=settings&tab=nope"), { view: "settings", tab: "sessions", focus: null });
  assert.equal(parseMainRoute("?view=other").view, "chat");
});

test("the usage tab of the earlier layout opens the tab that holds usage now", () => {
  assert.deepEqual([...SETTINGS_TABS], ["sessions", "accounts", "display", "devices"]);
  assert.deepEqual(parseMainRoute("?view=settings&tab=usage"), { view: "settings", tab: "sessions", focus: null });
  assert.deepEqual(parseMainRoute("?view=settings&tab=usage&focus=claude-a:x"), { view: "settings", tab: "sessions", focus: "claude-a:x" });
  assert.equal(settingsTabOf("usage"), "sessions");
  assert.equal(settingsTabOf("devices"), "devices");
  assert.equal(settingsTabOf(null), "sessions");
  assert.equal(settingsTabOf("nope"), "sessions");
});

test("writeMainRoute keeps the selected session and drops settings parameters for the chat", () => {
  const s = "?s=claude%3Aa%3Aid";
  const settings = writeMainRoute(s, { view: "settings", tab: "display", focus: null });
  assert.equal(settings, "?s=claude%3Aa%3Aid&view=settings&tab=display");
  assert.deepEqual(parseMainRoute(settings), { view: "settings", tab: "display", focus: null });
  assert.equal(writeMainRoute(`${settings}&focus=x`, { view: "chat", tab: "display", focus: null }), s);
  assert.equal(writeMainRoute("?view=settings&tab=display", { view: "chat", tab: "display", focus: null }), "");
});
