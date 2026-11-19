import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { completeFolder, friendlyPath, resumeCommand, shQuote, symlinkMap } from "./resume.ts";

test("shQuote quotes as shlex.quote does", () => {
  assert.equal(shQuote(""), "''");
  assert.equal(shQuote("/Users/x/projects/a-b_c.d"), "/Users/x/projects/a-b_c.d");
  assert.equal(shQuote("a b"), "'a b'");
  assert.equal(shQuote("it's"), `'it'"'"'s'`);
  assert.equal(shQuote("$HOME"), "'$HOME'");
});

test("resume command: enter the folder, then run with the account's env", () => {
  assert.equal(resumeCommand("/w/p q", "CLAUDE_CONFIG_DIR", "/h/.claude", ["claude", "--resume", "s1"], (p) => p),
    "cd -- '/w/p q' && CLAUDE_CONFIG_DIR=/h/.claude claude --resume s1");
  assert.equal(resumeCommand(null, "CODEX_HOME", "/h/.codex", ["codex", "resume", "t1"]), "CODEX_HOME=/h/.codex codex resume t1");
});

test("a resolved path shows through the project symlink that maps to it", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-links-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, "drive", "My Drive", "blog");
  fs.mkdirSync(path.join(real, "sub"), { recursive: true });
  fs.mkdirSync(path.join(root, "projects", "03_blog"), { recursive: true });
  fs.symlinkSync(real, path.join(root, "projects", "03_blog", "blog-next"));
  fs.symlinkSync(path.join(root, "nowhere"), path.join(root, "projects", "dangling"));
  const pairs = symlinkMap(path.join(root, "projects"), 0);
  const realResolved = fs.realpathSync(real);
  assert.deepEqual(pairs, [[realResolved, path.join(root, "projects", "03_blog", "blog-next")]]);
  assert.equal(friendlyPath(path.join(realResolved, "sub"), pairs), path.join(root, "projects", "03_blog", "blog-next", "sub"));
  assert.equal(friendlyPath(realResolved + "x", pairs), realResolved + "x", "a sibling with the same prefix is not mapped");
});

test("folder completion lists every matching subfolder", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "resume-complete-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const d of ["Projects", "proto", ".hidden", "other"]) fs.mkdirSync(path.join(home, d));
  fs.writeFileSync(path.join(home, "pfile"), "");
  for (let i = 0; i < 70; i++) fs.mkdirSync(path.join(home, "other", `d${String(i).padStart(2, "0")}`));
  assert.deepEqual(completeFolder("~/pro", home).dirs, [path.join(home, "Projects"), path.join(home, "proto")]);
  assert.deepEqual(completeFolder("~/", home).dirs, ["Projects", "other", "proto"].map((d) => path.join(home, d)));
  assert.deepEqual(completeFolder("~/.h", home).dirs, [path.join(home, ".hidden")]);
  assert.deepEqual(completeFolder("~/.", home).dirs, [path.join(home, ".hidden")], "a lone dot lists the hidden folders");
  assert.deepEqual(completeFolder("~/other/.", home).dirs, [], "a lone dot after a folder lists its hidden folders, none here");
  assert.equal(completeFolder("~/other/", home).dirs.length, 70, "no cap on the answer");
  assert.equal(completeFolder("relative", home).parent, home);
  assert.deepEqual(completeFolder("/nonexistent-dir-xyz/a", home).dirs, []);
  assert.equal(completeFolder("~/other/", home).status, "ok");
  assert.equal(completeFolder("/nonexistent-dir-xyz/a", home).status, "missing");
  assert.equal(completeFolder("~/pfile/", home).status, "not-folder");
  assert.equal(completeFolder("~/Projects/../proto/", home).parent, path.join(home, "proto"), "dot segments resolve");
  fs.mkdirSync(path.join(home, "improve"));
  fs.symlinkSync(path.join(home, "proto"), path.join(home, "protolink"));
  fs.symlinkSync(path.join(home, "pfile"), path.join(home, "filelink"));
  assert.deepEqual(
    completeFolder("~/pro", home).dirs,
    ["Projects", "proto", "protolink", "improve"].map((d) => path.join(home, d)),
    "starts-with first, then contains; a symlink to a folder is listed",
  );
  assert.ok(!completeFolder("~/", home).dirs.includes(path.join(home, "filelink")), "a symlink to a file is not a folder");
  const locked = path.join(home, "locked");
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o000);
  try {
    if (process.getuid?.() !== 0) assert.equal(completeFolder("~/locked/", home).status, "unreadable");
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});
