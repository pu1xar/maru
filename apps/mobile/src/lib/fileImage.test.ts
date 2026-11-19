import { test } from "node:test";
import assert from "node:assert/strict";
import { fileImageSource, fitPreview, pictureSource } from "./fileImage.ts";
import type { Pairing } from "./api.ts";

const pairing = { server: "https://maru.example", token: "maru_dev_x", device: { id: "d" } } as unknown as Pairing;

test("a picture loads from the raw file route with the device token", () => {
  const source = fileImageSource(pairing, "/private/tmp/a b/d-S7.png");
  assert.equal(source.uri, "https://maru.example/api/file/raw?path=%2Fprivate%2Ftmp%2Fa+b%2Fd-S7.png");
  assert.deepEqual(source.headers, { Authorization: "Bearer maru_dev_x" });
  assert.match(fileImageSource(pairing, "~/pics/a.png").uri, /path=%7E%2Fpics%2Fa\.png$|path=~%2Fpics%2Fa\.png$/);
});

test("a preview scales down to its box and never up", () => {
  assert.deepEqual(fitPreview(640, 360, 300, 200), { width: 300, height: 169 });
  assert.deepEqual(fitPreview(300, 500, 300, 200), { width: 120, height: 200 });
  assert.deepEqual(fitPreview(100, 50, 300, 200), { width: 100, height: 50 });
  assert.deepEqual(fitPreview(0, 50, 300, 200), { width: 0, height: 0 });
});

test("a tool's picture loads from a server-relative URL with the device token", () => {
  const source = pictureSource(pairing, "/api/file/blob?path=%2Fh%2Fs.jsonl&offset=9&pointer=%24.a.data");
  assert.equal(source.uri, "https://maru.example/api/file/blob?path=%2Fh%2Fs.jsonl&offset=9&pointer=%24.a.data");
  assert.deepEqual(source.headers, { Authorization: "Bearer maru_dev_x" });
});
