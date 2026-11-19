// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/markdown-links.ts (the file link resolvers ChatMarkdown calls).
// Local changes: the metadata has no `displayPath` (it fed T3's editor and panel actions, which
// this viewer leaves out). Split out of MarkdownFileLink.logic.ts so the Android app can import
// the resolvers: this file reaches only the t3-shared path and link helpers, none of the
// markdown pipeline's parser packages.
// By path: a node test of the Android app cannot resolve a value import of @maru/shared.
import { isInlineImagePath } from "../../../../../packages/shared/src/files.ts";
import {
  fileBasename,
  isAbsolutePath,
  isHostPath,
  workspaceRelativeFilePath,
} from "../../t3-shared/path.ts";
import {
  inlineCodeFilePathCandidate,
  isRelativeFilePath,
  normalizeMarkdownLinkDestination,
  parseMarkdownFileLink,
  resolveMarkdownFileLinkTarget,
} from "../../t3-shared/markdownLinks.ts";
import { parseFileUrlHref, splitFilePathPosition } from "../../t3-shared/fileLinks.ts";

export interface MarkdownFileLinkMeta {
  filePath: string;
  workspaceLookupPath: string | null;
  targetPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
  endLine?: number;
}

/**
 * The path of the picture a file link previews under its chip, or null. A picture path that names
 * its own place (absolute or `~/`) previews; a relative link the server may have to look up under
 * the session folder does not, since its first guess is often a 404. `isImage` is the client's
 * picture list: the web draws SVG too, the Android app only bitmaps.
 */
export function fileLinkImagePath(
  meta: MarkdownFileLinkMeta,
  isImage: (path: string) => boolean = isInlineImagePath,
): string | null {
  if (!isImage(meta.filePath) || !isHostPath(meta.filePath)) return null;
  if (meta.workspaceLookupPath !== null && !meta.workspaceLookupPath.startsWith("~/")) return null;
  return meta.filePath;
}

/** Collapses `.` and `..` segments of a POSIX host path; any other path is returned as is. */
function collapseDotSegments(path: string): string {
  if (!path.startsWith("/") || path.includes("\\")) return path;
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

/**
 * The path of the picture an authored image (`![](src)`, `<img src>`) names, or null. Unlike a
 * file link, an image states that it is a picture, so a relative source that resolves under the
 * base folder is read from there: the document's own folder in the file view, the session folder
 * in a chat. A source that is no picture file, or a miss on the server, shows nothing, and the
 * caller falls back to the chip.
 */
export function markdownImagePath(
  meta: MarkdownFileLinkMeta,
  isImage: (path: string) => boolean = isInlineImagePath,
): string | null {
  if (!isImage(meta.filePath) || !isHostPath(meta.filePath)) return null;
  return collapseDotSegments(meta.filePath);
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrlHref(normalizeMarkdownLinkDestination(href));
  return target ? `${target.path}${target.hash}` : null;
}

export function resolveInlineCodeFileLinkMeta(
  codeText: string,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const candidate = inlineCodeFilePathCandidate(codeText);
  if (candidate === null) return null;

  return resolveMarkdownFileLinkMeta(
    candidate,
    cwd,
    inlineCodePathNamesFromWorkspaceRoot(candidate, cwd, baseDir) ? cwd : baseDir,
  );
}

function inlineCodePathNamesFromWorkspaceRoot(
  candidate: string,
  cwd: string | undefined,
  baseDir: string | undefined,
): boolean {
  if (!cwd || !baseDir || !isRelativeFilePath(candidate)) return false;
  if (/^(?:~|\.{1,2})\//.test(candidate)) return false;
  if (!splitFilePathPosition(candidate).path.includes("/")) return false;
  return workspaceRelativeFilePath(baseDir, cwd) !== null;
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd, baseDir);
  if (!targetPath) return null;
  const source = href ? parseMarkdownFileLink(href) : null;
  return {
    ...buildFileLinkMetaFromTarget(targetPath, cwd),
    ...(source?.endLine !== undefined ? { endLine: source.endLine } : {}),
    workspaceLookupPath:
      source !== null &&
      !isAbsolutePath(source.path) &&
      baseDir !== undefined &&
      workspaceRelativeFilePath(baseDir, cwd) === "."
        ? source.path
        : null,
  };
}

function buildFileLinkMetaFromTarget(targetPath: string, cwd?: string) {
  const { path, line, column } = splitFilePathPosition(targetPath);
  return {
    filePath: path,
    targetPath,
    workspaceRelativePath: workspaceRelativeFilePath(path, cwd),
    basename: fileBasename(path),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}
