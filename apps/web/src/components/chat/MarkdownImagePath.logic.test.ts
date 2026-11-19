import assert from "node:assert/strict";
import { test } from "node:test";

import { isBitmapImagePath } from "../../../../../packages/shared/src/files.ts";
import {
  fileLinkImagePath,
  markdownImagePath,
  resolveMarkdownFileLinkMeta,
} from "./MarkdownFileLinkMeta.logic.ts";

const DOC_DIR = "/Users/me/notes";

function documentImage(src: string): string | null {
  const meta = resolveMarkdownFileLinkMeta(src, DOC_DIR, DOC_DIR);
  return meta ? markdownImagePath(meta) : null;
}

test("a relative file link does not preview, but an authored image names its picture under the base folder", () => {
  const link = resolveMarkdownFileLinkMeta("./img/a.png", DOC_DIR, DOC_DIR)!;
  assert.equal(fileLinkImagePath(link), null, "the chip rule is unchanged");
  assert.equal(markdownImagePath(link), "/Users/me/notes/img/a.png");
});

test("an authored image resolves every spelling of a path under the document's folder", () => {
  assert.equal(documentImage("img/a.png"), "/Users/me/notes/img/a.png");
  assert.equal(documentImage("../shared/a.png"), "/Users/me/shared/a.png", "dot segments collapse");
  assert.equal(documentImage("./a/./b/../c.png"), "/Users/me/notes/a/c.png");
  assert.equal(
    documentImage("img/%ED%95%9C%EA%B8%80%20%EA%B7%B8%EB%A6%BC.png"),
    "/Users/me/notes/img/한글 그림.png",
    "%-encoding decodes",
  );
  assert.equal(documentImage("<img/with space.png>"), "/Users/me/notes/img/with space.png", "angle brackets and spaces");
  assert.equal(documentImage("img/한글 그림.PNG"), "/Users/me/notes/img/한글 그림.PNG");
  assert.equal(documentImage("img/a.png?raw=1#x"), "/Users/me/notes/img/a.png", "query and fragment drop");
  assert.equal(documentImage("/abs/pic.webp"), "/abs/pic.webp");
  assert.equal(documentImage("~/pics/a.jpg"), "/Users/me/pics/a.jpg");
  assert.equal(documentImage("file:///abs/pic.gif"), "/abs/pic.gif");
});

test("an authored image that is no picture file, or no file at all, names no picture", () => {
  assert.equal(documentImage("notes.pdf"), null);
  assert.equal(documentImage("dir/"), null);
  assert.equal(documentImage("https://example.com/a.png"), null);
  assert.equal(documentImage("data:image/png;base64,AAAA"), null);
  const meta = resolveMarkdownFileLinkMeta("img/a.svg", DOC_DIR, DOC_DIR)!;
  assert.equal(markdownImagePath(meta, isBitmapImagePath), null);
});

test("without a base folder a relative authored image names no picture", () => {
  assert.equal(resolveMarkdownFileLinkMeta("img/a.png", undefined), null);
});
