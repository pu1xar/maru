import http from "node:http";
import type { Duplex } from "node:stream";
import type { DeviceKind, DevicePushRegistration, DeviceSelf, MobileApkLink, MobileAppInfo, PairDeviceRequest } from "@maru/shared";
import type { MobileApks } from "../mobile/apk.ts";
import { APK_LINK_PREFIX, ApkLinks, apkLinkToken } from "../mobile/apkLinks.ts";
import type { OtaUpdates } from "../mobile/ota.ts";
import type { UpdateToken } from "../mobile/updateToken.ts";
import { originAllowed, upgradeAllowed, webRouteAllowed } from "./access.ts";
import type { PairingHub } from "./pairing.ts";
import { bearerOf, secretKind } from "./secrets.ts";
import { tokenHint, type Authenticated, type DeviceStore } from "./store.ts";

/** The web server's routes and /ws, without the browser guard (http/server.ts). */
export interface MainRoutes {
  /** `device`: who asks, so an upload is stored with its device id (DESIGN.md 6n). */
  serveRequest(req: http.IncomingMessage, res: http.ServerResponse, device?: { id: string; kind: DeviceKind }): void;
  /** `kind`: the device's, for what its WebSocket may send (DESIGN.md 2e); `deviceId` for the uploads it may send (6n). */
  serveUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, kind: DeviceKind, deviceId?: string): void;
}

export interface DeviceServerOptions {
  store: DeviceStore;
  pairing: PairingHub;
  ota: OtaUpdates;
  /** The OTA read token every APK carries (mobile/updateToken.ts). */
  updateToken: UpdateToken;
  apks: MobileApks;
  /** The one-time APK links this listener issues and redeems. Default: a fresh ApkLinks (120 s). */
  apkLinks?: ApkLinks;
  main: MainRoutes;
  /** host[:port] values accepted in the Host header. */
  hosts: Set<string>;
  /** Whether this server can send pushes (push/fcm.ts found the service account). Default false. */
  pushServer?: () => boolean;
  log?: (line: string) => void;
}

/** The device listener, and whether a device has the app on screen right now. */
export interface DeviceServer extends http.Server {
  /**
   * The device has an open /ws. The app closes its /ws when it goes to the background and opens
   * it again when it comes back (DESIGN.md 2d, 푸시 알림), so this is "the app is on screen".
   */
  hasOpenWs(deviceId: string): boolean;
}

/** Same rule as the web server: bodies are small JSON commands; larger ones are rejected, not cut. */
const MAX_BODY = 1024 * 1024;

/**
 * The listener paired devices talk to (DESIGN.md 2d). It is a separate port, so whether a request
 * passed the web sign-in or came with a device token is decided by the port the reverse proxy
 * connected to, never by anything the client sends. The proxy routes `Authorization: Bearer maru_...`
 * requests here and everything else to the web port.
 *
 * Every HTTP request and every WebSocket upgrade is checked here:
 *   POST /api/device/pair       an open pairing code (PairingHub), long or short form
 *   /ota/*                      the update token the APK was built with
 *   GET /dl/apk/<token>         a one-time APK link (mobile/apkLinks.ts): the link is the credential
 *   everything else             a device token
 * The paths a device may use are its own (deviceRoute) and what its kind may pass on to the web
 * server (access.ts webRouteAllowed); others are 404. A request that names an Origin must come
 * from a page of the host it asks (access.ts originAllowed). Removing a device closes its open
 * WebSockets at once.
 */
export function createDeviceServer(opts: DeviceServerOptions): DeviceServer {
  const { store, pairing, ota, updateToken, apks, main, hosts } = opts;
  const apkLinks = opts.apkLinks ?? new ApkLinks();
  const sockets = new Map<string, Set<Duplex>>();
  store.onRemoved((id) => {
    apkLinks.dropDevice(id);
    const set = sockets.get(id);
    sockets.delete(id);
    for (const s of set ?? []) s.destroy();
    if (set?.size) opts.log?.(`devices: closed ${set.size} WebSocket(s) of removed device ${id}`);
  });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof BodyError) return json(res, err.status, { error: err.message });
      opts.log?.(`devices: ${req.method} ${req.url} failed: ${err instanceof Error ? err.stack : String(err)}`);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!hosts.has(req.headers.host ?? "")) return json(res, 403, { error: `host not allowed: ${req.headers.host ?? ""}` });
    if (!originAllowed(req)) return json(res, 403, { error: `origin not allowed: ${req.headers.origin ?? ""}` });
    const url = new URL(req.url || "/", "http://local");
    const secret = bearerOf(req);
    if (req.method === "POST" && url.pathname === "/api/device/pair") {
      if (!secret || !pairing.isCode(secret)) return unauthorized(res, "Pairing code required");
      // A code that is not open is refused before its body is read (no listener time for guesses).
      if (!pairing.kindOf(secret)) return unauthorized(res, "No pairing code is open. Start a new connection from Settings, Devices in the web app");
      const body = (await readJson(req)) as Partial<PairDeviceRequest>;
      const open = pairing.kindOf(secret);
      if (!open) return unauthorized(res, "No pairing code is open. Start a new connection from Settings, Devices in the web app");
      // The code fixes the kind; an app of the other kind is told so and the code stays open.
      const asked: DeviceKind = body.kind === "desktop" ? "desktop" : "android";
      if (asked !== open) {
        return json(res, 409, { error: open === "desktop" ? "This code is for connecting the desktop app. Start an Android connection in the web app" : "This code is for connecting the Android app. Start a desktop connection in the web app" });
      }
      const claimed = pairing.claim(secret, typeof body.name === "string" ? body.name : "");
      if (!claimed) return unauthorized(res, "No pairing code is open. Start a new connection from Settings, Devices in the web app");
      opts.log?.(`devices: paired ${claimed.device.id} (${claimed.device.kind}, ${claimed.device.name})`);
      return json(res, 200, claimed);
    }
    if (url.pathname.startsWith("/ota/")) {
      if (!secret || !updateToken.check(secret)) return unauthorized(res, "Update token does not match");
      return ota.handle(req, res, url);
    }
    const linkToken = apkLinkToken(url.pathname);
    if (linkToken !== null) return redeemApkLink(req, res, linkToken);
    const auth = secret ? store.authenticate(secret) : null;
    if (!auth) return unauthorized(res, "Device token is missing or was revoked");
    store.touch(auth.device.id);
    if (await deviceRoute(req, res, url, auth)) return;
    if (webRouteAllowed(auth.device.kind ?? "android", req.method ?? "GET", url.pathname, url.searchParams)) return main.serveRequest(req, res, { id: auth.device.id, kind: auth.device.kind ?? "android" });
    json(res, 404, { error: "not found" });
  }

  /** The browser's request: no Authorization, so the link itself decides. Every refusal looks alike. */
  function redeemApkLink(req: http.IncomingMessage, res: http.ServerResponse, token: string): void {
    // Only GET redeems: a HEAD or a preflight must not spend the link the browser is about to use.
    if (req.method !== "GET") return plain(res, 405, "method not allowed");
    const link = apkLinks.redeem(token);
    if (!link) return plain(res, 404, "This download link was used or has expired. Ask for a new one in the app");
    if (!apks.fileOf(link.file)) return plain(res, 404, "The APK is no longer available. Ask for a new link in the app");
    opts.log?.(`devices: ${link.deviceId} downloads ${link.file} through a one-time link`);
    apks.send(res, link.file);
  }

  async function deviceRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, auth: Authenticated): Promise<boolean> {
    const p = url.pathname;
    if (p === "/api/device/me" && req.method === "GET") {
      const body: DeviceSelf = { device: store.get(auth.device.id) ?? auth.device };
      json(res, 200, body);
      return true;
    }
    if (p === "/api/device/me" && req.method === "DELETE") {
      store.remove(auth.device.id);
      opts.log?.(`devices: ${auth.device.id} unpaired itself`);
      json(res, 200, { ok: true });
      return true;
    }
    if (p === "/api/device/app" && req.method === "GET") {
      const body: MobileAppInfo = { apk: apks.latest(), update: ota.info(), push: { server: opts.pushServer?.() ?? false } };
      json(res, 200, body);
      return true;
    }
    if (p === "/api/device/apk-link" && req.method === "POST") {
      const info = apks.latest();
      if (!info || !apks.fileOf(info.file)) {
        json(res, 404, { error: "No built APK" });
        return true;
      }
      // The origin the phone reached us by: Host passed the allow list above, the reverse proxy sets the scheme.
      const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
      const body: MobileApkLink = {
        url: `${proto}://${req.headers.host}${APK_LINK_PREFIX}${apkLinks.issue(auth.device.id, info.file)}`,
        expiresInSec: Math.round(apkLinks.ttlMs / 1000),
        file: info.file, size: info.size, runtimeVersion: info.runtimeVersion, version: info.version ?? null,
      };
      opts.log?.(`devices: ${auth.device.id} asked for a one-time link to ${info.file}`);
      json(res, 200, body);
      return true;
    }
    if (p === "/api/device/push" && req.method === "PUT") {
      const token = pushTokenOf(await readJson(req));
      if (token === null) {
        json(res, 400, { error: "token must be a non-empty string without whitespace" });
        return true;
      }
      // The row exists: authenticate() just read it. A removal in between leaves nothing to set.
      if (store.setPushToken(auth.device.id, token)) opts.log?.(`devices: ${auth.device.id} registered push token ${tokenHint(token)}`);
      json(res, 200, { ok: true });
      return true;
    }
    if (p === "/api/device/push" && req.method === "DELETE") {
      store.clearPushToken(auth.device.id);
      opts.log?.(`devices: ${auth.device.id} turned pushes off`);
      json(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  // Same as the web listener (http/server.ts): a desktop app's upload may take longer than Node's
  // 300 s request timeout on a slow link, and the listener is loopback only, behind the reverse proxy.
  server.requestTimeout = 0;

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://local");
    const secret = bearerOf(req);
    const auth = secret && secretKind(secret) === "device" ? store.authenticate(secret) : null;
    if (!hosts.has(req.headers.host ?? "") || !originAllowed(req) || !auth || !upgradeAllowed(auth.device.kind ?? "android", url.pathname)) {
      socket.write(`HTTP/1.1 ${auth ? "403 Forbidden" : "401 Unauthorized"}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    store.touch(auth.device.id);
    const id = auth.device.id;
    let set = sockets.get(id);
    if (!set) sockets.set(id, (set = new Set()));
    set.add(socket);
    socket.on("close", () => {
      set.delete(socket);
      if (set.size === 0 && sockets.get(id) === set) sockets.delete(id);
      // The end of a session is a use too: the list shows when the phone last had maru open.
      if (store.get(id)) store.touch(id);
    });
    main.serveUpgrade(req, socket, head, auth.device.kind ?? "android", auth.device.id);
  });

  return Object.assign(server, { hasOpenWs: (deviceId: string) => (sockets.get(deviceId)?.size ?? 0) > 0 });
}

/**
 * The token of a PUT /api/device/push body, or null when it is no FCM token. FCM documents no
 * length or alphabet for registration tokens, so only an empty value or one with whitespace is
 * refused here; FCM itself answers a malformed token with INVALID_ARGUMENT (push/fcm.ts).
 */
export function pushTokenOf(body: unknown): string | null {
  const token = (body as Partial<DevicePushRegistration> | null)?.token;
  return typeof token === "string" && /^\S+$/.test(token) ? token : null;
}

class BodyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  if (!(req.headers["content-type"] || "").includes("application/json")) throw new BodyError(415, "content-type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BodyError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new BodyError(400, "invalid JSON");
  }
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
}

function plain(res: http.ServerResponse, code: number, text: string): void {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(text);
}

function unauthorized(res: http.ServerResponse, error: string): void {
  res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "www-authenticate": "Bearer" })
    .end(JSON.stringify({ error }));
}
