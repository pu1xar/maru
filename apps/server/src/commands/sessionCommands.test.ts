import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { SessionSummary } from "@maru/shared";
import { SessionIndex } from "../index/store.ts";
import type { SkillMetadata } from "../codex/protocol/v2/SkillMetadata.ts";
import { CODEX_COMMANDS } from "../drive/codexCommands.ts";
import { SessionCommands, SessionCommandsError, codexModelOption, commandSourcesStamp } from "./sessionCommands.ts";
import type { Model as CodexModel } from "../codex/protocol/v2/Model.ts";

test("a Codex model row carries the display name and each effort's note", () => {
  const m = {
    model: "gpt-6-astra", displayName: "GPT-6-Astra", description: "Frontier model", isDefault: true, defaultReasoningEffort: "high",
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "high", description: "" }],
  } as unknown as CodexModel;
  const o = codexModelOption(m);
  assert.equal(o.label, "GPT-6-Astra");
  assert.deepEqual(o.efforts, ["low", "high"]);
  assert.deepEqual(o.effortNotes, { low: "Fast" });
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-commands-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CLAUDE = `claude:acct:${ID}`;
const CODEX = `codex:cx:${ID}`;

function summary(key: string, over: Partial<SessionSummary> = {}): SessionSummary {
  const [provider, account, id] = key.split(":") as ["claude" | "codex", string, string];
  return {
    key, provider, account, id, cwd: root, name: null, title: null, preview: null, status: "closed", owner: "none",
    pid: null, tmuxPane: null, parentKey: null, updatedAt: 1, createdAt: null, sizeBytes: null, entrypoint: null, ...over,
  };
}

function rig() {
  const index = new SessionIndex();
  index.apply({ type: "upsert", session: summary(CLAUDE) });
  index.apply({ type: "upsert", session: summary(CODEX) });
  const probes: Array<{ accountDir: string; cwd: string }> = [];
  let stamp = "s1";
  let live: Promise<SlashCommand[]> | null = null;
  let release: (() => void) | null = null;
  let probeFails: string | null = null;
  const reloads: boolean[] = [];
  const commands = new SessionCommands({
    index,
    claudeAccounts: [{ id: "acct", dir: "/cfg" }],
    claudeRun: () => live,
    claudeProbe: async (opts) => {
      probes.push(opts);
      if (release) await new Promise<void>((r) => (release = r));
      if (probeFails) throw new Error(probeFails);
      return {
        commands: [
          { name: "compact", description: "Clear history", argumentHint: "<instructions>", builtin: true },
          { name: "tdd", description: "Red green", argumentHint: "", aliases: ["test-first"] },
          { name: "model", description: "Set the AI model", argumentHint: "<model>", builtin: true },
          { name: "memory", description: "my own memory skill", argumentHint: "" },
        ],
        models: [
          { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday", supportsEffort: true, supportedEffortLevels: ["low", "high"], supportsFastMode: true },
          { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest" },
        ],
        outputStyles: ["default", "Concise"],
      };
    },
    claudeStamp: () => stamp,
    codexSkills: async (_key, opts) => {
      reloads.push(opts.reload === true);
      const skill: SkillMetadata = { name: "caveman", description: "long text", shortDescription: "terse", path: "/s/SKILL.md", scope: "user", enabled: true, pluginId: null };
      return [skill];
    },
    now: () => 1000,
  });
  return {
    index, commands, probes, reloads,
    setStamp: (s: string) => { stamp = s; },
    setLive: (p: Promise<SlashCommand[]> | null) => { live = p; },
    holdProbes: () => { release = () => {}; },
    releaseProbes: () => { const r = release; release = null; r?.(); },
    failProbes: (msg: string | null) => { probeFails = msg; },
  };
}

test("a Claude session's list comes from a probe, then from the cache while the stamp holds", async () => {
  const r = rig();
  const first = await r.commands.list(CLAUDE);
  assert.equal(first.from, "probe");
  assert.deepEqual(first.commands.slice(0, 2), [
    { name: "compact", sigil: "/", description: "Clear history", argumentHint: "<instructions>", aliases: [], source: "builtin" },
    { name: "tdd", sigil: "/", description: "Red green", argumentHint: "", aliases: ["test-first"], source: "custom" },
  ]);
  assert.deepEqual(r.probes, [{ accountDir: "/cfg", cwd: root }]);
  const second = await r.commands.list(CLAUDE);
  assert.equal(second.from, "cache");
  assert.deepEqual(second.commands, first.commands);
  assert.equal(r.probes.length, 1);
  // A changed source file, or refresh=1, reads it again.
  r.setStamp("s2");
  assert.equal((await r.commands.list(CLAUDE)).from, "probe");
  assert.equal((await r.commands.list(CLAUDE, { refresh: true })).from, "probe");
  assert.equal(r.probes.length, 3);
  assert.equal((await r.commands.list(CLAUDE)).from, "cache");
});

test("the menu marks maru's pickers and unsupported commands, adds the CLI screens the SDK leaves out, and lets a custom command of the same name through", async () => {
  const r = rig();
  const res = await r.commands.list(CLAUDE);
  const by = (name: string) => res.commands.find((c) => c.name === name);
  assert.deepEqual(by("model")?.handling, { kind: "picker", picker: "model" });
  assert.equal(by("model")?.description, "Set the AI model", "a listed command keeps the CLI's description");
  assert.deepEqual(by("permissions")?.handling, { kind: "picker", picker: "permissions" }, "added: the SDK lists no /permissions");
  assert.deepEqual(by("hooks")?.handling, { kind: "unsupported", reason: "Not supported in maru" });
  assert.match((by("resume")?.handling as { reason: string }).reason, /sidebar/);
  assert.equal(by("memory")?.handling, undefined, "a user's own /memory runs as itself");
  assert.equal(res.commands.filter((c) => c.name === "memory").length, 1);
  assert.equal(by("compact")?.handling, undefined);
  const added = res.commands.slice(4).map((c) => c.handling?.kind);
  assert.ok(added.indexOf("unsupported") > added.lastIndexOf("picker"), "added pickers come before the unsupported ones");
});

test("the model picker's rows come from the same probe, without middle dots; a run answers from its process", async () => {
  const r = rig();
  const res = await r.commands.models(CLAUDE);
  assert.equal(res.from, "probe");
  assert.deepEqual(res.options[0], {
    value: "default", resolved: "claude-opus-5-5", label: "Default (recommended)", description: "Opus 5.5, Best for everyday",
    efforts: ["low", "high"], defaultEffort: null, isDefault: true, fast: true,
  });
  assert.deepEqual(res.options[1]!.efforts, [], "a model without supportsEffort takes no effort");
  assert.deepEqual(res.outputStyles, ["default", "Concise"]);
  await r.commands.list(CLAUDE);
  assert.equal(r.probes.length, 1, "the menu reuses the probe");
});

test("menus opened while a probe runs share it", async () => {
  const r = rig();
  r.holdProbes();
  const a = r.commands.list(CLAUDE);
  const b = r.commands.list(CLAUDE);
  await new Promise((x) => setTimeout(x, 10));
  r.releaseProbes();
  assert.deepEqual((await a).commands, (await b).commands);
  assert.equal(r.probes.length, 1);
});

test("a session this server runs answers from its own process, without touching the cache", async () => {
  const r = rig();
  r.setLive(Promise.resolve([{ name: "mcp__docs__search", description: "Search", argumentHint: "<q>" }]));
  const res = await r.commands.list(CLAUDE);
  assert.equal(res.from, "run");
  assert.deepEqual(res.commands[0]!.name, "mcp__docs__search");
  assert.equal(r.probes.length, 0);
  r.setLive(null);
  assert.equal((await r.commands.list(CLAUDE)).from, "probe", "the run's list was not cached");
});

test("a Codex session gets the commands this server runs and the folder's skills as $name", async () => {
  const r = rig();
  const res = await r.commands.list(CODEX);
  assert.equal(res.from, "daemon");
  assert.deepEqual(res.commands.slice(0, CODEX_COMMANDS.length).map((c) => `${c.sigil}${c.name}`), ["/compact", "/review", "/goal", "/fork", "/rename"]);
  assert.deepEqual(res.commands.find((c) => c.sigil === "$"), { name: "caveman", sigil: "$", description: "terse", argumentHint: "", aliases: [], source: "custom" });
  assert.deepEqual(res.commands.find((c) => c.name === "model")?.handling, { kind: "picker", picker: "model" });
  assert.equal(res.commands.find((c) => c.name === "status")?.handling?.kind, "unsupported");
  assert.deepEqual(res.commands.find((c) => c.name === "pwd")?.aliases, ["cwd"], "the menu finds /pwd by its alias");
  assert.equal(res.commands.find((c) => c.name === "clear")?.handling?.kind, "unsupported");
  await r.commands.list(CODEX, { refresh: true });
  assert.deepEqual(r.reloads, [false, true]);
});

test("bad keys, unknown sessions, a missing folder and a failed probe answer with a status", async () => {
  const r = rig();
  const status = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      assert.ok(err instanceof SessionCommandsError);
      return err.status;
    }
    return 200;
  };
  assert.equal(await status(r.commands.list("nope")), 400);
  assert.equal(await status(r.commands.list(`${CLAUDE}:agent-x`)), 400);
  assert.equal(await status(r.commands.list(`claude:acct:${"1".repeat(8)}-1111-4111-8111-111111111111`)), 404);
  r.index.apply({ type: "upsert", session: summary(CLAUDE, { cwd: path.join(root, "gone") }) });
  assert.equal(await status(r.commands.list(CLAUDE)), 409);
  r.index.apply({ type: "upsert", session: summary(CLAUDE) });
  r.failProbes("login required");
  await assert.rejects(r.commands.list(CLAUDE), /Could not read the command list: login required/);
  r.failProbes(null);
  assert.equal((await r.commands.list(CLAUDE)).from, "probe", "a failed probe is not cached");
});

test("the stamp changes when a skill, a command or a project setting changes, and only then", () => {
  const account = path.join(root, "account");
  const work = path.join(root, "proj", "work");
  fs.mkdirSync(path.join(account, "skills", "tdd"), { recursive: true });
  fs.writeFileSync(path.join(account, "skills", "tdd", "SKILL.md"), "a");
  fs.mkdirSync(work, { recursive: true });
  const exe = path.join(root, "claude-bin");
  fs.writeFileSync(exe, "");
  const stamp = () => commandSourcesStamp(account, work, exe);
  const s0 = stamp();
  assert.equal(stamp(), s0, "stable while nothing changes");
  const steps: Array<[string, () => void]> = [
    ["a user skill's SKILL.md", () => fs.writeFileSync(path.join(account, "skills", "tdd", "SKILL.md"), "longer text")],
    ["a new user skill", () => {
      fs.mkdirSync(path.join(account, "skills", "grill"));
      fs.writeFileSync(path.join(account, "skills", "grill", "SKILL.md"), "x");
    }],
    ["a user command", () => {
      fs.mkdirSync(path.join(account, "commands", "git"), { recursive: true });
      fs.writeFileSync(path.join(account, "commands", "git", "ship.md"), "x");
    }],
    ["the account settings", () => fs.writeFileSync(path.join(account, "settings.json"), "{}")],
    ["a parent folder's project command", () => {
      fs.mkdirSync(path.join(root, "proj", ".claude", "commands"), { recursive: true });
      fs.writeFileSync(path.join(root, "proj", ".claude", "commands", "deploy.md"), "x");
    }],
    ["the folder's .mcp.json", () => fs.writeFileSync(path.join(work, ".mcp.json"), "{}")],
  ];
  let prev = s0;
  for (const [what, change] of steps) {
    change();
    const next = stamp();
    assert.notEqual(next, prev, what);
    prev = next;
  }
  // An unrelated file does not count.
  fs.writeFileSync(path.join(work, "notes.txt"), "x");
  assert.equal(stamp(), prev);
});
