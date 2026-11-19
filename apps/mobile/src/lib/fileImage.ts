// The pictures a message names by file path (DESIGN.md 2d, 6e), as the app loads them: the paired
// server's `GET /api/file/raw?path=` with the device token in `Authorization`, the one file read a
// phone token has (devices/access.ts). React Native-free, so node tests run it.
import { fileRawUrl } from "../../../../packages/shared/src/files.ts";
import { authHeaders, type Pairing } from "./api.ts";

/** What React Native's `Image` takes as `source` for a server-relative picture URL (`/api/file/raw?...`, `/api/file/blob?...`). */
export function pictureSource(pairing: Pairing, url: string): { uri: string; headers: Record<string, string> } {
  return { uri: `${pairing.server}${url}`, headers: authHeaders(pairing) };
}

/** What React Native's `Image` takes as `source` for the picture at `path` (absolute or `~/`). */
export function fileImageSource(pairing: Pairing, path: string): { uri: string; headers: Record<string, string> } {
  return pictureSource(pairing, fileRawUrl(path));
}

/**
 * The size a preview draws at: the picture's own size scaled down to fit the box (never scaled
 * up), rounded to whole pixels and at least 1 by 1. A picture with no size draws as 0 by 0.
 */
export function fitPreview(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
