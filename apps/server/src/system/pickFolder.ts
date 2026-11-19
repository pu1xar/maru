import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A folder chosen in the Mac's own folder dialog (Finder `choose folder`), for a new session's
 * working folder (DESIGN.md 6f). The browser cannot give an absolute path, and the server runs on
 * the same Mac, so the server shows the dialog. Finder comes forward for the dialog and the app
 * that was in front gets focus back afterwards. One dialog at a time.
 */
export class PickFolderError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type PickFolderResult = { path: string } | { cancelled: true };

let busy = false;

/** AppleScript string literal. */
function asString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function pickFolderScript(prompt: string, defaultPath: string): string {
  return [
    "set prev to path to frontmost application as text",
    'tell application "Finder"',
    "  activate",
    "  try",
    `    set f to choose folder with prompt ${asString(prompt)} default location (POSIX file ${asString(defaultPath)} as alias)`,
    "  on error number -128",
    "    tell application prev to activate",
    '    return ""',
    "  end try",
    "end tell",
    "tell application prev to activate",
    "return POSIX path of f",
  ].join("\n");
}

/** Waits for the user; there is no time limit on the choice. */
export function pickFolder(
  opts: { defaultPath?: string | null; prompt?: string },
  run: (script: string) => Promise<string> = runOsascript,
): Promise<PickFolderResult> {
  if (process.platform !== "darwin") return Promise.reject(new PickFolderError(501, "The folder picker can only be opened on macOS"));
  if (busy) return Promise.reject(new PickFolderError(409, "A folder picker is already open"));
  const home = os.homedir();
  const wanted = opts.defaultPath?.trim() || home;
  const defaultPath = isDir(wanted) ? wanted : home;
  busy = true;
  return run(pickFolderScript(opts.prompt ?? "Choose the working folder for the new session", defaultPath))
    .then((out) => {
      const p = out.trim();
      if (!p) return { cancelled: true as const };
      return { path: p.length > 1 ? p.replace(/\/+$/, "") : p };
    })
    .finally(() => {
      busy = false;
    });
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function runOsascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new PickFolderError(500, `Could not open the folder picker: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}
