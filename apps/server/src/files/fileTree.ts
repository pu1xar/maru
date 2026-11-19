// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/server/src/workspace/WorkspaceEntries.ts (`list` with a directoryPath: one folder's
// children, `.git` left out, symbolic links classified in batches, ignored children labelled by
// `git check-ignore -z --stdin`, a large folder checked as a whole first).
// Local changes: the root is any folder the session runs in, and the listed folder comes as a
// path relative to it. A link pointing outside the root is listed, as `/api/file` reads anywhere
// (DESIGN.md 6e); the entry carries `link`, so the client's "expand all" never follows one. Git
// runs in the listed folder itself, so a nested repository answers with its own ignore rules.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { FileTreeEntry, FileTreeListing } from "@maru/shared";

import { FileError, resolveRequestPath } from "./fileView.ts";

/** T3's IGNORE_CHECK_CHUNK_SIZE: a folder with more children is first checked as a whole. */
const WHOLE_FOLDER_CHECK_THRESHOLD = 1000;

/** T3's SYMLINK_RESOLVE_BATCH_SIZE: links classified at once; each costs a stat. */
const SYMLINK_RESOLVE_BATCH_SIZE = 64;

/**
 * T3's value. The ignore labels only dim rows; a check that has not answered by then leaves them
 * off, the listing goes out whole and says so (`ignoreFailed`).
 */
const IGNORE_CHECK_TIMEOUT_MS = 10_000;

/** The folder part of the request: "" for the root, else `/`-joined names under it. */
export function resolveTreeDir(raw: string | null): string {
  const dir = raw ?? "";
  if (dir === "") return "";
  const segments = dir.split("/");
  if (dir.includes("\0") || segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new FileError(400, "Invalid folder path", dir);
  }
  if (segments.includes(".git")) throw new FileError(400, "Contents of .git are hidden", dir);
  return dir;
}

function readdirError(err: unknown): never {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") throw new FileError(404, "Folder not found");
  if (code === "ENOTDIR") throw new FileError(415, "Not a folder");
  if (code === "EACCES" || code === "EPERM") throw new FileError(403, "No permission to read");
  if (code === "ELOOP") throw new FileError(400, "Link loop");
  throw err;
}

/** A link's kind, from what it points at; null for a dangling link or a special file. */
async function linkKind(full: string): Promise<FileTreeEntry["kind"] | null> {
  const st = await fs.promises.stat(full).catch(() => null);
  return st?.isDirectory() ? "directory" : st?.isFile() ? "file" : null;
}

/**
 * What git said about a folder's children: which it ignores, that the folder is outside any
 * repository, or no answer (git missing or failing, or the timeout).
 */
export type IgnoreCheck = { kind: "checked"; ignored: Set<string> } | { kind: "outside" } | { kind: "failed" };

/** Which of `names` git ignores, asked in `cwd`. `program` and `timeoutMs` are for tests. */
export function checkIgnored(
  cwd: string,
  names: readonly string[],
  opts: { program?: string; timeoutMs?: number } = {},
): Promise<IgnoreCheck> {
  if (names.length === 0) return Promise.resolve({ kind: "checked", ignored: new Set() });
  return new Promise((done) => {
    let settled = false;
    const resolve = (check: IgnoreCheck) => {
      if (settled) return;
      settled = true;
      done(check);
    };
    const child = spawn(opts.program ?? "git", ["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"], {
      cwd,
      // Untranslated messages, so "not a git repository" can be told from other failures.
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? IGNORE_CHECK_TIMEOUT_MS,
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => errors.push(c));
    child.on("error", () => resolve({ kind: "failed" }));
    // Killed (the timeout): answer now. A process it started can hold the pipes open, and
    // "close" waits for them.
    child.on("exit", (_code, signal) => {
      if (signal === null) return;
      resolve({ kind: "failed" });
      child.stdout.destroy();
      child.stderr.destroy();
    });
    // A child that exits before reading all of stdin (exit 128) closes the pipe under the write.
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      // 0: some are ignored, 1: none are.
      if (code === 0 || code === 1) {
        const answered = Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean);
        return resolve({ kind: "checked", ignored: new Set(answered.map((p) => (p.startsWith("./") ? p.slice(2) : p))) });
      }
      const outside = code === 128 && Buffer.concat(errors).toString("utf8").includes("not a git repository");
      resolve(outside ? { kind: "outside" } : { kind: "failed" });
    });
    // Each name as `./name`: one starting with `:` would read as pathspec magic, which
    // check-ignore refuses for the whole batch (exit 128); its literal mode is refused too.
    child.stdin.end(names.map((n) => `./${n}\0`).join(""));
  });
}

/** The children of `rawDir` under `rawRoot`, each with its kind, ignore label and link mark. */
export async function listTreeDirectory(rawRoot: string | null, rawDir: string | null): Promise<FileTreeListing> {
  const root = resolveRequestPath(rawRoot);
  const dir = resolveTreeDir(rawDir);
  const abs = dir === "" ? root : path.join(root, ...dir.split("/"));
  const dirents = await fs.promises.readdir(abs, { withFileTypes: true }).catch(readdirError);

  const children = dirents.filter((d) => d.name !== ".git");
  const kinds: Array<FileTreeEntry["kind"] | null> = [];
  for (let offset = 0; offset < children.length; offset += SYMLINK_RESOLVE_BATCH_SIZE) {
    kinds.push(
      ...(await Promise.all(
        children.slice(offset, offset + SYMLINK_RESOLVE_BATCH_SIZE).map((d) => {
          if (d.isDirectory()) return "directory" as const;
          if (d.isFile()) return "file" as const;
          return d.isSymbolicLink() ? linkKind(path.join(abs, d.name)) : null;
        }),
      )),
    );
  }
  const entries: FileTreeEntry[] = [];
  children.forEach((d, i) => {
    const kind = kinds[i];
    if (kind) entries.push(d.isSymbolicLink() ? { name: d.name, kind, link: true } : { name: d.name, kind });
  });

  const name = path.basename(abs);
  // A folder this large is usually installed or built output; one check of the folder itself
  // answers for every child when git ignores the whole folder.
  if (entries.length > WHOLE_FOLDER_CHECK_THRESHOLD && dir !== "") {
    const whole = await checkIgnored(path.dirname(abs), [name]);
    if (whole.kind === "checked" && whole.ignored.has(name)) {
      return { root, dir, entries: entries.map((e) => ({ ...e, ignored: true })), ignoreChecked: true };
    }
  }
  // An empty folder asks git nothing; with no children there is nothing for "expand all" to open.
  const check = await checkIgnored(abs, entries.map((e) => e.name));
  const ignored = check.kind === "checked" ? check.ignored : null;
  return {
    root,
    dir,
    entries: ignored?.size ? entries.map((e) => (ignored.has(e.name) ? { ...e, ignored: true } : e)) : entries,
    ignoreChecked: ignored !== null,
    ...(check.kind === "failed" ? { ignoreFailed: true as const } : {}),
  };
}
