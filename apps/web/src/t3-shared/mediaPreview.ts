// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: packages/shared/src/mediaPreview.ts (workspace image preview check only).

export const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = [
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
] as const;

export function isWorkspaceImagePreviewPath(path: string): boolean {
  const literalPath = path.toLowerCase();
  return WORKSPACE_IMAGE_PREVIEW_EXTENSIONS.some((extension) => literalPath.endsWith(extension));
}
