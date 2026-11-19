import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary } from "@maru/shared";
import { composerState, OFFLINE_NOTE } from "./composerState.ts";

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return { key: "claude:a:1", provider: "claude", account: "a", id: "1", cwd: "/x", name: null, title: null, preview: null, status: "open-idle", owner: "ui", pid: null, tmuxPane: null, parentKey: null, updatedAt: 0, createdAt: null, sizeBytes: null, entrypoint: null, ...over };
}

test("a send keeps the start of the text and drops the trailing whitespace", () => {
  const s = composerState({ session: session(), online: true, text: "    indented\n  code  \n\n" });
  assert.equal(s.send, "    indented\n  code");
  assert.equal(composerState({ session: session(), online: true, text: " \n\t" }).send, null);
});

test("a dropped connection stops the send but leaves the field open", () => {
  const s = composerState({ session: session(), online: false, text: "hello" });
  assert.equal(s.reason, null);
  assert.equal(s.offline, true);
  assert.equal(s.send, null);
  assert.equal(OFFLINE_NOTE, "Disconnected from server");
});

test("a session that cannot take messages locks the field with its reason", () => {
  assert.equal(composerState({ session: null, online: true, text: "x" }).reason, "Select a session");
  assert.equal(composerState({ session: session({ parentKey: "claude:a:0" }), online: true, text: "x" }).reason, "Cannot send to a subagent conversation");
  assert.equal(composerState({ session: session({ owner: "terminal" }), online: true, text: "x" }).reason, "Cannot send while open in a terminal");
  assert.equal(composerState({ session: null, readOnly: "x", online: true, text: "x" }).block?.kind, "subagent");
  assert.equal(composerState({ session: null, readOnly: "x", online: true, text: "x" }).send, null);
});

test("the stop button shows while this server's turn runs or waits for an answer", () => {
  assert.equal(composerState({ session: session({ status: "running" }), online: true, text: "" }).running, true);
  assert.equal(composerState({ session: session({ status: "waiting-input" }), online: true, text: "" }).running, true);
  assert.equal(composerState({ session: session({ status: "running", owner: "terminal" }), online: true, text: "" }).running, false);
  assert.equal(composerState({ session: session(), online: true, text: "" }).running, false);
});

test("the web's rule for held sessions: a closed one the terminal had opens again, an idle Codex one is taken over", () => {
  assert.equal(composerState({ session: session({ owner: "terminal", status: "closed" }), online: true, text: "x" }).send, "x");
  assert.equal(composerState({ session: session({ provider: "codex", owner: "terminal", status: "open-idle" }), online: true, text: "x" }).send, "x");
  const busy = composerState({ session: session({ provider: "codex", owner: "terminal", status: "running" }), online: true, text: "x" });
  assert.equal(busy.block?.kind, "other-client");
  assert.equal(busy.send, null);
});
