import assert from "node:assert/strict";
import test from "node:test";
import { appVersions } from "./appVersion.ts";

const apkConfig = JSON.stringify({ name: "maru", version: "0.1.52", android: { versionCode: 52 } });

test("the APK's own bundle runs the APK's version", () => {
  assert.deepEqual(appVersions({ embeddedLaunch: true, manifest: { id: "embedded" }, apkConfig }), { running: "0.1.52", apk: "0.1.52" });
});

test("an OTA update runs the version its release put in the manifest", () => {
  const manifest = { id: "u", metadata: {}, extra: { maruVersion: "0.1.60" } };
  assert.deepEqual(appVersions({ embeddedLaunch: false, manifest, apkConfig }), { running: "0.1.60", apk: "0.1.52" });
});

test("unknown parts stay null", () => {
  // An update exported before versions, and an APK config that cannot be read.
  assert.deepEqual(appVersions({ embeddedLaunch: false, manifest: { metadata: {}, extra: {} }, apkConfig: "{" }), { running: null, apk: null });
  assert.deepEqual(appVersions({ embeddedLaunch: false, manifest: null, apkConfig: null }), { running: null, apk: null });
  assert.deepEqual(appVersions({ embeddedLaunch: true, manifest: {}, apkConfig: { version: "0.1.0" } }), { running: "0.1.0", apk: "0.1.0" });
});
