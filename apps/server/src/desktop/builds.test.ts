import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { DesktopAppInfo, DesktopUpdateManifest, DesktopUpdateResponse } from "@maru/shared";
import { DesktopBuilds, parseByteRange } from "./builds.ts";

async function serve(builds: DesktopBuilds) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://local");
    if (!builds.handle(req, res, url)) res.writeHead(418).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

test("desktop builds: the signed manifest as written, listed files only, and nothing without a build", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-builds-"));
  const builds = new DesktopBuilds(dir);
  const s = await serve(builds);
  try {
    assert.deepEqual((await (await fetch(`${s.base}/api/desktop/app`)).json()) as DesktopAppInfo, { build: null });
    assert.equal((await fetch(`${s.base}/api/desktop/update`)).status, 404);
    assert.equal((await fetch(`${s.base}/elsewhere`)).status, 418, "other paths are not its own");

    const zip = Buffer.from("zip bytes");
    fs.writeFileSync(path.join(dir, "maru-0.1.9-mac-arm64.zip"), zip);
    fs.writeFileSync(path.join(dir, "secret.txt"), "not listed");
    const manifest: DesktopUpdateManifest = {
      format: 1, type: "maru-desktop-update", version: "0.1.9", fingerprint: "v1-abc", builtAt: "2026-11-16T00:00:00.000Z",
      artifacts: [{ file: "maru-0.1.9-mac-arm64.zip", platform: "darwin", arch: "arm64", format: "zip", size: zip.length, sha256: "00" }],
    };
    // Written with its own spacing: the bytes go out as they are, since the signature covers them.
    const text = JSON.stringify(manifest, null, 1) + "\n";
    fs.writeFileSync(path.join(dir, "manifest.json"), text);
    fs.writeFileSync(path.join(dir, "manifest.json.sig"), "c2lnbmF0dXJl\n");

    const info = (await (await fetch(`${s.base}/api/desktop/app`)).json()) as DesktopAppInfo;
    assert.equal(info.build?.version, "0.1.9");
    assert.equal(info.build?.artifacts.length, 1);
    const update = (await (await fetch(`${s.base}/api/desktop/update`)).json()) as DesktopUpdateResponse;
    assert.equal(update.manifest, text);
    assert.equal(update.signature, "c2lnbmF0dXJl");

    const dl = await fetch(`${s.base}/api/desktop/download/maru-0.1.9-mac-arm64.zip`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get("content-type"), "application/zip");
    assert.match(dl.headers.get("content-disposition")!, /attachment; filename="maru-0.1.9-mac-arm64.zip"/);
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), zip);
    for (const name of ["secret.txt", "manifest.json", "manifest.json.sig", "..%2Fsecret.txt", "%2E%2E"]) {
      assert.equal((await fetch(`${s.base}/api/desktop/download/${name}`)).status, 404, name);
    }
    assert.equal((await fetch(`${s.base}/api/desktop/download/maru-0.1.9-mac-arm64.zip`, { method: "POST" })).status, 404);

    // Resuming: a byte range answers 206 with only those bytes, an If-Range of another build's
    // ETag gets the whole file, and a range past the end is 416.
    const url = `${s.base}/api/desktop/download/maru-0.1.9-mac-arm64.zip`;
    assert.equal(dl.headers.get("accept-ranges"), "bytes");
    assert.equal(dl.headers.get("etag"), '"00"');
    const part = await fetch(url, { headers: { range: "bytes=4-", "if-range": '"00"' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 4-${zip.length - 1}/${zip.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), zip.subarray(4));
    const other = await fetch(url, { headers: { range: "bytes=4-", "if-range": '"ff"' } });
    assert.equal(other.status, 200);
    assert.deepEqual(Buffer.from(await other.arrayBuffer()), zip);
    const past = await fetch(url, { headers: { range: `bytes=${zip.length}-` } });
    assert.equal(past.status, 416);
    assert.equal(past.headers.get("content-range"), `bytes */${zip.length}`);

    // A listed file that is gone, and a new manifest picked up without a restart.
    fs.rmSync(path.join(dir, "maru-0.1.9-mac-arm64.zip"));
    assert.equal((await fetch(`${s.base}/api/desktop/download/maru-0.1.9-mac-arm64.zip`)).status, 404);
    const next = { ...manifest, version: "0.1.10" };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(next));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, "manifest.json"), later, later);
    assert.equal(((await (await fetch(`${s.base}/api/desktop/app`)).json()) as DesktopAppInfo).build?.version, "0.1.10");
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test("desktop builds: the block map a manifest lists is served like the file, one it does not list is not", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-builds-map-"));
  const s = await serve(new DesktopBuilds(dir));
  try {
    const map = Buffer.from("block map bytes");
    fs.writeFileSync(path.join(dir, "maru-0.1.9-mac-arm64.zip"), "zip");
    fs.writeFileSync(path.join(dir, "maru-0.1.9-mac-arm64.zip.blockmap"), map);
    fs.writeFileSync(path.join(dir, "stray.blockmap"), "not listed");
    const manifest: DesktopUpdateManifest = {
      format: 1, type: "maru-desktop-update", version: "0.1.9", fingerprint: "v1-abc", builtAt: "x",
      artifacts: [{ file: "maru-0.1.9-mac-arm64.zip", platform: "darwin", arch: "arm64", format: "zip", size: 3, sha256: "00",
        blockmap: { file: "maru-0.1.9-mac-arm64.zip.blockmap", size: map.length, sha256: "11" } }],
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, "manifest.json.sig"), "c2ln");
    const url = `${s.base}/api/desktop/download/maru-0.1.9-mac-arm64.zip.blockmap`;
    const whole = await fetch(url);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("etag"), '"11"', "the block map's own SHA-256, not the file's");
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), map);
    const part = await fetch(url, { headers: { range: "bytes=6-10", "if-range": '"11"' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), "map b");
    assert.equal((await fetch(`${s.base}/api/desktop/download/stray.blockmap`)).status, 404);
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test("byte ranges: one range clamped to the file, else the whole file or 416", () => {
  assert.equal(parseByteRange(undefined, 10), null);
  assert.deepEqual(parseByteRange("bytes=0-3", 10), { start: 0, end: 3 });
  assert.deepEqual(parseByteRange("bytes=4-", 10), { start: 4, end: 9 });
  assert.deepEqual(parseByteRange("bytes=8-100", 10), { start: 8, end: 9 });
  assert.deepEqual(parseByteRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange("bytes=-30", 10), { start: 0, end: 9 });
  assert.equal(parseByteRange("bytes=10-", 10), "unsatisfiable");
  assert.equal(parseByteRange("bytes=-0", 10), "unsatisfiable");
  assert.equal(parseByteRange("bytes=0-", 0), "unsatisfiable");
  for (const h of ["bytes=5-2", "bytes=0-1,4-5", "items=0-1", "bytes=-", "bytes=a-b"]) assert.equal(parseByteRange(h, 10), null, h);
});
