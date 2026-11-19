import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAC_SWAP_SCRIPT, macBundleOf, macInPlaceProblem, macRelaunchArgs, nsisArgs } from "./install.ts";

test("mac bundle: found from the executable, and refused where it cannot be replaced", () => {
  assert.equal(macBundleOf("/Applications/maru.app/Contents/MacOS/maru"), "/Applications/maru.app");
  assert.equal(macBundleOf("/usr/local/bin/electron"), null);
  const yes = () => true;
  assert.equal(macInPlaceProblem("/Applications/maru.app", yes), null);
  assert.match(macInPlaceProblem("/private/var/folders/x/AppTranslocation/ABC/d/maru.app", yes)!, /temporary location/);
  assert.match(macInPlaceProblem("/Volumes/maru 0.1.9/maru.app", yes)!, /disk image/);
  assert.match(macInPlaceProblem("/Applications/maru.app", (p) => p !== "/Applications")!, /not writable/);
  assert.match(macInPlaceProblem(null, yes)!, /Cannot find the app bundle location/);
});

test("mac relaunch: the app's own settings and options, never a deep link or the debugger", () => {
  const t = "/Applications/maru.app";
  assert.deepEqual(macRelaunchArgs(t, [], {}), [t]);
  assert.deepEqual(
    macRelaunchArgs(t, ["--use-mock-keychain", "maru://pair?server=x&code=y", "--inspect=0", "--remote-debugging-port=0"],
      { MARU_DESKTOP_USER_DATA: "/tmp/ud", MARU_DESKTOP_SHOW_INACTIVE: "1", HOME: "/Users/x", MARU_STATE: "/x" }),
    ["-g", "--env", "MARU_DESKTOP_USER_DATA=/tmp/ud", "--env", "MARU_DESKTOP_SHOW_INACTIVE=1", t, "--args", "--use-mock-keychain"],
  );
});

test("nsis: electron-updater's silent install arguments", () => {
  assert.deepEqual(nsisArgs(true), ["--updated", "/S", "--force-run"]);
  assert.deepEqual(nsisArgs(false), ["--updated", "/S"]);
});

test("mac swap script: waits for the app to exit, swaps the bundle, keeps the old one on failure", { skip: process.platform !== "darwin" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maru-swap-"));
  try {
    const script = path.join(dir, "swap.sh");
    fs.writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o755 });
    const target = path.join(dir, "Applications", "maru.app");
    const staged = path.join(dir, "stage", "maru.app");
    fs.mkdirSync(path.join(target, "Contents"), { recursive: true });
    fs.writeFileSync(path.join(target, "Contents", "v"), "old");
    fs.mkdirSync(path.join(staged, "Contents", "Frameworks"), { recursive: true });
    fs.writeFileSync(path.join(staged, "Contents", "v"), "new");
    fs.symlinkSync("Contents/v", path.join(staged, "link"));

    // A process standing in for the running app: the script waits for it.
    const app = spawn("sleep", ["30"]);
    const run = spawn("/bin/sh", [script, String(app.pid), staged, target, "0"]);
    let out = "";
    run.stdout.on("data", (d) => (out += d));
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(fs.readFileSync(path.join(target, "Contents", "v"), "utf8"), "old", "nothing moves while the app runs");
    app.kill();
    const code = await new Promise((r) => run.on("exit", r));
    assert.equal(code, 0);
    assert.match(out, /replaced/);
    assert.equal(fs.readFileSync(path.join(target, "Contents", "v"), "utf8"), "new");
    assert.equal(fs.readlinkSync(path.join(target, "link")), "Contents/v", "symlinks survive");
    assert.equal(fs.existsSync(staged), false, "the staged copy is gone");
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ["maru.app"], "no old copy left");

    // A copy that fails (the staged bundle is missing): the old app comes back.
    const r = spawnSync("/bin/sh", [script, "999999", path.join(dir, "missing.app"), target, "0"], { encoding: "utf8" });
    assert.match(r.stderr, /kept the old app/);
    assert.equal(fs.readFileSync(path.join(target, "Contents", "v"), "utf8"), "new");
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ["maru.app"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
