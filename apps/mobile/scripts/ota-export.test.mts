import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contentId, describeFile, signManifest, verifyManifest } from "./ota-export.mts";

test("describeFile: the protocol's hash (base64url SHA-256) and an md5 key the URL names", () => {
  const bytes = Buffer.from("console.log(1)");
  const a = describeFile(bytes, "bundle", "application/javascript");
  assert.equal(a.hash, crypto.createHash("sha256").update(bytes).digest("base64url"));
  assert.match(a.key, /^[0-9a-f]{32}$/);
  assert.equal(a.url, `/ota/assets/${a.key}`);
  assert.equal(a.fileExtension, ".bundle");
});

test("contentId: a UUID that follows the content and nothing else", () => {
  const launch = describeFile(Buffer.from("A"), "bundle", "application/javascript");
  const x = describeFile(Buffer.from("x"), "png", "image/png");
  const y = describeFile(Buffer.from("y"), "png", "image/png");
  const id = contentId("rv", launch, [x, y]);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(contentId("rv", launch, [y, x]), id, "asset order does not matter");
  assert.notEqual(contentId("rv2", launch, [x, y]), id, "another native build is another update");
  assert.notEqual(contentId("rv", describeFile(Buffer.from("B"), "bundle", "application/javascript"), [x, y]), id);
});

test("signManifest: verifies with the matching key only, and with the APK certificate's format", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = (k: crypto.KeyObject) => k.export({ type: "pkcs8", format: "pem" }) as string;
  const pub = (k: crypto.KeyObject) => k.export({ type: "spki", format: "pem" }) as string;
  const manifest = JSON.stringify({ id: "x", createdAt: "2026-11-16T00:00:00.000Z" });
  const sig = signManifest(manifest, pem(privateKey));
  assert.match(sig, /^sig="[A-Za-z0-9+/=]+", keyid="main", alg="rsa-v1_5-sha256"$/);
  assert.equal(verifyManifest(manifest, sig, pub(publicKey)), true);
  assert.equal(verifyManifest(`${manifest} `, sig, pub(publicKey)), false, "one changed byte fails");
  assert.equal(verifyManifest(manifest, signManifest(manifest, pem(other.privateKey)), pub(publicKey)), false, "another key fails");
  // The certificate the APK embeds (a self-signed X.509 certificate of the signing key) works as a
  // verification key. Made here with openssl, so the test needs no file of any deployment.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maru-ota-cert-"));
  try {
    const selfSigned = (name: string, key: crypto.KeyObject): string => {
      const keyFile = path.join(dir, `${name}.key.pem`);
      const certFile = path.join(dir, `${name}.cert.pem`);
      fs.writeFileSync(keyFile, pem(key));
      execFileSync("openssl", ["req", "-x509", "-new", "-key", keyFile, "-sha256", "-days", "1", "-subj", "/CN=maru-test", "-out", certFile], { stdio: "ignore" });
      return fs.readFileSync(certFile, "utf8");
    };
    assert.equal(verifyManifest(manifest, sig, selfSigned("main", privateKey)), true);
    assert.equal(verifyManifest(manifest, sig, selfSigned("other", other.privateKey)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
