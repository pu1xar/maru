import { test } from "node:test";
import assert from "node:assert/strict";
import { leanBounds, parseLeanStates, readLeanRequest } from "./leanState.ts";

const SERVER = "https://maru.example.com";
const area = { x: 0, y: 0, width: 1920, height: 1080 };

test("lean bounds: the default size, centred by the system, when nothing is saved and nothing dropped", () => {
  assert.deepEqual(leanBounds(null, null, [area]), { width: 480, height: 680 });
});

test("lean bounds: a drop centres the window on the pointer with the session's saved size", () => {
  const saved = { x: 5, y: 5, width: 500, height: 600 };
  assert.deepEqual(leanBounds(saved, { x: 1000, y: 400 }, [area]), { x: 750, y: 384, width: 500, height: 600 });
});

test("lean bounds: a drop near an edge keeps the window on the display", () => {
  assert.deepEqual(leanBounds(null, { x: 1910, y: 1075 }, [area]), { x: 1440, y: 400, width: 480, height: 680 });
  assert.deepEqual(leanBounds(null, { x: 5, y: -20 }, [area]), { x: 0, y: 0, width: 480, height: 680 });
});

test("lean bounds: a drop on the second display uses that display's work area", () => {
  const right = { x: 1920, y: 0, width: 1280, height: 800 };
  assert.deepEqual(leanBounds(null, { x: 3190, y: 790 }, [area, right]), { x: 2720, y: 120, width: 480, height: 680 });
});

test("lean bounds: with no drop the last place returns while it is on a display, else the system centres", () => {
  const saved = { x: 100, y: 120, width: 400, height: 500 };
  assert.deepEqual(leanBounds(saved, null, [area]), { x: 100, y: 120, width: 400, height: 500 });
  assert.deepEqual(leanBounds({ x: 5000, y: 120, width: 400, height: 500 }, null, [area]), { width: 400, height: 500 });
});

test("lean states: only complete bounds are read", () => {
  assert.deepEqual(parseLeanStates(JSON.stringify({ a: { x: 1, y: 2, width: 3, height: 4 }, b: { x: 1 }, c: "x" })), { a: { x: 1, y: 2, width: 3, height: 4 } });
  assert.deepEqual(parseLeanStates("[]"), {});
  assert.deepEqual(parseLeanStates("nope"), {});
  assert.deepEqual(parseLeanStates(null), {});
});

test("open request: the page's own lean address on the paired server is rebuilt from the origin", () => {
  const r = readLeanRequest({ key: "claude:acct:abc-1", path: "/?s=abc-1&window=lean", at: { x: 10, y: 20 } }, SERVER);
  assert.deepEqual(r, { key: "claude:acct:abc-1", url: `${SERVER}/?s=abc-1&window=lean`, at: { x: 10, y: 20 } });
  assert.equal(readLeanRequest({ key: "claude:acct:abc-1", path: "/?s=abc-1&window=lean", at: null }, SERVER)?.at, null);
  assert.equal(readLeanRequest({ key: "claude:acct:abc-1", path: "/?s=abc-1&window=lean", at: { x: "1", y: 2 } }, SERVER)?.at, null);
});

test("open request: another origin, another page, a key that does not match, or no server is refused", () => {
  const ok = { key: "claude:acct:abc-1", path: "/?s=abc-1&window=lean", at: null };
  assert.ok(readLeanRequest(ok, SERVER));
  assert.equal(readLeanRequest(ok, null), null);
  assert.equal(readLeanRequest({ ...ok, path: "//evil.example/?s=abc-1&window=lean" }, SERVER), null);
  assert.equal(readLeanRequest({ ...ok, path: "https://evil.example/?s=abc-1&window=lean" }, SERVER), null);
  assert.equal(readLeanRequest({ ...ok, path: "/api/file?s=abc-1&window=lean" }, SERVER), null);
  assert.equal(readLeanRequest({ ...ok, path: "/?s=abc-1" }, SERVER), null);
  assert.equal(readLeanRequest({ ...ok, path: "/?window=lean" }, SERVER), null);
  assert.equal(readLeanRequest({ ...ok, key: "claude:acct:other" }, SERVER), null);
  assert.equal(readLeanRequest({ ...ok, key: "bad key\n" }, SERVER), null);
  assert.equal(readLeanRequest({ ...ok, key: 5 }, SERVER), null);
  assert.equal(readLeanRequest(null, SERVER), null);
});
