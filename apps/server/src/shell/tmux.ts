// The tmux server that keeps maru's shell terminals (DESIGN.md 6s). It is a tmux server of its own
// (its own socket, `-f /dev/null` so the user's ~/.tmux.conf never applies, and the options below),
// started by the first shell and ending with the last one (tmux's exit-empty). tmux puts its server
// in the background as a child of launchd, so it is not in the web server's process tree: a pm2
// restart of the web server ends the attached clients only, and every shell keeps running.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isShellId, type ShellInfo } from "@maru/shared";

/**
 * Lines of scrollback tmux keeps per shell; the page's terminal keeps the same number (the view's
 * `scrollback`). A reload reads them back from tmux (historyPrelude), so this is what survives one.
 */
export const SHELL_HISTORY_LINES = 1_000; // user decision 2026-11-16 (T3: 5,000)

/**
 * The options of this tmux server, set again before every new shell (idempotent):
 *   status off, prefix None   no tmux bar and no tmux key: every key reaches the shell (ctrl+b too)
 *   escape-time 0             Esc reaches vim at once instead of after tmux's 500 ms wait
 *   smcup@ rmcup@             tmux stays on the page terminal's main screen, so the lines it scrolls
 *                             off go into the page terminal's own scrollback (wheel, selection)
 *   RGB                       24-bit color passes through
 *   window-size latest        the window follows the view used last when two browsers attach
 *   history-limit             SHELL_HISTORY_LINES (applies to shells made after it is set)
 */
export function serverOptionCommands(): string[][] {
  return [
    ["set-option", "-s", "escape-time", "0"],
    ["set-option", "-s", "exit-empty", "on"],
    ["set-option", "-s", "terminal-overrides[0]", "xterm*:smcup@:rmcup@"],
    ["set-option", "-s", "terminal-features[0]", "xterm*:RGB"],
    ["set-option", "-g", "status", "off"],
    ["set-option", "-g", "prefix", "None"],
    ["set-option", "-g", "prefix2", "None"],
    ["set-option", "-g", "mouse", "off"],
    ["set-option", "-g", "set-titles", "off"],
    ["set-option", "-g", "destroy-unattached", "off"],
    ["set-option", "-g", "detach-on-destroy", "on"],
    ["set-option", "-g", "default-terminal", "tmux-256color"],
    ["set-option", "-g", "history-limit", String(SHELL_HISTORY_LINES)],
    ["set-option", "-wg", "window-size", "latest"],
    ["set-option", "-wg", "allow-rename", "off"],
    ["set-option", "-wg", "remain-on-exit", "off"],
  ];
}

/**
 * A value tmux takes as is from argv: tmux reads any argument that ends in `;` as the end of a
 * command (not only a lone `;`), unless the `;` is escaped as `\;`.
 */
export function tmuxLiteral(value: string): string {
  return value.endsWith(";") ? `${value.slice(0, -1)}\\;` : value;
}

/** A value for an argument tmux expands as a format (`new-session -c`): `#` doubled, so `#(cmd)` stays text. */
export function formatLiteral(value: string): string {
  return value.replaceAll("#", "##");
}

/** Control characters (line breaks, the list's unit separator) that a list line could not carry. */
export function hasControlChars(value: string): boolean {
  return /[\x00-\x1f\x7f]/.test(value);
}

/** Commands joined into one tmux invocation (tmux reads a lone `;` argument as the separator). */
export function joinCommands(commands: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const c of commands) {
    if (out.length) out.push(";");
    out.push(...c);
  }
  return out;
}

/**
 * The environment the tmux server, and so every shell, starts with: what a login shell needs and
 * nothing of the web server's own (its pm2 variables, PORT, MARU_*, and whatever the shell that
 * started pm2 had). The shell is a login shell, so it reads the user's profile on top of this.
 *   TMUX and TMUX_PANE are never passed on: the pane command unsets the ones tmux adds, so a `tmux`
 *   typed in the shell talks to the user's own tmux server, not this one
 */
export function shellEnv(base: NodeJS.ProcessEnv, user: { home: string; name: string; shell: string }): Record<string, string> {
  const name = base.USER || base.LOGNAME || user.name;
  const env: Record<string, string> = {
    HOME: base.HOME || user.home,
    USER: name,
    LOGNAME: base.LOGNAME || name,
    PATH: base.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: user.shell,
    // tmux and the shell need a UTF-8 locale for Korean; the services on this machine run with C.UTF-8.
    LANG: base.LANG && /utf-?8/i.test(base.LANG) ? base.LANG : "C.UTF-8",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "maru",
  };
  if (base.TMPDIR) env.TMPDIR = base.TMPDIR;
  if (base.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = base.SSH_AUTH_SOCK;
  return env;
}

/** The pane's command: the user's shell as a login shell, without the TMUX variables tmux sets. */
export function paneCommand(shell: string): string[] {
  return ["/usr/bin/env", "-u", "TMUX", "-u", "TMUX_PANE", shell, "-l"];
}

export function newShellId(bytes: Buffer = randomBytes(12)): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "sh-";
  for (let i = 0; i < 12; i++) id += alphabet[bytes[i]! % alphabet.length];
  return id;
}

// One field per line part; tmux prints the unit separator as is (measured on 3.6a).
const SEP = "\x1f";
export const LIST_FORMAT = [
  "#{session_name}", "#{@maru_cwd}", "#{session_created}", "#{session_attached}",
  "#{pane_current_command}", "#{pane_current_path}",
].join(SEP);

/** list-sessions output (LIST_FORMAT) as shells; sessions this server did not name are left out. */
export function parseSessionList(stdout: string): ShellInfo[] {
  const shells: ShellInfo[] = [];
  for (const line of stdout.split("\n")) {
    const f = line.split(SEP);
    if (f.length < 6 || !isShellId(f[0])) continue;
    const [id, cwd, created, attached, command, current] = f as [string, string, string, string, string, string];
    shells.push({
      id,
      cwd: cwd || current,
      createdAt: Number(created) * 1000 || 0,
      command,
      path: current,
      clients: Number(attached) || 0,
    });
  }
  return shells.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * What a new view writes before tmux draws the screen: the shell's scrollback (capture-pane of the
 * history above the screen, with colors, wrapped lines joined so the page rewraps them), then
 * `rows` line feeds. Those push every history row off the page terminal's screen into its
 * scrollback, so the screen tmux then clears and draws holds no history and none is lost: n
 * physical rows followed by `rows` line feeds scroll exactly n rows. Trailing blanks of a line
 * (capture-pane -J keeps them) and blank lines after the last text are dropped.
 */
export function historyPrelude(capture: string, rows: number): string {
  const lines = capture.replace(/\n$/, "").split("\n").map((l) => l.replace(/ +((?:\x1b\[[0-9;:]*m)*)$/, "$1"));
  while (lines.length && stripSgr(lines.at(-1)!).trim() === "") lines.pop();
  if (!lines.length) return "";
  return lines.join("\r\n") + "\r\n".repeat(rows);
}

function stripSgr(s: string): string {
  return s.replace(/\x1b\[[0-9;:]*m/g, "");
}

/** The tmux binary: MARU_TMUX, then Homebrew's and the system's places, then PATH. */
export function resolveTmux(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [env.MARU_TMUX, "/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux",
    ...(env.PATH ?? "").split(":").filter(Boolean).map((d) => path.join(d, "tmux"))];
  for (const c of candidates) {
    if (!c) continue;
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      // next
    }
  }
  return null;
}

export class TmuxError extends Error {
  /** tmux says there is no server, or no such session. */
  missing: boolean;
  constructor(message: string, missing: boolean) {
    super(message);
    this.missing = missing;
  }
}

export interface TmuxRunner {
  (args: string[]): Promise<string>;
}

/**
 * Runs tmux against the shells' socket. The socket is named relative to its folder and tmux runs in
 * that folder: a unix socket path is limited to 104 bytes on macOS, which a scratch folder of an
 * isolated instance exceeds. (`~/.config/maru/shell-tmux.sock` is well under it.)
 */
export function tmuxRunner(tmux: string, socket: string, env: Record<string, string>): TmuxRunner {
  const dir = path.dirname(socket);
  const name = `./${path.basename(socket)}`;
  return (args) =>
    new Promise((resolve, reject) => {
      fs.mkdirSync(dir, { recursive: true });
      execFile(tmux, ["-u", "-S", name, "-f", "/dev/null", ...args], { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const text = String(stderr || err.message).trim();
        reject(new TmuxError(text, /no server running|error connecting to|can't find session|no such session|session not found/i.test(text)));
      });
    });
}

/** The user the shells run as: home folder, name and login shell. */
export function shellUser(): { home: string; name: string; shell: string } {
  const info = os.userInfo();
  return { home: os.homedir(), name: info.username, shell: info.shell || process.env.SHELL || "/bin/zsh" };
}
