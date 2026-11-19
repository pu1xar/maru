// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: apps/web/src/pierre-icons.ts (T3_PIERRE_ICONS: the "complete" colored set with T3's
// file name and extension rules, ensurePierreIconSprite) and the parts of @pierre/trees it relies
// on (Apache License 2.0): render/iconResolver.js (createFileTreeIconResolver), builtInIcons.js
// (resolveBuiltInFileIconToken) and style.css (the --trees-file-icon-color-* palette, the muted
// icon color). The sprite and the rule tables are in treeIconData.ts.
// Local change: the tree is maru's own (FileExplorer.tsx), so the resolver and the palette are
// plain functions here instead of Pierre's shadow-DOM stylesheet.
import {
  BUILT_IN_FILE_EXTENSION_TOKENS,
  BUILT_IN_FILE_NAME_TOKENS,
  COMPLETE_EXTENSION_OVERRIDES,
  T3_ICON_BY_FILE_EXTENSION,
  T3_ICON_BY_FILE_NAME,
  TREE_ICON_SPRITE,
} from "./treeIconData.ts";

export interface TreeIcon {
  /** The sprite symbol id. */
  name: string;
  /** Pierre's color token, for the built-in language marks. */
  token?: string;
}

/** "a.test.ts" gives "test.ts", then "ts". */
function extensionCandidates(fileName: string): string[] {
  const segments = fileName.toLowerCase().split(".");
  const out: string[] = [];
  for (let i = 1; i < segments.length; i++) out.push(segments.slice(i).join("."));
  return out;
}

/** Pierre's resolveIcon("file-tree-icon-file", path) under T3_PIERRE_ICONS. */
export function resolveFileIcon(fileName: string): TreeIcon {
  const lower = fileName.toLowerCase();
  const byName = T3_ICON_BY_FILE_NAME[lower];
  if (byName) return { name: byName };
  const candidates = extensionCandidates(fileName);
  for (const ext of candidates) {
    const byExt = T3_ICON_BY_FILE_EXTENSION[ext];
    if (byExt) return { name: byExt };
  }
  let token = BUILT_IN_FILE_NAME_TOKENS[lower];
  if (!token) {
    for (const ext of candidates) {
      token = COMPLETE_EXTENSION_OVERRIDES[ext] ?? BUILT_IN_FILE_EXTENSION_TOKENS[ext];
      if (token) break;
    }
  }
  token ??= "default";
  return { name: `file-tree-builtin-${token}`, token };
}

// Pierre's --trees-icon-* hues, light then dark.
const GRAY = "light-dark(#84848a, #adadb1)";
const RED = "light-dark(#d52c36, #ff6762)";
const VERMILION = "light-dark(#ff8c5b, #d5512f)";
const ORANGE = "light-dark(#d47628, #ffa359)";
const YELLOW = "light-dark(#d5a910, #ffd452)";
const GREEN = "light-dark(#199f43, #5ecc71)";
const TEAL = "light-dark(#17a5af, #64d1db)";
const CYAN = "light-dark(#1ca1c7, #68cdf2)";
const BLUE = "light-dark(#1a85d4, #69b1ff)";
const INDIGO = "light-dark(#693acf, #9d6afb)";
const PURPLE = "light-dark(#a631be, #d568ea)";
const PINK = "light-dark(#d32a61, #ff678d)";
const MAUVE = "light-dark(#594c5b, #79697b)";

/** Pierre's --trees-fg-muted: the chevron, and icons whose token has no hue of its own. */
export const TREE_MUTED_COLOR = "light-dark(#84848a, #84848a)";

/** Pierre's --trees-file-icon-color-<token>. Tokens missing here take TREE_MUTED_COLOR. */
const TOKEN_COLOR: Readonly<Record<string, string>> = {
  default: GRAY, astro: PURPLE, babel: YELLOW, bash: GREEN, biome: BLUE, bootstrap: INDIGO,
  browserslist: YELLOW, bun: MAUVE, c: BLUE, cpp: BLUE, claude: ORANGE, css: INDIGO, database: PURPLE,
  docker: BLUE, eslint: INDIGO, git: VERMILION, go: CYAN, graphql: PINK, html: ORANGE, image: PINK,
  javascript: YELLOW, json: ORANGE, markdown: GREEN, mcp: TEAL, npm: RED, oxc: CYAN, postcss: RED,
  prettier: TEAL, python: BLUE, react: CYAN, ruby: RED, rust: ORANGE, sass: PINK, svg: ORANGE,
  svelte: RED, svgo: GREEN, swift: ORANGE, table: TEAL, text: GRAY, tailwind: CYAN, terraform: INDIGO,
  typescript: BLUE, vite: PURPLE, vscode: BLUE, vue: GREEN, wasm: INDIGO, webpack: BLUE, yml: RED,
  zig: ORANGE, zip: ORANGE,
};

export function treeIconColor(icon: TreeIcon): string {
  return (icon.token && TOKEN_COLOR[icon.token]) || TREE_MUTED_COLOR;
}

const SPRITE_ID = "maru-tree-icon-sprite";

/** Puts the sprite in the document once; every row's `<use>` points into it. */
export function ensureTreeIconSprite(): void {
  if (typeof document === "undefined" || !document.body || document.getElementById(SPRITE_ID)) return;
  const container = document.createElement("div");
  container.id = SPRITE_ID;
  container.setAttribute("aria-hidden", "true");
  container.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  container.innerHTML = TREE_ICON_SPRITE;
  document.body.prepend(container);
}
