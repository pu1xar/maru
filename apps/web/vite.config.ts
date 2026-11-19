import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { normalizeFontCdn } from "../../packages/shared/src/bonFont.ts";
import { loadBuildEnv } from "../../packages/shared/src/buildEnv.ts";
import { buildVersion } from "../../packages/shared/src/gitVersion.ts";
import { themeColorsPlugin } from "./src/build/themeColors.ts";
import { uiNamesPlugin } from "./src/build/uiNames.ts";

// The build settings (build.env.example): MARU_FONT_CDN below.
loadBuildEnv();

const target = `http://127.0.0.1:${process.env.MARU_PORT || 8024}`;
// The page's version (lib/pageVersion.ts, DESIGN.md 2c): MARU_VERSION from release.sh, else the
// checkout's HEAD with -dev. Read once per build or dev server start.
const version = buildVersion(fileURLToPath(new URL("../..", import.meta.url)));

// Packages the markdown pipeline pulls in (unified, remark, rehype, micromark, parse5 and their
// helpers). Only the lazily loaded timeline uses them.
const MARKDOWN_VENDOR =
  /[\\/]node_modules[\\/](micromark[^\\/]*|mdast-[^\\/]+|hast[^\\/]*|unist-[^\\/]+|unified|remark-[^\\/]+|rehype-[^\\/]+|react-markdown|parse5|entities|property-information|vfile[^\\/]*|markdown-table|@ungap[\\/]structured-clone|inline-style-parser|style-to-[^\\/]+|trough|zwitch|extend|bail|devlop|ccount|comma-separated-tokens|space-separated-tokens|trim-lines|html-url-attributes|html-void-elements|web-namespaces|is-plain-obj|longest-streak|escape-string-regexp|decode-named-character-reference|character-entities[^\\/]*|character-reference-invalid|estree-util-[^\\/]+)[\\/]/;

// Dev: run the server with MARU_ORIGINS=http://localhost:5173 so it accepts this origin.
export default defineConfig({
  // uiNamesPlugin first: it reads the JSX before it is compiled (element names, DESIGN.md 7e).
  // themeColorsPlugin writes theme-colors.generated.css from packages/shared's themeColors.ts
  // (DESIGN.md 7d) before the CSS is read.
  plugins: [
    themeColorsPlugin(fileURLToPath(new URL("./src", import.meta.url))),
    uiNamesPlugin(fileURLToPath(new URL("./src", import.meta.url))),
    react(),
    tailwindcss(),
  ],
  define: {
    __MARU_VERSION__: JSON.stringify(version),
    // Where the Bon font files are served (lib/bonFont.ts); null declares no Bon font.
    __MARU_FONT_CDN__: JSON.stringify(normalizeFontCdn(process.env.MARU_FONT_CDN)),
  },
  build: {
    rolldownOptions: {
      output: {
        // Large vendors in their own chunks, so no single chunk passes the 500 kB warning. The
        // legend-list and markdown chunks load with the timeline chunk, not with the page.
        codeSplitting: {
          groups: [
            // First, so the page's shared React modules never land in a lazy group (a group
            // otherwise takes its modules' dependencies along).
            {
              name: "react",
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler|use-sync-external-store)[\\/]/,
              priority: 3,
            },
            { name: "markdown", test: MARKDOWN_VENDOR, priority: 2 },
            { name: "legend-list", test: /[\\/]node_modules[\\/]@legendapp[\\/]list[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
  resolve: {
    // Same `~/` root as tsconfig `paths`, so files adapted from T3 Code keep their imports.
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": { target, changeOrigin: true },
      "/ws": { target, ws: true, changeOrigin: true },
    },
  },
});
