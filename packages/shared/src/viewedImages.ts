// A picture an agent opened with a tool (Claude's Read of an image file, Codex's image view), as the
// chat draws it under the tool's row (DESIGN.md 6e, "작업 행의 그림"). Two sources, tried in order:
//   1. the image block the tool result carries inline in the transcript. The projector keeps no
//      base64 (claude/projection/extract.ts `stripBlobs`); the block holds a BlobRef to the
//      transcript line, which `GET /api/file/blob` decodes. It shows even when the file is gone.
//   2. the file itself, `GET /api/file/raw?path=`, for a picture file the result did not carry
//      (Codex's image view, a Claude result that came without an image block).
import { transcriptBlobUrl } from "./attachments.ts";
import { fileRawUrl, isInlineImagePath } from "./files.ts";

/** Where a transcript line carries the picture: `transcriptBlobUrl`'s arguments. */
export interface ViewedImageBlob {
  path: string;
  byteOffset: number;
  jsonPath: string;
}

export interface ViewedImage {
  /** The picture file the tool opened. */
  path: string;
  /** The tool result's own copy of the picture, or null when the result carried none. */
  blob: ViewedImageBlob | null;
}

/** Types `GET /api/file/blob` answers with (transcriptBlob.ts IMAGE_TYPES). */
const BLOB_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function rec(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The blocks of a tool output: the array itself, the `content` of an `{content, structuredContent}` pair, or the value alone. */
function outputBlocks(output: unknown): unknown[] {
  if (Array.isArray(output)) return output;
  const content = rec(output)?.content;
  return Array.isArray(content) ? content : [output];
}

/**
 * The first image block of a tool output whose picture the transcript line carries and
 * `GET /api/file/blob` can decode: a `source.data` BlobRef (the route reads that JSON path
 * only) of a bitmap type. Null for anything else.
 */
export function viewedImageBlobFromOutput(output: unknown): ViewedImageBlob | null {
  for (const block of outputBlocks(output)) {
    const image = rec(block);
    if (image?.type !== "image") continue;
    const blob = rec(image.blob);
    const raw = rec(blob?.raw);
    if (!blob || !raw) continue;
    const media = typeof blob.mediaType === "string" ? blob.mediaType : image.mimeType;
    if (
      typeof raw.path === "string" &&
      typeof raw.byteOffset === "number" &&
      typeof blob.jsonPath === "string" &&
      blob.jsonPath.endsWith(".source.data") &&
      typeof media === "string" &&
      BLOB_IMAGE_TYPES.has(media.toLowerCase())
    ) {
      return { path: raw.path, byteOffset: raw.byteOffset, jsonPath: blob.jsonPath };
    }
  }
  return null;
}

/**
 * The server-relative URLs a preview of `image` tries in order: the transcript's copy, then the
 * file. The file route is offered for a bitmap or SVG path only (`isInlineImagePath`), the
 * pictures the server and the phone token serve. An empty list leaves the row with its path chip.
 */
export function viewedImageUrls(image: ViewedImage): string[] {
  return [
    ...(image.blob === null ? [] : [transcriptBlobUrl({ path: image.blob.path, byteOffset: image.blob.byteOffset, jsonPath: image.blob.jsonPath })]),
    ...(isInlineImagePath(image.path) && !image.path.includes("\n") ? [fileRawUrl(image.path)] : []),
  ];
}
