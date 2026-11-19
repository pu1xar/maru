import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type { MobileAppInfo } from "@maru/shared";

/**
 * dist-ota/update.json, written by apps/mobile/scripts/ota-export.mts (DESIGN.md 2d). The manifest
 * is signed there, on this Mac, with the key in ~/.config/maru/updates-signing; this server
 * never holds that key and serves the signed bytes as they are.
 */
export interface OtaUpdateFile {
  format: 1;
  platform: "android";
  id: string;
  runtimeVersion: string;
  createdAt: string;
  /** The manifest body exactly as signed. Asset URLs in it are relative (`/ota/assets/<key>`). */
  manifest: string;
  /** The `expo-signature` part header: sig="...", keyid="main", alg="rsa-v1_5-sha256" */
  signature: string;
  /** Asset key -> its file under dist-ota/ and content type. The launch bundle is one of them. */
  assets: Record<string, { file: string; contentType: string }>;
  /** The maru version of the release that exported it (the manifest's extra.maruVersion too). */
  version?: string | null;
}

/**
 * The OTA update of the release this server runs from (Expo Updates protocol 1). The device
 * listener calls handle() for /ota/* after it checked the device's token.
 *   GET /ota/manifest      multipart/mixed with the signed manifest, or 204 when the app already
 *                          runs this update or its runtime version (native fingerprint) differs
 *   GET /ota/assets/<key>  one asset of that manifest
 * update.json is read again when its mtime changes, so a test can publish without a restart.
 */
export class OtaUpdates {
  private cached: { mtimeMs: number; update: OtaUpdateFile } | null = null;
  private dir: string;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
  }

  current(): OtaUpdateFile | null {
    const file = path.join(this.dir, "update.json");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      this.cached = null;
      return null;
    }
    if (this.cached && this.cached.mtimeMs === stat.mtimeMs) return this.cached.update;
    const update = JSON.parse(fs.readFileSync(file, "utf8")) as OtaUpdateFile;
    if (update.format !== 1 || update.platform !== "android") throw new Error(`unsupported ${file}`);
    this.cached = { mtimeMs: stat.mtimeMs, update };
    return update;
  }

  info(): MobileAppInfo["update"] {
    const u = this.current();
    return u ? { id: u.id, runtimeVersion: u.runtimeVersion, createdAt: u.createdAt, version: u.version ?? null } : null;
  }

  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    if (req.method !== "GET" && req.method !== "HEAD") return plain(res, 405, "method not allowed");
    if (url.pathname === "/ota/manifest") return this.manifest(req, res);
    const m = /^\/ota\/assets\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (m) return this.asset(res, m[1]!);
    plain(res, 404, "not found");
  }

  private manifest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const platform = header(req, "expo-platform");
    const protocol = header(req, "expo-protocol-version");
    if (platform !== "android") return plain(res, 400, "expo-platform must be android");
    if (protocol !== "1") return plain(res, 400, "expo-protocol-version must be 1");
    const update = this.current();
    const noUpdate = !update
      || header(req, "expo-runtime-version") !== update.runtimeVersion
      || header(req, "expo-current-update-id") === update.id;
    if (noUpdate) {
      res.writeHead(204, { "expo-protocol-version": "1", "expo-sfv-version": "0", "cache-control": "private, max-age=0" });
      res.end();
      return;
    }
    const boundary = `maru-${crypto.randomBytes(12).toString("hex")}`;
    const parts = [
      `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="manifest"\r\n`
        + `Content-Type: application/json; charset=utf-8\r\n`
        + `expo-signature: ${update.signature}\r\n\r\n`
        + `${update.manifest}\r\n`,
      `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="extensions"\r\n`
        + `Content-Type: application/json\r\n\r\n`
        + `{"assetRequestHeaders":{}}\r\n`,
      `--${boundary}--\r\n`,
    ];
    const body = Buffer.from(parts.join(""), "utf8");
    res.writeHead(200, {
      "content-type": `multipart/mixed; boundary=${boundary}`,
      "content-length": body.length,
      "expo-protocol-version": "1",
      "expo-sfv-version": "0",
      "cache-control": "private, max-age=0",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  private asset(res: http.ServerResponse, key: string): void {
    const update = this.current();
    const entry = update?.assets[key];
    if (!entry) return plain(res, 404, "no such asset in the current update");
    const file = path.join(this.dir, entry.file);
    if (!file.startsWith(this.dir + path.sep)) return plain(res, 400, "bad asset path");
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return plain(res, 404, "asset file missing");
    }
    res.writeHead(200, {
      "content-type": entry.contentType,
      "content-length": size,
      "cache-control": "private, max-age=31536000, immutable",
    });
    fs.createReadStream(file).pipe(res);
  }
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function plain(res: http.ServerResponse, code: number, text: string): void {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(text);
}
