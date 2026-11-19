import assert from "node:assert/strict";
import { test } from "node:test";
import { foldedMessageLabel } from "./userMessage.ts";

test("a folded message names its sender, so an agent's message never reads as the user's", () => {
  assert.equal(foldedMessageLabel("agent", { kind: "peer", from: "a0ec", name: "general-purpose" }), "From general-purpose");
  assert.equal(foldedMessageLabel("agent", { kind: "peer", from: "a0ec" }), "From a0ec");
  assert.equal(foldedMessageLabel("agent", undefined), "Agent");
  assert.equal(foldedMessageLabel("automation", { kind: "scheduled" }), "Automated run");
  assert.equal(foldedMessageLabel("t3code", undefined), "System");
});
