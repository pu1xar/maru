import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, completeUserConfig, configFile, expandHome, loadUserConfig, parseUserConfig, resolveClaudeBin } from "./userConfig.ts";

const HOME = "/home/someone";
const CONFIG_TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "config.ts");

/** A deployment with several accounts of each provider, as one person's config file writes it. */
const MULTI = {
  claudeAccounts: [
    { id: "claude-work", dir: "~/.claude" },
    { id: "claude-personal", dir: "~/.claude-personal" },
    { id: "claude-shared", dir: "~/.claude-shared" },
  ],
  codexAccounts: [
    { id: "codex-work", home: "~/.codex" },
    { id: "codex-personal", home: "~/.codex-personal" },
  ],
  claudeUsage: true,
  codexUsage: true,
};

test("a multi-account config gives the accounts with ~ expanded, in file order", () => {
  const c = parseUserConfig(JSON.stringify(MULTI), HOME, "config.json");
  assert.deepEqual(c.claudeAccounts, [
    { id: "claude-work", dir: path.join(HOME, ".claude") },
    { id: "claude-personal", dir: path.join(HOME, ".claude-personal") },
    { id: "claude-shared", dir: path.join(HOME, ".claude-shared") },
  ]);
  assert.deepEqual(c.codexAccounts, [
    { id: "codex-work", home: path.join(HOME, ".codex") },
    { id: "codex-personal", home: path.join(HOME, ".codex-personal") },
  ]);
  assert.equal(c.claudeUsage, true);
  assert.equal(c.codexUsage, true);
});

test("every field is optional: the usage switches default to off", () => {
  const c = parseUserConfig("{}", HOME, "config.json");
  assert.equal(c.claudeUsage, false);
  assert.equal(c.codexUsage, false);
});

test("a missing account list is found on disk; an explicit empty list stays empty", () => {
  const has = (...dirs: string[]) => (p: string) => dirs.includes(p);
  assert.deepEqual(completeUserConfig({}, HOME, has(path.join(HOME, ".claude"), path.join(HOME, ".codex"))), {
    claudeAccounts: [{ id: "claude", dir: path.join(HOME, ".claude") }],
    codexAccounts: [{ id: "codex", home: path.join(HOME, ".codex") }],
    claudeUsage: false,
    codexUsage: false,
    claudeBin: null,
  });
  const onlyClaude = completeUserConfig({}, HOME, has(path.join(HOME, ".claude")));
  assert.equal(onlyClaude.codexAccounts.length, 0);
  assert.equal(completeUserConfig({ claudeAccounts: [] }, HOME, () => true).claudeAccounts.length, 0);
  // Only the list that is absent is found: a file naming Claude accounts leaves Codex to the disk.
  const c = completeUserConfig({ claudeAccounts: [{ id: "a", dir: "/x" }] }, HOME, has(path.join(HOME, ".codex")));
  assert.deepEqual(c.codexAccounts, [{ id: "codex", home: path.join(HOME, ".codex") }]);
});

test("settings that cannot be read are an error that names the file and the reason", () => {
  const bad: [string, RegExp][] = [
    ["{ not json", /config\.json: not valid JSON/],
    ["[]", /top level must be a JSON object/],
    ['{ "claudeAccount": [] }', /unknown field "claudeAccount"/],
    ['{ "claudeAccounts": {} }', /"claudeAccounts" must be an array/],
    ['{ "claudeAccounts": ["x"] }', /claudeAccounts\[0\] must be an object/],
    ['{ "claudeAccounts": [{ "id": "a:b", "dir": "/x" }] }', /claudeAccounts\[0\]\.id must be letters/],
    ['{ "claudeAccounts": [{ "id": "a" }] }', /claudeAccounts\[0\]\.dir must be a folder path/],
    ['{ "claudeAccounts": [{ "id": "a", "dir": "rel/dir" }] }', /must be absolute or start with ~/],
    ['{ "claudeAccounts": [{ "id": "a", "dir": "/x", "home": "/y" }] }', /unknown field "home"/],
    ['{ "codexAccounts": [{ "id": "a", "dir": "/x" }] }', /unknown field "dir"/],
    ['{ "claudeUsage": "yes" }', /"claudeUsage" must be true or false/],
    ['{ "claudeBin": 3 }', /"claudeBin" must be the path/],
    ['{ "claudeBin": "claude" }', /"claudeBin" must be absolute or start with ~/],
    ['{ "codexUsage": 1 }', /"codexUsage" must be true or false/],
    ['{ "claudeAccounts": [{ "id": "a", "dir": "/x" }], "codexAccounts": [{ "id": "a", "home": "/y" }] }', /account id "a" is used twice/],
    ['{ "claudeAccounts": [{ "id": "a", "dir": "/x" }, { "id": "b", "dir": "/x" }] }', /share the folder \/x/],
  ];
  for (const [text, message] of bad) {
    assert.throws(() => parseUserConfig(text, HOME, "config.json"), (err) => err instanceof ConfigError && message.test(err.message), text);
  }
});

test("claudeBin: the configured path, else claude on PATH, else ~/.local/bin/claude", () => {
  assert.equal(parseUserConfig('{ "claudeBin": "~/bin/claude" }', HOME, "c.json").claudeBin, path.join(HOME, "bin", "claude"));
  assert.equal(parseUserConfig("{}", HOME, "c.json").claudeBin, null);
  const on = (...files: string[]) => (p: string) => files.includes(p);
  const PATHS = ["/a/bin", "/b/bin"].join(path.delimiter);
  assert.equal(resolveClaudeBin("/x/claude", HOME, PATHS, on("/a/bin/claude")), "/x/claude");
  assert.equal(resolveClaudeBin(null, HOME, PATHS, on("/b/bin/claude")), "/b/bin/claude");
  assert.equal(resolveClaudeBin(null, HOME, PATHS, on("/a/bin/claude", "/b/bin/claude")), "/a/bin/claude");
  assert.equal(resolveClaudeBin(null, HOME, PATHS, on()), path.join(HOME, ".local", "bin", "claude"));
  assert.equal(resolveClaudeBin(null, HOME, undefined, on()), path.join(HOME, ".local", "bin", "claude"));
  assert.equal(resolveClaudeBin(null, HOME, ["rel", ""].join(path.delimiter), () => true), path.join(HOME, ".local", "bin", "claude"), "relative PATH entries are skipped");
});

test("~ is the home folder only at the start of a path", () => {
  assert.equal(expandHome("~", HOME), HOME);
  assert.equal(expandHome("~/a/b", HOME), path.join(HOME, "a", "b"));
  assert.equal(expandHome("/abs/dir/", HOME), "/abs/dir");
  assert.equal(expandHome("~other/x", HOME), null);
  assert.equal(expandHome("x/~", HOME), null);
});

test("loadUserConfig reads MARU_CONFIG or ~/.config/maru/config.json, and a missing default file is not an error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maru-config-"));
  try {
    const file = path.join(dir, "c.json");
    fs.writeFileSync(file, JSON.stringify(MULTI));
    const named = loadUserConfig({ MARU_CONFIG: file }, HOME);
    assert.equal(named.file, file);
    assert.equal(named.config.claudeAccounts.length, 3);

    assert.equal(configFile({}, HOME), path.join(HOME, ".config", "maru", "config.json"));
    const none = loadUserConfig({}, dir);
    assert.equal(none.file, null);
    assert.equal(none.config.claudeAccounts.length, 0, "an empty home has no accounts to find");

    // A path somebody wrote down that is not there is a mistake.
    assert.throws(() => loadUserConfig({ MARU_CONFIG: path.join(dir, "missing.json") }, HOME), /does not exist/);

    fs.mkdirSync(path.join(dir, ".config", "maru"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".config", "maru", "config.json"), "{ broken");
    assert.throws(() => loadUserConfig({}, dir), /config\.json: not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs config.ts in its own process with HOME and MARU_CONFIG as given and prints what it exports. */
function runConfig(env: Record<string, string>) {
  const code = `
    import * as c from ${JSON.stringify(CONFIG_TS)};
    console.log(JSON.stringify({ claude: c.CLAUDE_ACCOUNTS, codex: c.CODEX_ACCOUNTS, usage: c.CLAUDE_USAGE, codexUsage: c.CODEX_USAGE, file: c.CONFIG_FILE }));`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
}

test("config.ts exports the accounts of the config file, the same shape the server always took", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maru-config-home-"));
  try {
    const file = path.join(dir, "personal.json");
    fs.writeFileSync(file, JSON.stringify(MULTI));
    const r = runConfig({ HOME: dir, MARU_CONFIG: file });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      claude: [
        { id: "claude-work", dir: path.join(dir, ".claude") },
        { id: "claude-personal", dir: path.join(dir, ".claude-personal") },
        { id: "claude-shared", dir: path.join(dir, ".claude-shared") },
      ],
      codex: [
        { id: "codex-work", home: path.join(dir, ".codex") },
        { id: "codex-personal", home: path.join(dir, ".codex-personal") },
      ],
      usage: true,
      codexUsage: true,
      file,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config.ts without a file finds ~/.claude and ~/.codex", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maru-config-home-"));
  try {
    fs.mkdirSync(path.join(dir, ".claude"));
    fs.mkdirSync(path.join(dir, ".codex"));
    const r = runConfig({ HOME: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      claude: [{ id: "claude", dir: path.join(dir, ".claude") }],
      codex: [{ id: "codex", home: path.join(dir, ".codex") }],
      usage: false,
      codexUsage: false,
      file: null,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config.ts stops with the reason when the config file is invalid JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maru-config-home-"));
  try {
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, '{ "claudeAccounts": [ ');
    const r = runConfig({ HOME: dir, MARU_CONFIG: file });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /maru: .*bad\.json: not valid JSON/);
    assert.equal(r.stdout, "", "nothing was exported");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
