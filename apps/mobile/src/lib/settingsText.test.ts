import { test } from "node:test";
import assert from "node:assert/strict";
import { describeApk, describeAppUpdate, describeServerUpdate, updateBusy } from "./settingsText.ts";

test("the app row says the version and where the check stands, as the web's update row does", () => {
  assert.equal(describeAppUpdate({ status: "idle" }, "0.1.5"), "maru 0.1.5");
  assert.equal(describeAppUpdate({ status: "checking" }, "0.1.5"), "maru 0.1.5, checking");
  assert.equal(describeAppUpdate({ status: "up-to-date" }, "0.1.5"), "maru 0.1.5, up to date");
  assert.equal(describeAppUpdate({ status: "error", message: "offline" }, "0.1.5"), "maru 0.1.5, check failed: offline");
  assert.match(describeAppUpdate({ status: "disabled" }, "0.1.5"), /automatic updates off/);
  assert.equal(describeAppUpdate({ status: "needs-install" }, "0.1.5"), "maru 0.1.5, a new app version needs a new install");
});

test("the button waits while a check or a download runs", () => {
  assert.equal(updateBusy({ status: "checking" }), true);
  assert.equal(updateBusy({ status: "downloading" }), true);
  assert.equal(updateBusy({ status: "idle" }), false);
  assert.equal(updateBusy({ status: "up-to-date" }), false);
});

test("the server's update reads as the web's Android app section writes it", () => {
  assert.equal(describeServerUpdate(null), "No OTA update");
  const text = describeServerUpdate({ id: "abcdef0123456789", runtimeVersion: "1234567890abcdef", createdAt: "2026-11-15T14:03:00", version: "0.1.9" });
  assert.match(text, /^0\.1\.9, .+ signed, id abcdef01, runtime 1234567890ab$/);
});

test("the APK row names the version when there is one and the runtime", () => {
  assert.equal(describeApk("0.1.2", "abcdef0123456789"), "0.1.2, runtime abcdef012345");
  assert.equal(describeApk(null, "-"), "runtime -");
});
