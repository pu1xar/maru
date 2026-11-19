import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type { FileEntry, FileMedia, FileView } from "@maru/shared";

/**
 * File preview for the right panel (DESIGN.md 6e). The server is single-user and local, so any
 * absolute path the user's sessions mention is readable; the request guard and the fetch-site
 * check below keep other pages in the same browser out.
 */

/** Bytes per text page. A page size, not a cap: `nextOffset` reaches the rest. */
export const TEXT_PAGE_BYTES = 256 * 1024;

/** Bytes looked at for a NUL that marks a binary file. */
const SNIFF_BYTES = 8000;

/** `message` is a short label for the panel ("File not found"); `detail` says more where there is more. */
export class FileError extends Error {
  readonly status: number;
  readonly detail: string | null;
  constructor(status: number, message: string, detail: string | null = null) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** A path as the panel writes it, with the home folder as `~`. */
function tildePath(p: string): string {
  const home = os.homedir();
  return p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

const MEDIA: Record<string, { mime: string; media: FileMedia }> = {
  png: { mime: "image/png", media: "image" },
  jpg: { mime: "image/jpeg", media: "image" },
  jpeg: { mime: "image/jpeg", media: "image" },
  gif: { mime: "image/gif", media: "image" },
  webp: { mime: "image/webp", media: "image" },
  avif: { mime: "image/avif", media: "image" },
  bmp: { mime: "image/bmp", media: "image" },
  ico: { mime: "image/x-icon", media: "image" },
  svg: { mime: "image/svg+xml", media: "image" },
  pdf: { mime: "application/pdf", media: "pdf" },
  mp3: { mime: "audio/mpeg", media: "audio" },
  wav: { mime: "audio/wav", media: "audio" },
  m4a: { mime: "audio/mp4", media: "audio" },
  ogg: { mime: "audio/ogg", media: "audio" },
  flac: { mime: "audio/flac", media: "audio" },
  mp4: { mime: "video/mp4", media: "video" },
  mov: { mime: "video/quicktime", media: "video" },
  webm: { mime: "video/webm", media: "video" },
};

const LANGUAGE: Record<string, string> = {
  ts: "ts", tsx: "tsx", mts: "ts", cts: "ts", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
  json: "json", jsonl: "json", md: "markdown", markdown: "markdown", mdx: "markdown",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php", lua: "lua",
  sh: "bash", bash: "bash", zsh: "bash", fish: "fish", ps1: "powershell",
  html: "html", htm: "html", css: "css", scss: "scss", xml: "xml", yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "ini", sql: "sql", csv: "csv", tsv: "tsv", txt: "text", log: "text",
  dockerfile: "dockerfile", makefile: "makefile",
};

function extensionOf(p: string): string {
  const base = path.basename(p).toLowerCase();
  if (base === "dockerfile" || base === "makefile") return base;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

/** `~` expanded and required absolute; a relative path has no session to be relative to here. */
export function resolveRequestPath(raw: string | null): string {
  if (!raw) throw new FileError(400, "Missing path");
  const expanded = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) throw new FileError(400, "Not an absolute path", raw);
  return path.normalize(expanded);
}

function statOrThrow(p: string): fs.Stats {
  try {
    return fs.statSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new FileError(404, "File not found");
    if (code === "EACCES" || code === "EPERM") throw new FileError(403, "No permission to read");
    throw err;
  }
}

function readRange(p: string, offset: number, length: number): Buffer {
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** The end of the last complete UTF-8 character in `buf`. */
function utf8Boundary(buf: Buffer): number {
  let i = buf.length;
  // Step back over continuation bytes (10xxxxxx) to the lead byte of the last character.
  let back = 0;
  while (i - back - 1 >= 0 && back < 4 && (buf[i - back - 1]! & 0xc0) === 0x80) back++;
  const lead = i - back - 1;
  if (lead < 0) return i;
  const b = buf[lead]!;
  const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
  return back + 1 === need ? i : lead;
}

export function readFileView(rawPath: string | null, offsetParam?: string | null): FileView {
  const p = resolveRequestPath(rawPath);
  const st = statOrThrow(p);
  if (st.isDirectory()) return { kind: "directory", path: p, mtimeMs: st.mtimeMs, entries: listDirectory(p) };
  if (!st.isFile()) throw new FileError(415, "Not a regular file");

  const ext = extensionOf(p);
  const media = MEDIA[ext];
  if (media) return { kind: "media", path: p, mtimeMs: st.mtimeMs, size: st.size, ...media };

  const offset = Math.max(0, Math.min(Number(offsetParam) || 0, st.size));
  if (readRange(p, 0, Math.min(SNIFF_BYTES, st.size)).includes(0)) {
    return { kind: "binary", path: p, mtimeMs: st.mtimeMs, size: st.size, mime: null };
  }
  const page = readRange(p, offset, Math.min(TEXT_PAGE_BYTES, st.size - offset));
  const atEnd = offset + page.length >= st.size;
  let end = page.length;
  if (!atEnd) {
    const nl = page.lastIndexOf(0x0a);
    end = nl >= 0 ? nl + 1 : utf8Boundary(page);
  }
  return {
    kind: "text",
    path: p,
    mtimeMs: st.mtimeMs,
    size: st.size,
    language: LANGUAGE[ext] ?? null,
    text: page.subarray(0, end).toString("utf8"),
    offset,
    nextOffset: atEnd ? null : offset + end,
  };
}

function listDirectory(p: string): FileEntry[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(p, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new FileError(403, "No permission to read");
    throw err;
  }
  const entries = dirents.map((d): FileEntry => {
    let kind: FileEntry["kind"] = d.isDirectory() ? "directory" : d.isFile() ? "file" : "other";
    let size: number | null = null;
    if (d.isSymbolicLink() || kind === "file") {
      try {
        const st = fs.statSync(path.join(p, d.name));
        kind = st.isDirectory() ? "directory" : st.isFile() ? "file" : "other";
        size = st.isFile() ? st.size : null;
      } catch {
        // A dangling link stays "other".
      }
    }
    return { name: d.name, kind, size };
  });
  return entries.sort((a, b) =>
    a.kind === "directory" && b.kind !== "directory" ? -1
    : b.kind === "directory" && a.kind !== "directory" ? 1
    : a.name.localeCompare(b.name),
  );
}

/**
 * Only this app's own pages and a typed-in URL may load file bytes. `Sec-Fetch-Site` is
 * "same-site" for other ports on 127.0.0.1 (the tmux web app on 8012), so only "same-origin"
 * and "none" pass; a request without the header (curl) is not a browser page.
 */
export function fileFetchAllowed(req: http.IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

/** Headers every file response carries, so another page cannot embed or sniff the bytes. */
export const FILE_RESPONSE_HEADERS = {
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
} as const;

/** Stream the file's bytes with its media type, honoring one `Range: bytes=a-b`. */
export function sendRawFile(req: http.IncomingMessage, res: http.ServerResponse, rawPath: string | null): void {
  const p = resolveRequestPath(rawPath);
  const st = statOrThrow(p);
  if (!st.isFile()) throw new FileError(415, "Not a regular file");
  const ext = extensionOf(p);
  const mime = MEDIA[ext]?.mime ?? "application/octet-stream";
  const headers: http.OutgoingHttpHeaders = {
    ...FILE_RESPONSE_HEADERS,
    "content-type": mime,
    "accept-ranges": "bytes",
    // An SVG opened on its own runs no script in this origin.
    ...(ext === "svg" ? { "content-security-policy": "sandbox" } : {}),
  };
  let start = 0;
  let end = st.size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (range && st.size > 0) {
    if (range[1]) start = Number(range[1]);
    if (range[2]) end = range[1] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (!range[1] && range[2]) start = Math.max(0, st.size - Number(range[2]));
    if (start > end || start >= st.size) {
      res.writeHead(416, { ...headers, "content-range": `bytes */${st.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
  } else {
    res.writeHead(200, { ...headers, "content-length": st.size });
  }
  if (req.method === "HEAD" || st.size === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(p, { start, end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/** Folders a lookup walk does not enter: version control internals and installed packages. */
const LOOKUP_SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * Files under `root` whose path ends with `/<rel>`. The walk skips LOOKUP_SKIP_DIRS and reports
 * how many folders it skipped, so a miss can say where it did not look.
 */
export async function findBySuffix(root: string, rel: string): Promise<{ matches: string[]; skippedDirs: number }> {
  const suffix = `/${rel.replace(/^\.\//, "").replace(/^\/+/, "")}`;
  const matches: string[] = [];
  let skippedDirs = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (LOOKUP_SKIP_DIRS.has(e.name)) skippedDirs++;
        else await walk(full);
      } else if ((e.isFile() || e.isSymbolicLink()) && full.endsWith(suffix)) {
        matches.push(full);
      }
    }
  };
  await walk(root);
  return { matches: matches.sort(), skippedDirs };
}

/**
 * readFileView, and for a missing path that came from a relative link, a lookup under the
 * session folder: one match is read in its place, several come back as choices.
 */
export async function readFileViewWithLookup(
  rawPath: string | null,
  offsetParam: string | null,
  lookup: string | null,
  rawRoot: string | null,
): Promise<FileView> {
  try {
    return readFileView(rawPath, offsetParam);
  } catch (err) {
    if (!(err instanceof FileError) || err.status !== 404 || !lookup || !rawRoot || path.isAbsolute(lookup)) throw err;
    const root = resolveRequestPath(rawRoot);
    const { matches, skippedDirs } = await findBySuffix(root, lookup);
    if (matches.length === 1) return readFileView(matches[0]!, offsetParam);
    if (matches.length > 1) return { kind: "ambiguous", path: resolveRequestPath(rawPath), lookup, root, candidates: matches };
    const skipped = skippedDirs ? ` (${skippedDirs} ${skippedDirs === 1 ? "folder" : "folders"} excluded: ${[...LOOKUP_SKIP_DIRS].join(", ")})` : "";
    throw new FileError(404, "File not found", `Searched in ${tildePath(root)}${skipped}`);
  }
}
