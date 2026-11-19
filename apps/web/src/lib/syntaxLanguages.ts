// Which code gets syntax colors, without loading the highlighter. A fence language or a file
// path resolves to one of the grammars `syntaxHighlight.ts` registers, or to null for plain text.
// The list follows the fence languages counted in this machine's Claude and Codex transcripts
// (2026-11-16): bash, javascript, json, python, http, yaml, sql, html and markdown lead.

export const SYNTAX_LANGUAGES = [
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "diff",
  "dockerfile",
  "dos",
  "go",
  "graphql",
  "groovy",
  "http",
  "ini",
  "java",
  "javascript",
  "json",
  "kotlin",
  "lua",
  "makefile",
  "markdown",
  "nginx",
  "php",
  "powershell",
  "properties",
  "python",
  "ruby",
  "rust",
  "shell",
  "sql",
  "typescript",
  "vbscript",
  "xml",
  "yaml",
] as const;

export type SyntaxLanguage = (typeof SYNTAX_LANGUAGES)[number];

const KNOWN = new Set<string>(SYNTAX_LANGUAGES);

/** Fence names and file extensions that name a registered grammar under another name. */
const ALIASES: Readonly<Record<string, SyntaxLanguage>> = {
  sh: "bash",
  zsh: "bash",
  ksh: "bash",
  "shell-script": "bash",
  bashrc: "bash",
  zshrc: "bash",
  console: "shell",
  shellsession: "shell",
  terminal: "shell",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  jsonc: "json",
  json5: "json",
  jsonl: "json",
  ndjson: "json",
  geojson: "json",
  py: "python",
  python3: "python",
  pyw: "python",
  gyp: "python",
  https: "http",
  yml: "yaml",
  html: "xml",
  htm: "xml",
  xhtml: "xml",
  svg: "xml",
  plist: "xml",
  xsl: "xml",
  xslt: "xml",
  rss: "xml",
  vue: "xml",
  svelte: "xml",
  md: "markdown",
  mdx: "markdown",
  golang: "go",
  ps: "powershell",
  ps1: "powershell",
  psm1: "powershell",
  pwsh: "powershell",
  toml: "ini",
  conf: "ini",
  cfg: "ini",
  editorconfig: "ini",
  gitconfig: "ini",
  gitignore: "ini",
  env: "properties",
  dotenv: "properties",
  h: "c",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  "c#": "csharp",
  scss: "css",
  sass: "css",
  less: "css",
  gql: "graphql",
  gradle: "groovy",
  patch: "diff",
  rb: "ruby",
  gemspec: "ruby",
  rake: "ruby",
  kt: "kotlin",
  kts: "kotlin",
  rs: "rust",
  docker: "dockerfile",
  containerfile: "dockerfile",
  mk: "makefile",
  make: "makefile",
  mak: "makefile",
  bat: "dos",
  cmd: "dos",
  vbs: "vbscript",
  vba: "vbscript",
  vb: "vbscript",
  postgres: "sql",
  postgresql: "sql",
  psql: "sql",
  mysql: "sql",
  sqlite: "sql",
  plsql: "sql",
};

/** File names whose grammar their name gives, not their extension. */
const FILE_NAMES: Readonly<Record<string, SyntaxLanguage>> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
  ".bash_profile": "bash",
  ".zprofile": "bash",
  ".env": "properties",
  ".gitconfig": "ini",
  ".editorconfig": "ini",
  ".npmrc": "ini",
};

/** The grammar for a fence language (`ts`, `Python`, `shell-script`), or null for plain text. */
export function resolveSyntaxLanguage(name: string | null | undefined): SyntaxLanguage | null {
  const key = name?.trim().toLowerCase();
  if (!key) return null;
  if (KNOWN.has(key)) return key as SyntaxLanguage;
  const alias = ALIASES[key];
  if (alias) return alias;
  // A fence like ```app.config.ts names a file.
  return key.includes(".") ? syntaxLanguageForPath(key) : null;
}

/** The grammar for a file path, by its name or extension. */
export function syntaxLanguageForPath(path: string | null | undefined): SyntaxLanguage | null {
  const name = path?.trim().split(/[\\/]/).pop()?.toLowerCase();
  if (!name) return null;
  const byName = FILE_NAMES[name];
  if (byName) return byName;
  if (name.startsWith(".env")) return "properties";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const extension = name.slice(dot + 1);
  if (KNOWN.has(extension)) return extension as SyntaxLanguage;
  // Dockerfile.dev, Makefile.local
  return ALIASES[extension] ?? FILE_NAMES[name.slice(0, dot)] ?? null;
}
