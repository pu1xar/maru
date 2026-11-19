import { test } from "node:test";
import assert from "node:assert/strict";
import type { MobileApkInfo, MobileAppInfo } from "@maru/shared";
import { INSTALL_HEADLINE, installDetail, installStatus } from "./apkUpdate.logic.ts";

const OLD = "aa6390ac5d286596e63a7ed51fdd5ae69fd5b89c";
const NEW = "ae6cebc21ac3745fee382337f17711dd2de2b09d";
const apk = (runtimeVersion: string, version: string | null = "0.1.374"): MobileApkInfo => ({
  file: "maru.apk", runtimeVersion, size: 90 * 1024 * 1024, sha256: "0", builtAt: "2026-11-18T00:00:00Z", updatesUrl: "u", version,
});
const update = (runtimeVersion: string) => ({ id: "i", runtimeVersion, createdAt: "2026-11-18T00:00:00Z", version: "0.1.374" });
const info = (a: MobileApkInfo | null, u: ReturnType<typeof update> | null): MobileAppInfo => ({ apk: a, update: u });

test("an app on the old runtime is told to install the APK of the update's runtime", () => {
  const s = installStatus(info(apk(NEW), update(NEW)), OLD);
  assert.equal(s.kind, "install");
  assert.equal(s.kind === "install" && s.apk.runtimeVersion, NEW);
});

test("an app on the update's runtime takes OTA and is not asked to install", () => {
  assert.deepEqual(installStatus(info(apk(NEW), update(NEW)), NEW), { kind: "ok" });
});

test("a newer update with no APK of its runtime says so instead of offering an APK that would not help", () => {
  assert.deepEqual(installStatus(info(apk(OLD), update(NEW)), OLD), { kind: "no-apk" });
  assert.deepEqual(installStatus(info(null, update(NEW)), OLD), { kind: "no-apk" });
});

test("with no OTA update the newest APK's runtime is the target", () => {
  assert.equal(installStatus(info(apk(NEW), null), OLD).kind, "install");
  assert.deepEqual(installStatus(info(apk(NEW), null), NEW), { kind: "ok" });
  assert.deepEqual(installStatus(info(null, null), OLD), { kind: "ok" });
});

test("nothing is claimed while the server's answer or this app's runtime is missing", () => {
  assert.deepEqual(installStatus(null, OLD), { kind: "unknown" });
  assert.deepEqual(installStatus(info(apk(NEW), update(NEW)), null), { kind: "unknown" });
});

test("the notice names the version and size, and the no-APK case", () => {
  assert.equal(INSTALL_HEADLINE, "A new app version needs a new install");
  assert.equal(installDetail(installStatus(info(apk(NEW), update(NEW)), OLD)), "maru 0.1.374, 90.0 MB. Download it, then open the file to install");
  assert.equal(installDetail(installStatus(info(apk(NEW, null), update(NEW)), OLD)), "The new APK, 90.0 MB. Download it, then open the file to install");
  assert.equal(installDetail({ kind: "no-apk" }), "No APK for it has been built on the server yet");
  assert.equal(installDetail({ kind: "ok" }), null);
});
