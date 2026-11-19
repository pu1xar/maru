import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatVersion, parseVersion, VERSION_SERIES } from "@maru/shared";
import { buildVersion, gitCount, gitVersion } from "../../../../packages/shared/src/gitVersion.ts";
import { serverVersion } from "./version.ts";

function tempDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maru-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A repository with `commits` empty commits. */
function repo(t: test.TestContext, commits: number): string {
  const dir = tempDir(t);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { stdio: "ignore" });
  git("init", "-q");
  for (let i = 0; i < commits; i++) git("commit", "-q", "--allow-empty", "-m", `c${i}`);
  return dir;
}

test("format and parse", () => {
  assert.equal(formatVersion(52), `${VERSION_SERIES}.52`);
  assert.equal(formatVersion(7, { series: "0.2", dev: true }), "0.2.7-dev");
  assert.deepEqual(parseVersion("0.1.102"), { series: "0.1", count: 102, dev: false });
  assert.deepEqual(parseVersion("0.1.52-dev"), { series: "0.1", count: 52, dev: true });
  for (const bad of ["", "0.1", "v0.1.2", "0.1.2-rc", "0.1.x", "20261116-133458"]) assert.equal(parseVersion(bad), null, bad);
});

test("git count and version of a commit", (t) => {
  const dir = repo(t, 3);
  assert.equal(gitCount(dir), 3);
  assert.equal(gitCount(dir, "HEAD~2"), 1);
  assert.equal(gitVersion(dir, "HEAD~1"), formatVersion(2));
  assert.equal(gitVersion(dir, "HEAD", { dev: true }), formatVersion(3, { dev: true }));
  assert.equal(gitCount(dir, "no-such-ref"), null);
  // An option in the ref's place is a ref name to git, not an option.
  assert.equal(gitCount(dir, "--all"), null);
});

test("a folder inside some other repository has no version", (t) => {
  const dir = repo(t, 2);
  const inner = path.join(dir, "releases", "x");
  fs.mkdirSync(inner, { recursive: true });
  assert.equal(gitCount(inner), null);
  assert.equal(gitCount(tempDir(t)), null);
});

test("server version: the release's, else HEAD with -dev", (t) => {
  const dir = repo(t, 4);
  assert.equal(serverVersion(dir), formatVersion(4, { dev: true }));
  fs.writeFileSync(path.join(dir, ".release.json"), JSON.stringify({ name: "20261116-133458", version: "0.1.40" }));
  assert.equal(serverVersion(dir), "0.1.40");
  // A release made before the field: no git there either (a release is a git archive).
  const old = tempDir(t);
  fs.writeFileSync(path.join(old, ".release.json"), JSON.stringify({ name: "20261116-014905" }));
  assert.equal(serverVersion(old), null);
});

test("build version: MARU_VERSION first", (t) => {
  const dir = repo(t, 5);
  const saved = process.env.MARU_VERSION;
  t.after(() => {
    if (saved === undefined) delete process.env.MARU_VERSION;
    else process.env.MARU_VERSION = saved;
  });
  delete process.env.MARU_VERSION;
  assert.equal(buildVersion(dir), formatVersion(5, { dev: true }));
  process.env.MARU_VERSION = "0.1.99";
  assert.equal(buildVersion(dir), "0.1.99");
});
