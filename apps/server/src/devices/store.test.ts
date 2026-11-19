import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bearerOf, hashSecret, newSecret, secretKind } from "./secrets.ts";
import { DeviceStore } from "./store.ts";
import { PairingHub } from "./pairing.ts";
import { SHORT_CODE_LENGTH, formatShortCode, normalizeShortCode, shortCodeCredential } from "@maru/shared";

test("secrets: 256-bit values behind a kind prefix, and only well-formed ones have a kind", () => {
  const d = newSecret("device");
  assert.match(d, /^maru_d_[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(d.slice(7), "base64url").length, 32);
  assert.equal(secretKind(d), "device");
  assert.equal(secretKind(newSecret("update")), "update");
  assert.equal(secretKind(newSecret("pairing")), "pairing");
  assert.notEqual(newSecret("device"), newSecret("device"));
  for (const bad of ["", "maru_unpaired", "maru_d_short", `maru_x_${"a".repeat(43)}`, `${d}x`, ` ${d}`]) {
    assert.equal(secretKind(bad), null, bad);
  }
  assert.equal(hashSecret(d).length, 64);
});

test("bearerOf reads only an Authorization Bearer credential", () => {
  const req = (authorization?: string) => ({ headers: authorization === undefined ? {} : { authorization } }) as IncomingMessage;
  assert.equal(bearerOf(req("Bearer abc")), "abc");
  assert.equal(bearerOf(req("bearer  abc")), "abc");
  assert.equal(bearerOf(req("Basic abc")), null);
  assert.equal(bearerOf(req("Bearer a b")), null);
  assert.equal(bearerOf(req()), null);
});

test("store: a token authenticates its device; the file holds only hashes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devices-"));
  const file = path.join(dir, "state.sqlite");
  const store = new DeviceStore(file);
  const a = store.create("Pixel 9", 1000);
  const b = store.create("  tab\u0007let  ", 2000);
  assert.equal(b.device.name, "tab let");
  assert.equal(store.create("   ", 3000).device.name, "Unnamed device");

  assert.deepEqual(store.authenticate(a.token), { device: a.device });
  assert.equal(store.authenticate(b.token)?.device.id, b.device.id);
  // A pairing or update secret, an unknown token, or a token's hash is no device credential.
  assert.equal(store.authenticate(newSecret("device")), null);
  assert.equal(store.authenticate(newSecret("pairing")), null);
  assert.equal(store.authenticate(newSecret("update")), null);
  assert.equal(store.authenticate(hashSecret(a.token)), null);

  assert.deepEqual(store.list().map((d) => d.id), [store.list()[0]!.id, b.device.id, a.device.id]);
  store.touch(a.device.id, 5000);
  assert.equal(store.get(a.device.id)?.lastUsedAt, 5000);

  const removed: string[] = [];
  store.onRemoved((id) => removed.push(id));
  assert.equal(store.remove(a.device.id), true);
  assert.equal(store.remove(a.device.id), false);
  assert.deepEqual(removed, [a.device.id]);
  assert.equal(store.authenticate(a.token), null);
  store.close();

  const raw = new DatabaseSync(file);
  const rows = raw.prepare("SELECT * FROM devices").all();
  raw.close();
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes(b.token), "plain tokens must not be stored");
  assert.ok(dump.includes(hashSecret(b.token)));
  fs.rmSync(dir, { recursive: true });
});

test("push tokens: one per device, one device per token, gone with the device", () => {
  const store = new DeviceStore(":memory:");
  const a = store.create("old pairing of the phone", 1000).device;
  const b = store.create("tablet", 2000).device;
  assert.deepEqual(store.pushTargets(), []);
  assert.equal(store.setPushToken(a.id, "fcm-phone"), true);
  assert.equal(store.setPushToken(b.id, "fcm-tablet"), true);
  assert.deepEqual(store.pushTargets(), [{ deviceId: a.id, token: "fcm-phone" }, { deviceId: b.id, token: "fcm-tablet" }]);
  assert.equal(store.setPushToken(b.id, "fcm-tablet-2"), true, "a new token replaces the old one");
  assert.equal(store.pushTokenOf(b.id), "fcm-tablet-2");
  assert.equal(store.setPushToken("no-such-device", "fcm-x"), false);

  // The phone paired again: the new row takes the token over, so the phone gets each push once.
  const c = store.create("phone", 3000).device;
  assert.equal(store.setPushToken(c.id, "fcm-phone"), true);
  assert.equal(store.pushTokenOf(a.id), null);
  assert.deepEqual(store.pushTargets().map((t) => t.deviceId), [b.id, c.id]);

  store.clearPushToken(b.id);
  assert.equal(store.pushTokenOf(b.id), null);
  assert.equal(store.dropPushToken("fcm-phone"), true);
  assert.equal(store.dropPushToken("fcm-phone"), false);
  assert.deepEqual(store.pushTargets(), []);

  store.setPushToken(c.id, "fcm-phone");
  store.remove(c.id);
  assert.deepEqual(store.pushTargets(), [], "removing the device removes its token");
  store.close();
});

test("a state file from before pushes keeps its devices and gains the token column", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devices-"));
  const file = path.join(dir, "state.sqlite");
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER);
    CREATE TABLE other (x INTEGER);
    INSERT INTO other VALUES (7);
  `);
  const token = newSecret("device");
  raw.prepare("INSERT INTO devices VALUES ('d-1', 'Pixel 9', ?, 1000, 2000)").run(hashSecret(token));
  raw.close();

  const store = new DeviceStore(file);
  assert.deepEqual(store.list(), [{ id: "d-1", name: "Pixel 9", kind: "android", createdAt: 1000, lastUsedAt: 2000 }]);
  assert.equal(store.authenticate(token)?.device.id, "d-1", "the paired phone still signs in");
  assert.equal(store.pushTokenOf("d-1"), null);
  assert.equal(store.setPushToken("d-1", "fcm-1"), true);
  store.close();
  // Opening it again finds the column there and changes nothing.
  const again = new DeviceStore(file);
  assert.equal(again.pushTokenOf("d-1"), "fcm-1");
  again.close();
  const check = new DatabaseSync(file);
  assert.deepEqual(check.prepare("SELECT x FROM other").all().map((r) => r.x), [7]);
  check.close();
  fs.rmSync(dir, { recursive: true });
});

test("pairing: a code works once, only while open, and only as a pairing code", () => {
  const store = new DeviceStore(":memory:");
  const hub = new PairingHub(store);
  const claimed: string[] = [];
  const s1 = hub.start((d) => claimed.push(d.name));
  assert.equal(secretKind(s1.code), "pairing");
  assert.equal(hub.openCount(), 1);

  const ok = hub.claim(s1.code, "phone");
  assert.ok(ok);
  assert.equal(ok.device.name, "phone");
  assert.deepEqual(claimed, ["phone"]);
  assert.equal(store.authenticate(ok.token)?.device.id, ok.device.id);
  assert.equal(hub.claim(s1.code, "again"), null, "a used code is gone");
  assert.equal(hub.openCount(), 0);

  const s2 = hub.start(() => claimed.push("x"));
  s2.close();
  assert.equal(hub.claim(s2.code, "late"), null, "a closed dialog ends its code");
  assert.equal(hub.claim(newSecret("pairing"), "guess"), null);
  assert.equal(hub.claim(ok.token, "device token"), null);
  assert.deepEqual(claimed, ["phone"]);
  assert.equal(store.list().length, 1);
});

test("store: a table from before device kinds gains the column, and its rows are phones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devices-"));
  const file = path.join(dir, "state.sqlite");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL, last_used_at INTEGER)`);
  old.prepare("INSERT INTO devices VALUES ('11111111-1111-1111-1111-111111111111', 'old phone', ?, 1, NULL)").run(hashSecret("t"));
  old.close();
  const store = new DeviceStore(file);
  assert.equal(store.get("11111111-1111-1111-1111-111111111111")?.kind, "android");
  const d = store.create("mac", 2, "desktop");
  assert.equal(d.device.kind, "desktop");
  assert.equal(store.authenticate(d.token)?.device.kind, "desktop");
  store.close();
  // Opening it again leaves the column as it is.
  const again = new DeviceStore(file);
  assert.deepEqual(again.list().map((x) => x.kind), ["desktop", "android"]);
  again.close();
  // An older release's insert (no kind column named) still works and makes a phone.
  const raw = new DatabaseSync(file);
  raw.prepare("INSERT INTO devices (id, name, token_hash, created_at, last_used_at) VALUES ('22222222-2222-2222-2222-222222222222', 'x', 'h', 3, NULL)").run();
  raw.close();
  const third = new DeviceStore(file);
  assert.equal(third.get("22222222-2222-2222-2222-222222222222")?.kind, "android");
  third.close();
  fs.rmSync(dir, { recursive: true });
});

test("pairing: a desktop code pairs a desktop device by its long or short form, once", () => {
  const store = new DeviceStore(":memory:");
  const hub = new PairingHub(store);
  const phone = hub.start(() => {});
  assert.equal(phone.shortCode, undefined, "a phone reads the QR; it gets no short form");
  assert.equal(hub.kindOf(phone.code), "android");

  const s = hub.start(() => {}, "desktop");
  assert.match(s.shortCode!, new RegExp(`^[0-9A-HJKMNP-TV-Z]{${SHORT_CODE_LENGTH}}$`));
  assert.equal(normalizeShortCode(formatShortCode(s.shortCode!).toLowerCase()), s.shortCode);
  const short = shortCodeCredential(s.shortCode!);
  assert.equal(hub.kindOf(short), "desktop");
  assert.equal(hub.kindOf(s.code), "desktop");
  assert.equal(hub.openCount(), 2, "the two forms of one session count once");

  const ok = hub.claim(short, "work laptop");
  assert.equal(ok?.device.kind, "desktop");
  assert.equal(hub.claim(s.code, "again"), null, "claiming by the short form ends the long one too");
  assert.equal(hub.kindOf(short), null);
  assert.equal(hub.openCount(), 1);

  const s2 = hub.start(() => {}, "desktop");
  s2.close();
  assert.equal(hub.claim(shortCodeCredential(s2.shortCode!), "late"), null, "a closed dialog ends the short form");
  assert.equal(hub.claim("maru_s_0000000000000", "wrong length"), null);
  assert.equal(hub.isCode("maru_s_ILOU00000000"), false, "letters outside the alphabet are no code");
  assert.equal(normalizeShortCode("ilo0-1234-5678"), "1100" + "12345678");
  assert.equal(normalizeShortCode("1234-5678"), null);
});
