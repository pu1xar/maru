// The picture a model gets for an uploaded image (DESIGN.md 6n).
//
// The Claude CLI fits every image it is given, from its own paste and from an SDK user message
// alike: longest side 2000 px, at most 4784 image tokens, then a 512,000 byte budget (Claude Code
// 2.1.325 bundle: `tT={maxWidth:2000,maxHeight:2000,...}`, `R5=512000`, and stream-json image
// blocks go through the same `sk` pipeline). So this server does not shrink what the CLI will
// shrink anyway; it fixes only what would fail before that:
//   - a format the API does not take (HEIC from a phone, TIFF, BMP, AVIF) is converted
//   - a picture over the API's own limits (8000 px a side, 10 MB of base64 per image on the Claude
//     API; platform.claude.com vision docs, read 2026-11-16) is fitted to the CLI's 2000 px and
//     re-encoded, with the CLI's JPEG quality steps 80, 60, 40, 20 when it is still too large
// The original stays as uploaded; the message names its path. Conversion uses macOS `sips`
// (ImageIO), the image engine this Mac already has, so HEIC needs no extra library.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type PreparedImage =
  | { ok: true; path: string; mime: string; width: number; height: number }
  | { ok: false; reason: string };

/** Media types the Claude API takes (vision docs); Codex reads the same four. */
export const API_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Vision docs: "The maximum dimensions for each image are 8000x8000 px." */
export const API_MAX_SIDE = 8000;
/** Vision docs: "10 MB (base64-encoded) on the Claude API". */
export const API_MAX_BASE64_BYTES = 10 * 1024 * 1024;
/** Claude Code 2.1.325 `tT.maxWidth` and `maxHeight`: what the CLI fits a picture to anyway. */
export const FIT_SIDE = 2000;
/** Claude Code 2.1.325 `rrt`: JPEG qualities tried in turn when a picture is still too large. */
export const JPEG_QUALITIES = [80, 60, 40, 20] as const;

export function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

export interface ImageInfo {
  mime: string;
  width: number;
  height: number;
  bytes: number;
}

export type ImagePlan =
  | { action: "as-is" }
  | { action: "convert"; format: "jpeg" | "png"; fitSide: number | null; why: string };

/** Lossy sources become JPEG, lossless ones PNG (a screenshot stays sharp, a photo stays small). */
const LOSSY = new Set(["image/jpeg", "image/heic", "image/heif", "image/avif", "image/webp"]);

/** What to do with a picture, from its type, size and bytes. Pure. */
export function planImage(info: ImageInfo): ImagePlan {
  const longSide = Math.max(info.width, info.height);
  const fitSide = longSide > FIT_SIDE ? FIT_SIDE : null;
  const format = LOSSY.has(info.mime) ? "jpeg" : "png";
  if (!API_IMAGE_TYPES.has(info.mime)) return { action: "convert", format, fitSide, why: `${info.mime} is not a format the model accepts` };
  if (longSide > API_MAX_SIDE) return { action: "convert", format, fitSide, why: `a side is longer than ${API_MAX_SIDE}px` };
  if (base64Length(info.bytes) > API_MAX_BASE64_BYTES) return { action: "convert", format, fitSide, why: "over base64 10MB" };
  return { action: "as-is" };
}

/** `sips -g` output: `  pixelWidth: 3024` lines. */
export function parseSipsInfo(out: string): { width: number; height: number; format: string } | null {
  const get = (k: string) => new RegExp(`^\\s*${k}:\\s*(\\S+)`, "m").exec(out)?.[1];
  const width = Number(get("pixelWidth"));
  const height = Number(get("pixelHeight"));
  const format = get("format");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || !format) return null;
  return { width, height, format };
}

const SIPS_FORMAT_MIME: Record<string, string> = {
  png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  tiff: "image/tiff", bmp: "image/bmp", avif: "image/avif",
};

async function sipsInfo(file: string): Promise<{ width: number; height: number; mime: string } | null> {
  try {
    const { stdout } = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "format", file]);
    const info = parseSipsInfo(stdout);
    return info ? { width: info.width, height: info.height, mime: SIPS_FORMAT_MIME[info.format] ?? `image/${info.format}` } : null;
  } catch {
    // Not a picture ImageIO reads (sips aborts on it).
    return null;
  }
}

async function sipsConvert(file: string, out: string, format: "jpeg" | "png", fitSide: number | null, quality: number): Promise<void> {
  // -Z also enlarges, so it goes only on a picture larger than the fit.
  const args = ["-s", "format", format, ...(format === "jpeg" ? ["-s", "formatOptions", String(quality)] : []), ...(fitSide ? ["-Z", String(fitSide)] : []), file, "--out", out];
  await run("/usr/bin/sips", args);
}

/**
 * The picture the model gets for `file` (stored in `dir`), or why it goes by path only. The format
 * is the one ImageIO reads from the bytes, not the name's or the browser's: a `.png` that holds a
 * TIFF is converted, and the media type sent is what the bytes are.
 */
export async function prepareImage(file: string, _declaredMime: string, dir: string): Promise<PreparedImage> {
  const info = await sipsInfo(file);
  if (!info) return { ok: false, reason: "Could not read it as an image, sending the file path only" };
  const bytes = fs.statSync(file).size;
  const plan = planImage({ mime: info.mime, width: info.width, height: info.height, bytes });
  if (plan.action === "as-is") return { ok: true, path: file, mime: info.mime, width: info.width, height: info.height };
  const tries: Array<{ format: "jpeg" | "png"; quality: number }> = plan.format === "png"
    ? [{ format: "png", quality: 0 }, ...JPEG_QUALITIES.map((q) => ({ format: "jpeg" as const, quality: q }))]
    : JPEG_QUALITIES.map((q) => ({ format: "jpeg" as const, quality: q }));
  for (const t of tries) {
    const out = path.join(dir, t.format === "png" ? "image.png" : "image.jpg");
    let size: number;
    try {
      await sipsConvert(file, out, t.format, plan.fitSide, t.quality);
      size = fs.statSync(out).size;
    } catch {
      // sips failed, or ended without writing the file.
      fs.rmSync(out, { force: true });
      return { ok: false, reason: `Could not convert the image, sending the file path only (${plan.why})` };
    }
    if (base64Length(size) <= API_MAX_BASE64_BYTES) {
      const done = await sipsInfo(out);
      if (!done) break;
      return { ok: true, path: out, mime: t.format === "png" ? "image/png" : "image/jpeg", width: done.width, height: done.height };
    }
    fs.rmSync(out, { force: true });
  }
  return { ok: false, reason: `Still over the per-image limit (base64 10MB) after shrinking, sending the file path only (${plan.why})` };
}
