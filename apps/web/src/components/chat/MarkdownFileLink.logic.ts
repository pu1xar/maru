// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/markdown-links.ts (the file link resolvers ChatMarkdown calls).
// Local changes: the metadata has no `displayPath` (it fed T3's editor and panel actions, which
// this viewer leaves out), and the editor-activation helpers are left out with them.
import { isLocalEditorFileUrl } from "../../t3-shared/markdownPipeline.ts";
// The resolvers live in MarkdownFileLinkMeta.logic.ts (the Android app imports them from there).
export {
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  type MarkdownFileLinkMeta,
} from "./MarkdownFileLinkMeta.logic.ts";

export function isLocalEditorFileHref(href: string): boolean {
  try {
    return isLocalEditorFileUrl(new URL(href));
  } catch {
    return false;
  }
}
