import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type { DesktopAppInfo, DesktopArtifact, DesktopUpdateManifest, DesktopUpdateResponse } from "@maru/shared";

const CONTENT_TYPES: Record<DesktopArtifact["format"], string> = {
  zip: "application/zip",
  dmg: "application/x-apple-diskimage",
  nsis: "application/vnd.microsoft.portable-executable",
};

interface Loaded {
  mtimeMs: number;
  /** manifest.json exactly as signed. */
  text: string;
  signature: string;
  manifest: DesktopUpdateManifest;
}

/**
 * The desktop app's build this release serves (DESIGN.md 2e): apps/desktop/dist-release, which
 * release.sh fills (a new build when the shell's fingerprint changed, else the running release's
 * files). manifest.json is signed there, on this Mac, with the update signing key, and
 * manifest.json.sig holds the signature; this server never holds the key and serves the signed
 * bytes as they are. The app verifies them with the certificate built into it.
 *
 * Both listeners route here: the web for the 기기 tab's downloads, the device listener for a
 * desktop token (the app's update check and download). Only files the manifest lists are served.
 * manifest.json is read again when its mtime changes, so a test can publish without a restart.
 */
export class DesktopBuilds {
  private dir: string;
  private cached: Loaded | null = null;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
  }

  private current(): Loaded | null {
    const file = path.join(this.dir, "manifest.json");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      this.cached = null;
      return null;
    }
    if (this.cached && this.cached.mtimeMs === stat.mtimeMs) return this.cached;
    const text = fs.readFileSync(file, "utf8");
    const manifest = JSON.parse(text) as DesktopUpdateManifest;
    if (manifest.format !== 1 || manifest.type !== "maru-desktop-update") throw new Error(`unsupported ${file}`);
    const signature = fs.readFileSync(`${file}.sig`, "utf8").trim();
    this.cached = { mtimeMs: stat.mtimeMs, text, signature, manifest };
    return this.cached;
  }

  info(): DesktopAppInfo {
    const m = this.current()?.manifest;
    return { build: m ? { version: m.version, fingerprint: m.fingerprint, builtAt: m.builtAt, artifacts: m.artifacts } : null };
  }

  /** Answers /api/desktop/*; false for any other path. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
    const p = url.pathname;
    if (!p.startsWith("/api/desktop/")) return false;
    const get = req.method === "GET" || req.method === "HEAD";
    if (get && p === "/api/desktop/app") {
      json(res, 200, this.info());
      return true;
    }
    if (get && p === "/api/desktop/update") {
      const c = this.current();
      if (!c) json(res, 404, { error: "This release has no desktop app build" });
      else json(res, 200, { manifest: c.text, signature: c.signature } satisfies DesktopUpdateResponse);
      return true;
    }
    const m = /^\/api\/desktop\/download\/([^/]+)$/.exec(p);
    if (get && m) {
      this.download(req, res, decodeURIComponent(m[1]!));
      return true;
    }
    json(res, 404, { error: "not found" });
    return true;
  }

  private download(req: http.IncomingMessage, res: http.ServerResponse, name: string): void {
    // An update file, or the block map the manifest lists beside it (the differential update, 2e).
    const manifest = this.current()?.manifest;
    const artifact = manifest?.artifacts.find((a) => a.file === name);
    const mapOf = manifest?.artifacts.find((a) => a.blockmap?.file === name)?.blockmap;
    const entry = artifact ? { sha256: artifact.sha256, type: CONTENT_TYPES[artifact.format] } : mapOf ? { sha256: mapOf.sha256, type: "application/octet-stream" } : null;
    if (!entry || path.basename(name) !== name) return json(res, 404, { error: `File not in the build: ${name}` });
    const file = path.join(this.dir, name);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return json(res, 404, { error: `File not found: ${name}` });
    }
    // A download cut off on a slow path resumes from where it stopped (DESIGN.md 2e): the browser
    // and the app send Range with If-Range set to this ETag, the file's SHA-256 from the manifest,
    // so a resumed download never joins two builds' bytes.
    const etag = `"${entry.sha256}"`;
    const common = {
      "content-type": entry.type,
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "accept-ranges": "bytes",
      etag,
    };
    const ifRange = req.headers["if-range"];
    const range = ifRange === undefined || ifRange === etag ? parseByteRange(req.headers.range, size) : null;
    if (range === "unsatisfiable") {
      res.writeHead(416, { ...common, "content-range": `bytes */${size}`, "content-length": 0 }).end();
      return;
    }
    if (range) {
      res.writeHead(206, { ...common, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": range.end - range.start + 1 });
    } else {
      res.writeHead(200, { ...common, "content-length": size });
    }
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = range ? fs.createReadStream(file, { start: range.start, end: range.end }) : fs.createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }
}

/**
 * One byte range of a file of `size` bytes from a Range header (RFC 9110 14.1.2): `bytes=a-b`,
 * `bytes=a-` and the suffix `bytes=-n`, end clamped to the file. null means "send the whole file":
 * no header, another unit, a malformed value or several ranges (a server may ignore Range).
 * "unsatisfiable" is a range that starts past the end (416).
 */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (size === 0) return "unsatisfiable";
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size) return "unsatisfiable";
  if (end < start) return null;
  return { start, end };
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
}
