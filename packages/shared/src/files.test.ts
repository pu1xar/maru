import assert from "node:assert/strict";
import { test } from "node:test";

import { isBitmapImagePath, isInlineImagePath } from "./files.ts";

test("bitmap image paths: the web's picture list without SVG", () => {
  assert.equal(isBitmapImagePath("/a/b.webp"), true);
  assert.equal(isBitmapImagePath("/a/v.svg"), false);
  assert.equal(isInlineImagePath("/a/v.svg"), true);
  assert.equal(isBitmapImagePath("/a/b.txt"), false);
});

test("inline image paths: the previewed picture extensions, any case, with or without a position", () => {
  for (const p of ["/a/b.png", "/a/b.PNG", "~/x.jpg", "x.jpeg", "/a/b.gif", "/a/b.webp", "/a/v.svg", "/a/b.png:12"]) {
    assert.equal(isInlineImagePath(p), true, p);
  }
});

test("inline image paths: other files, dotfiles and folders are not pictures", () => {
  for (const p of ["/a/b.ts", "/a/png", "/a/.png", "/a/b.png/", "/a/b.pdf", "/a/b.png.bak", "/a.b/c", "", "/a/b.avif"]) {
    assert.equal(isInlineImagePath(p), false, p);
  }
});
