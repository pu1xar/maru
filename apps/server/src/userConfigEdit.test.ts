// Editing the config file (userConfig.ts), which the accounts screen does (DESIGN.md 6y).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ConfigEditError, ConfigError, addAccountToFile, editUserConfig, loadUserConfig, removeAccountFromFile, setClaudeUsageInFile, tildify,
  writeFileAtomic,
} from "./userConfig.ts";

function scratch(): { home: string; file: string; env: NodeJS.ProcessEnv; done: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maru-edit-"));
  const file = path.join(home, ".config", "maru", "config.json");
  return { home, file, env: { MARU_CONFIG: file }, done: () => fs.rmSync(home, { recursive: true, force: true }) };
}

const status = (code: number) => (e: unknown) => e instanceof ConfigEditError && e.status === code;

test("tildify writes a path under the home folder with ~", () => {
  assert.equal(tildify("/h/u/.claude-x", "/h/u"), "~/.claude-x");
  assert.equal(tildify("/h/u", "/h/u"), "~");
  assert.equal(tildify("/h/user2/x", "/h/u"), "/h/user2/x");
  assert.equal(tildify("/opt/x", "/h/u"), "/opt/x");
});

test("adding an account to a missing file writes a new file with the accounts found on disk first", () => {
  const s = scratch();
  try {
    fs.mkdirSync(path.join(s.home, ".claude"));
    fs.mkdirSync(path.join(s.home, ".codex"));
    // MARU_CONFIG names a file that does not exist: an edit may create it (the server itself would not start on it).
    const out = addAccountToFile(s.env, s.home, "claude", "work", "~/.claude-work");
    assert.deepEqual(JSON.parse(fs.readFileSync(s.file, "utf8")), {
      claudeAccounts: [{ id: "claude", dir: "~/.claude" }, { id: "work", dir: "~/.claude-work" }],
      codexAccounts: [{ id: "codex", home: "~/.codex" }],
    });
    assert.deepEqual(out.claudeAccounts.map((a) => a.id), ["claude", "work"]);
    assert.deepEqual(fs.readdirSync(path.dirname(s.file)), ["config.json"], "no temporary file is left");
  } finally {
    s.done();
  }
});

test("an edit keeps the other fields, their order and the other account list as written", () => {
  const s = scratch();
  try {
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    const original = {
      claudeBin: "~/.local/bin/claude",
      codexAccounts: [{ id: "codex-a", home: "~/.codex" }],
      claudeUsage: true,
      claudeAccounts: [{ id: "claude-a", dir: "~/.claude" }],
      codexUsage: true,
    };
    fs.writeFileSync(s.file, JSON.stringify(original));
    addAccountToFile(s.env, s.home, "claude", "claude-b", "/opt/claude-b");
    const after = JSON.parse(fs.readFileSync(s.file, "utf8"));
    assert.deepEqual(Object.keys(after), Object.keys(original));
    assert.deepEqual(after.claudeAccounts, [{ id: "claude-a", dir: "~/.claude" }, { id: "claude-b", dir: "/opt/claude-b" }]);
    assert.deepEqual(after.codexAccounts, original.codexAccounts);
    assert.equal(after.claudeUsage, true);
    assert.equal(after.codexUsage, true);
    assert.equal(after.claudeBin, "~/.local/bin/claude");
  } finally {
    s.done();
  }
});

test("an account list the file leaves out is filled with the detected account before an edit, for add and for remove", () => {
  const s = scratch();
  try {
    fs.mkdirSync(path.join(s.home, ".codex"));
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(s.file, JSON.stringify({ claudeAccounts: [] }));
    addAccountToFile(s.env, s.home, "codex", "extra", "~/.codex-extra");
    assert.deepEqual(JSON.parse(fs.readFileSync(s.file, "utf8")).codexAccounts, [{ id: "codex", home: "~/.codex" }, { id: "extra", home: "~/.codex-extra" }]);
    // Removing a detected account writes the list without it, so it is not found again.
    fs.writeFileSync(s.file, "{}");
    removeAccountFromFile(s.env, s.home, "codex");
    assert.deepEqual(JSON.parse(fs.readFileSync(s.file, "utf8")).codexAccounts, []);
    assert.equal(loadUserConfig(s.env, s.home).config.codexAccounts.length, 0);
  } finally {
    s.done();
  }
});

test("the id follows the config rule and is unique across both providers, and a folder is one account's", () => {
  const s = scratch();
  try {
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(s.file, JSON.stringify({ claudeAccounts: [{ id: "a", dir: "~/.claude" }], codexAccounts: [{ id: "c", home: "~/.codex" }] }));
    const before = fs.readFileSync(s.file, "utf8");
    for (const bad of ["", "-x", ".x", "a b", "a/b", "a:b", "é"]) {
      assert.throws(() => addAccountToFile(s.env, s.home, "claude", bad, "~/.x"), status(400), JSON.stringify(bad));
    }
    assert.throws(() => addAccountToFile(s.env, s.home, "codex", "a", "~/.y"), status(409));
    assert.throws(() => addAccountToFile(s.env, s.home, "claude", "n", "~/.codex"), status(409));
    assert.throws(() => addAccountToFile(s.env, s.home, "claude", "n", "relative/dir"), status(400));
    assert.equal(fs.readFileSync(s.file, "utf8"), before, "a refused edit leaves the file as it was");
  } finally {
    s.done();
  }
});

test("removing an account takes it out of the file only; an unknown id is a 404", () => {
  const s = scratch();
  try {
    fs.mkdirSync(path.join(s.home, ".claude-gone"), { recursive: true });
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(s.file, JSON.stringify({ claudeAccounts: [{ id: "keep", dir: "~/.claude" }, { id: "gone", dir: "~/.claude-gone" }], claudeUsage: true }));
    removeAccountFromFile(s.env, s.home, "gone");
    assert.deepEqual(JSON.parse(fs.readFileSync(s.file, "utf8")), { claudeAccounts: [{ id: "keep", dir: "~/.claude" }], claudeUsage: true });
    assert.equal(fs.existsSync(path.join(s.home, ".claude-gone")), true, "the folder stays");
    assert.throws(() => removeAccountFromFile(s.env, s.home, "gone"), status(404));
  } finally {
    s.done();
  }
});

test("claudeUsage is set in place, and creates the file with the detected accounts when there is none", () => {
  const s = scratch();
  try {
    fs.mkdirSync(path.join(s.home, ".claude"));
    setClaudeUsageInFile(s.env, s.home, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.file, "utf8")), { claudeAccounts: [{ id: "claude", dir: "~/.claude" }], codexAccounts: [], claudeUsage: true });
    setClaudeUsageInFile(s.env, s.home, false);
    assert.equal(JSON.parse(fs.readFileSync(s.file, "utf8")).claudeUsage, false);
  } finally {
    s.done();
  }
});

test("the write is atomic: a failed rename leaves no temporary file, a file that does not parse is never replaced, the file is owner-only", () => {
  const s = scratch();
  try {
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    // A directory where the rename lands: it fails after the temporary file was written.
    const target = path.join(s.home, "target");
    fs.mkdirSync(target);
    assert.throws(() => writeFileAtomic(target, "{}"));
    assert.deepEqual(fs.readdirSync(s.home).filter((n) => n.endsWith(".tmp")), []);
    fs.writeFileSync(s.file, "{ not json");
    assert.throws(() => editUserConfig(s.env, s.home, null, (raw) => (raw.claudeUsage = true)), ConfigError);
    assert.equal(fs.readFileSync(s.file, "utf8"), "{ not json");
    fs.writeFileSync(s.file, "{}");
    fs.chmodSync(s.file, 0o640);
    setClaudeUsageInFile(s.env, s.home, true);
    assert.equal(fs.statSync(s.file).mode & 0o777, 0o600, "a wider mode is narrowed to owner-only");
    const created = path.join(s.home, "new", "config.json");
    writeFileAtomic(created, "{}");
    assert.equal(fs.statSync(created).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(created)).mode & 0o777, 0o700);
  } finally {
    s.done();
  }
});

test("an edit that would make the file invalid is refused before anything is written", () => {
  const s = scratch();
  try {
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(s.file, "{}");
    assert.throws(() => editUserConfig(s.env, s.home, null, (raw) => (raw.claudeUsage = "yes")), ConfigError);
    assert.equal(fs.readFileSync(s.file, "utf8"), "{}");
  } finally {
    s.done();
  }
});

test("a symlinked config file stays a symlink and its target is written", () => {
  const s = scratch();
  try {
    const real = path.join(s.home, "dotfiles", "maru.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(real, "{}");
    fs.symlinkSync(real, s.file);
    setClaudeUsageInFile(s.env, s.home, true);
    assert.equal(fs.lstatSync(s.file).isSymbolicLink(), true);
    assert.equal(JSON.parse(fs.readFileSync(real, "utf8")).claudeUsage, true);
  } finally {
    s.done();
  }
});
