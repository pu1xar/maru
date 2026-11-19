import { test } from "node:test";
import assert from "node:assert/strict";
import { isTerminalSearch, requestNewShell, takeNewShellRequest, writeTerminalSearch } from "./terminalRoute.ts";
import { writePanesView } from "./panesRoute.ts";
import { writeDashboardSearch } from "./dashboardRoute.ts";
import { writeMainRoute } from "./settingsRoute.ts";

test("opening writes view=terminal and keeps the selected session; closing removes only its own view", () => {
  assert.equal(writeTerminalSearch("?s=abc", true), "?s=abc&view=terminal");
  assert.equal(writeTerminalSearch("?s=abc&view=terminal", false), "?s=abc");
  assert.equal(writeTerminalSearch("?view=terminal", false), "");
  assert.equal(writeTerminalSearch("?s=abc&view=dashboard", false), "?s=abc&view=dashboard", "another screen's view is left alone");
  assert.equal(isTerminalSearch("?view=terminal"), true);
  assert.equal(isTerminalSearch("?view=dashboard"), false);
});

test("the terminal takes settings' parameters off; the other screens replace it (one screen at a time)", () => {
  assert.equal(writeTerminalSearch("?view=settings&tab=display&focus=x", true), "?view=terminal");
  assert.equal(writeDashboardSearch("?s=a&view=terminal", true), "?s=a&view=dashboard");
  assert.equal(isTerminalSearch(writeMainRoute("?s=a&view=terminal", { view: "settings", tab: "display", focus: null })), false);
  assert.equal(writePanesView("?s=a&view=terminal", true), "?s=a&view=panes");
  assert.equal(writePanesView("?s=a&view=terminal", false), "?s=a");
});

test("a new-shell request made before the screen mounts is taken once, however many were made", () => {
  assert.equal(takeNewShellRequest(), false);
  requestNewShell();
  requestNewShell();
  assert.equal(takeNewShellRequest(), true);
  assert.equal(takeNewShellRequest(), false);
});
