import { test } from "node:test";
import assert from "node:assert/strict";
import { describeDesktopUpdate, desktopBridge } from "./desktopBridge.ts";

test("desktop bridge: none outside the desktop app", () => {
  assert.equal(desktopBridge(), null);
});

test("desktop update line: one line per state, the percentage while downloading", () => {
  const v = "0.1.90";
  assert.equal(describeDesktopUpdate(null, v), "maru 0.1.90");
  assert.equal(describeDesktopUpdate({ status: "disabled", reason: "개발 실행" }, v), "maru 0.1.90, auto update off: 개발 실행");
  assert.equal(describeDesktopUpdate({ status: "up-to-date", checkedAt: 1 }, v), "maru 0.1.90, up to date");
  assert.equal(describeDesktopUpdate({ status: "downloading", version: "0.1.95", received: 33, total: 100 }, v), "Downloading maru 0.1.95 33%");
  assert.equal(describeDesktopUpdate({ status: "downloading", version: "0.1.95", received: 0, total: 0 }, v), "Downloading maru 0.1.95 0%");
  assert.equal(describeDesktopUpdate({ status: "downloaded", version: "0.1.95" }, v), "maru 0.1.95 downloaded, restart to apply");
  assert.equal(describeDesktopUpdate({ status: "error", context: "download", message: "x", checkedAt: 1 }, v), "maru 0.1.90, download failed: x");
});
