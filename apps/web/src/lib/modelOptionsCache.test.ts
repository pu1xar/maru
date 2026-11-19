import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelOption } from "@maru/shared";
import { accountScope, storeModelOptions, storedModelOptions } from "./modelOptionsCache.ts";

const OPT: ModelOption = { value: "gpt-6-astra", resolved: null, label: "GPT-6-Astra", description: "", efforts: [], defaultEffort: null, isDefault: true };

test("a list is shared by the sessions of one account", () => {
  const a = "codex:cx:11111111-1111-1111-1111-111111111111";
  const b = "codex:cx:22222222-2222-2222-2222-222222222222";
  assert.equal(accountScope(a), "codex:cx");
  assert.equal(storedModelOptions(b), null);
  storeModelOptions(a, [OPT]);
  assert.equal(storedModelOptions(b)?.[0]?.label, "GPT-6-Astra");
  assert.equal(storedModelOptions("codex:other:33333333-3333-3333-3333-333333333333"), null);
});
