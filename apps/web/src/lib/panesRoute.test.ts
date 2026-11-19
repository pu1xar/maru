import assert from "node:assert/strict";
import { test } from "node:test";

import { baseFromHistory, baseOf, isPanesView, writePanesView } from "./panesRoute.ts";

test("the split view is ?view=panes and keeps the single view's ?s=", () => {
  assert.equal(isPanesView("?view=panes&s=claude:a:1"), true);
  assert.equal(isPanesView("?s=claude:a:1"), false);
  assert.equal(isPanesView("?view=settings&tab=usage"), false);
  assert.equal(writePanesView("?s=claude%3Aa%3A1", true), "?s=claude%3Aa%3A1&view=panes");
  assert.equal(writePanesView("?s=claude%3Aa%3A1&view=panes", false), "?s=claude%3Aa%3A1");
  assert.equal(writePanesView("?view=settings&tab=usage&focus=x&s=k", true), "?s=k&view=panes", "settings' parameters stay behind");
  assert.equal(writePanesView("?view=panes", false), "");
});

test("the base view follows the split view and the single view, and outlasts settings and the dashboard", () => {
  assert.equal(baseOf("?view=panes&s=k", false), true);
  assert.equal(baseOf("?s=k", true), false);
  assert.equal(baseOf("", true), false);
  assert.equal(baseOf("?view=settings&tab=usage", true), true, "settings over the split view");
  assert.equal(baseOf("?view=dashboard", false), false, "the dashboard over the single view");
});

test("back and forward bring back the base an entry was written with", () => {
  assert.equal(baseFromHistory({ panesBase: false }, "?view=dashboard", true), false, "the dashboard opened over the single view");
  assert.equal(baseFromHistory({ panesBase: true }, "?view=settings", false), true, "settings opened over the split view");
  assert.equal(baseFromHistory(null, "?view=panes", false), true, "the page's first entry: its address");
  assert.equal(baseFromHistory(null, "?view=dashboard", true), true);
  assert.equal(baseFromHistory({ other: 1 }, "", true), false);
});
