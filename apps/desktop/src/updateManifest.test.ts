import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { DesktopUpdateManifest } from "@maru/shared";
import { ManifestError, isNewer, updateArtifact, verifyManifest } from "./updateManifest.ts";
import { initialModel, reduce, type UpdateEvent } from "./updateMachine.ts";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
const sign = (text: string, key = privateKey) => crypto.sign("sha256", Buffer.from(text, "utf8"), key).toString("base64");
const sha = "a".repeat(64);
const manifest: DesktopUpdateManifest = {
  format: 1, type: "maru-desktop-update", version: "0.1.200", fingerprint: "v1-x", builtAt: "2026-11-16T00:00:00.000Z",
  artifacts: [
    { file: "maru-0.1.200-mac-arm64.zip", platform: "darwin", arch: "arm64", format: "zip", size: 10, sha256: sha },
    { file: "maru-0.1.200-mac-arm64.dmg", platform: "darwin", arch: "arm64", format: "dmg", size: 10, sha256: sha },
    { file: "maru-0.1.200-win-x64.exe", platform: "win32", arch: "x64", format: "nsis", size: 10, sha256: sha },
  ],
};

test("manifest: read only when the key signed exactly these bytes", () => {
  const text = JSON.stringify(manifest);
  assert.deepEqual(verifyManifest(text, sign(text), pub), manifest);
  assert.throws(() => verifyManifest(text.replace("0.1.200", "0.1.201"), sign(text), pub), ManifestError, "changed after signing");
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.throws(() => verifyManifest(text, sign(text, other), pub), /signature does not match/, "another key");
  assert.throws(() => verifyManifest(text, "", pub), ManifestError);
  // Signed, but not a desktop manifest, not a release version, or a bad file entry.
  for (const body of [
    { ...manifest, type: "expo" },
    { ...manifest, version: "0.1.200-dev" },
    { ...manifest, artifacts: [{ ...manifest.artifacts[0]!, file: "../evil.zip" }] },
    { ...manifest, artifacts: [{ ...manifest.artifacts[0]!, sha256: "xyz" }] },
    { ...manifest, artifacts: [{ ...manifest.artifacts[0]!, blockmap: { file: "../m", size: 10, sha256: sha } }] },
    { ...manifest, artifacts: [{ ...manifest.artifacts[0]!, blockmap: { file: "m.blockmap", size: 0, sha256: sha } }] },
    { ...manifest, artifacts: [{ ...manifest.artifacts[0]!, blockmap: { file: "m.blockmap", size: 10, sha256: "xyz" } }] },
    { ...manifest, artifacts: [{ ...manifest.artifacts[0]!, blockmap: { file: manifest.artifacts[0]!.file, size: 10, sha256: sha } }] },
  ]) {
    const t = JSON.stringify(body);
    assert.throws(() => verifyManifest(t, sign(t), pub), ManifestError, JSON.stringify(body).slice(0, 80));
  }
});

test("manifest: a block map entry rides inside the signed bytes", () => {
  const withMap: DesktopUpdateManifest = {
    ...manifest,
    artifacts: [{ ...manifest.artifacts[0]!, blockmap: { file: "maru-0.1.200-mac-arm64.zip.blockmap", size: 252, sha256: sha } }, ...manifest.artifacts.slice(1)],
  };
  const text = JSON.stringify(withMap);
  assert.deepEqual(verifyManifest(text, sign(text), pub).artifacts[0]!.blockmap, withMap.artifacts[0]!.blockmap);
  // The server cannot swap in another block map: its hash is part of what was signed.
  const swapped = text.replace(`"sha256":"${sha}"}`, `"sha256":"${"b".repeat(64)}"}`);
  assert.notEqual(swapped, text);
  assert.throws(() => verifyManifest(swapped, sign(text), pub), /signature does not match/);
});

test("manifest: the Mac updates from its zip, Windows from its installer, by CPU", () => {
  assert.equal(updateArtifact(manifest, "darwin", "arm64")?.format, "zip");
  assert.equal(updateArtifact(manifest, "win32", "x64")?.file, "maru-0.1.200-win-x64.exe");
  assert.equal(updateArtifact(manifest, "darwin", "x64"), null, "no Intel build in this one");
  assert.equal(updateArtifact(manifest, "linux", "x64"), null);
});

test("versions: by series then commit count; an older build is no update", () => {
  assert.equal(isNewer("0.1.201", "0.1.200"), true);
  assert.equal(isNewer("0.1.200", "0.1.200"), false);
  assert.equal(isNewer("0.1.150", "0.1.200"), false, "a rolled back server");
  assert.equal(isNewer("0.2.180", "0.1.200"), true, "a new series wins over the count");
  assert.equal(isNewer("1.0.1", "0.9.900"), true);
  assert.equal(isNewer("0.1.201", "0.1.200-dev"), true);
  assert.equal(isNewer("garbage", "0.1.200"), false);
});

test("update machine: T3's transitions, downloading at once, a ready build kept through failures", () => {
  const run = (events: UpdateEvent[], disabled: string | null = null) => events.reduce(reduce, initialModel(disabled));
  assert.deepEqual(run([]).state, { status: "idle" });
  assert.deepEqual(run([{ type: "check-start" }, { type: "no-update", at: 5 }]).state, { status: "up-to-date", checkedAt: 5 });
  assert.deepEqual(run([{ type: "check-start" }, { type: "check-failed", message: "x", at: 6 }]).state,
    { status: "error", context: "check", message: "x", checkedAt: 6 });
  const dl = run([{ type: "check-start" }, { type: "download-start", version: "0.1.9", total: 100 }, { type: "download-progress", received: 40 }]);
  assert.deepEqual(dl.state, { status: "downloading", version: "0.1.9", received: 40, total: 100 });
  const ready = reduce(dl, { type: "downloaded", version: "0.1.9" });
  assert.deepEqual(ready, { state: { status: "downloaded", version: "0.1.9" }, downloaded: "0.1.9" });
  for (const e of [{ type: "check-failed", message: "x", at: 1 }, { type: "no-update", at: 1 }, { type: "download-failed", message: "y", at: 1 }] as UpdateEvent[]) {
    assert.deepEqual(reduce(reduce(ready, { type: "check-start" }), e).state, { status: "downloaded", version: "0.1.9" }, e.type);
  }
  assert.equal(reduce(ready, { type: "install-failed", message: "z", at: 2 }).state.status, "error");
  assert.deepEqual(run([{ type: "check-start" }], "dev").state, { status: "disabled", reason: "dev" });
});
