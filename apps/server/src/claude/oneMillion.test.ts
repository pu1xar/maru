import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  ONE_MILLION_CLI_VERSION, ONE_MILLION_MODELS, ONE_MILLION_SDK_VERSION, oneMillionModelOf, oneMillionWindow, optionFor,
} from "@maru/shared";
import { claudeModelOptions } from "../commands/sessionCommands.ts";
import { claudeContextWindow } from "./projection/claudeModels.ts";

const model = (value: string, resolvedModel: string, displayName: string): ModelInfo =>
  ({ value, resolvedModel, displayName, description: `${displayName} blurb`, supportsEffort: true, supportedEffortLevels: ["low", "high"], supportsFastMode: value === "opus" }) as ModelInfo;

// What the SDK's supportedModels() answered on a Max account (2026-11-16, CLI 2.1.325).
const SDK_LIST = [
  model("default", "claude-opus-5-5", "Default (recommended)"),
  model("opus", "claude-opus-5-5", "Opus 5.5"),
  model("sonnet", "claude-sonnet-5-5", "Sonnet 5.5"),
  model("claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001", "Haiku 4.5"),
  model("claude-opus-4-6", "claude-opus-4-6", "Opus 4.6"),
  model("claude-sonnet-4-6", "claude-sonnet-4-6", "Sonnet 4.6"),
];

test("the table is the one measured against the installed SDK: raising the SDK means reading the CLI's model catalog again", () => {
  const pkg = fs.readFileSync(fileURLToPath(new URL("../../node_modules/@anthropic-ai/claude-agent-sdk/package.json", import.meta.url)), "utf8");
  const installed = (JSON.parse(pkg) as { version: string }).version;
  assert.equal(
    installed,
    ONE_MILLION_SDK_VERSION,
    `SDK ${installed} is installed but packages/shared/src/oneMillion.ts was read from SDK ${ONE_MILLION_SDK_VERSION} (CLI ${ONE_MILLION_CLI_VERSION}): ` +
      "extract the models with supports_1m_suffix, supports_1m_beta and maximum_window > window from the new claude binary's catalog, update ONE_MILLION_MODELS and the two versions, and extend claudeModels.ts to match",
  );
});

test("each table model is 200K by default and 1M with the beta in the context table the projector uses", () => {
  for (const m of ONE_MILLION_MODELS) {
    for (const id of m.ids) {
      assert.equal(claudeContextWindow(id, false), m.window, `${id} window`);
      if (!/-0$/.test(id)) assert.equal(claudeContextWindow(id, true), m.maxWindow, `${id} with the beta`);
      assert.equal(claudeContextWindow(`${id}[1m]`, null), m.maxWindow, `${id}[1m]`);
    }
  }
});

test("a 1M row follows each model that has both windows; a model already at 1M or without the beta gets none", () => {
  const options = claudeModelOptions(SDK_LIST);
  assert.deepEqual(
    options.map((o) => o.value),
    ["default", "opus", "sonnet", "claude-haiku-4-5-20251001", "claude-opus-4-6", "claude-opus-4-6[1m]", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]"],
    "default, opus and sonnet resolve to 1M-native models; Haiku 4.5 has the suffix but not the beta (the API answered 400)",
  );
  const row = options.find((o) => o.value === "claude-opus-4-6[1m]")!;
  assert.equal(row.label, "Opus 4.6 (1M)");
  assert.equal(row.description, "Opus 4.6 for long sessions");
  assert.equal(row.oneMillion, true);
  assert.equal(row.resolved, "claude-opus-4-6");
  assert.equal(row.isDefault, false);
  assert.deepEqual(row.efforts, ["low", "high"], "the row keeps its model's effort levels");
  assert.equal(options.find((o) => o.value === "claude-opus-4-6")?.oneMillion, undefined);
});

test("a model reached by two rows (an alias and its id) gets one 1M row, under the first", () => {
  const rows = claudeModelOptions([model("default", "claude-opus-4-6", "Default"), model("claude-opus-4-6", "claude-opus-4-6", "Opus 4.6")]);
  assert.deepEqual(rows.map((o) => o.value), ["default", "claude-opus-4-6[1m]", "claude-opus-4-6"]);
  assert.equal(rows[1]!.label, "Opus 4.6 (1M)", "named by the model, not by the default row's label");
});

test("optionFor tells the 1M run from the plain one, by [1m] and by id", () => {
  const options = claudeModelOptions(SDK_LIST);
  assert.equal(optionFor(options, "claude-opus-4-6")?.value, "claude-opus-4-6");
  assert.equal(optionFor(options, "claude-opus-4-6[1m]")?.value, "claude-opus-4-6[1m]");
  assert.equal(optionFor(options, "claude-opus-4-6[1M]")?.value, "claude-opus-4-6[1m]", "case of the tag");
  assert.equal(optionFor(options, "claude-opus-5-5")?.value, "opus", "an id names the non-default row");
  assert.equal(optionFor(options, "claude-opus-5-5[1m]"), null, "no 1M row for a model that has one window");
  assert.equal(optionFor(options, "claude-sonnet-4-6-20991231[1m]")?.value, "claude-sonnet-4-6[1m]", "an unlisted date falls back to the undated id");
});

test("the table's lookups", () => {
  assert.equal(oneMillionModelOf("claude-sonnet-4-5-20250929")?.name, "Sonnet 4.5");
  assert.equal(oneMillionModelOf("claude-sonnet-4-5")?.name, "Sonnet 4.5");
  assert.equal(oneMillionModelOf("claude-sonnet-4-0[1m]")?.name, "Sonnet 4");
  assert.equal(oneMillionModelOf("claude-haiku-4-5"), null);
  assert.equal(oneMillionModelOf("claude-opus-5-5"), null);
  assert.equal(oneMillionWindow("claude-opus-4-6"), 200_000);
  assert.equal(oneMillionWindow("claude-opus-4-6[1m]"), 1_000_000);
  assert.equal(oneMillionWindow("claude-opus-5-5"), null);
});
