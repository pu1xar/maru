// Uploaded attachments (DESIGN.md 6n): one folder per upload under maru's state folder, where every
// session this server drives can read it (Claude runs with bypassPermissions, Codex turns with
// dangerFullAccess).
//
//   <root>/<id>/<name>        the bytes as uploaded; the message names this path
//   <root>/<id>/image.<ext>   the picture fitted to the model's limits, when the original is not
//                             already one (images.ts)
//   <root>/<id>/meta.json     what POST /api/attachments answered, and where the model's picture is
//
// Nothing here deletes an upload: a message in a transcript names its path, and the agent may come
// back to it in a later turn. Removing old uploads is the user's call (DESIGN.md 6n).
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { UploadedAttachment } from "@maru/shared";
import { prepareImage, type PreparedImage } from "./images.ts";

/** What meta.json holds: the upload as answered, and the picture the model gets. */
export interface StoredAttachment extends UploadedAttachment {
  createdAt: number;
  /** The paired device that uploaded it (device listener), so a phone sends only its own uploads (DESIGN.md 6n). */
  deviceId?: string;
  /** The file sent to the model as an image (the original or its fitted copy), for kind image. */
  imagePath?: string;
  imageMime?: string;
}

export class AttachmentError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ID_RE = /^\d{8}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * The longest file name APFS takes: 255 UTF-16 units, not bytes (measured 2026-11-16 on this Mac's
 * data volume: 255 ASCII letters, 255 Hangul syllables of 765 bytes, 127 emoji; one more fails
 * with ENAMETOOLONG).
 */
const NAME_MAX_UNITS = 255;
/** The upload is written here first; the folder is the upload's own, so a fixed name cannot clash. */
const PART_NAME = "upload.part";

export function isAttachmentId(id: string): boolean {
  return ID_RE.test(id);
}

/** `<YYYYMMDD>-<uuid>`: sorts by day in a listing, and cannot be guessed. */
export function newAttachmentId(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${randomUUID()}`;
}

/** Code points a stored name may not hold: controls, line and paragraph separators, bidi overrides and isolates, the double quote. */
const UNSAFE_NAME_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], [0x22, 0x22], [0x7f, 0x7f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069],
];

function unsafeToUnderscore(s: string): string {
  return [...s].map((c) => (UNSAFE_NAME_RANGES.some(([a, b]) => c.codePointAt(0)! >= a && c.codePointAt(0)! <= b) ? "_" : c)).join("");
}

/**
 * The name a file is stored under: its last path part with separators, control characters, line
 * and paragraph separators, bidirectional overrides (they can make a name read as another) and
 * double quotes replaced (the message quotes the name on one line),
 * cut to the file system's 255 UTF-16 units with its extension kept. Names the folder reserves
 * (meta.json, image.*, *.part) get a leading underscore; APFS ignores case, so the check does too.
 */
export function safeFileName(raw: string): string {
  let name = unsafeToUnderscore(raw.split(/[/\\]/).pop() ?? "").trim();
  if (name === "" || name === "." || name === "..") name = "file";
  const lower = name.toLowerCase();
  if (lower === "meta.json" || /^image\.[a-z0-9]+$/.test(lower) || lower.endsWith(".part")) name = `_${name}`;
  if (name.length <= NAME_MAX_UNITS) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
  let base = name.slice(0, NAME_MAX_UNITS - ext.length);
  // A cut between the halves of a surrogate pair would leave half a character.
  if (/[\ud800-\udbff]$/.test(base)) base = base.slice(0, -1);
  return base + ext;
}

/** First bytes of a file, to tell its type by content instead of trusting the browser. */
export function sniffMime(head: Buffer, declared: string, name: string): string {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, 6).toString("latin1") === "GIF87a" || head.subarray(0, 6).toString("latin1") === "GIF89a") return "image/gif";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (head.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = head.subarray(8, 12).toString("latin1");
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return "image/heic";
    if (brand === "avif") return "image/avif";
  }
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  const clean = declared.split(";")[0]!.trim().toLowerCase();
  if (clean && clean !== "application/octet-stream") return clean;
  const ext = path.extname(name).slice(1).toLowerCase();
  return EXT_MIME[ext] ?? "application/octet-stream";
}

const EXT_MIME: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html",
  tiff: "image/tiff", tif: "image/tiff", bmp: "image/bmp", svg: "image/svg+xml", zip: "application/zip",
};

export interface AttachmentStoreOptions {
  root: string;
  /** Fits a picture to the model's limits (images.ts). Tests pass their own. */
  prepare?: (file: string, mime: string, dir: string) => Promise<PreparedImage>;
  now?: () => Date;
}

export class AttachmentStore {
  readonly root: string;
  private prepare: NonNullable<AttachmentStoreOptions["prepare"]>;
  private now: () => Date;

  constructor(opts: AttachmentStoreOptions) {
    this.root = path.resolve(opts.root);
    this.prepare = opts.prepare ?? prepareImage;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Stores one upload, streamed to disk as it arrives (no size cap: a file the model cannot take as
   * an image goes by path, and a path has no size). A picture is then fitted for the model.
   */
  async save(body: Readable, rawName: string, declaredMime: string, deviceId?: string): Promise<UploadedAttachment> {
    const name = safeFileName(rawName);
    const id = newAttachmentId(this.now());
    const dir = path.join(this.root, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, name);
    const part = path.join(dir, PART_NAME);
    try {
      await pipeline(body, fs.createWriteStream(part, { mode: 0o600 }));
      fs.renameSync(part, file);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    const sizeBytes = fs.statSync(file).size;
    const head = Buffer.alloc(16);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, head, 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
    const mimeType = sniffMime(head, declaredMime, name);
    const stored: StoredAttachment = { id, kind: "file", name, mimeType, sizeBytes, path: file, createdAt: this.now().getTime(), ...(deviceId ? { deviceId } : {}) };
    if (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") {
      // The upload is kept whatever the picture step does: a failure there makes it a file.
      const img = await this.prepare(file, mimeType, dir).catch(
        (err: unknown): PreparedImage => ({ ok: false, reason: `Could not process the image, sending the file path only (${err instanceof Error ? err.message : String(err)})` }),
      );
      if (img.ok) {
        Object.assign(stored, { kind: "image", width: img.width, height: img.height, imagePath: img.path, imageMime: img.mime });
      } else {
        stored.notice = img.reason;
      }
    }
    fs.writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    return publicView(stored);
  }

  /** The upload with this id, or an error the route and the send path both report. */
  get(id: string): StoredAttachment {
    if (!isAttachmentId(id)) throw new AttachmentError(400, `Invalid attachment id: ${id}`);
    let meta: StoredAttachment;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(this.root, id, "meta.json"), "utf8")) as StoredAttachment;
    } catch {
      throw new AttachmentError(404, `Attachment not found: ${id}`);
    }
    if (!fs.existsSync(meta.path)) throw new AttachmentError(404, `Attachment file is missing: ${meta.path}`);
    return meta;
  }
}

export function publicView(s: StoredAttachment): UploadedAttachment {
  const { createdAt: _c, deviceId: _d, imagePath: _p, imageMime: _m, ...rest } = s;
  return rest;
}
