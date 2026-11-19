// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: packages/shared/src/markdownLinks.ts (unchanged).
import {
  isNetworkPath,
  isWindowsAbsolutePath,
  stripSlashPrefixedWindowsDrive,
  workspaceRelativeFilePath,
} from "./path.ts";
import {
  type FilePathPosition,
  formatFilePathPosition,
  parseFileUrlHref,
  resolvePathLinkTarget,
  splitFilePathPosition,
} from "./fileLinks.ts";

const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;

// Names may use any script (`線性代數/考試.pdf`) and routing punctuation (`posts.$id.tsx`,
// `(group)/[id]/+page.svelte`, `@scope/pkg`). The final segment is optional so an explicit
// folder link may end in `/` (`patches/`, `docs/My Folder/`). A bare name with no slash still fails.
const RELATIVE_FILE_PATH_PATTERN =
  /^(?:[\p{L}\p{M}\p{N}._$+@()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+@()[\]-]+)*\/)+(?:[\p{L}\p{M}\p{N}._$+@()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+@()[\]-]+)*(?::\d+(?::\d+|-\d+)?)?)?$/u;

// No `@` here: `me@example.com` is an address, not a file.
const RELATIVE_FILE_NAME_PATTERN =
  /^[\p{L}\p{M}\p{N}._$+()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+()[\]-]+)*\.[\p{L}\p{M}\p{N}_-]+(?::\d+(?::\d+|-\d+)?)?$/u;

const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;

const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+|-\d+)?$/;

const POSITION_ONLY_PATTERN = /^\d+(?::\d+|-\d+)?$/;

const INLINE_CODE_DISQUALIFIER_PATTERN = /[\s`]/;

// An inline code span whose whole text is one explicit path may hold spaces (`~/notes/My Plan 2,5.md`):
// the code span's own backticks mark where the path ends, which prose cannot. Only a plain space
// counts (a tab or line break is not part of a file name), and the span must read as a path, not a
// command: it opens with `/`, `~/`, `./`, `../` or a drive letter, and its end is a folder slash
// or a file-shaped name.
const SPACED_PATH_START_PATTERN = /^(?:~\/|\.{1,2}\/|\/|[A-Za-z]:[\\/])(?=\S)/;
// Shell syntax a file name does not carry: an option after a space (`rm -rf`), a pipe, `&&`,
// `;`, a redirect, a substitution, a quote, or a second path after a space.
const SPACED_PATH_COMMAND_PATTERN =
  /\s[-+]\S|[|;<>"]|&&|\$[({]|\s&(?:\s|$)|(?:^|\s)'|'(?:\s|$)|\s(?:~\/|\.{0,2}\/|[A-Za-z]:[\\/])/;
const SPACED_PATH_END_PATTERN = /(?:[\\/]|\.[^.\\/\s:]+|:\d+(?::\d+|-\d+)?)$/;
// A launcher folder (`/usr/bin/python script.py`) names a command, not a file to open.
const SPACED_PATH_EXECUTABLE_DIR_PATTERN = /(?:^|[\\/])s?bin[\\/][^\\/\s]+\s/;

function isSpacedInlineCodePath(trimmed: string): boolean {
  if (/[^\S ]/.test(trimmed) || trimmed.includes("`")) return false;
  if (!SPACED_PATH_START_PATTERN.test(trimmed)) return false;
  if (SPACED_PATH_COMMAND_PATTERN.test(trimmed)) return false;
  if (SPACED_PATH_EXECUTABLE_DIR_PATTERN.test(trimmed)) return false;
  return SPACED_PATH_END_PATTERN.test(trimmed) || EXTENSIONLESS_FILE_NAMES.has(trimmed.slice(trimmed.lastIndexOf("/") + 1));
}

const PATH_SEPARATOR_PATTERN = /[\\/]/;
// Agents shorten long paths with a `...` or `…` segment, which no file chip can open.
const ELIDED_PATH_SEGMENT_PATTERN = /(?:^|[\\/])(?:\.{3,}|…)(?:[\\/]|$)/;

const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9_-]+$/;
const ANY_FILE_EXTENSION_PATTERN = /\.[^./\\]+$/;
const VERSION_SUFFIX_PATTERN = /\d\.\d[^.]*$/;
const NUMERIC_DOTTED_PATTERN = /^\d+(?:\.\d+)+$/;

const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/lib/",
  "/lib64/",
  "/srv/",
  "/dev/",
  "/proc/",
  "/sys/",
  "/run/",
  "/boot/",
  "/media/",
  "/workspace/",
  "/workspaces/",
] as const;

const EXTENSIONLESS_FILE_NAMES = new Set([
  "Makefile",
  "makefile",
  "GNUmakefile",
  "Dockerfile",
  "Containerfile",
  "Justfile",
  "justfile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "Brewfile",
  "Caddyfile",
  "Vagrantfile",
  "Jenkinsfile",
  "Podfile",
  "Fastfile",
  "BUILD",
  "WORKSPACE",
  "LICENSE",
  "LICENCE",
  "COPYING",
  "NOTICE",
  "AUTHORS",
  "CONTRIBUTORS",
  "CHANGELOG",
  "README",
  "CODEOWNERS",
]);

const SINGLE_LABEL_HOSTNAMES = new Set(["localhost"]);

const GENERIC_HOSTNAME_TLDS = new Set([
  "com",
  "net",
  "org",
  "io",
  "dev",
  "app",
  "ai",
  "co",
  "edu",
  "gov",
  "mil",
  "info",
  "biz",
  "xyz",
  "me",
  "tv",
  "gg",
  "chat",
  "cloud",
  "site",
  "online",
  "tech",
  "store",
  "link",
]);

const COUNTRY_HOSTNAME_TLDS = new Set([
  "uk",
  "de",
  "fr",
  "nl",
  "se",
  "no",
  "fi",
  "dk",
  "pl",
  "ch",
  "at",
  "be",
  "es",
  "it",
  "pt",
  "eu",
  "us",
  "ca",
  "au",
  "nz",
  "jp",
  "kr",
  "cn",
  "br",
  "ru",
  "mx",
  "ie",
  "cz",
  "tr",
  "sg",
  "hk",
  // C++ sources end in `.cc`, so `allocator.cc:217` names a file, not a host and port.
  "cc",
]);

function looksLikeHostname(segment: string, hasPosition: boolean): boolean {
  if (segment.startsWith(".")) return false;
  const lowered = segment.toLowerCase();
  if (SINGLE_LABEL_HOSTNAMES.has(lowered)) return true;
  if (NUMERIC_DOTTED_PATTERN.test(segment)) return true;
  const labels = lowered.split(".");
  const lastLabel = labels.at(-1);
  if (labels.length < 2 || lastLabel === undefined) return false;
  if (GENERIC_HOSTNAME_TLDS.has(lastLabel)) return true;
  return !hasPosition && COUNTRY_HOSTNAME_TLDS.has(lastLabel);
}

export function inlineCodeFilePathCandidate(codeText: string): string | null {
  const trimmed = codeText.trim();
  if (trimmed.length === 0) return null;
  if (INLINE_CODE_DISQUALIFIER_PATTERN.test(trimmed) && !isSpacedInlineCodePath(trimmed)) return null;

  const candidate = isWindowsAbsolutePath(trimmed) ? trimmed : trimmed.replaceAll("\\", "/");
  const hasPosition = POSITION_SUFFIX_PATTERN.test(candidate);
  if (!hasPosition && !PATH_SEPARATOR_PATTERN.test(candidate)) return null;
  if (ELIDED_PATH_SEGMENT_PATTERN.test(candidate.replace(POSITION_SUFFIX_PATTERN, ""))) return null;

  const hasExplicitPathShape =
    RELATIVE_PATH_PREFIX_PATTERN.test(candidate) ||
    candidate.startsWith("/") ||
    isWindowsAbsolutePath(candidate);
  if (!hasExplicitPathShape) {
    const withoutPosition = candidate.replace(POSITION_SUFFIX_PATTERN, "");
    // Markdown destinations accept `patches/`. Inline code still needs a
    // file-shaped final segment, so a trailing slash stays plain code.
    if (withoutPosition.endsWith("/")) return null;
    const firstSegment = withoutPosition.split("/")[0] ?? withoutPosition;
    if (looksLikeHostname(firstSegment, hasPosition)) return null;
    const basename =
      withoutPosition
        .replace(/[/\\]+$/, "")
        .split(/[\\/]/)
        .at(-1) ?? "";
    if (VERSION_SUFFIX_PATTERN.test(basename)) return null;
    if (!FILE_EXTENSION_PATTERN.test(basename)) {
      if (!hasPosition) return null;
      // A `:line` suffix alone does not make `I/W217:220` a file reference.
      if (
        withoutPosition.includes("/") &&
        !ANY_FILE_EXTENSION_PATTERN.test(basename) &&
        !EXTENSIONLESS_FILE_NAMES.has(basename)
      ) {
        return null;
      }
    }
  }
  return candidate;
}

export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeMarkdownLinkDestination(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
}

export function splitMarkdownLinkSearchAndHash(value: string): {
  readonly path: string;
  readonly hash: string;
} {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  return {
    path: queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch,
    hash,
  };
}

/**
 * The decoded path a markdown destination names on the host, before any workspace resolution, or
 * null for a `file:` URL that does not parse. Clients and the guest media route both read it here.
 */
export function markdownDestinationHostPath(source: string): string | null {
  if (/^file:/i.test(source)) {
    const target = parseFileUrlHref(source);
    return target === null
      ? null
      : stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(target.path));
  }
  return stripSlashPrefixedWindowsDrive(
    safeDecodeURIComponent(splitMarkdownLinkSearchAndHash(source).path),
  );
}

export function isMarkdownFileLinkLabel(label: string, href: string): boolean {
  const destination = parseMarkdownFileLink(href);
  if (!destination) return false;
  const normalize = (path: string) =>
    path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const labelPosition = splitFilePathPosition(label.trim());
  if (
    (labelPosition.line !== undefined && labelPosition.line !== destination.line) ||
    (labelPosition.column !== undefined && labelPosition.column !== destination.column) ||
    (labelPosition.endLine !== undefined && labelPosition.endLine !== destination.endLine)
  ) {
    return false;
  }
  let labelPath = normalize(labelPosition.path);
  let destinationPath = normalize(destination.path);
  if (labelPath.length === 0) return true;
  if (isWindowsAbsolutePath(destination.path)) {
    labelPath = labelPath.toLowerCase();
    destinationPath = destinationPath.toLowerCase();
  }
  return destinationPath === labelPath || destinationPath.endsWith(`/${labelPath}`);
}

export function isRelativeFilePath(path: string): boolean {
  return (
    RELATIVE_PATH_PREFIX_PATTERN.test(path) ||
    (!path.startsWith("/") && !isWindowsAbsolutePath(path))
  );
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return EXTENSIONLESS_FILE_NAMES.has(basename) || FILE_EXTENSION_PATTERN.test(basename);
}

function looksLikeFilePath(path: string, authoredPath: string): boolean {
  if (isWindowsAbsolutePath(path) || RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(authoredPath);
  if (EXTENSIONLESS_FILE_NAMES.has(path)) return true;
  return RELATIVE_FILE_PATH_PATTERN.test(authoredPath) || RELATIVE_FILE_NAME_PATTERN.test(path);
}

function hasExternalScheme(path: string): boolean {
  if (isWindowsAbsolutePath(path)) return false;
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? "";
  if (rest.startsWith("//")) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

export function parseMarkdownFileLink(href: string): FilePathPosition | null {
  const normalized = normalizeMarkdownLinkDestination(href);
  if (normalized.length === 0 || normalized.startsWith("#") || normalized.startsWith("//")) {
    return null;
  }

  const source =
    (normalized.toLowerCase().startsWith("file:") ? parseFileUrlHref(normalized) : null) ??
    splitMarkdownLinkSearchAndHash(normalized);
  const path = stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(source.path.trim()));
  const hash = safeDecodeURIComponent(source.hash.trim());
  if (path.length === 0 || hasExternalScheme(path)) return null;

  const position = parseFilePathLink(path, hash);
  // `src\a.ts` is Windows-relative. A link that already parses keeps its spelling, since POSIX
  // names may contain `\`; a rooted `\\host` or `\foo` would change root if rewritten.
  if (position || /^[\\/]/.test(path) || isWindowsAbsolutePath(path)) return position;
  return path.includes("\\") ? parseFilePathLink(path.replaceAll("\\", "/"), hash) : null;
}

function parseFilePathLink(path: string, hash: string): FilePathPosition | null {
  const position = splitFilePathPosition(path, hash);
  return !ELIDED_PATH_SEGMENT_PATTERN.test(position.path) && looksLikeFilePath(position.path, path)
    ? position
    : null;
}

const FENCED_CODE_SEGMENT_PATTERN = /(```[\s\S]*?(?:```|$))/;

const INLINE_CODE_SPAN_PATTERN = /`([^`\n]+)`/g;

export function extractInlineCodeSpans(text: string): string[] {
  const spans: string[] = [];
  const segments = text.split(FENCED_CODE_SEGMENT_PATTERN);
  for (let index = 0; index < segments.length; index += 2) {
    for (const match of (segments[index] ?? "").matchAll(INLINE_CODE_SPAN_PATTERN)) {
      const span = match[1]?.trim();
      if (span) spans.push(span);
    }
  }
  return spans;
}

function markdownRunEndFinder(markdown: string, delimiter: RegExp) {
  let runStart = -1;
  let runEnd = -1;
  return (start: number) => {
    if (start >= runStart && start <= runEnd) return runEnd;
    delimiter.lastIndex = start;
    runStart = start;
    runEnd = delimiter.exec(markdown)?.index ?? markdown.length;
    return runEnd;
  };
}

function markdownLinkTailScanner(markdown: string) {
  const whitespaceEnd = markdownRunEndFinder(markdown, /\S/g);
  const titleEnd = markdownRunEndFinder(markdown, /["']/g);
  const titleWhitespaceEnd = markdownRunEndFinder(markdown, /\S/g);
  return (start: number) => {
    const end = whitespaceEnd(start);
    if (markdown[end] === ")") return end + 1;
    if (end === start || (markdown[end] !== '"' && markdown[end] !== "'")) return null;
    const quoteEnd = titleEnd(end + 1);
    if (quoteEnd === markdown.length) return null;
    const close = titleWhitespaceEnd(quoteEnd + 1);
    return markdown[close] === ")" ? close + 1 : null;
  };
}

function markdownLinkDestinationScanner(markdown: string) {
  const whitespaceEnd = markdownRunEndFinder(markdown, /\S/g);
  const angleEnd = markdownRunEndFinder(markdown, /[>\n]/g);
  const bareEnd = markdownRunEndFinder(markdown, /[\s)]/g);
  // Separate caches keep scans moving forward when angle destinations fall back to bare ones.
  const angleTail = markdownLinkTailScanner(markdown);
  const bareTail = markdownLinkTailScanner(markdown);
  return (start: number) => {
    if (markdown[start] !== "(") return null;
    const hrefStart = whitespaceEnd(start + 1);
    if (markdown[hrefStart] === "<") {
      const hrefEnd = angleEnd(hrefStart + 1);
      if (hrefEnd > hrefStart + 1 && markdown[hrefEnd] === ">") {
        const end = angleTail(hrefEnd + 1);
        if (end !== null) return { hrefStart: hrefStart + 1, hrefEnd, end };
      }
    }
    const hrefEnd = bareEnd(hrefStart);
    if (hrefEnd === hrefStart) return null;
    const end = bareTail(hrefEnd);
    return end === null ? null : { hrefStart, hrefEnd, end };
  };
}

// The composer escapes brackets in labels (`[\[id\].tsx](...)`), and `\]` does not close one.
function unescapedLabelEnd(markdown: string, start: number): number {
  let end = markdown.indexOf("]", start);
  while (end !== -1) {
    let backslashes = 0;
    while (end - backslashes > start && markdown[end - backslashes - 1] === "\\") backslashes += 1;
    if (backslashes % 2 === 0) return end;
    end = markdown.indexOf("]", end + 1);
  }
  return -1;
}

export function extractMarkdownLinkHrefs(markdown: string): string[] {
  const hrefs: string[] = [];
  const scanDestination = markdownLinkDestinationScanner(markdown);
  let cursor = 0;
  while (cursor < markdown.length) {
    const labelStart = markdown.indexOf("[", cursor);
    if (labelStart === -1) break;
    const labelEnd = unescapedLabelEnd(markdown, labelStart + 1);
    if (labelEnd === -1) break;

    // Skip a failed label once; nested openings share its closing bracket.
    cursor = labelEnd + 1;
    const destination = scanDestination(cursor);
    if (!destination) continue;
    cursor = destination.end;
    const href = markdown.slice(destination.hrefStart, destination.hrefEnd).trim();
    if (href) hrefs.push(href);
  }
  return hrefs;
}

export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): string | null {
  if (!href) return null;
  const target = parseMarkdownFileLink(href);
  if (!target) return null;

  const pathWithPosition = formatFilePathPosition(target);
  if (!isRelativeFilePath(pathWithPosition)) {
    // Opening a network path makes Windows sign in to its host with the user's
    // NTLM credentials, so only the project's own share becomes a file link.
    return isNetworkPath(target.path) && workspaceRelativeFilePath(target.path, cwd) === null
      ? null
      : pathWithPosition;
  }
  if (!baseDir) {
    // A home path needs no session folder: the server expands `~/`.
    return pathWithPosition.startsWith("~/") ? pathWithPosition : null;
  }
  return resolvePathLinkTarget(pathWithPosition, baseDir);
}

export function isWindowsDrivePathHref(href: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(safeDecodeURIComponent(href));
}

// A path glued to a Korean particle ("d.png를") ends at its extension.
const GLUED_EXTENSION_PATTERN = /^(.*?\.[A-Za-z0-9]{1,8})(?=[^\x00-\x7f])/;

// Bare prose paths need a filesystem root or a position, so `/api/users.json` stays a route,
// and a file-shaped last segment. A `~/` path has no root to check, so it needs the extension.
// The path starts after whitespace, an opening bracket or quote, or the colon of a non-ASCII label
// (`그림:/tmp/a.png`; `https://x/a.png` and `C:/a.png` have an ASCII character before the colon).
export function absoluteFilePathMatches(text: string): Array<{ index: number; path: string }> {
  const paths: Array<{ index: number; path: string }> = [];
  for (const match of text.matchAll(/(^|[\s(["']|(?<=[^\x00-\x7f]):)((?:\/(?!\/)|~\/)[^\s<>"'`]+)/g)) {
    const source = match[2]!;
    let parentheses = 0;
    let brackets = 0;
    for (const character of source) {
      if (character === "(") parentheses += 1;
      if (character === ")") parentheses -= 1;
      if (character === "[") brackets += 1;
      if (character === "]") brackets -= 1;
    }
    let end = source.length;
    while (end > 0) {
      const character = source[end - 1]!;
      if (character === ")" && parentheses < 0) parentheses += 1;
      else if (character === "]" && brackets < 0) brackets += 1;
      else if (!".,;!?:".includes(character)) break;
      end -= 1;
    }
    let path = source.slice(0, end);
    const gluedBase = path.slice(path.lastIndexOf("/") + 1);
    if (!FILE_EXTENSION_PATTERN.test(gluedBase) && !POSITION_SUFFIX_PATTERN.test(path)) {
      const glued = GLUED_EXTENSION_PATTERN.exec(gluedBase);
      if (glued) path = path.slice(0, path.length - gluedBase.length) + glued[1]!;
    }
    // Trimming `/tmp/a/....` to `/tmp/a/` would hide its elided segment.
    if (path.endsWith("/") && source.startsWith("...", end)) continue;
    if (
      !path.startsWith("~/") &&
      !POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
      !POSITION_SUFFIX_PATTERN.test(path)
    )
      continue;
    // Prose ends a path at whitespace, so `/Users/me/Library/Application Support/...` must not link.
    const basename = path.slice(path.lastIndexOf("/") + 1);
    if (
      !POSITION_SUFFIX_PATTERN.test(path) &&
      !FILE_EXTENSION_PATTERN.test(basename) &&
      !EXTENSIONLESS_FILE_NAMES.has(basename)
    )
      continue;
    if (!parseMarkdownFileLink(path)) continue;
    paths.push({ index: match.index + match[1]!.length, path });
  }
  return paths;
}
