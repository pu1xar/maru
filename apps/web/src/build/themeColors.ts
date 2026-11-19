// Writes packages/shared/src/themeColors.ts (the one source of both themes' base colors, DESIGN.md
// 7d) as CSS variables: theme-colors.generated.css, committed next to index.css. index.css's
// tokens point at these variables. themeColors.test.ts fails when the committed file differs
// from what this renders, so the file never lags the source.
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import * as bundled from "../../../../packages/shared/src/themeColors.ts";

type Source = Pick<typeof bundled, "darkSurfaces" | "glassOpacity" | "themeColors">;

const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The generated file's text, of the source as imported here or of a freshly loaded copy. */
export function themeColorsCss({ darkSurfaces, glassOpacity, themeColors }: Source = bundled): string {
  const lines: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    for (const [key, value] of Object.entries(themeColors[theme])) lines.push(`  --theme-${theme}-${kebab(key)}: ${value};`);
  }
  darkSurfaces.forEach((value, level) => lines.push(`  --theme-dark-surface-${level}: ${value};`));
  lines.push(`  --theme-glass-opacity: ${Math.round(glassOpacity * 100)}%;`);
  return [
    "/* Generated from packages/shared/src/themeColors.ts by src/build/themeColors.ts. Edit the source, not this file. */",
    ":root {",
    ...lines,
    "}",
    "",
  ].join("\n");
}

/** Where the generated file lives, under the web's src directory. */
export const themeColorsFile = (srcDir: string): string => path.join(srcDir, "theme-colors.generated.css");

/** Rewrites the file when it differs from the source (an unchanged file keeps its mtime, so no reload). */
export function writeThemeColors(srcDir: string, source: Source = bundled): boolean {
  const file = themeColorsFile(srcDir);
  const css = themeColorsCss(source);
  let current: string | null = null;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    current = null;
  }
  if (current === css) return false;
  fs.writeFileSync(file, css);
  return true;
}

/** Vite plugin: writes the file at build and dev server start, and again when the source changes in dev. */
export function themeColorsPlugin(srcDir: string): Plugin {
  const sourceFile = path.resolve(srcDir, "../../../packages/shared/src/themeColors.ts");
  return {
    name: "maru:theme-colors",
    buildStart() {
      writeThemeColors(srcDir);
    },
    configureServer(server) {
      writeThemeColors(srcDir);
      server.watcher.add(sourceFile);
      server.watcher.on("change", async (file) => {
        if (path.resolve(file) !== sourceFile) return;
        // Node caches the imported module; a query string loads the edited source.
        const fresh = (await import(`${sourceFile}?t=${Date.now()}`)) as Source;
        writeThemeColors(srcDir, fresh);
      });
    },
  };
}
