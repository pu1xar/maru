import assert from "node:assert/strict";
import { test } from "node:test";

import { viewedImageBlobFromOutput, viewedImageUrls } from "./viewedImages.ts";

const block = (over: Record<string, unknown> = {}, blobOver: Record<string, unknown> = {}) => ({
  type: "image",
  mimeType: "image/png",
  blob: {
    raw: { source: "claude-transcript", key: "k", path: "/h/.claude/projects/p/s.jsonl", byteOffset: 77 },
    jsonPath: "$.message.content[0].content[0].source.data",
    mediaType: "image/png",
    ...blobOver,
  },
  ...over,
});

test("the tool result's image block names where the transcript carries the picture", () => {
  const expected = { path: "/h/.claude/projects/p/s.jsonl", byteOffset: 77, jsonPath: "$.message.content[0].content[0].source.data" };
  assert.deepEqual(viewedImageBlobFromOutput([block()]), expected);
  // The `{content, structuredContent}` pair an MCP-style result becomes.
  assert.deepEqual(viewedImageBlobFromOutput({ content: [{ type: "text", text: "x" }, block()], structuredContent: { a: 1 } }), expected);
  assert.deepEqual(viewedImageBlobFromOutput(block()), expected);
});

test("the first usable block wins and unusable ones are passed over", () => {
  const second = block({}, { raw: { source: "claude-transcript", key: "k", path: "/other.jsonl", byteOffset: 5 } });
  assert.equal(viewedImageBlobFromOutput([block({}, { mediaType: "image/svg+xml" }), second])?.path, "/other.jsonl");
});

test("anything the blob route cannot decode gives no copy", () => {
  assert.equal(viewedImageBlobFromOutput(undefined), null);
  assert.equal(viewedImageBlobFromOutput("plain text"), null);
  assert.equal(viewedImageBlobFromOutput([{ type: "text", text: "x" }]), null);
  // The route reads a `source.data` path only; the structured result's `file.base64` is not one.
  assert.equal(viewedImageBlobFromOutput([block({}, { jsonPath: "$.toolUseResult.file.base64" })]), null);
  assert.equal(viewedImageBlobFromOutput([block({}, { mediaType: "image/svg+xml" })]), null);
  assert.equal(viewedImageBlobFromOutput([block({}, { raw: { source: "claude-stream", key: "k" } })]), null);
  assert.equal(viewedImageBlobFromOutput([{ type: "image", mimeType: "image/png" }]), null);
});

test("a preview tries the transcript copy, then the file", () => {
  const blob = { path: "/h/s.jsonl", byteOffset: 9, jsonPath: "$.message.content[0].content[0].source.data" };
  const urls = viewedImageUrls({ path: "/tmp/a b/v.png", blob });
  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /^\/api\/file\/blob\?path=%2Fh%2Fs\.jsonl&offset=9&pointer=/);
  assert.equal(urls[1], "/api/file/raw?path=%2Ftmp%2Fa+b%2Fv.png");
  assert.deepEqual(viewedImageUrls({ path: "/tmp/v.png", blob: null }), ["/api/file/raw?path=%2Ftmp%2Fv.png"]);
});

test("a picture type the file route does not serve keeps only the transcript copy", () => {
  const blob = { path: "/h/s.jsonl", byteOffset: 9, jsonPath: "$.message.content[0].content[0].source.data" };
  assert.equal(viewedImageUrls({ path: "/tmp/v.heic", blob }).length, 1);
  assert.deepEqual(viewedImageUrls({ path: "/tmp/v.heic", blob: null }), []);
  assert.deepEqual(viewedImageUrls({ path: "/tmp/a\nb.png", blob: null }), []);
});
