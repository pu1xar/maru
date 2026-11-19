import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileTreeEntry } from "@maru/shared";

import { checkIgnored, listTreeDirectory, resolveTreeDir } from "./fileTree.ts";
import { FileError } from "./fileView.ts";

function tmpdir(t: { after: (fn: () => void) => void }): string {
  // realpath: macOS tmpdir is a link (/var -> /private/var), and the listing answers the real root.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filetree-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initRepo(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
}

function write(root: string, rel: string, text = ""): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function byName(entries: FileTreeEntry[]): Record<string, FileTreeEntry> {
  return Object.fromEntries(entries.map((e) => [e.name, e]));
}

test("a folder lists files, folders and links with their kinds, leaves .git out and labels ignored children", async (t) => {
  const root = tmpdir(t);
  initRepo(root);
  write(root, ".gitignore", "node_modules\n*.log\n");
  write(root, "src/a.ts");
  write(root, "debug.log");
  write(root, "node_modules/react/index.js");
  write(root, ".env");
  fs.mkdirSync(path.join(root, "target-dir"));
  fs.symlinkSync(path.join(root, "target-dir"), path.join(root, "linked-dir"));
  fs.symlinkSync(path.join(root, "src/a.ts"), path.join(root, "linked-file"));
  fs.symlinkSync(path.join(root, "nowhere"), path.join(root, "dangling"));

  const listing = await listTreeDirectory(root, "");
  assert.equal(listing.root, root);
  assert.equal(listing.dir, "");
  assert.equal(listing.ignoreChecked, true);
  const entries = byName(listing.entries);
  assert.deepEqual(Object.keys(entries).sort(), [
    ".env", ".gitignore", "debug.log", "linked-dir", "linked-file", "node_modules", "src", "target-dir",
  ]);
  assert.deepEqual(entries["src"], { name: "src", kind: "directory" });
  assert.deepEqual(entries["debug.log"], { name: "debug.log", kind: "file", ignored: true });
  assert.deepEqual(entries["node_modules"], { name: "node_modules", kind: "directory", ignored: true });
  assert.deepEqual(entries["linked-dir"], { name: "linked-dir", kind: "directory", link: true });
  assert.deepEqual(entries["linked-file"], { name: "linked-file", kind: "file", link: true });

  // Inside an ignored folder every child is ignored too.
  const inside = await listTreeDirectory(root, "node_modules");
  assert.deepEqual(inside.entries, [{ name: "react", kind: "directory", ignored: true }]);
  const nested = await listTreeDirectory(root, "node_modules/react");
  assert.deepEqual(nested.entries, [{ name: "index.js", kind: "file", ignored: true }]);
});

test("a nested repository answers with its own ignore rules, and a folder outside any repository has no labels", async (t) => {
  const base = tmpdir(t);
  write(base, "plain/a.txt");
  write(base, "plain/b.log");
  const outside = await listTreeDirectory(base, "plain");
  assert.ok(outside.entries.every((e) => e.ignored === undefined), "no repository, no ignore labels");
  assert.equal(outside.ignoreChecked, false);
  assert.equal(outside.ignoreFailed, undefined, "outside a repository is an answer, not a failure");

  initRepo(path.join(base, "repo"));
  write(base, "repo/.gitignore", "dist\n");
  write(base, "repo/dist/out.js");
  write(base, "repo/sub/.gitignore", "cache\n");
  initRepo(path.join(base, "repo/sub"));
  write(base, "repo/sub/cache/x");
  write(base, "repo/sub/keep.ts");
  // The tree's root is above both repositories.
  const repoListing = await listTreeDirectory(base, "repo");
  assert.equal(repoListing.ignoreChecked, true);
  const top = byName(repoListing.entries);
  assert.equal(top["dist"]?.ignored, true);
  assert.equal(top["sub"]?.ignored, undefined);
  const sub = byName((await listTreeDirectory(base, "repo/sub")).entries);
  assert.equal(sub["cache"]?.ignored, true);
  assert.equal(sub["keep.ts"]?.ignored, undefined);
});

test("a large ignored folder is checked as a whole and every child comes back labelled", async (t) => {
  const root = tmpdir(t);
  initRepo(root);
  write(root, ".gitignore", "big\n");
  fs.mkdirSync(path.join(root, "big"));
  for (let i = 0; i < 1005; i++) fs.writeFileSync(path.join(root, "big", `f${i}.js`), "");
  const listing = await listTreeDirectory(root, "big");
  assert.equal(listing.entries.length, 1005, "every child is listed");
  assert.equal(listing.ignoreChecked, true);
  assert.ok(listing.entries.every((e) => e.ignored === true));
});

test("the folder must be a plain relative path under the root, outside .git", async (t) => {
  const root = tmpdir(t);
  write(root, "a.txt");
  for (const bad of ["..", "a/../..", "/etc", "a//b", "./a", ".git", "x/.git/objects"]) {
    assert.throws(() => resolveTreeDir(bad), (e: unknown) => e instanceof FileError && e.status === 400, bad);
  }
  assert.equal(resolveTreeDir(null), "");
  assert.equal(resolveTreeDir("src/components"), "src/components");
  await assert.rejects(listTreeDirectory(root, "missing"), (e: unknown) => e instanceof FileError && e.status === 404);
  await assert.rejects(listTreeDirectory(root, "a.txt"), (e: unknown) => e instanceof FileError && e.status === 415);
  await assert.rejects(listTreeDirectory("relative/root", ""), (e: unknown) => e instanceof FileError && e.status === 400);
});

test("names that look like pathspecs are read as plain names", async (t) => {
  const root = tmpdir(t);
  initRepo(root);
  write(root, ".gitignore", "*.log\n");
  for (const name of [":(glob)x", ":!y", "star*", "a.log", "q?.txt"]) write(root, name);
  const listing = await listTreeDirectory(root, "");
  assert.equal(listing.ignoreChecked, true);
  const entries = byName(listing.entries);
  assert.equal(entries["a.log"]?.ignored, true);
  for (const name of [":(glob)x", ":!y", "star*", "q?.txt"]) assert.equal(entries[name]?.ignored, undefined, name);
});

test("a link cycle reads as a refused folder, not a server error", async (t) => {
  const root = tmpdir(t);
  fs.symlinkSync("loop", path.join(root, "loop"));
  await assert.rejects(listTreeDirectory(root, "loop"), (e: unknown) => e instanceof FileError && e.status === 400);
});

test("checkIgnored tells outside a repository from no answer, and asks nothing for no names", async (t) => {
  const dir = tmpdir(t);
  assert.deepEqual(await checkIgnored(dir, ["x"]), { kind: "outside" });
  assert.deepEqual(await checkIgnored(dir, []), { kind: "checked", ignored: new Set() });
  assert.deepEqual(await checkIgnored(dir, ["x"], { program: path.join(dir, "no-such-git") }), { kind: "failed" });
  // A git that does not answer in time.
  const slow = path.join(dir, "slow-git");
  fs.writeFileSync(slow, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  const t0 = Date.now();
  assert.deepEqual(await checkIgnored(dir, ["x"], { program: slow, timeoutMs: 200 }), { kind: "failed" });
  assert.ok(Date.now() - t0 < 4000, "the timeout ends the wait");
});
