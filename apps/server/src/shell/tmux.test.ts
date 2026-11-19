import { test } from "node:test";
import assert from "node:assert/strict";
import { historyPrelude, joinCommands, LIST_FORMAT, newShellId, paneCommand, parseSessionList, serverOptionCommands, shellEnv } from "./tmux.ts";
import { isShellId } from "@maru/shared";

const US = "\x1f";

test("list-sessions lines become shells; sessions maru did not name are left out", () => {
  assert.equal(LIST_FORMAT.split(US).length, 6);
  const out = [
    ["sh-bbbbbbbbbbbb", "/proj", "1763290000", "1", "vim", "/proj/src"].join(US),
    ["main", "", "1763280000", "0", "zsh", "/"].join(US),
    ["sh-aaaaaaaaaaaa", "", "1763280000", "0", "zsh", "/Users/u"].join(US),
    "",
  ].join("\n");
  assert.deepEqual(parseSessionList(out), [
    { id: "sh-aaaaaaaaaaaa", cwd: "/Users/u", createdAt: 1763280000000, command: "zsh", path: "/Users/u", clients: 0 },
    { id: "sh-bbbbbbbbbbbb", cwd: "/proj", createdAt: 1763290000000, command: "vim", path: "/proj/src", clients: 1 },
  ]);
});

test("the prelude pushes every history row off the screen with exactly `rows` line feeds", () => {
  const capture = "line 1   \n\x1b[31mred\x1b[39m   \x1b[0m\nlast\n   \n\n";
  assert.equal(historyPrelude(capture, 3), "line 1\r\n\x1b[31mred\x1b[39m\x1b[0m\r\nlast\r\n\r\n\r\n");
  assert.equal(historyPrelude("", 24), "");
  assert.equal(historyPrelude("     \n\n", 24), "", "a blank history writes nothing");
});

test("the shell environment keeps a login's basics and drops the web server's own", () => {
  const env = shellEnv(
    { HOME: "/Users/u", USER: "u", PATH: "/opt/homebrew/bin:/usr/bin", PORT: "8024", MARU_STATE: "/x", pm_id: "3", CLAUDECODE: "1", TMUX: "/tmp/t,1,0", LANG: "C" },
    { home: "/Users/u", name: "u", shell: "/bin/zsh" },
  );
  assert.deepEqual(env, {
    HOME: "/Users/u", USER: "u", LOGNAME: "u", PATH: "/opt/homebrew/bin:/usr/bin", SHELL: "/bin/zsh",
    LANG: "C.UTF-8", COLORTERM: "truecolor", TERM_PROGRAM: "maru",
  });
  assert.equal(shellEnv({ LANG: "ko_KR.UTF-8" }, { home: "/h", name: "n", shell: "/bin/sh" }).LANG, "ko_KR.UTF-8");
});

test("ids, the pane command and the joined options", () => {
  const id = newShellId();
  assert.ok(isShellId(id), id);
  assert.equal(newShellId(Buffer.alloc(12, 0)), "sh-aaaaaaaaaaaa");
  assert.deepEqual(paneCommand("/bin/zsh"), ["/usr/bin/env", "-u", "TMUX", "-u", "TMUX_PANE", "/bin/zsh", "-l"]);
  assert.deepEqual(joinCommands([["a", "1"], ["b"]]), ["a", "1", ";", "b"]);
  const flat = serverOptionCommands().map((c) => c.join(" "));
  for (const want of ["set-option -g status off", "set-option -g prefix None", "set-option -s escape-time 0", "set-option -s terminal-overrides[0] xterm*:smcup@:rmcup@"]) {
    assert.ok(flat.includes(want), want);
  }
});
