import assert from "node:assert/strict";
import { test } from "node:test";

import { isBitmapImagePath } from "../../../../../packages/shared/src/files.ts";
import {
  fileLinkImagePath,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
} from "./MarkdownFileLinkMeta.logic.ts";

const CWD = "/Users/me/projects/app";
const OUTSIDE = "/private/tmp/claude-501/-Users-me-work-a/3296a420/scratchpad/d-S7.png";

test("a picture path outside the session folder is a file link with a preview", () => {
  for (const meta of [
    resolveInlineCodeFileLinkMeta(OUTSIDE, CWD),
    resolveMarkdownFileLinkMeta(OUTSIDE, CWD),
    resolveMarkdownFileLinkMeta(OUTSIDE, undefined),
  ]) {
    assert.ok(meta);
    assert.equal(meta.workspaceRelativePath, null, "outside the session folder");
    assert.equal(fileLinkImagePath(meta), OUTSIDE);
  }
});

test("a home path previews, with or without a session folder", () => {
  assert.equal(fileLinkImagePath(resolveInlineCodeFileLinkMeta("~/pics/a.png", undefined)!), "~/pics/a.png");
  const inHome = fileLinkImagePath(resolveInlineCodeFileLinkMeta("~/pics/a.png", CWD)!);
  assert.equal(inHome, "/Users/me/pics/a.png");
});

test("a relative picture path and a non-picture file get no preview", () => {
  assert.equal(fileLinkImagePath(resolveInlineCodeFileLinkMeta("docs/shot.png", CWD)!), null);
  assert.equal(fileLinkImagePath(resolveInlineCodeFileLinkMeta("/tmp/a.ts", CWD)!), null);
  assert.equal(fileLinkImagePath(resolveInlineCodeFileLinkMeta("/tmp/a.png:12", CWD)!), "/tmp/a.png");
});

test("the app's bitmap list leaves SVG out", () => {
  const svg = resolveInlineCodeFileLinkMeta("/tmp/v.svg", CWD)!;
  assert.equal(fileLinkImagePath(svg), "/tmp/v.svg");
  assert.equal(fileLinkImagePath(svg, isBitmapImagePath), null);
});

test("an inline code span of one path with spaces resolves like any file link, a command does not", () => {
  const name = "한글 파일 이름 예시 Track C 2,5,6,7.md";
  const path = `~/projects/notes/summaries/${name}`;
  const meta = resolveInlineCodeFileLinkMeta(path, CWD);
  assert.ok(meta);
  assert.equal(meta.basename, name);
  assert.equal(resolveInlineCodeFileLinkMeta(path, undefined)?.targetPath, path);
  assert.equal(resolveInlineCodeFileLinkMeta(`cat ${path}`, CWD), null);
  assert.equal(resolveInlineCodeFileLinkMeta(`${path} | wc -l`, CWD), null);
});
