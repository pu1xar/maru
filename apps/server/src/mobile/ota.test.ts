import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { OtaUpdates, type OtaUpdateFile } from "./ota.ts";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

function publish(dir: string, id: string, runtimeVersion: string, bundle: string, version?: string): OtaUpdateFile {
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  const bytes = Buffer.from(bundle);
  const key = crypto.createHash("md5").update(bytes).digest("hex");
  fs.writeFileSync(path.join(dir, "files", `${key}.bundle`), bytes);
  const launchAsset = {
    hash: crypto.createHash("sha256").update(bytes).digest("base64url"), key,
    contentType: "application/javascript", fileExtension: ".bundle", url: `/ota/assets/${key}`,
  };
  const extra = version ? { maruVersion: version } : {};
  const manifest = JSON.stringify({ id, createdAt: "2026-11-16T00:00:00.000Z", runtimeVersion, launchAsset, assets: [], metadata: {}, extra });
  const sig = crypto.sign("sha256", Buffer.from(manifest), privateKey).toString("base64");
  const update: OtaUpdateFile = {
    format: 1, platform: "android", id, runtimeVersion, createdAt: "2026-11-16T00:00:00.000Z", manifest,
    signature: `sig="${sig}", keyid="main", alg="rsa-v1_5-sha256"`,
    assets: { [key]: { file: `files/${key}.bundle`, contentType: "application/javascript" } },
    ...(version ? { version } : {}),
  };
  fs.writeFileSync(path.join(dir, "update.json.tmp"), JSON.stringify(update));
  fs.renameSync(path.join(dir, "update.json.tmp"), path.join(dir, "update.json"));
  return update;
}

/** The parts of a multipart/mixed body: headers (lower-cased names) and body. */
function parts(contentType: string, body: string): Array<{ headers: Record<string, string>; body: string }> {
  const boundary = /boundary=([^;]+)/.exec(contentType)![1]!;
  return body.split(`--${boundary}`).slice(1, -1).map((chunk) => {
    const raw = chunk.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const split = raw.indexOf("\r\n\r\n");
    const headers: Record<string, string> = {};
    for (const line of raw.slice(0, split).split("\r\n")) {
      const i = line.indexOf(":");
      headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
    }
    return { headers, body: raw.slice(split + 4) };
  });
}

test("OTA: a signed multipart manifest, its assets, and 204 when there is nothing to take", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ota-"));
  const ota = new OtaUpdates(dir);
  const server = http.createServer((req, res) => ota.handle(req, res, new URL(req.url || "/", "http://x")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const expo = (extra: Record<string, string> = {}) => ({
    "expo-platform": "android", "expo-protocol-version": "1", "expo-runtime-version": "rv1",
    "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"', ...extra,
  });
  try {
    assert.equal((await fetch(`${base}/ota/manifest`, { headers: expo() })).status, 204, "no update published");
    assert.equal(ota.info(), null);

    const u1 = publish(dir, "11111111-1111-5111-8111-111111111111", "rv1", "console.log('A')");
    // An update exported before versions has none.
    assert.equal(ota.info()?.version, null);
    const res = await fetch(`${base}/ota/manifest`, { headers: expo({ "expo-current-update-id": "embedded-id" }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("expo-protocol-version"), "1");
    const ps = parts(res.headers.get("content-type")!, await res.text());
    assert.deepEqual(ps.map((p) => /name="([^"]+)"/.exec(p.headers["content-disposition"]!)?.[1]), ["manifest", "extensions"]);
    const manifest = ps[0]!;
    assert.equal(manifest.body, u1.manifest, "the signed bytes go out unchanged");
    const sig = /sig="([^"]+)"/.exec(manifest.headers["expo-signature"]!)![1]!;
    assert.ok(crypto.verify("sha256", Buffer.from(manifest.body), publicKey, Buffer.from(sig, "base64")));
    assert.match(manifest.headers["expo-signature"]!, /keyid="main", alg="rsa-v1_5-sha256"$/);

    const launch = JSON.parse(manifest.body).launchAsset;
    const asset = await fetch(`${base}${launch.url}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"), "application/javascript");
    const bytes = Buffer.from(await asset.arrayBuffer());
    assert.equal(crypto.createHash("sha256").update(bytes).digest("base64url"), launch.hash);

    assert.equal((await fetch(`${base}/ota/manifest`, { headers: expo({ "expo-current-update-id": u1.id }) })).status, 204, "already running it");
    assert.equal((await fetch(`${base}/ota/manifest`, { headers: expo({ "expo-runtime-version": "rv0" }) })).status, 204, "another native build");
    assert.equal((await fetch(`${base}/ota/manifest`, { headers: expo({ "expo-platform": "ios" }) })).status, 400);
    assert.equal((await fetch(`${base}/ota/manifest`, { headers: expo({ "expo-protocol-version": "0" }) })).status, 400);
    assert.equal((await fetch(`${base}/ota/assets/nope`)).status, 404);
    assert.equal((await fetch(`${base}/ota/assets/..%2Fupdate.json`)).status, 404);
    assert.equal((await fetch(`${base}/ota/manifest`, { method: "POST" })).status, 405);

    // A new export replaces update.json; the next request serves it without a restart.
    await new Promise((r) => setTimeout(r, 20));
    const u2 = publish(dir, "22222222-2222-5222-8222-222222222222", "rv1", "console.log('B')", "0.1.52");
    assert.deepEqual(ota.info(), { id: u2.id, runtimeVersion: "rv1", createdAt: u2.createdAt, version: "0.1.52" });
    const res2 = await fetch(`${base}/ota/manifest`, { headers: expo({ "expo-current-update-id": u1.id }) });
    assert.equal(JSON.parse(parts(res2.headers.get("content-type")!, await res2.text())[0]!.body).id, u2.id);
    assert.equal((await fetch(`${base}/ota/assets/${launch.key}`)).status, 404, "assets of a replaced update are gone");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true });
  }
});
