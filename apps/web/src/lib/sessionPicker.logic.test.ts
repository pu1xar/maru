import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelOption, SessionCommand, SessionModelsResponse, ThreadProjectionState } from "@maru/shared";
import {
  INITIAL_PICKER_LOAD, effortDetail, effortLine, effortSegments, effortStart, effortSteps, initialRow, interceptMessage, modelChange, pickerDataFor, pickerKey, pickerLoadReducer,
  pickerView, currentModel,
} from "./sessionPicker.logic.ts";
import { withOneMillionRows } from "@maru/shared";

const opt = (over: Partial<ModelOption>): ModelOption => ({
  value: "x", resolved: null, label: "X", description: "", efforts: [], defaultEffort: null, isDefault: false, ...over,
});
const OPTIONS: ModelOption[] = [
  opt({ value: "default", resolved: "claude-opus-5-5", label: "Default (recommended)", efforts: ["low", "high"], isDefault: true, fast: true }),
  opt({ value: "opus", resolved: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "high"], fast: true }),
  opt({ value: "claude-haiku-4-5-20251001", resolved: "claude-haiku-4-5-20251001", label: "Haiku 4.5" }),
];
const state = (over: Partial<ThreadProjectionState>): ThreadProjectionState => ({
  ownership: "headless", control: "headless", nameSource: "id",
  stats: { linesRead: 0, parseFailures: 0, partialTail: 0, byKey: {}, displayedByKey: {}, hiddenByKey: {}, unknownByKey: {} },
  ...over,
});

test("the model picker checks the row the session runs: a chosen value first, else the transcript's model id", () => {
  const fromTranscript = pickerView("model", "claude", state({ model: "claude-opus-5-5" }), { models: { key: "k", options: OPTIONS, from: "run" } });
  assert.deepEqual(fromTranscript.rows.filter((r) => r.current).map((r) => r.id), ["opus"], "an id names the non-default row");
  assert.equal(fromTranscript.current, "Opus 5.5");
  const dated = pickerView("model", "claude", state({ model: "claude-haiku-4-5-20251001" }), { models: { key: "k", options: OPTIONS, from: "run" } });
  assert.equal(dated.rows.find((r) => r.current)?.id, "claude-haiku-4-5-20251001");
  const chosen = pickerView("model", "claude", state({ model: "claude-haiku-4-5-20251001", chosen: { model: "default", pending: true } }), { models: { key: "k", options: OPTIONS, from: "probe" } });
  assert.equal(chosen.rows.find((r) => r.current)?.id, "default");
  assert.equal(chosen.pending, true);
  assert.equal(initialRow(chosen.rows), 0);
});

test("a 1M row is checked only for the 1M run: [1m] chosen, reported, or the latest request's beta on the transcript's model", () => {
  const rows = withOneMillionRows([
    opt({ value: "default", resolved: "claude-opus-5-5", label: "Default (recommended)", isDefault: true }),
    opt({ value: "claude-opus-4-6", resolved: "claude-opus-4-6", label: "Opus 4.6", efforts: ["low", "high"] }),
  ]);
  const data = { models: { key: "k", options: rows, from: "run" as const } };
  const checked = (s: ThreadProjectionState) => pickerView("model", "claude", s, data).rows.filter((r) => r.current).map((r) => r.id);
  assert.deepEqual(checked(state({ model: "claude-opus-4-6" })), ["claude-opus-4-6"]);
  assert.deepEqual(checked(state({ model: "claude-opus-4-6", oneMillion: false })), ["claude-opus-4-6"]);
  assert.deepEqual(checked(state({ model: "claude-opus-4-6", oneMillion: true })), ["claude-opus-4-6[1m]"], "the transcript has no [1m]; the request's beta does");
  assert.deepEqual(checked(state({ model: "claude-opus-4-6", chosen: { model: "claude-opus-4-6[1m]" } })), ["claude-opus-4-6[1m]"]);
  assert.deepEqual(checked(state({ model: "claude-opus-4-6", oneMillion: true, chosen: { model: "claude-opus-4-6" } })), ["claude-opus-4-6"], "choosing the plain row again leaves the 1M run");
  assert.equal(pickerView("model", "claude", state({ model: "claude-opus-4-6", chosen: { model: "claude-opus-4-6[1m]" } }), data).current, "Opus 4.6 (1M)");
  assert.deepEqual(modelChange("claude", rows[2]!, 0, false), { model: "claude-opus-4-6[1m]" });
  // A model already at 1M has no variant: oneMillion on the state changes nothing.
  assert.equal(currentModel(state({ model: "claude-opus-5-5", oneMillion: true })), "claude-opus-5-5");
});

test("the effort line steps through auto and the model's levels; picking sends the effort only when it was moved", () => {
  const opus = OPTIONS[1]!;
  assert.deepEqual(effortSteps("claude", opus), ["auto", "low", "high"]);
  assert.deepEqual(effortSteps("codex", opus), ["low", "high"], "Codex has no auto");
  assert.deepEqual(effortSteps("claude", OPTIONS[2]), [], "a model without effort");
  assert.equal(effortStart("claude", opus, "high"), 2);
  assert.equal(effortStart("claude", opus, null), 0, "no effort chosen is auto");
  assert.equal(effortStart("codex", opt({ efforts: ["low", "high"], defaultEffort: "high" }), null), 1, "Codex starts at the model's default");
  assert.equal(effortLine("codex", opt({ efforts: ["low", "high"], defaultEffort: "high" }), 1), "effort high (default)");
  assert.equal(effortLine("claude", OPTIONS[2], -1), "Haiku 4.5 takes no effort");
  const noted = opt({ efforts: ["low", "high"], defaultEffort: "high", effortNotes: { high: "Greater depth" } });
  assert.equal(effortLine("codex", noted, 1), "effort high (default), Greater depth");
  assert.equal(effortLine("codex", noted, 0), "effort low");
  const segs = effortSegments("claude", opus, 2);
  assert.deepEqual(segs.map((s) => s.level), ["auto", "low", "medium", "high", "xhigh", "max"], "Claude lists every named level");
  assert.deepEqual(segs.filter((s) => s.selected).map((s) => s.level), ["high"], "step 2 of auto, low, high is high");
  assert.deepEqual(segs.filter((s) => !s.disabled).map((s) => s.level), ["auto", "low", "high"], "only the model's levels can be picked");
  assert.equal(segs.find((s) => s.level === "medium")!.disabled, "Opus 5.5 does not take medium");
  assert.equal(segs.find((s) => s.level === "auto")!.note, "Follows the model's default");
  assert.deepEqual(effortSegments("claude", OPTIONS[2], -1), [], "a model without efforts has no strip");
  const cx = effortSegments("codex", noted, 1);
  assert.deepEqual(cx.map((s) => [s.level, s.selected, s.disabled, s.isDefault, s.note]), [["low", false, null, false, null], ["high", true, null, true, "Greater depth"]]);
  assert.equal(effortDetail("codex", noted, 1), "default, Greater depth");
  assert.equal(effortDetail("codex", noted, 0), "");
  assert.equal(effortDetail("claude", opus, 0), "Follows the model's default");
  assert.equal(effortDetail("claude", OPTIONS[2], -1), "Haiku 4.5 takes no effort");
  assert.deepEqual(modelChange("claude", opus, 1, false), { model: "opus" });
  assert.deepEqual(modelChange("claude", opus, 1, true), { model: "opus", effort: "low" });
  assert.deepEqual(modelChange("claude", opus, 0, true), { model: "opus", effort: null }, "auto is null");
});

test("the effort, permission, fast and output style pickers", () => {
  const models = { key: "k", options: OPTIONS, from: "run" as const, outputStyles: ["default", "Concise"] };
  const effort = pickerView("effort", "claude", state({ model: "claude-opus-5-5", effort: "high" }), { models });
  assert.deepEqual(effort.rows.map((r) => r.id), ["auto", "low", "high"]);
  assert.equal(effort.rows.find((r) => r.current)?.id, "high");
  assert.deepEqual(effort.rows[0]!.change, { effort: null });
  const haiku = pickerView("effort", "claude", state({ model: "claude-haiku-4-5-20251001" }), { models });
  assert.match(haiku.rows[1]!.disabled ?? "", /takes no effort/);
  const modes = pickerView("permissions", "claude", state({ permissionMode: "plan" }), {});
  assert.deepEqual(modes.rows.map((r) => [r.id, r.current]), [["default", false], ["acceptEdits", false], ["plan", true], ["bypassPermissions", false]]);
  const fast = pickerView("fast", "claude", state({ model: "claude-haiku-4-5-20251001" }), { models });
  assert.match(fast.rows[0]!.disabled ?? "", /does not take fast mode/);
  assert.equal(fast.rows[1]!.current, true);
  const styles = pickerView("output-style", "claude", state({ chosen: { outputStyle: "Concise" } }), { models });
  assert.deepEqual(styles.rows.map((r) => [r.id, r.current, r.change]), [["default", false, { outputStyle: null }], ["Concise", true, { outputStyle: "Concise" }]]);
});

test("an MCP server row opens its actions", () => {
  const view = pickerView("mcp", "claude", null, { mcp: [
    { name: "docs", status: "connected", scope: "user", error: null, tools: 3 },
    { name: "off", status: "disabled", scope: "user", error: null, tools: 0 },
  ] });
  assert.equal(view.rows[0]!.description, "Connected, 3 tools");
  assert.deepEqual(view.rows[0]!.next!.rows.map((r) => [r.label, r.change]), [
    ["Turn off", { mcp: { server: "docs", action: "disable" } }],
    ["Reconnect", { mcp: { server: "docs", action: "reconnect" } }],
  ]);
  assert.equal(view.rows[1]!.next!.rows[0]!.label, "Turn on");
  assert.equal(view.rows[1]!.next!.rows[1]!.disabled, "Server is off");
});

test("a composer opens a picker for /model alone, sends /model with an argument, and keeps unsupported screens back", () => {
  const builtinOnly: SessionCommand[] = [{ name: "compact", sigil: "/", description: "", argumentHint: "", aliases: [], source: "builtin" }];
  assert.deepEqual(interceptMessage("claude", "/model"), { kind: "picker", picker: "model" });
  assert.equal(interceptMessage("claude", "/model opus"), null, "the server runs it");
  assert.deepEqual(interceptMessage("claude", "/permissions  "), { kind: "picker", picker: "permissions" });
  assert.equal(interceptMessage("claude", " /permissions"), null, "a leading space makes it text, as the server reads it");
  assert.equal(interceptMessage("codex", " /status"), null);
  assert.deepEqual(interceptMessage("claude", "/hooks", builtinOnly), { kind: "unsupported", notice: "/hooks: Not supported in maru" });
  assert.equal(interceptMessage("claude", "/compact"), null);
  assert.equal(interceptMessage("claude", "/Users/me/a.txt 봐 줘"), null);
  const own: SessionCommand[] = [{ name: "hooks", sigil: "/", description: "", argumentHint: "", aliases: [], source: "custom" }];
  assert.equal(interceptMessage("claude", "/hooks", own), null, "the user's own command");
  assert.deepEqual(interceptMessage("codex", "/model"), { kind: "picker", picker: "model" });
  assert.deepEqual(interceptMessage("codex", "/effort"), { kind: "picker", picker: "effort" }, "maru's own: the TUI has it inside /model only");
  assert.equal(interceptMessage("claude", "/status", []), null, "a command the server runs goes as it is");
  assert.match((interceptMessage("codex", "/status") as { notice: string }).notice, /Not supported in maru/);
});

test("Claude: while the session's list is not loaded an unsupported screen goes to the server, which reads the list (it may be the user's skill)", () => {
  assert.equal(interceptMessage("claude", "/hooks"), null);
  assert.equal(interceptMessage("claude", "/plan 이 캐시 계층 설계해줘", null), null);
  assert.equal(interceptMessage("claude", "/usage-credits"), null);
});

test("Codex: every 0.169.0 TUI command is kept back, its aliases and the fast tier too; the rest goes to the server, which refuses other /names", () => {
  for (const name of ["clear", "cd", "pwd", "cwd", "side", "btw", "recap", "voice", "worktree", "archive", "import", "keymap", "vim", "ide",
    "raw", "daemon", "warnings", "debug-config", "ps", "stop", "clean", "presets", "daybreak", "subagents", "pet", "memories", "approve", "fast"]) {
    assert.equal(interceptMessage("codex", `/${name}`)?.kind, "unsupported", name);
  }
  for (const name of ["approvals", "memory", "rollout", "compact", "goal"]) {
    assert.equal(interceptMessage("codex", `/${name}`), null, name);
  }
});

test("picker keys: arrows wrap, Esc backs out of a second list or closes, ← → only with an effort line, digits only where asked", () => {
  const ctx = { rows: 3, index: 2, nested: false, effort: true };
  assert.deepEqual(pickerKey("ArrowDown", {}, ctx), { type: "move", to: 0 });
  assert.deepEqual(pickerKey("ArrowUp", {}, { ...ctx, index: 0 }), { type: "move", to: 2 });
  assert.deepEqual(pickerKey("ArrowUp", {}, { ...ctx, rows: 0, index: 0 }), { type: "move", to: 0 }, "an empty list keeps the key");
  assert.deepEqual(pickerKey("Escape", {}, ctx), { type: "close" });
  assert.deepEqual(pickerKey("Escape", {}, { ...ctx, nested: true }), { type: "back" });
  assert.deepEqual(pickerKey("ArrowRight", {}, ctx), { type: "effort", delta: 1 });
  assert.equal(pickerKey("ArrowLeft", {}, { ...ctx, effort: false }), null, "the caret moves");
  assert.deepEqual(pickerKey("Enter", {}, ctx), { type: "pick", index: 2 });
  assert.equal(pickerKey("Enter", { shift: true }, ctx), null);
  assert.equal(pickerKey("Enter", { alt: true }, ctx), null);
  assert.equal(pickerKey("Enter", { composing: true }, ctx), null, "an IME syllable is committed first");
  assert.equal(pickerKey("2", {}, ctx), null, "typing in the chat composer");
  assert.deepEqual(pickerKey("2", {}, { ...ctx, digits: true }), { type: "pick", index: 1 });
  assert.equal(pickerKey("4", {}, { ...ctx, digits: true }), null, "no fourth row");
  for (const mods of [{ meta: true }, { ctrl: true }, { alt: true }]) {
    assert.equal(pickerKey("2", mods, { ...ctx, digits: true }), null, `${JSON.stringify(mods)}+2 is a shortcut`);
    assert.equal(pickerKey("ArrowDown", mods, ctx), null);
    assert.deepEqual(pickerKey("Escape", mods, ctx), { type: "close" }, "Esc still closes");
  }
  assert.equal(pickerKey("a", {}, ctx), null);
});

test("the Codex effort picker lists the model's levels with its default and no auto; fast cooldown is named", () => {
  const codex = [opt({ value: "gpt-big", resolved: "gpt-big", label: "GPT-BIG", efforts: ["low", "high"], defaultEffort: "high", isDefault: true })];
  const view = pickerView("effort", "codex", state({ model: "gpt-big" }), { models: { key: "k", options: codex, from: "daemon" } });
  assert.deepEqual(view.rows.map((r) => [r.id, r.description, r.current, r.change]), [
    ["low", "", false, { effort: "low" }],
    ["high", "Default", true, { effort: "high" }],
  ]);
  const picked = pickerView("effort", "codex", state({ model: "gpt-big", chosen: { effort: "low", pending: true } }), { models: { key: "k", options: codex, from: "daemon" } });
  assert.deepEqual([picked.current, picked.pending], ["low", true]);
  const fast = pickerView("fast", "claude", state({ chosen: { fast: true, fastCooldown: true } }), { models: { key: "k", options: OPTIONS, from: "run" } });
  assert.match(fast.current ?? "", /^on, standard speed/);
});

const models = (key: string): SessionModelsResponse => ({ key, options: OPTIONS, from: "run" });

test("picker data belongs to the session and the request it answers", () => {
  let s = pickerLoadReducer(INITIAL_PICKER_LOAD, { type: "open", seq: 1, key: "a", need: "models" });
  assert.equal(pickerDataFor(s, "a"), null, "nothing while loading");
  s = pickerLoadReducer(s, { type: "loaded", seq: 1, need: "models", body: models("a") });
  assert.equal(pickerDataFor(s, "a")?.models?.key, "a");
  assert.equal(pickerDataFor(s, "b"), null, "another session sees none of it");

  // Opened again: a failure hides the earlier rows, so Enter cannot pick one of them.
  s = pickerLoadReducer(s, { type: "open", seq: 2, key: "a", need: "models" });
  s = pickerLoadReducer(s, { type: "failed", seq: 2, need: "models", error: "HTTP 502" });
  assert.equal(pickerDataFor(s, "a"), null);
  assert.equal(s.error, "HTTP 502");
  assert.equal(s.data.models, undefined);

  // Another session's picker: an answer to the first session's older request is dropped.
  s = pickerLoadReducer(s, { type: "open", seq: 3, key: "a", need: "models" });
  s = pickerLoadReducer(s, { type: "open", seq: 4, key: "b", need: "models" });
  s = pickerLoadReducer(s, { type: "loaded", seq: 3, need: "models", body: models("a") });
  assert.equal(s.loading, true, "still waiting for b's answer");
  assert.equal(s.data.models, undefined);
  s = pickerLoadReducer(s, { type: "loaded", seq: 4, need: "models", body: models("b") });
  assert.equal(pickerDataFor(s, "b")?.models?.key, "b");

  // A picker that fetches nothing (permissions) shows at once, keeping the session's data.
  s = pickerLoadReducer(s, { type: "open", seq: 5, key: "b", need: null });
  assert.equal(pickerDataFor(s, "b")?.models?.key, "b");
  s = pickerLoadReducer(s, { type: "open", seq: 6, key: "c", need: null });
  assert.deepEqual(pickerDataFor(s, "c"), {}, "a new session starts with no data");
});
