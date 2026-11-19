import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesktopUpdateManifest } from "@maru/shared";
import { decodeBlockMap } from "../src/blockmap.ts";
import { parseTargets, reusable, writeBlockmap } from "./build.ts";
import { fingerprint, fingerprintInputs } from "./fingerprint.ts";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const cert = publicKey.export({ type: "spki", format: "pem" }).toString();

function previousBuild(dir: string, fp: string, files: Record<string, string>, key = privateKey, withMaps = true) {
  fs.mkdirSync(dir, { recursive: true });
  const artifacts = Object.entries(files).map(([file, body]) => {
    fs.writeFileSync(path.join(dir, file), body);
    const platform = file.includes("-mac-") ? "darwin" : "win32";
    const format = file.endsWith(".zip") ? "zip" : file.endsWith(".dmg") ? "dmg" : "nsis";
    const artifact: DesktopUpdateManifest["artifacts"][number] = { file, platform, arch: file.includes("arm64") ? "arm64" : "x64", format,
      size: Buffer.byteLength(body), sha256: crypto.createHash("sha256").update(body).digest("hex") };
    if (withMaps && format !== "dmg") {
      const map = `map of ${body}`;
      fs.writeFileSync(path.join(dir, `${file}.blockmap`), map);
      artifact.blockmap = { file: `${file}.blockmap`, size: Buffer.byteLength(map), sha256: crypto.createHash("sha256").update(map).digest("hex") };
    }
    return artifact;
  });
  const m: DesktopUpdateManifest = { format: 1, type: "maru-desktop-update", version: "0.1.90", fingerprint: fp, builtAt: "x", artifacts: [...artifacts] };
  const text = JSON.stringify(m);
  fs.writeFileSync(path.join(dir, "manifest.json"), text);
  fs.writeFileSync(path.join(dir, "manifest.json.sig"), crypto.sign("sha256", Buffer.from(text), key).toString("base64"));
}

test("targets: mac and win by CPU", () => {
  assert.deepEqual(parseTargets("mac-arm64, win-x64"), [{ platform: "darwin", arch: "arm64" }, { platform: "win32", arch: "x64" }]);
  assert.throws(() => parseTargets("linux-x64"), /unknown target/);
});

test("previous build: kept only when signed, the same shell, complete and intact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-prev-"));
  const log = console.log;
  console.log = () => {};
  try {
    const files = { "maru-0.1.90-mac-arm64.zip": "zip", "maru-0.1.90-mac-arm64.dmg": "dmg", "maru-0.1.90-win-x64.exe": "exe" };
    const both = parseTargets("mac-arm64,win-x64");
    previousBuild(path.join(dir, "ok"), "v1-a", files);
    assert.equal(reusable(path.join(dir, "ok"), "v1-a", both, cert)?.manifest.version, "0.1.90");
    assert.equal(reusable(path.join(dir, "ok"), "v1-b", both, cert), null, "the shell changed");
    assert.equal(reusable(path.join(dir, "ok"), "v1-a", parseTargets("mac-arm64,mac-x64"), cert), null, "a target it lacks");
    assert.equal(reusable(path.join(dir, "none"), "v1-a", both, cert), null, "no previous build");
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    previousBuild(path.join(dir, "foreign"), "v1-a", files, other);
    assert.equal(reusable(path.join(dir, "foreign"), "v1-a", both, cert), null, "signed by another key");
    previousBuild(path.join(dir, "changed"), "v1-a", files);
    fs.writeFileSync(path.join(dir, "changed", "maru-0.1.90-win-x64.exe"), "exf");
    assert.equal(reusable(path.join(dir, "changed"), "v1-a", both, cert), null, "a file changed after signing");
    previousBuild(path.join(dir, "nomap"), "v1-a", files, privateKey, false);
    assert.equal(reusable(path.join(dir, "nomap"), "v1-a", both, cert), null, "a build from before block maps would leave installed apps without differential updates");
    previousBuild(path.join(dir, "mapchanged"), "v1-a", files);
    fs.writeFileSync(path.join(dir, "mapchanged", "maru-0.1.90-win-x64.exe.blockmap"), "other map");
    assert.equal(reusable(path.join(dir, "mapchanged"), "v1-a", both, cert), null, "a block map changed after signing");
  } finally {
    console.log = log;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("block map: written beside the file, listed with its size and SHA-256, readable back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-map-"));
  try {
    const body = crypto.randomBytes(500_000);
    fs.writeFileSync(path.join(dir, "maru-0.1.90-mac-arm64.zip"), body);
    const entry = await writeBlockmap(dir, "maru-0.1.90-mac-arm64.zip");
    assert.equal(entry.file, "maru-0.1.90-mac-arm64.zip.blockmap");
    const written = fs.readFileSync(path.join(dir, entry.file));
    assert.equal(entry.size, written.length);
    assert.equal(entry.sha256, crypto.createHash("sha256").update(written).digest("hex"));
    const map = decodeBlockMap(written, body.length);
    assert.equal(map.sizes.reduce((a, b) => a + b, 0), body.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fingerprint: the inputs' bytes and the certificate, not the time", () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-fp-"));
  try {
    for (const f of ["dist-electron/main.cjs", "dist-electron/pages/pair.html", "package.json", "scripts/builderConfig.ts", "resources/icon.png", "scripts/build.ts"]) {
      fs.mkdirSync(path.dirname(path.join(app, f)), { recursive: true });
      fs.writeFileSync(path.join(app, f), f);
    }
    assert.deepEqual(fingerprintInputs(app).map((f) => path.relative(app, f)),
      ["dist-electron/main.cjs", "dist-electron/pages/pair.html", "package.json", "resources/icon.png", "scripts/builderConfig.ts"]);
    const a = fingerprint(app, cert);
    assert.match(a, /^v1-[0-9a-f]{64}$/);
    fs.writeFileSync(path.join(app, "scripts/build.ts"), "orchestration only");
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(path.join(app, "package.json"), later, later);
    assert.equal(fingerprint(app, cert), a, "build.ts and file times are not inputs");
    fs.writeFileSync(path.join(app, "dist-electron/main.cjs"), "changed");
    assert.notEqual(fingerprint(app, cert), a);
    fs.writeFileSync(path.join(app, "dist-electron/main.cjs"), "dist-electron/main.cjs");
    assert.equal(fingerprint(app, cert), a);
    assert.notEqual(fingerprint(app, `${cert}x`), a, "a new certificate is a new shell");
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});
