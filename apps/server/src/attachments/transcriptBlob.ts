// An image a Claude transcript line carries inline, as GET /api/file/blob returns it (DESIGN.md
// 6n). The projector keeps no image data: each image block becomes a BlobRef (claude/projection/
// extract.ts) that names the transcript, the line's byte offset and the JSON path of the base64
// string. This reads that one line back and decodes the string.
import fs from "node:fs";
import path from "node:path";
import { FileError, resolveRequestPath } from "../files/fileView.ts";

/** Bytes read per step while looking for the end of the line. A step size, not a cap. */
const READ_STEP = 256 * 1024;

/** The line that starts at `offset` (without its newline). */
export function readLineAt(file: string, offset: number): string {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new FileError(404, "File not found");
    if (code === "EACCES" || code === "EPERM") throw new FileError(403, "No permission to read");
    throw err;
  }
  try {
    const chunks: Buffer[] = [];
    let at = offset;
    for (;;) {
      const buf = Buffer.alloc(READ_STEP);
      const n = fs.readSync(fd, buf, 0, READ_STEP, at);
      if (n === 0) break;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      if (nl >= 0) {
        chunks.push(buf.subarray(0, nl));
        break;
      }
      chunks.push(buf.subarray(0, n));
      at += n;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Steps of a projector JSON path (`$.message.content[0].source.data`): object keys and array
 * indexes. Null for anything else, so a request cannot ask for a shape the projector never writes.
 */
export function parseJsonPath(pointer: string): Array<string | number> | null {
  if (!pointer.startsWith("$")) return null;
  const steps: Array<string | number> = [];
  const re = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/y;
  re.lastIndex = 1;
  while (re.lastIndex < pointer.length) {
    const m = re.exec(pointer);
    if (!m) return null;
    steps.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  return steps;
}

export function valueAt(value: unknown, steps: ReadonlyArray<string | number>): unknown {
  let cur = value;
  for (const step of steps) {
    if (typeof step === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[step];
    } else {
      if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[step];
    }
  }
  return cur;
}

/** Media types this route answers with; other data is not an image the page should draw. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The transcript `rawPath` names, checked before anything is read: a regular `.jsonl` file under
 * one of `roots` (the Claude accounts' `projects` folders), after links are resolved. Reading a
 * line runs to the next newline, so anything else (a device such as /dev/zero, a FIFO, a large
 * binary) could hold the server; a picture in an agent's answer can point the page at this route.
 */
export function transcriptFile(rawPath: string | null, roots: readonly string[]): string {
  const asked = resolveRequestPath(rawPath);
  let real: string;
  try {
    real = fs.realpathSync(asked);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new FileError(404, "File not found");
    if (code === "EACCES" || code === "EPERM") throw new FileError(403, "No permission to read");
    throw err;
  }
  const inRoot = roots.some((root) => {
    let r: string;
    try {
      r = fs.realpathSync(root);
    } catch {
      return false;
    }
    return real.startsWith(`${r}${path.sep}`);
  });
  if (!inRoot || !real.endsWith(".jsonl")) throw new FileError(403, "Not a Claude transcript file", asked);
  if (!fs.statSync(real).isFile()) throw new FileError(415, "Not a regular file");
  return real;
}

/**
 * The decoded bytes and media type of the base64 string at `pointer` in the line at `offset` of a
 * Claude transcript under `roots`. The media type is the sibling `media_type` of a `source.data`
 * path (an image block's source).
 */
export function readTranscriptBlob(
  rawPath: string | null,
  rawOffset: string | null,
  pointer: string | null,
  roots: readonly string[],
): { bytes: Buffer; mime: string } {
  const file = transcriptFile(rawPath, roots);
  const offset = Number(rawOffset);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new FileError(400, "Invalid offset");
  const steps = pointer ? parseJsonPath(pointer) : null;
  if (!steps || steps.at(-1) !== "data") throw new FileError(400, "Invalid pointer");
  let record: unknown;
  try {
    record = JSON.parse(readLineAt(file, offset));
  } catch (err) {
    if (err instanceof FileError) throw err;
    throw new FileError(404, "No record at that position");
  }
  const data = valueAt(record, steps);
  if (typeof data !== "string") throw new FileError(404, "No image at that position");
  const media = valueAt(record, [...steps.slice(0, -1), "media_type"]);
  const mime = typeof media === "string" && IMAGE_TYPES.has(media) ? media : null;
  if (!mime) throw new FileError(415, "Not an image");
  return { bytes: Buffer.from(data, "base64"), mime };
}
