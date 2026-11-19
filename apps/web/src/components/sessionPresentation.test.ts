import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionSummary } from "@maru/shared";
import { resolveFolderDot, sessionActivity, sessionTopStatus } from "./sessionPresentation.ts";

const s = (status: SessionSummary["status"], backgroundTasks?: number, backgroundAgents?: number) =>
  ({ status, backgroundTasks, backgroundAgents }) as SessionSummary;

test("an idle turn with background work counts as working; the main agent's turn stays running", () => {
  assert.equal(sessionActivity(s("open-idle", 2)), "background");
  assert.equal(sessionActivity(s("open-idle", 0)), "open-idle");
  assert.equal(sessionActivity(s("open-idle")), "open-idle");
  assert.equal(sessionActivity(s("running", 3)), "running");
  assert.equal(sessionActivity(s("waiting-input", 1)), "waiting-input");
  assert.equal(sessionActivity(s("closed", 1)), "closed");
  // A dev server left running in the background is a task but not a subagent.
  assert.equal(sessionActivity(s("open-idle", 1, 0)), "open-idle");
  assert.equal(sessionActivity(s("open-idle", 2, 1)), "background");
});

test("the main agent shows a solid circle, background work a dashed one", () => {
  assert.notEqual(sessionTopStatus("running")?.icon, sessionTopStatus("background")?.icon);
  assert.equal(sessionTopStatus("open-idle"), null);
  assert.equal(sessionTopStatus("closed"), null);
});

test("a folded Group shows the working dot for background work too", () => {
  assert.equal(resolveFolderDot([s("open-idle", 1)]), "working");
  assert.equal(resolveFolderDot([s("open-idle", 0)]), null);
  assert.equal(resolveFolderDot([s("open-idle", 1), s("waiting-input")]), "attention");
});
