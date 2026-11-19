// Copy-ready resume commands and folder completion for the rehome dialog, ported from the
// dashboard this client replaces (`_resume_command`, `_dispath`, `_symlink_map`, `fs_complete`).
//
// A session records its resolved cwd (a Google Drive path, for instance). The command enters the
// folder through the symlink under ~/projects the user actually works through, when one maps to
// it, so the command shows the familiar path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filterFolderNames, type FolderCompletion, type FolderStatus } from "@maru/shared";
import { readDirOrEmpty } from "./fsUtil.ts";

/** Quote for a POSIX shell, as Python's shlex.quote does. */
export function shQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

/** `cd -- <folder> && <ENV>=<value> <argv...>`; without a cwd only the part after `&&`. */
export function resumeCommand(cwd: string | null, envName: string, envValue: string, argv: string[], display: (p: string) => string = friendlyPath): string {
  const command = `${envName}=${shQuote(envValue)} ${argv.map(shQuote).join(" ")}`;
  if (!cwd || cwd === "?") return command;
  return `cd -- ${shQuote(display(cwd))} && ${command}`;
}

/** Symlink scan settings, as the dashboard had them: four levels below ~/projects, these folders skipped. */
const SCAN_DEPTH = 4;
const SKIP = new Set(["node_modules", ".git", ".venv", "__pycache__"]);
/** The scan is reused for ten minutes, as in the dashboard. */
const SCAN_TTL_MS = 10 * 60 * 1000;

let cache: { at: number; root: string; pairs: Array<[string, string]> } | null = null;

/** [real target, symlink path] for the symlinks under `root`, longest target first. */
export function symlinkMap(root = path.join(os.homedir(), "projects"), now = Date.now()): Array<[string, string]> {
  if (cache && cache.root === root && now - cache.at < SCAN_TTL_MS) return cache.pairs;
  const pairs: Array<[string, string]> = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    for (const e of readDirOrEmpty(dir)) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        let target: string;
        try {
          target = fs.realpathSync(p);
        } catch {
          continue; // dangling
        }
        if (target !== p) pairs.push([target, p]);
      } else if (e.isDirectory() && !SKIP.has(e.name) && depth < SCAN_DEPTH) {
        stack.push({ dir: p, depth: depth + 1 });
      }
    }
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  cache = { at: now, root, pairs };
  return pairs;
}

/** The path through a project symlink when one maps to it, else the path itself. */
export function friendlyPath(p: string, pairs: Array<[string, string]> = symlinkMap()): string {
  for (const [target, link] of pairs) {
    if (p === target) return link;
    if (p.startsWith(target + "/")) return link + p.slice(target.length);
  }
  return p;
}

/** Why a folder could not be listed (`readdirSync`'s error), as `FolderCompletion.status` names it. */
function folderStatusOf(error: unknown): FolderStatus {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return "missing";
  if (code === "ENOTDIR") return "not-folder";
  return "unreadable";
}

/** `~` and `~/...` to the home directory. A trailing slash stays (it means "inside this folder"). */
export function expandHome(p: string, home = os.homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return home.replace(/\/+$/, "") + p.slice(1);
  return p;
}

/**
 * Folders that complete `input`: the subfolders of its parent whose names start with or contain its
 * last part (case-insensitive, starting-with first, `filterFolderNames`).
 * Hidden folders only when that part starts with a dot. A relative or empty input completes from the home directory. Every match is returned. `status` tells why the
 * parent folder gave nothing (missing, a file, not readable), which an empty `dirs` cannot.
 */
export function completeFolder(input: unknown, home = os.homedir()): FolderCompletion {
  let expanded = expandHome(typeof input === "string" ? input.trim() : "", home);
  if (!expanded.startsWith("/")) expanded = home + "/";
  // `.`, `..` and doubled slashes resolve; a trailing slash stays. A last part of just `.` is the
  // start of a hidden name (the user is typing it), not a segment to resolve away.
  const hiddenStart = expanded.endsWith("/.");
  expanded = path.posix.normalize(hiddenStart ? expanded.slice(0, -1) : expanded);
  if (hiddenStart) expanded += ".";
  let parent: string;
  let prefix: string;
  if (expanded.endsWith("/")) {
    parent = expanded.replace(/\/+$/, "") || "/";
    prefix = "";
  } else {
    parent = path.dirname(expanded) || "/";
    prefix = path.basename(expanded);
  }
  let entries: fs.Dirent[];
  let status: FolderStatus = "ok";
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch (error) {
    entries = []; // missing, not a folder, or not readable: nothing completes
    status = folderStatusOf(error);
  }
  const matched = new Set(filterFolderNames(prefix, entries.map((e) => e.name)));
  const byName = new Map<string, string>();
  for (const e of entries) {
    if (!matched.has(e.name)) continue;
    const full = path.join(parent, e.name);
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) byName.set(e.name, full);
  }
  const dirs = filterFolderNames(prefix, [...byName.keys()]).map((name) => byName.get(name)!);
  return { dirs, expanded, parent, status };
}
