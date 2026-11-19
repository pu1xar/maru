import { test } from "node:test";
import assert from "node:assert/strict";
import { isServerUrl, linkTarget, siteOrigin } from "./links.ts";
import { parseWindowState, restorableBounds } from "./windowState.ts";

const S = "https://maru.example.com";

test("links: the server's pages stay in the app, the web goes to the browser, the rest is dropped", () => {
  assert.equal(linkTarget(`${S}/api/attachments/x`, S), "app");
  assert.equal(linkTarget("https://github.com/x", S), "browser");
  assert.equal(linkTarget("http://maru.example.com/x", S), "browser", "another scheme is another site");
  assert.equal(linkTarget("https://maru.example.com:8443/x", S), "browser", "another port is another site");
  assert.equal(linkTarget("mailto:a@b.c", S), "browser");
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "maru://pair?x", "vscode://x", "not a url"]) {
    assert.equal(linkTarget(bad, S), "drop", bad);
  }
  assert.equal(linkTarget(`${S}/x`, null), "browser", "unpaired: nothing is the app's");
});

test("links: a WebSocket URL is the site of its http origin", () => {
  assert.equal(siteOrigin("wss://maru.example.com/ws"), S);
  assert.equal(siteOrigin("ws://127.0.0.1:18101/ws"), "http://127.0.0.1:18101");
  assert.equal(isServerUrl("wss://maru.example.com/ws", S), true);
  assert.equal(isServerUrl("wss://evil.example.com/ws", S), false);
  assert.equal(siteOrigin("file:///x"), null);
});

test("window state: restored only when the window lies inside a display", () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }, { x: 1920, y: 0, width: 1280, height: 800 }];
  const state = parseWindowState(JSON.stringify({ bounds: { x: 2000, y: 50, width: 1000, height: 700 }, maximized: true }));
  assert.deepEqual(state, { bounds: { x: 2000, y: 50, width: 1000, height: 700 }, maximized: true });
  assert.deepEqual(restorableBounds(state, displays), state!.bounds);
  assert.equal(restorableBounds(state, displays.slice(0, 1)), null, "the second monitor is gone");
  assert.equal(restorableBounds({ bounds: { x: 10, y: 10, width: 200, height: 700 }, maximized: false }, displays), null, "smaller than the minimum");
  assert.equal(restorableBounds(null, displays), null);
  for (const bad of ["", "{", "{}", JSON.stringify({ bounds: { x: "1", y: 0, width: 1, height: 1 } })]) {
    assert.equal(parseWindowState(bad), null, bad);
  }
});
