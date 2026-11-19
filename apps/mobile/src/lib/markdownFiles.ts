// File paths in a message become chips like the web's (ChatMarkdown's file link chips): an inline
// code span, a link or a bare absolute path in the prose that names a file draws as the file's icon
// and name, and a bitmap picture's chip also gets a small preview under its paragraph (DESIGN.md
// 2d, 6e). The resolvers and the label rules are the web's (t3-shared/markdownLinks.ts,
// fileLinks.ts, MarkdownFileLinkMeta.logic.ts); this module only runs them over one message's text.
// Absolute and `~/` paths link whatever the thread's folder is; a relative path needs the folder.
// React Native-free, so node tests run it.
import type { Token, Tokens } from "marked";
import { decodeEntities } from "../components/markdownModel.ts";
import { isBitmapImagePath } from "../../../../packages/shared/src/files.ts";
import {
  buildFileLinkParentSuffixByPath,
  fileLinkLabel,
} from "../../../web/src/t3-shared/fileLinks.ts";
import {
  absoluteFilePathMatches,
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  isMarkdownFileLinkLabel,
  normalizeMarkdownLinkDestination,
} from "../../../web/src/t3-shared/markdownLinks.ts";
import {
  fileLinkImagePath,
  markdownImagePath,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  type MarkdownFileLinkMeta,
} from "../../../web/src/components/chat/MarkdownFileLinkMeta.logic.ts";

export interface FileChip {
  /** The chip's text: the name, the folder when two files share a name, the line. */
  label: string;
  folder: boolean;
  /** The file's path without its position, for copying and for reading it from the server. */
  path: string;
  /** The picture to preview under the chip (a bitmap the server can read), or null. */
  image: string | null;
}

/** A piece of prose text: plain, or a bare path drawn as a chip. */
export type TextPart = { text: string } | { chip: FileChip };

export interface MessageFiles {
  /** The chip of an inline code span's text, or null when it is not a file path. */
  forCode: (codeText: string) => FileChip | null;
  /** The chip of a link's destination, or null when it is not a file. */
  forLink: (href: string) => FileChip | null;
  /** The chip of an authored image's source (`![](src)`), whose picture is read even from a relative path, or null. */
  forImage: (src: string) => FileChip | null;
  /** Whether a link's text is the file's own label, which the chip replaces (web isMarkdownFileLinkLabel). */
  labelsFile: (label: string, href: string) => boolean;
  /** Prose text split around the bare absolute paths in it, or null when it holds none. */
  forText: (text: string) => TextPart[] | null;
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

function hrefKey(href: string): string {
  const normalized = normalizeMarkdownLinkDestination(href);
  const rewritten = rewriteMarkdownFileUriHref(normalized) ?? normalized;
  return WINDOWS_DRIVE_PATH.test(rewritten) ? rewritten.replaceAll("\\", "/") : rewritten;
}

/** The message's file chips for `cwd` (the thread's folder, when the thread has one). */
export function messageFiles(text: string, cwd: string | undefined): MessageFiles {
  const linkMeta = new Map<string, MarkdownFileLinkMeta>();
  for (const href of new Set(extractMarkdownLinkHrefs(text).map(hrefKey))) {
    const meta = resolveMarkdownFileLinkMeta(href, cwd, cwd);
    if (meta) linkMeta.set(href, meta);
  }
  const codeMeta = new Map<string, MarkdownFileLinkMeta>();
  for (const span of new Set(extractInlineCodeSpans(text))) {
    const meta = resolveInlineCodeFileLinkMeta(span, cwd, cwd);
    if (meta) codeMeta.set(span, meta);
  }
  const bareMeta = new Map<string, MarkdownFileLinkMeta>();
  for (const { path } of absoluteFilePathMatches(text)) {
    const meta = resolveMarkdownFileLinkMeta(path, cwd, cwd);
    if (meta) bareMeta.set(path, meta);
  }
  const suffixByPath = buildFileLinkParentSuffixByPath(
    [...linkMeta.values(), ...codeMeta.values(), ...bareMeta.values()].map((m) => m.filePath),
  );
  const chip = (meta: MarkdownFileLinkMeta, authoredImage = false): FileChip => ({
    label: fileLinkLabel(
      {
        path: meta.filePath,
        ...(meta.line !== undefined ? { line: meta.line } : {}),
        ...(meta.column !== undefined ? { column: meta.column } : {}),
        ...(meta.endLine !== undefined ? { endLine: meta.endLine } : {}),
      },
      suffixByPath,
    ),
    folder: /[\\/]$/.test(meta.targetPath),
    path: meta.filePath,
    image: authoredImage ? markdownImagePath(meta, isBitmapImagePath) : fileLinkImagePath(meta, isBitmapImagePath),
  });
  return {
    forCode: (codeText) => {
      const meta = codeMeta.get(codeText.trim()) ?? resolveInlineCodeFileLinkMeta(codeText, cwd, cwd);
      return meta ? chip(meta) : null;
    },
    forLink: (href) => {
      const key = hrefKey(href);
      const meta = linkMeta.get(key) ?? resolveMarkdownFileLinkMeta(key, cwd, cwd);
      return meta ? chip(meta) : null;
    },
    forImage: (src) => {
      const key = hrefKey(src);
      const meta = linkMeta.get(key) ?? resolveMarkdownFileLinkMeta(key, cwd, cwd);
      return meta ? chip(meta, true) : null;
    },
    labelsFile: (label, href) => isMarkdownFileLinkLabel(label, hrefKey(href)),
    forText: (prose) => {
      const found = absoluteFilePathMatches(prose);
      if (found.length === 0) return null;
      const parts: TextPart[] = [];
      let at = 0;
      for (const { index, path } of found) {
        const meta = bareMeta.get(path) ?? resolveMarkdownFileLinkMeta(path, cwd, cwd);
        if (!meta) continue;
        if (index > at) parts.push({ text: prose.slice(at, index) });
        parts.push({ chip: chip(meta) });
        at = index + path.length;
      }
      if (at === 0) return null;
      if (at < prose.length) parts.push({ text: prose.slice(at) });
      return parts;
    },
  };
}

/** A picture to preview: the path to read and the name to show. */
export interface FileImageRef {
  path: string;
  name: string;
}

/**
 * The pictures one paragraph's inline tokens name, in order, each path once: file chips of code
 * spans, links and bare prose paths whose file is a bitmap. `searched` says a leaf is painted by a
 * find, which draws it as typed (Markdown.tsx), so it names none.
 */
export function inlineImages(tokens: Token[], files: MessageFiles, searched: (text: string) => boolean = () => false): FileImageRef[] {
  const found = new Map<string, FileImageRef>();
  const add = (chip: FileChip | null) => {
    if (chip?.image && !found.has(chip.image)) found.set(chip.image, { path: chip.image, name: chip.path.slice(chip.path.lastIndexOf("/") + 1) });
  };
  const walk = (list: Token[], inLink: boolean) => {
    for (const t of list) {
      if (t.type === "codespan") {
        const text = (t as Tokens.Codespan).text;
        if (!searched(text)) add(files.forCode(text));
      } else if (t.type === "link") {
        const l = t as Tokens.Link;
        const chip = files.forLink(l.href);
        if (chip) add(chip);
        else walk(l.tokens, true);
      } else if (t.type === "image") {
        add(files.forImage((t as Tokens.Image).href));
      } else if (t.type === "text" && !("tokens" in t && Array.isArray((t as Tokens.Text).tokens))) {
        const text = decodeEntities((t as Tokens.Text).text);
        if (!inLink && !searched(text)) for (const part of files.forText(text) ?? []) if ("chip" in part) add(part.chip);
      } else if ("tokens" in t && Array.isArray(t.tokens)) {
        walk(t.tokens as Token[], inLink);
      }
    }
  };
  walk(tokens, false);
  return [...found.values()];
}
