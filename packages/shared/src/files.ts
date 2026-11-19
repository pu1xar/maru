// File preview contract (DESIGN.md 6e): what `GET /api/file` answers for one path, and what
// `GET /api/file/tree` answers for one folder of the file tree.

/** Media the browser shows from `GET /api/file/raw`. */
export type FileMedia = "image" | "pdf" | "audio" | "video";

export interface FileEntry {
  name: string;
  kind: "file" | "directory" | "other";
  /** Bytes, for files. */
  size: number | null;
}

interface FileViewBase {
  /** Absolute path, `~` expanded. */
  path: string;
  mtimeMs: number;
}

export type FileView =
  | (FileViewBase & {
      kind: "text";
      size: number;
      /** A language id from the extension (`ts`, `markdown`, ...), null when unknown. */
      language: string | null;
      /** One page of the file, starting at `offset` bytes and ending on a line break. */
      text: string;
      offset: number;
      /** Where the next page starts; null at the end of the file. */
      nextOffset: number | null;
    })
  | (FileViewBase & { kind: "media"; size: number; mime: string; media: FileMedia })
  | (FileViewBase & { kind: "binary"; size: number; mime: string | null })
  | (FileViewBase & { kind: "directory"; entries: FileEntry[] })
  /** The path was missing and several files under `root` end with the looked-up relative path. */
  | { kind: "ambiguous"; path: string; lookup: string; root: string; candidates: string[] };

/**
 * A relative path from the conversation, looked up under the session folder when the path
 * resolved against it is missing (an agent often works in a subfolder). T3 does the same with
 * its workspace lookup.
 */
export interface FileLookup {
  lookup: string;
  root: string;
}

export function fileApiUrl(path: string, offset?: number, lookup?: FileLookup): string {
  const q = new URLSearchParams({ path });
  if (offset) q.set("offset", String(offset));
  if (lookup) {
    q.set("lookup", lookup.lookup);
    q.set("root", lookup.root);
  }
  return `/api/file?${q}`;
}

export function fileRawUrl(path: string): string {
  return `/api/file/raw?${new URLSearchParams({ path })}`;
}

/**
 * Extensions a chat message previews as a small picture under its file chip (DESIGN.md 6e).
 * SVG is included: an `<img>` never runs a script, and `GET /api/file/raw` also answers an SVG
 * with `Content-Security-Policy: sandbox`.
 */
const BITMAP_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

function pathExtension(path: string): string {
  const name = path.replace(/:\d+(?::\d+|-\d+)?$/, "");
  if (/[\\/]$/.test(name)) return "";
  const dot = name.lastIndexOf(".");
  if (dot <= name.lastIndexOf("/") + 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Whether `path` (with or without a `:line` suffix) names a picture the web chat previews inline. */
export function isInlineImagePath(path: string): boolean {
  const ext = pathExtension(path);
  return ext === "svg" || BITMAP_IMAGE_EXTENSIONS.has(ext);
}

/** The pictures React Native's `Image` draws (no SVG): what the Android app previews inline. */
export function isBitmapImagePath(path: string): boolean {
  return BITMAP_IMAGE_EXTENSIONS.has(pathExtension(path));
}

/**
 * One child of a folder in the right panel's file tree (`GET /api/file/tree`). After T3's
 * ProjectEntry: files, folders and links to either; `.git` is left out.
 */
export interface FileTreeEntry {
  name: string;
  kind: "file" | "directory";
  /** Git ignores it (`git check-ignore` run in the listed folder). Absent outside a repository. */
  ignored?: true;
  /** A symbolic link. "Expand all" does not follow a linked folder, so a link cycle cannot run away. */
  link?: true;
}

export interface FileTreeListing {
  /** The tree's root folder, absolute, `~` expanded. */
  root: string;
  /** The listed folder relative to `root`, `/`-separated; "" is the root itself. */
  dir: string;
  /** Every child, in the order the folder read them; the tree sorts them. */
  entries: FileTreeEntry[];
  /**
   * Git answered which children it ignores: the folder is inside a repository. "Expand all" opens
   * folders only where this holds, as it relies on `ignored` to pass over installed packages.
   */
  ignoreChecked: boolean;
  /**
   * Git was asked and gave no answer (missing, failing, or past its time), so the ignore labels
   * are missing. Absent when git answered or said the folder is outside any repository.
   */
  ignoreFailed?: true;
}

export function fileTreeApiUrl(root: string, dir: string): string {
  return `/api/file/tree?${new URLSearchParams({ root, dir })}`;
}
