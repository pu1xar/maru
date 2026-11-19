import { test } from "node:test";
import assert from "node:assert/strict";
import type { ShellInfo } from "@maru/shared";
import { afterClose, cycleShell, lastActiveShell, newShellCwd, pickActive, rememberActiveShell, shellLabels } from "./shellTabs.ts";

const sh = (id: string, command = "zsh"): ShellInfo => ({ id, cwd: "/", createdAt: 0, command, path: "/", clients: 0 });

test("the active shell: the chosen one while it lives, else the newest; closing moves right, then left", () => {
  const list = [sh("a"), sh("b"), sh("c")];
  assert.equal(pickActive(list, "b"), "b");
  assert.equal(pickActive(list, "gone"), "c");
  assert.equal(pickActive([], "a"), null);
  assert.equal(afterClose(list, "b"), "c");
  assert.equal(afterClose(list, "c"), "b");
  assert.equal(afterClose([sh("a")], "a"), null);
  assert.equal(afterClose(list, "gone"), "c", "an unknown tab leaves the newest showing");
});

test("tab keys move around the ends; with no tab showing they start at the first", () => {
  const list = [sh("a"), sh("b"), sh("c")];
  assert.equal(cycleShell(list, "c", 1), "a");
  assert.equal(cycleShell(list, "a", -1), "c");
  assert.equal(cycleShell(list, "a", 1), "b");
  assert.equal(cycleShell(list, "b", -1), "a");
  assert.equal(cycleShell(list, null, 1), "a");
  assert.equal(cycleShell([], null, 1), null);
  assert.equal(cycleShell([sh("a")], "a", 1), "a");
});

test("labels number shells that run the same command", () => {
  assert.deepEqual([...shellLabels([sh("a"), sh("b", "vim"), sh("c")]).values()], ["zsh 1", "vim", "zsh 2"]);
});

test("a new shell starts in the covered session's folder when that is an absolute path, else in home (null)", () => {
  assert.equal(newShellCwd("/Users/u/projects/x"), "/Users/u/projects/x");
  assert.equal(newShellCwd(null), null);
  assert.equal(newShellCwd(undefined), null);
  assert.equal(newShellCwd(""), null);
  assert.equal(newShellCwd("relative/dir"), null);
});

test("the last shown tab is remembered for the next open", () => {
  assert.equal(lastActiveShell(), null);
  rememberActiveShell("sh-x");
  assert.equal(lastActiveShell(), "sh-x");
  rememberActiveShell(null);
});
