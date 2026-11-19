import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeContextWindow, hasOneMillionBeta } from "./claudeModels.ts";

test("context window: native 1M, 200k, and the 1M context by beta or [1m] suffix (CLI 2.1.325 catalog)", () => {
  assert.equal(claudeContextWindow("claude-opus-5-5", null), 1_000_000);
  assert.equal(claudeContextWindow("claude-haiku-4-5-20251001", null), 200_000, "first-party dated id");
  assert.equal(claudeContextWindow("claude-haiku-4-5", true), 200_000, "no wider window to switch to");
  assert.equal(claudeContextWindow("claude-opus-4-6", true), 1_000_000);
  assert.equal(claudeContextWindow("claude-opus-4-6", false), 200_000);
  assert.equal(claudeContextWindow("claude-opus-4-6", null), undefined, "depends on the 1M context, which is unknown");
  assert.equal(claudeContextWindow("claude-opus-4-6", null, 150_000), undefined, "a context that fits either window tells nothing");
  assert.equal(claudeContextWindow("claude-opus-4-6", null, 250_000), 1_000_000, "a context over 200k shows the 1M context");
  assert.equal(claudeContextWindow("claude-opus-4-6", false, 250_000), 200_000, "a request record decides");
  assert.equal(claudeContextWindow("claude-opus-4-6[1m]", null), 1_000_000);
  assert.equal(claudeContextWindow("claude-sonnet-4-5-20250929", false), 200_000);
  assert.equal(claudeContextWindow("claude-sonnet-4-5-20991231", false), 200_000, "an unlisted date falls back to the undated id");
  assert.equal(claudeContextWindow("claude-future-9", null), undefined);
  assert.equal(claudeContextWindow(undefined, null), undefined);
  assert.equal(claudeContextWindow("<synthetic>", null), undefined);
});

test("1M beta: any context-1m-* entry", () => {
  assert.equal(hasOneMillionBeta(["claude-code-20250219", "context-1m-2025-08-07"]), true);
  assert.equal(hasOneMillionBeta(["claude-code-20250219"]), false);
  assert.equal(hasOneMillionBeta("context-1m-2025-08-07"), false);
  assert.equal(hasOneMillionBeta(undefined), false);
});
