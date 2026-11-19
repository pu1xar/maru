import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { FCM_PAYLOAD_LIMIT, FCM_SCOPE, FcmClient, fcmMessage, fitsFcm, loadServiceAccount, openFcm, tokenGone, type ServiceAccount } from "./fcm.ts";
import type { PushNotice } from "./policy.ts";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

/**
 * A local stand-in for Google: `/token` checks the JWT the way Google's token endpoint does
 * (signature with the service account's public key, claims) and hands out numbered access
 * tokens; `/v1/projects/<id>/messages:send` answers by the device token in the message.
 * A check that fails here is answered 418 with its message and kept in `failures`, so the send
 * under test fails instead of waiting for an answer.
 */
async function google(t: { after: (fn: () => Promise<void> | void) => void }) {
  const seen: Seen[] = [];
  const issued: string[] = [];
  const failures: string[] = [];
  let expiresIn = 3600;
  let base = "";
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      try {
        answer(req, res, body);
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
        res.writeHead(418, { "content-type": "text/plain" }).end(failures.at(-1));
      }
    });
  });
  const answer = (req: http.IncomingMessage, res: http.ServerResponse, body: string): unknown => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const send = (code: number, v: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (req.url === "/token") {
      const form = new URLSearchParams(body);
      assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [h, c, sig] = form.get("assertion")!.split(".");
      const header = JSON.parse(Buffer.from(h!, "base64url").toString());
      const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
      assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
      assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig!, "base64url")), "signed with the account's key");
      assert.equal(claims.iss, "maru-push@proj.iam.gserviceaccount.com");
      assert.equal(claims.scope, FCM_SCOPE);
      assert.equal(claims.aud, `${base}/token`);
      assert.equal(claims.exp - claims.iat, 3600);
      const token = `at-${issued.length + 1}`;
      issued.push(token);
      return send(200, { access_token: token, expires_in: expiresIn, token_type: "Bearer" });
    }
    const m = /^\/v1\/projects\/([^/]+)\/messages:send$/.exec(req.url!);
    if (!m || req.method !== "POST") return send(404, { error: { code: 404, status: "NOT_FOUND", message: "no route" } });
    if (req.headers.authorization !== `Bearer ${issued.at(-1)}`) {
      return send(401, { error: { code: 401, status: "UNAUTHENTICATED", message: "Request had invalid authentication credentials." } });
    }
    const device = (JSON.parse(body) as { message: { token: string } }).message.token;
    if (device === "gone") {
      return send(404, { error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found.", details: [
        { "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" },
      ] } });
    }
    if (device === "malformed") {
      return send(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token", details: [
        { "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "INVALID_ARGUMENT" },
        { "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field: "message.token", description: "The registration token is not a valid FCM registration token" }] },
      ] } });
    }
    if (device === "bad-payload") {
      return send(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "Invalid value at 'message.android.priority'", details: [
        { "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "INVALID_ARGUMENT" },
        { "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field: "message.android.priority", description: "Invalid value" }] },
      ] } });
    }
    if (device === "busy") return send(503, { error: { code: 503, status: "UNAVAILABLE", message: "The service is currently unavailable." } });
    return send(200, { name: `projects/${m[1]}/messages/0:1` });
  };
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  t.after(() => assert.deepEqual(failures, [], "checks of the stand-in Google"));
  const account: ServiceAccount = {
    client_email: "maru-push@proj.iam.gserviceaccount.com", private_key: PRIVATE_PEM, project_id: "proj", token_uri: `${base}/token`,
  };
  return { base, seen, issued, account, setExpiresIn: (s: number) => { expiresIn = s; } };
}

const notice: PushNotice = {
  kind: "turn.completed", sessionKey: "codex:cx:019a0000-0000-7000-8000-000000000000", title: "릴리스 정리", body: "Response finished",
  brief: { title: "릴리스 정리", body: "Response finished" },
};

test("the message: notification, high priority on the sessions channel, tagged by session, data as strings", () => {
  assert.deepEqual(fcmMessage(notice, "tok"), {
    token: "tok",
    notification: { title: "릴리스 정리", body: "Response finished" },
    android: { priority: "high", notification: { channel_id: "maru-sessions", tag: notice.sessionKey } },
    data: { kind: "turn.completed", sessionKey: notice.sessionKey },
  });
});

test("a notice over FCM's 4096-byte payload goes in its brief form; one at the limit goes whole", () => {
  const brief = { title: "릴리스 정리", body: "Ended with an error (see the reason in the app)" };
  const sized = (body: string): PushNotice => ({ ...notice, kind: "turn.failed", body, brief });
  const base = Buffer.byteLength(JSON.stringify({ notification: { title: notice.title, body: "" }, data: { kind: "turn.failed", sessionKey: notice.sessionKey } }));
  const atLimit = sized("a".repeat(FCM_PAYLOAD_LIMIT - base));
  assert.equal(fitsFcm(atLimit), true);
  assert.equal(fcmMessage(atLimit, "tok").notification.body, atLimit.body, "kept whole, not cut");
  const over = sized("a".repeat(FCM_PAYLOAD_LIMIT - base + 1));
  assert.equal(fitsFcm(over), false);
  assert.deepEqual(fcmMessage(over, "tok").notification, brief);
  // Bytes, not characters: Korean takes 3 bytes in UTF-8.
  assert.equal(fitsFcm(sized("가".repeat(Math.floor((FCM_PAYLOAD_LIMIT - base) / 3) + 1))), false);
});

test("send: a signed JWT for an access token, reused until shortly before its end, then renewed", async (t) => {
  const g = await google(t);
  let now = 1_700_000_000_000;
  const fcm = new FcmClient({ account: g.account, base: g.base, now: () => now });
  assert.deepEqual(await fcm.send(fcmMessage(notice, "device-1")), { ok: true });
  assert.deepEqual(await fcm.send(fcmMessage(notice, "device-2")), { ok: true });
  assert.deepEqual(g.issued, ["at-1"], "one exchange for both sends");
  const sends = g.seen.filter((s) => s.url.endsWith(":send"));
  assert.equal(sends.length, 2);
  assert.equal(sends[0]!.url, "/v1/projects/proj/messages:send");
  assert.equal(sends[0]!.headers.authorization, "Bearer at-1");
  assert.deepEqual(JSON.parse(sends[0]!.body), { message: fcmMessage(notice, "device-1") });

  now += 3600_000 - 61_000;
  await fcm.send(fcmMessage(notice, "device-1"));
  assert.deepEqual(g.issued, ["at-1"], "still more than a minute left");
  now += 2_000;
  await fcm.send(fcmMessage(notice, "device-1"));
  assert.deepEqual(g.issued, ["at-1", "at-2"], "renewed in the last minute");
});

test("sends at the same time share one exchange", async (t) => {
  const g = await google(t);
  const fcm = new FcmClient({ account: g.account, base: g.base });
  const results = await Promise.all(["a", "b", "c"].map((d) => fcm.send(fcmMessage(notice, d))));
  assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
  assert.deepEqual(g.issued, ["at-1"]);
});

test("UNREGISTERED and a malformed token mark the token gone; a payload fault or an outage does not", async (t) => {
  const g = await google(t);
  const fcm = new FcmClient({ account: g.account, base: g.base });
  const gone = await fcm.send(fcmMessage(notice, "gone"));
  assert.equal(gone.ok, false);
  assert.ok(!gone.ok && gone.tokenGone && gone.status === 404 && /NOT_FOUND/.test(gone.error));
  const malformed = await fcm.send(fcmMessage(notice, "malformed"));
  assert.ok(!malformed.ok && malformed.tokenGone && malformed.status === 400);
  const payload = await fcm.send(fcmMessage(notice, "bad-payload"));
  assert.ok(!payload.ok && !payload.tokenGone && payload.status === 400);
  const busy = await fcm.send(fcmMessage(notice, "busy"));
  assert.ok(!busy.ok && !busy.tokenGone && busy.status === 503);
  assert.deepEqual(g.issued, ["at-1"], "failures keep the access token");
});

test("tokenGone reads only what FCM documents for a dead token", () => {
  assert.equal(tokenGone(404, { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }), true);
  // A 404 without UNREGISTERED (a wrong project id) is no reason to forget every device's token.
  assert.equal(tokenGone(404, { error: { status: "NOT_FOUND", message: "Requested entity was not found." } }), false);
  assert.equal(tokenGone(400, { error: { status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" } }), true);
  assert.equal(tokenGone(400, { error: { status: "INVALID_ARGUMENT", message: "Message is too big" } }), false);
  assert.equal(tokenGone(403, { error: { status: "PERMISSION_DENIED", details: [{ errorCode: "SENDER_ID_MISMATCH" }] } }), false);
  assert.equal(tokenGone(500, null), false);
});

test("a 401 drops the access token, so the next send exchanges a new one; a failed exchange is a failed send", async (t) => {
  const g = await google(t);
  const fcm = new FcmClient({ account: g.account, base: g.base });
  await fcm.send(fcmMessage(notice, "a"));
  g.issued.push("rotated-elsewhere");
  const denied = await fcm.send(fcmMessage(notice, "a"));
  assert.ok(!denied.ok && denied.status === 401 && !denied.tokenGone);
  assert.deepEqual(await fcm.send(fcmMessage(notice, "a")), { ok: true });
  assert.equal(g.issued.at(-1), "at-3");

  const broken = new FcmClient({ account: { ...g.account, token_uri: `${g.base}/nope` }, base: g.base });
  const r = await broken.send(fcmMessage(notice, "a"));
  assert.ok(!r.ok && r.status === 0 && /^access token: 404/.test(r.error));
});

test("the service account file: missing, unusable, or loaded with a warning when others may read it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fcm-"));
  try {
    const file = path.join(dir, "service-account.json");
    const lines: string[] = [];
    assert.deepEqual(loadServiceAccount(file), { state: "missing" });
    assert.equal(openFcm(file, (l) => lines.push(l)), null);
    assert.match(lines.at(-1)!, /^push: off \(no Firebase service account at /);

    fs.writeFileSync(file, "{", { mode: 0o600 });
    assert.deepEqual(loadServiceAccount(file), { state: "invalid", error: "not JSON" });
    fs.writeFileSync(file, JSON.stringify({ client_email: "a", private_key: "", project_id: "p" }));
    assert.deepEqual(loadServiceAccount(file), { state: "invalid", error: "missing private_key, token_uri" });
    fs.writeFileSync(file, JSON.stringify({ client_email: "a", private_key: "nope", project_id: "p", token_uri: "https://x" }));
    const bad = loadServiceAccount(file);
    assert.ok(bad.state === "invalid" && bad.error.startsWith("private_key: "));
    assert.equal(openFcm(file, (l) => lines.push(l)), null);
    assert.match(lines.at(-1)!, /^push: off \(.*private_key: /);

    const account = { type: "service_account", client_email: "a@p.iam.gserviceaccount.com", private_key: PRIVATE_PEM, project_id: "p", token_uri: "https://oauth2.googleapis.com/token" };
    fs.writeFileSync(file, JSON.stringify(account));
    fs.chmodSync(file, 0o600);
    const ok = loadServiceAccount(file);
    assert.ok(ok.state === "ok" && ok.looseMode === null && ok.account.project_id === "p");
    assert.deepEqual(Object.keys(ok.state === "ok" ? ok.account : {}).sort(), ["client_email", "private_key", "project_id", "token_uri"]);
    lines.length = 0;
    assert.ok(openFcm(file, (l) => lines.push(l)) instanceof FcmClient);
    assert.deepEqual(lines, ["push: on (Firebase project p)"]);

    fs.chmodSync(file, 0o644);
    lines.length = 0;
    assert.ok(openFcm(file, (l) => lines.push(l)));
    assert.deepEqual(lines, [`push: warning: ${file} is mode 0644; it holds a private key, chmod 600 it`, "push: on (Firebase project p)"]);
    assert.ok(!lines.join("\n").includes("PRIVATE KEY"), "the key never reaches the log");
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
