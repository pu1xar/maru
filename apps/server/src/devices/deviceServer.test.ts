import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { MobileApkLink, PairDeviceResponse, PairingOffer, ServerMessage } from "@maru/shared";
import { SessionIndex } from "../index/store.ts";
import { ProjectStore } from "../projects/store.ts";
import { ChosenStore } from "../state/chosen.ts";
import { VisibleIndex } from "../index/visible.ts";
import { createServer } from "../http/server.ts";
import { MobileApks } from "../mobile/apk.ts";
import { OtaUpdates } from "../mobile/ota.ts";
import { ApkLinks } from "../mobile/apkLinks.ts";
import { UpdateToken } from "../mobile/updateToken.ts";
import { createDeviceServer } from "./deviceServer.ts";
import { PairingHub } from "./pairing.ts";
import { DeviceStore } from "./store.ts";
import { newSecret } from "./secrets.ts";
import { normalizeShortCode, shortCodeCredential } from "@maru/shared";

async function rig(extra: { transcriptRoots?: readonly string[]; shells?: Parameters<typeof createServer>[0]["shells"]; rewind?: Parameters<typeof createServer>[0]["rewind"]; fork?: Parameters<typeof createServer>[0]["fork"]; search?: Parameters<typeof createServer>[0]["search"] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "device-server-"));
  const projects = new ProjectStore(":memory:");
  const chosen = new ChosenStore(":memory:");
  const view = new VisibleIndex(new SessionIndex((s) => s), chosen);
  const store = new DeviceStore(":memory:");
  const pairing = new PairingHub(store);
  const ota = new OtaUpdates(path.join(dir, "dist-ota"));
  const apks = new MobileApks(path.join(dir, "mobile"));
  const updateSecret = newSecret("update");
  fs.writeFileSync(path.join(dir, "update-token"), `${updateSecret}\n`);
  const updateToken = new UpdateToken(path.join(dir, "update-token"));
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  let pushOn = false;
  const pushServer = () => pushOn;
  const devicesDeps = { store, pairing, apks, ota, deviceUrl: null as string | null, devicePort: null as number | null, pushServer };
  const webDir = path.join(dir, "web");
  fs.mkdirSync(webDir);
  fs.writeFileSync(path.join(webDir, "index.html"), "<!doctype html><title>maru</title>");
  const web = createServer({ view, projects, chosen, guard, webDir, devices: devicesDeps, ...extra });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", () => r()));
  const webPort = (web.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${webPort}`);
  const deviceHosts = new Set<string>();
  const logs: string[] = [];
  let clock = 1_000_000;
  const apkLinks = new ApkLinks({ now: () => clock });
  const dev = createDeviceServer({ store, pairing, ota, updateToken, apks, apkLinks, main: web, hosts: deviceHosts, pushServer, log: (l) => logs.push(l) });
  await new Promise<void>((r) => dev.listen(0, "127.0.0.1", () => r()));
  const devPort = (dev.address() as AddressInfo).port;
  deviceHosts.add(`127.0.0.1:${devPort}`);
  devicesDeps.devicePort = devPort;
  const close = async () => {
    web.closeAllConnections();
    dev.closeAllConnections();
    await new Promise((r) => web.close(r));
    await new Promise((r) => dev.close(r));
    fs.rmSync(dir, { recursive: true });
  };
  return {
    web: `http://127.0.0.1:${webPort}`, dev: `http://127.0.0.1:${devPort}`, devPort, store, pairing, close, logs, updateSecret, dir,
    devServer: dev, advance: (ms: number) => { clock += ms; },
    /** Puts a fake built APK in the rig's mobile/apk folder, as build-apk.sh would. */
    publishApk: (file: string, bytes: Buffer) => {
      const apkDir = path.join(dir, "mobile", "apk");
      fs.mkdirSync(apkDir, { recursive: true });
      fs.writeFileSync(path.join(apkDir, file), bytes);
      fs.writeFileSync(path.join(apkDir, "latest.json"), JSON.stringify({ file, runtimeVersion: "r".repeat(40), size: bytes.length, sha256: "0".repeat(64), builtAt: "2026-11-18T00:00:00.000Z", updatesUrl: "https://x/ota/manifest", version: "0.1.999" }));
    },
    setPush: (on: boolean) => { pushOn = on; },
  };
}

/** Opens the web pairing stream and resolves with the first offer; `events` collects the rest. */
function openPairing(webBase: string, query = ""): Promise<{ offer: PairingOffer; events: string[]; ended: Promise<void>; abort(): void }> {
  return new Promise((resolve, reject) => {
    const events: string[] = [];
    const req = http.get(`${webBase}/api/devices/pairing${query}`, (res) => {
      assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
      let buf = "";
      const ended = new Promise<void>((r) => res.on("end", () => r()).on("close", () => r()));
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!name || !data) continue;
          events.push(`${name} ${data}`);
          if (name === "code") resolve({ offer: JSON.parse(data) as PairingOffer, events, ended, abort: () => req.destroy() });
        }
      });
    });
    req.on("error", reject);
  });
}

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

async function claim(dev: string, link: string, name = "Pixel test", extra: Record<string, unknown> = {}): Promise<Response> {
  const code = new URL(link.replace("maru://", "http://x/")).searchParams.get("code")!;
  return claimWith(dev, code, { name, ...extra });
}

function claimWith(dev: string, credential: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${dev}/api/device/pair`, {
    method: "POST", headers: { ...bearer(credential), "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

/** A GET with a header Node's fetch would not let us set (Origin). */
function getStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    }).on("error", reject);
  });
}

test("pairing through the web stream: the code works once and the stream reports the claim", async () => {
  const r = await rig();
  try {
    const p = await openPairing(r.web);
    assert.equal(p.offer.server, `http://127.0.0.1:${r.devPort}`, "a loopback page pairs against the device port");
    assert.match(p.offer.link, /^maru:\/\/pair\?server=http%3A%2F%2F127\.0\.0\.1%3A\d+&code=maru_p_/);
    const res = await claim(r.dev, p.offer.link);
    assert.equal(res.status, 200);
    const body = (await res.json()) as PairDeviceResponse;
    assert.match(body.token, /^maru_d_/);
    assert.deepEqual(Object.keys(body).sort(), ["device", "token"]);
    assert.equal(body.device.name, "Pixel test");
    assert.equal(body.device.kind, "android");
    assert.equal(p.offer.kind, "android");
    assert.equal(p.offer.shortCode, undefined);
    await p.ended;
    assert.equal(p.events.length, 2);
    assert.match(p.events[1]!, /^claimed \{"device":\{"id":"/);
    assert.equal((await claim(r.dev, p.offer.link)).status, 401, "a used code is refused");
    const list = await (await fetch(`${r.web}/api/devices`)).json();
    assert.deepEqual(list.devices.map((d: { id: string }) => d.id), [body.device.id]);
  } finally {
    await r.close();
  }
});

test("closing the dialog's stream ends the code", async () => {
  const r = await rig();
  try {
    const p = await openPairing(r.web);
    assert.equal(r.pairing.openCount(), 1);
    p.abort();
    while (r.pairing.openCount() > 0) await new Promise((x) => setTimeout(x, 10));
    assert.equal((await claim(r.dev, p.offer.link)).status, 401);
    assert.equal(r.store.list().length, 0);
  } finally {
    await r.close();
  }
});

test("the device listener checks every request and serves only the device routes", async () => {
  const r = await rig();
  try {
    const { token, device } = r.store.create("phone");
    const updateToken = r.updateSecret;
    const me = await fetch(`${r.dev}/api/device/me`, { headers: bearer(token) });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).device.id, device.id);
    assert.ok(r.store.get(device.id)?.lastUsedAt, "a request records its use");

    // No token, a wrong one, a pairing code, the update token, the web listener's lack of a guard.
    for (const headers of [{}, bearer(newSecret("device")), bearer(newSecret("pairing")), bearer(updateToken), { authorization: token }]) {
      const res = await fetch(`${r.dev}/api/device/me`, { headers });
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.equal(res.headers.get("www-authenticate"), "Bearer");
    }
    assert.equal((await fetch(`${r.dev}/api/sessions`)).status, 401);
    assert.equal((await fetch(`${r.dev}/api/sessions`, { headers: bearer(token) })).status, 200);
    // Device management and Mac-only routes stay on the web listener.
    for (const p of [
      "/api/devices", "/api/devices/pairing", "/api/mobile/apk", "/api/pick-folder", "/api/file?path=/etc/hosts",
      "/api/file/raw?path=/etc/hosts", "/api/file/tree?root=/etc&dir=", "/",
    ]) {
      assert.equal((await fetch(`${r.dev}${p}`, { headers: bearer(token) })).status, 404, p);
    }
    const pick = await fetch(`${r.dev}/api/pick-folder`, { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: "{}" });
    assert.equal(pick.status, 404);
    // The build's update token reaches the OTA routes only (no update in this rig: 204); a device
    // token, a wrong update token and no token do not.
    const otaHeaders = { ...bearer(updateToken), "expo-platform": "android", "expo-protocol-version": "1", "expo-runtime-version": "x" };
    assert.equal((await fetch(`${r.dev}/ota/manifest`, { headers: otaHeaders })).status, 204);
    for (const auth of [bearer(token), bearer(newSecret("update")), { authorization: "Bearer maru_unpaired" }, {}]) {
      assert.equal((await fetch(`${r.dev}/ota/manifest`, { headers: { ...otaHeaders, authorization: "", ...auth } })).status, 401, JSON.stringify(auth));
    }
    assert.equal((await fetch(`${r.dev}/ota/assets/abc`, { headers: bearer(token) })).status, 401);
    // Without the token file, /ota refuses everything.
    fs.rmSync(path.join(r.dir, "update-token"));
    assert.equal((await fetch(`${r.dev}/ota/manifest`, { headers: otaHeaders })).status, 401);
    // A Host this listener does not serve.
    const foreign = await new Promise<number>((resolve) => {
      http.get(`${r.dev}/api/device/me`, { headers: { ...bearer(token), host: "evil.example" } }, (res) => resolve(res.statusCode!)).end();
    });
    assert.equal(foreign, 403);
  } finally {
    await r.close();
  }
});

test("WebSocket: a device token opens /ws; removing the device closes it and refuses the token", async () => {
  const r = await rig();
  try {
    const { token, device } = r.store.create("phone");
    const updateToken = r.updateSecret;
    const wsUrl = `ws://127.0.0.1:${r.devPort}/ws`;
    const refused = async (headers: Record<string, string>) => {
      const ws = new WebSocket(wsUrl, { headers });
      return new Promise<number>((resolve) => ws.on("unexpected-response", (_q, res) => resolve(res.statusCode!)).on("error", () => resolve(-1)));
    };
    assert.equal(await refused({}), 401);
    assert.equal(await refused(bearer(updateToken)), 401);
    assert.equal(await refused(bearer(newSecret("device"))), 401);

    const ws = new WebSocket(wsUrl, { headers: bearer(token) });
    const first = await new Promise<ServerMessage>((resolve) => ws.once("message", (d) => resolve(JSON.parse(String(d)))));
    assert.equal(first.type, "hello");
    const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));

    const del = await fetch(`${r.web}/api/devices/${device.id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    await closed;
    assert.ok(r.logs.some((l) => l.includes("closed 1 WebSocket")));
    assert.equal(await refused(bearer(token)), 401);
    assert.equal((await fetch(`${r.dev}/api/device/me`, { headers: bearer(token) })).status, 401);
    assert.equal((await fetch(`${r.web}/api/devices/${device.id}`, { method: "DELETE" })).status, 404);
  } finally {
    await r.close();
  }
});

test("a device can unpair itself but no other device", async () => {
  const r = await rig();
  try {
    const a = r.store.create("a");
    const b = r.store.create("b");
    assert.equal((await fetch(`${r.dev}/api/devices/${b.device.id}`, { method: "DELETE", headers: bearer(a.token) })).status, 404);
    assert.equal((await fetch(`${r.dev}/api/device/me`, { method: "DELETE", headers: bearer(a.token) })).status, 200);
    assert.deepEqual(r.store.list().map((d) => d.id), [b.device.id]);
  } finally {
    await r.close();
  }
});

test("push registration: a device sets and clears its own FCM token; a malformed body is refused", async () => {
  const r = await rig();
  try {
    const a = r.store.create("phone");
    const b = r.store.create("tablet");
    const put = (token: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
      fetch(`${r.dev}/api/device/push`, { method: "PUT", headers: { ...bearer(token), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const fcmToken = `cXyZ:APA91b${"x".repeat(140)}`;
    const ok = await put(a.token, { token: fcmToken });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    assert.equal(r.store.pushTokenOf(a.device.id), fcmToken);
    assert.equal(r.store.pushTokenOf(b.device.id), null, "only the caller's row");
    assert.ok(r.logs.includes(`devices: ${a.device.id} registered push token cXyZ:APA...`));
    assert.ok(!r.logs.some((l) => l.includes(fcmToken)), "the full token stays out of the log");

    for (const bad of [{}, { token: "" }, { token: " " }, { token: "a b" }, { token: 42 }, { token: null }, [], null]) {
      assert.equal((await put(a.token, bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await put(a.token, "{")).status, 400, "not JSON");
    assert.equal((await put(a.token, { token: "t" }, { "content-type": "text/plain" })).status, 415);
    assert.equal((await put(newSecret("device"), { token: "t" })).status, 401);
    assert.equal((await put(r.updateSecret, { token: "t" })).status, 401);
    // Not on the web listener: Google sign-in is no device.
    assert.equal((await fetch(`${r.web}/api/device/push`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
    assert.equal(r.store.pushTokenOf(a.device.id), fcmToken, "refused requests changed nothing");

    const del = await fetch(`${r.dev}/api/device/push`, { method: "DELETE", headers: bearer(a.token) });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { ok: true });
    assert.equal(r.store.pushTokenOf(a.device.id), null);
    assert.equal((await fetch(`${r.dev}/api/device/push`, { headers: bearer(a.token) })).status, 404, "no GET");

    // Unpairing takes the token along.
    await put(a.token, { token: fcmToken });
    await fetch(`${r.dev}/api/device/me`, { method: "DELETE", headers: bearer(a.token) });
    assert.deepEqual(r.store.pushTargets(), []);
  } finally {
    await r.close();
  }
});

test("app info says whether this server can push, on the device and the web listener", async () => {
  const r = await rig();
  try {
    const { token } = r.store.create("phone");
    const read = async () => [
      (await (await fetch(`${r.dev}/api/device/app`, { headers: bearer(token) })).json()).push,
      (await (await fetch(`${r.web}/api/mobile/app`)).json()).push,
    ];
    assert.deepEqual(await read(), [{ server: false }, { server: false }]);
    r.setPush(true);
    assert.deepEqual(await read(), [{ server: true }, { server: true }]);
  } finally {
    await r.close();
  }
});

test("hasOpenWs: true while the device has any /ws open, per device", async () => {
  const r = await rig();
  try {
    const a = r.store.create("phone");
    const b = r.store.create("tablet");
    assert.equal(r.devServer.hasOpenWs(a.device.id), false);
    const open = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${r.devPort}/ws`, { headers: bearer(a.token) });
      await new Promise<void>((resolve) => ws.once("message", () => resolve()));
      return ws;
    };
    const closeAndWait = async (ws: WebSocket) => {
      const done = new Promise<void>((resolve) => ws.once("close", () => resolve()));
      ws.close();
      await done;
      // The server's socket closes right after the closing handshake the client just saw.
      await new Promise((x) => setTimeout(x, 50));
    };
    const first = await open();
    const second = await open();
    assert.equal(r.devServer.hasOpenWs(a.device.id), true);
    assert.equal(r.devServer.hasOpenWs(b.device.id), false);
    await closeAndWait(first);
    assert.equal(r.devServer.hasOpenWs(a.device.id), true, "the other socket is still open");
    await closeAndWait(second);
    assert.equal(r.devServer.hasOpenWs(a.device.id), false, "the app went to the background");
  } finally {
    await r.close();
  }
});

test("desktop pairing: the code fixes the kind, a phone is turned away, and the short form claims it", async () => {
  const r = await rig();
  try {
    const p = await openPairing(r.web, "?kind=desktop");
    assert.equal(p.offer.kind, "desktop");
    assert.match(p.offer.shortCode!, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    // The Android app (no kind in its request) is told what the code is for; the code stays open.
    const phone = await claim(r.dev, p.offer.link, "Pixel");
    assert.equal(phone.status, 409);
    assert.match((await phone.json()).error, /connecting the desktop app/);
    assert.equal(r.pairing.openCount(), 1);
    const typed = shortCodeCredential(normalizeShortCode(p.offer.shortCode!.toLowerCase())!);
    const res = await claimWith(r.dev, typed, { name: "work laptop", kind: "desktop" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as PairDeviceResponse;
    assert.equal(body.device.kind, "desktop");
    await p.ended;
    assert.equal((await claim(r.dev, p.offer.link, "again", { kind: "desktop" })).status, 401, "the long form ended with the short one");
    // A phone code refuses a desktop app the same way.
    const q = await openPairing(r.web);
    assert.equal((await claim(r.dev, q.offer.link, "mac", { kind: "desktop" })).status, 409);
    q.abort();
  } finally {
    await r.close();
  }
});

test("an android token reaches the conversation search and nothing else of the search family", async () => {
  const searched: string[] = [];
  const search = {
    search: async (q: string) => {
      searched.push(q);
      return { query: q, hits: [], sessions: [], total: 0, offset: 0, searchedSessions: 0, searchedTexts: 0, unlistedFiles: 0, refreshMs: 0, searchMs: 0 };
    },
  };
  const r = await rig({ search });
  try {
    const phone = r.store.create("phone");
    assert.equal((await fetch(`${r.dev}/api/search?q=abc`)).status, 401, "no token");
    assert.equal((await fetch(`${r.dev}/api/search?q=abc`, { headers: bearer(phone.token) })).status, 200);
    assert.deepEqual(searched, ["abc"]);
    assert.equal((await fetch(`${r.dev}/api/search?q=abc`, { method: "POST", headers: bearer(phone.token) })).status, 404, "GET only");
  } finally {
    await r.close();
  }
});

test("a phone token reaches the session management's routes and the web's own checks answer; the sidebar's arrangement routes stay closed", async () => {
  const r = await rig();
  try {
    const phone = r.store.create("phone");
    const h = { ...bearer(phone.token), "content-type": "application/json" };
    const put = (p: string) => fetch(`${r.dev}${p}`, { method: "PUT", headers: h, body: "{}" });
    // The handler answers (its own validation, 400), not the listener's 404.
    assert.equal((await put("/api/session-chosen")).status, 400);
    assert.equal((await fetch(`${r.dev}/api/session-chosen`, { method: "PUT", body: "{}", headers: { "content-type": "application/json" } })).status, 401, "no token");
    assert.equal((await fetch(`${r.dev}/api/session-candidates?q=a`, { headers: bearer(phone.token) })).status, 200);
    // Pin, archive and project moves are the sidebar's, not the session table's.
    for (const p of ["/api/session-pin", "/api/session-pins", "/api/session-archive", "/api/session-project", "/api/session-order"]) assert.equal((await put(p)).status, 404, p);
  } finally {
    await r.close();
  }
});

test("a phone token reads a picture file's bytes through GET /api/file/raw and no other file", async () => {
  const r = await rig();
  try {
    const phone = r.store.create("phone");
    const h = bearer(phone.token);
    const png = path.join(r.dir, "pic.png");
    const svg = path.join(r.dir, "vec.svg");
    const txt = path.join(r.dir, "note.txt");
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    fs.writeFileSync(svg, "<svg xmlns='http://www.w3.org/2000/svg'/>");
    fs.writeFileSync(txt, "text");
    const raw = (p: string, headers: Record<string, string> = h) => fetch(`${r.dev}/api/file/raw?path=${encodeURIComponent(p)}`, { headers });
    const ok = await raw(png);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.equal(ok.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const vec = await raw(svg);
    assert.equal(vec.status, 200);
    assert.equal(vec.headers.get("content-security-policy"), "sandbox");
    assert.equal((await raw(path.join(r.dir, "gone.png"))).status, 404, "the web's own answer for a missing file");
    // No token, other file types, and the file routes that read text or folders.
    assert.equal((await raw(png, {})).status, 401);
    assert.equal((await raw(txt)).status, 404);
    for (const route of [`/api/file?path=${encodeURIComponent(png)}`, `/api/file/tree?root=${encodeURIComponent(r.dir)}&dir=`]) {
      assert.equal((await fetch(`${r.dev}${route}`, { headers: h })).status, 404, route);
    }
    // The blob route passes to the web's handler, whose own checks refuse a file that is no transcript.
    const notTranscript = await fetch(`${r.dev}/api/file/blob?path=${encodeURIComponent(png)}&offset=0&pointer=${encodeURIComponent("$.a.data")}`, { headers: h });
    assert.equal(notTranscript.status, 403);
    // The web's browser rule still runs behind the device listener: another site's page is refused.
    assert.equal((await raw(png, { ...h, "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await raw(png, { ...h, "sec-fetch-site": "same-origin" })).status, 200);
  } finally {
    await r.close();
  }
});

test("a phone token reads the picture a tool result carries through GET /api/file/blob and only that", async () => {
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "device-blob-"));
  const r = await rig({ transcriptRoots: [projects] });
  try {
    const phone = r.store.create("phone");
    const h = bearer(phone.token);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
    const line = JSON.stringify({ message: { content: [{ type: "tool_result", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } }] }] } });
    const transcript = path.join(projects, "t.jsonl");
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "user" })}\n${line}\n`);
    const offset = Buffer.byteLength(`${JSON.stringify({ type: "user" })}\n`);
    const blob = (p: string, o: number, pointer: string, headers: Record<string, string> = h) =>
      fetch(`${r.dev}/api/file/blob?${new URLSearchParams({ path: p, offset: String(o), pointer })}`, { headers });
    const data = "$.message.content[0].content[0].source.data";
    const ok = await blob(transcript, offset, data);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [...bytes]);
    assert.equal((await blob(transcript, offset, data, {})).status, 401, "no token");
    assert.equal((await blob(transcript, offset, "$.message.content[0].content[0].source.media_type")).status, 400, "only a data path");
    // A file outside the Claude projects folders is not read, whatever the extension.
    const outside = path.join(r.dir, "x.jsonl");
    fs.writeFileSync(outside, `${line}\n`);
    assert.equal((await blob(outside, 0, data)).status, 403);
    // Writes to the route stay closed to a phone.
    assert.equal((await fetch(`${r.dev}/api/file/blob?path=${encodeURIComponent(transcript)}`, { method: "POST", headers: h })).status, 404);
  } finally {
    await r.close();
    fs.rmSync(projects, { recursive: true });
  }
});

test("a desktop token reaches what the web listener serves except device management", async () => {
  const r = await rig();
  try {
    const desk = r.store.create("mac", Date.now(), "desktop");
    const phone = r.store.create("phone");
    const other = r.store.create("other");
    const h = bearer(desk.token);
    // The page itself, its API and file reads (the phone gets none of these).
    for (const [p, status] of [["/", 200], ["/healthz", 200], ["/api/sessions", 200], ["/api/session-candidates", 200], ["/api/mobile/app", 200]] as const) {
      assert.equal((await fetch(`${r.dev}${p}`, { headers: h })).status, status, p);
      // A phone gets the list, and the sessions outside it for its session management (ANDROID_MANAGE_ROUTES).
      assert.equal((await fetch(`${r.dev}${p}`, { headers: bearer(phone.token) })).status, p === "/api/sessions" || p === "/api/session-candidates" ? 200 : 404, `phone ${p}`);
    }
    const page = await fetch(`${r.dev}/settings`, { headers: h });
    assert.match(await page.text(), /<title>maru<\/title>/, "the SPA fallback serves the page");
    // A malformed escape is a bad request on both listeners, not a thrown handler.
    assert.equal((await fetch(`${r.dev}/%E0`, { headers: h })).status, 400);
    assert.equal((await fetch(`${r.web}/%E0`)).status, 400);
    assert.equal((await fetch(`${r.web}/healthz`)).status, 200, "the server is still up");
    const hosts = path.join(r.dir, "hosts.txt");
    fs.writeFileSync(hosts, "127.0.0.1 localhost\n");
    const file = await fetch(`${r.dev}/api/file?path=${encodeURIComponent(hosts)}`, { headers: h });
    assert.equal(file.status, 200);
    assert.equal((await fetch(`${r.dev}/api/file/raw?path=${encodeURIComponent(hosts)}`, { headers: h })).status, 200);
    // Device management stays behind Google sign-in.
    assert.equal((await fetch(`${r.dev}/api/devices`, { headers: h })).status, 404);
    assert.equal((await fetch(`${r.dev}/api/devices/pairing?kind=desktop`, { headers: h })).status, 404);
    assert.equal((await fetch(`${r.dev}/api/devices/${other.device.id}`, { method: "DELETE", headers: h })).status, 404);
    assert.equal(r.store.list().length, 3);
    assert.equal(r.pairing.openCount(), 0);
    // A write passes through with the web's own checks (no such project: the store's 404).
    const patch = await fetch(`${r.dev}/api/projects/nope`, { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: "{}" });
    assert.notEqual(patch.status, 401);
    // Browser rule: an Origin must be a page of the host asked.
    const url = `${r.dev}/api/sessions`;
    assert.equal(await getStatus(url, { ...h, origin: r.dev }), 200);
    for (const origin of ["null", "https://evil.example", `http://localhost:${r.devPort}`, `${r.dev}/x`]) {
      assert.equal(await getStatus(url, { ...h, origin }), 403, origin);
    }
    const ws = (origin?: string) => new Promise<number>((resolve) => {
      const s = new WebSocket(`ws://127.0.0.1:${r.devPort}/ws`, { headers: { ...h, ...(origin ? { origin } : {}) } });
      s.on("open", () => {
        s.close();
        resolve(101);
      });
      s.on("unexpected-response", (_q, res) => resolve(res.statusCode!));
      s.on("error", () => resolve(-1));
    });
    assert.equal(await ws(r.dev), 101);
    // A good token from a wrong page: known but refused.
    assert.equal(await ws("null"), 403);
    assert.equal(await ws("https://evil.example"), 403);
  } finally {
    await r.close();
  }
});

test("shell terminals: a desktop token and a phone token open /api/shells and the view socket, a stranger neither", async () => {
  const attached: string[] = [];
  const r = await rig({
    shells: {
      handle: async (_req, res, url, io) => {
        if (url.pathname !== "/api/shells") return false;
        io.sendJson(res, 200, { shells: [] });
        return true;
      },
      attach: (socket, query) => {
        attached.push(query.get("id") ?? "");
        socket.close(1000);
      },
    },
  });
  try {
    const desk = r.store.create("mac", Date.now(), "desktop");
    const phone = r.store.create("phone");
    const open = (token: string, origin?: string) => new Promise<number>((resolve) => {
      const s = new WebSocket(`ws://127.0.0.1:${r.devPort}/shell?id=sh-aaaaaaaaaaaa&cols=80&rows=24`, { headers: { ...bearer(token), ...(origin ? { origin } : {}) } });
      s.on("open", () => resolve(101));
      s.on("unexpected-response", (_q, res) => resolve(res.statusCode!));
      s.on("error", () => resolve(-1));
    });
    assert.equal(await open(desk.token, r.dev), 101);
    assert.deepEqual(attached, ["sh-aaaaaaaaaaaa"]);
    assert.equal(await open(desk.token, "https://evil.example"), 403);
    // React Native sends the socket's own host as the Origin, which the device listener's rule accepts.
    assert.equal(await open(phone.token, r.dev), 101, "the phone's token opens a shell view");
    assert.equal(await open(phone.token), 101, "a phone without an Origin header too");
    assert.equal(await open(phone.token, "https://evil.example"), 403);
    assert.equal(await open(newSecret("device")), 401);
    assert.deepEqual(attached, ["sh-aaaaaaaaaaaa", "sh-aaaaaaaaaaaa", "sh-aaaaaaaaaaaa"]);
    assert.equal((await fetch(`${r.dev}/api/shells`, { headers: bearer(desk.token) })).status, 200);
    assert.equal((await fetch(`${r.dev}/api/shells`, { headers: bearer(phone.token) })).status, 200);
    assert.equal((await fetch(`${r.dev}/api/shells`)).status, 401, "no token");
    // The web listener: the browser guard, as for /ws.
    const web = (origin?: string) => new Promise<number>((resolve) => {
      const s = new WebSocket(`${r.web.replace("http", "ws")}/shell?id=sh-aaaaaaaaaaaa&cols=80&rows=24`, origin ? { origin } : {});
      s.on("open", () => resolve(101));
      s.on("unexpected-response", (_q, res) => resolve(res.statusCode!));
      s.on("error", () => resolve(-1));
    });
    assert.equal(await web("https://evil.example"), 403);
  } finally {
    await r.close();
  }
});

test("the phone's token reaches the rewind and fork routes by method and exact path, nothing around them", async () => {
  const seen: string[] = [];
  const stub = (name: string, path: string[]) => ({
    async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
      if (!path.includes(url.pathname)) return false;
      seen.push(`${name} ${req.method} ${url.pathname}`);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return true;
    },
  });
  const r = await rig({ rewind: stub("rewind", ["/api/session-rewind", "/api/session-rewind/preview"]), fork: stub("fork", ["/api/session-fork"]) });
  try {
    const phone = r.store.create("phone");
    const h = { ...bearer(phone.token), "content-type": "application/json" };
    const status = async (method: string, p: string, headers: Record<string, string> = h) =>
      (await fetch(`${r.dev}${p}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) })).status;
    assert.equal(await status("GET", "/api/session-rewind?key=k"), 200);
    assert.equal(await status("GET", "/api/session-rewind/preview?key=k&id=i"), 200);
    assert.equal(await status("POST", "/api/session-rewind"), 200);
    assert.equal(await status("POST", "/api/session-fork"), 200);
    assert.deepEqual(seen, [
      "rewind GET /api/session-rewind", "rewind GET /api/session-rewind/preview", "rewind POST /api/session-rewind", "fork POST /api/session-fork",
    ]);
    // Other methods and neighbouring paths stay closed.
    for (const [m, p] of [["GET", "/api/session-fork"], ["POST", "/api/session-rewind/preview"], ["DELETE", "/api/session-rewind"], ["PUT", "/api/session-fork"], ["POST", "/api/session-rewind/x"], ["POST", "/api/session-fork/x"], ["POST", "/api/session-name"]] as const) {
      assert.equal(await status(m, p), 404, `${m} ${p}`);
    }
    assert.equal(seen.length, 4, "the closed ones never reached a handler");
    // A token is required, and the wrong kind of secret is not one.
    for (const headers of [{ "content-type": "application/json" }, { ...bearer(newSecret("pairing")), "content-type": "application/json" }]) {
      assert.equal(await status("POST", "/api/session-rewind", headers), 401);
      assert.equal(await status("POST", "/api/session-fork", headers), 401);
    }
    assert.equal(seen.length, 4);
  } finally {
    await r.close();
  }
});

test("one-time APK link: a phone asks with its token, the link downloads the file once with no token, then 404", async () => {
  const r = await rig();
  try {
    const { token } = r.store.create("phone");
    const bytes = crypto.randomBytes(5000);
    // No built APK yet.
    assert.equal((await fetch(`${r.dev}/api/device/apk-link`, { method: "POST", headers: bearer(token) })).status, 404);
    r.publishApk("maru-0.1.999-rrrrrrrrrrrr.apk", bytes);
    // The token is required, and a GET of the issuing route is no route.
    assert.equal((await fetch(`${r.dev}/api/device/apk-link`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${r.dev}/api/device/apk-link`, { headers: bearer(token) })).status, 404);
    const res = await fetch(`${r.dev}/api/device/apk-link`, { method: "POST", headers: bearer(token) });
    assert.equal(res.status, 200);
    const link = (await res.json()) as MobileApkLink;
    assert.equal(link.expiresInSec, 120);
    assert.equal(link.file, "maru-0.1.999-rrrrrrrrrrrr.apk");
    assert.equal(link.size, 5000);
    assert.equal(link.version, "0.1.999");
    assert.ok(link.url.startsWith(`${r.dev}/dl/apk/`), link.url);
    assert.match(link.url, /\/dl\/apk\/[A-Za-z0-9_-]{43}$/);
    // A HEAD does not spend it; the GET downloads the bytes with no Authorization header.
    assert.equal((await fetch(link.url, { method: "HEAD" })).status, 405);
    const got = await fetch(link.url);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "application/vnd.android.package-archive");
    assert.equal(got.headers.get("content-disposition"), 'attachment; filename="maru-0.1.999-rrrrrrrrrrrr.apk"');
    assert.equal(got.headers.get("content-length"), "5000");
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);
    // Used: the same URL is refused now, and with a device token it still is.
    assert.equal((await fetch(link.url)).status, 404);
    assert.equal((await fetch(link.url, { headers: bearer(token) })).status, 404);
  } finally {
    await r.close();
  }
});

test("one-time APK link: it expires after 120 s, dies with its device, and a guessed or odd path gives nothing", async () => {
  const r = await rig();
  try {
    const a = r.store.create("a");
    const b = r.store.create("b");
    r.publishApk("maru-1.apk", Buffer.from("apk-bytes"));
    const ask = async (token: string) => ((await (await fetch(`${r.dev}/api/device/apk-link`, { method: "POST", headers: bearer(token) })).json()) as MobileApkLink).url;
    const expired = await ask(a.token);
    r.advance(119_000);
    const fresh = await ask(a.token);
    r.advance(2_000);
    assert.equal((await fetch(expired)).status, 404, "121 s old");
    assert.equal(await (await fetch(fresh)).text(), "apk-bytes", "2 s old");
    // Removing the device kills the links it asked for; another device's link stays.
    const mine = await ask(a.token);
    const theirs = await ask(b.token);
    r.store.remove(a.device.id);
    assert.equal((await fetch(mine)).status, 404);
    assert.equal((await fetch(theirs)).status, 200);
    // Other paths under /dl and malformed tokens never reach a file.
    for (const p of ["/dl/apk/", "/dl/apk/short", `/dl/apk/${"A".repeat(43)}`, `/dl/apk/${"A".repeat(43)}/x`, `/dl/apk/${"A".repeat(44)}`]) {
      assert.equal((await fetch(`${r.dev}${p}`)).status, 404, p);
    }
    for (const p of ["/dl/apk", "/dl/", "/dl/other"]) assert.equal((await fetch(`${r.dev}${p}`)).status, 401, p);
  } finally {
    await r.close();
  }
});

test("one-time APK link: the file is the one the link was issued for, and a missing file is a 404", async () => {
  const r = await rig();
  try {
    const { token } = r.store.create("phone");
    r.publishApk("maru-old.apk", Buffer.from("old"));
    const url = ((await (await fetch(`${r.dev}/api/device/apk-link`, { method: "POST", headers: bearer(token) })).json()) as MobileApkLink).url;
    r.publishApk("maru-new.apk", Buffer.from("new"));
    assert.equal(await (await fetch(url)).text(), "old");
    const gone = ((await (await fetch(`${r.dev}/api/device/apk-link`, { method: "POST", headers: bearer(token) })).json()) as MobileApkLink).url;
    fs.rmSync(path.join(r.dir, "mobile", "apk", "maru-new.apk"));
    assert.equal((await fetch(gone)).status, 404);
    // The web listener's signed-in download is unchanged, and a device token cannot use it.
    r.publishApk("maru-new.apk", Buffer.from("new"));
    assert.equal(await (await fetch(`${r.web}/api/mobile/apk`)).text(), "new");
    assert.equal((await fetch(`${r.dev}/api/mobile/apk`, { headers: bearer(token) })).status, 404);
  } finally {
    await r.close();
  }
});
