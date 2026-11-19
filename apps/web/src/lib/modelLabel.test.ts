import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadProjectionState, ThreadTokenUsageSnapshot } from "@maru/shared";

import { composerModelLabel, contextWindowOf, footerModel, shortModelLabel } from "./modelLabel.ts";

test("composerModelLabel capitalizes a Claude family and keeps other ids", () => {
  assert.equal(composerModelLabel("claude-opus-5-5"), "Opus 5.5");
  assert.equal(composerModelLabel("claude-opus-5-5[1m]"), "Opus 5.5 1M");
  assert.equal(composerModelLabel("sonnet"), "Sonnet");
  assert.equal(composerModelLabel("gpt-6-astra"), "gpt-6-astra");
  assert.equal(composerModelLabel(undefined), null);
});

test("shortModelLabel reads Claude ids as family and version", () => {
  assert.equal(shortModelLabel("claude-sonnet-4-8"), "sonnet 4.8");
  assert.equal(shortModelLabel("claude-opus-5-5[1m]"), "opus 5.5 1M");
  assert.equal(shortModelLabel("claude-haiku-4-5-20251001"), "haiku 4.5");
  assert.equal(shortModelLabel("claude-opus-5"), "opus 5");
  assert.equal(shortModelLabel("claude-3-5-haiku-20241022"), "haiku 3.5");
  assert.equal(shortModelLabel("claude-fable-5"), "fable 5");
});

test("a 1M choice reads as 1M on the button, the terminal footer and its context", () => {
  assert.equal(composerModelLabel("claude-opus-4-6[1m]"), "Opus 4.6 1M");
  assert.equal(shortModelLabel("claude-sonnet-4-6[1m]"), "sonnet 4.6 1M");
  const base = { model: "claude-opus-4-6", ownership: "headless", control: "headless", nameSource: "id" } as unknown as ThreadProjectionState;
  const usage = { usedTokens: 34_000, maxTokens: 200_000 } as ThreadTokenUsageSnapshot;
  // The footer names the model as chosen or reported; an alias or "default" is not a model name.
  assert.equal(footerModel({ ...base, chosen: { model: "claude-opus-4-6[1m]" } }), "claude-opus-4-6[1m]");
  assert.equal(footerModel({ ...base, chosen: { model: "opus" } }), "claude-opus-4-6");
  assert.equal(footerModel({ ...base, oneMillion: true }), "claude-opus-4-6[1m]");
  // The window follows the model as shown; the snapshot's (latest request) value is the fallback.
  assert.equal(contextWindowOf({ ...base, chosen: { model: "claude-opus-4-6[1m]" } }, usage), 1_000_000, "right after the choice, before a request");
  assert.equal(contextWindowOf({ ...base, oneMillion: true }, { ...usage, maxTokens: 1_000_000 }), 1_000_000);
  assert.equal(contextWindowOf({ ...base, oneMillion: false }, usage), 200_000);
  assert.equal(contextWindowOf({ ...base, oneMillion: true, chosen: { model: "claude-opus-4-6" } }, { ...usage, maxTokens: 1_000_000 }), 200_000, "back to the plain row");
  assert.equal(contextWindowOf(base, { ...usage, maxTokens: 1_000_000 }), 1_000_000, "no request record: the server's value stands");
  assert.equal(contextWindowOf({ ...base, model: "gpt-6-luna" }, { ...usage, maxTokens: 258_400 }), 258_400);
  assert.equal(contextWindowOf({ ...base, model: "claude-opus-5-5", oneMillion: true }, { ...usage, maxTokens: 1_000_000 }), 1_000_000);
});

test("shortModelLabel keeps other ids and skips none", () => {
  assert.equal(shortModelLabel("gpt-6-luna"), "gpt-6-luna");
  assert.equal(shortModelLabel(null), null);
  assert.equal(shortModelLabel(""), null);
});
