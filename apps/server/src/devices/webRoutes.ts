import type http from "node:http";
import { formatShortCode, pairingLink } from "@maru/shared";
import type { DeviceKind, DeviceList, MobileAppInfo, PairingClaimed, PairingOffer } from "@maru/shared";
import type { MobileApks } from "../mobile/apk.ts";
import type { OtaUpdates } from "../mobile/ota.ts";
import type { PairingHub } from "./pairing.ts";
import type { DeviceStore } from "./store.ts";

export interface DeviceWebDeps {
  store: DeviceStore;
  pairing: PairingHub;
  apks: MobileApks;
  ota: OtaUpdates;
  /** The URL a new device will talk to (config.ts DEVICE_URL), or null to derive it per request. */
  deviceUrl: string | null;
  /** The device listener's port, for a pairing started from a loopback page. */
  devicePort: number | null;
  /** Whether this server can send pushes (push/fcm.ts found the service account). Default false. */
  pushServer?: () => boolean;
}

/** Keeps proxies (many drop a silent stream after about 100 s) from ending a pairing stream. */
const KEEPALIVE_MS = 20_000;

/**
 * The 기기 tab's routes on the web listener, which only Google sign-in reaches (DESIGN.md 2d).
 * Device management lives only here: a device token cannot list devices, pair another device or
 * remove one other than itself. Returns false for paths it does not own.
 */
export async function handleDeviceWebRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: DeviceWebDeps,
  sendJson: (res: http.ServerResponse, code: number, body: unknown) => void,
): Promise<boolean> {
  const m = req.method;
  const p = url.pathname;
  if (m === "GET" && p === "/api/devices") {
    const body: DeviceList = { devices: deps.store.list() };
    sendJson(res, 200, body);
    return true;
  }
  const dm = /^\/api\/devices\/([0-9a-f-]{36})$/.exec(p);
  if (m === "DELETE" && dm) {
    if (!deps.store.remove(dm[1]!)) sendJson(res, 404, { error: "No such device" });
    else sendJson(res, 200, { ok: true });
    return true;
  }
  if (m === "GET" && p === "/api/devices/pairing") {
    pairingStream(req, res, deps, url.searchParams.get("kind") === "desktop" ? "desktop" : "android");
    return true;
  }
  if (m === "GET" && p === "/api/mobile/app") {
    const body: MobileAppInfo = { apk: deps.apks.latest(), update: deps.ota.info(), push: { server: deps.pushServer?.() ?? false } };
    sendJson(res, 200, body);
    return true;
  }
  if ((m === "GET" || m === "HEAD") && p === "/api/mobile/apk") {
    deps.apks.send(res);
    return true;
  }
  return false;
}

function pairingStream(req: http.IncomingMessage, res: http.ServerResponse, deps: DeviceWebDeps, kind: DeviceKind): void {
  const server = deviceUrlFor(req, deps);
  if (!server) {
    res.writeHead(503, { "content-type": "application/json; charset=utf-8" })
      .end(JSON.stringify({ error: "The device port is disabled (MARU_DEVICE_PORT)" }));
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  const event = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
  const session = deps.pairing.start((device) => {
    const claimed: PairingClaimed = { device };
    event("claimed", claimed);
    res.end();
  }, kind);
  const offer: PairingOffer = {
    link: pairingLink(server, session.code), server, kind,
    ...(session.shortCode ? { shortCode: formatShortCode(session.shortCode) } : {}),
  };
  event("code", offer);
  // The code ends with the stream: the dialog closed, the tab went away, or the claim above.
  res.on("close", () => {
    clearInterval(keepalive);
    session.close();
  });
}

/**
 * The public URL when the page came through a reverse proxy (the same host serves devices: a bearer token
 * routes there), the device port on loopback when the page is the local one.
 */
function deviceUrlFor(req: http.IncomingMessage, deps: DeviceWebDeps): string | null {
  if (deps.devicePort === null) return null;
  if (deps.deviceUrl) return deps.deviceUrl;
  const host = req.headers.host ?? "";
  const loopback = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  if (loopback) return `http://127.0.0.1:${deps.devicePort}`;
  const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return `${proto}://${host}`;
}
