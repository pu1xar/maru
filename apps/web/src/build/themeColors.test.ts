import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { themeColors } from "../../../../packages/shared/src/themeColors.ts";
import { themeColorsCss, themeColorsFile } from "./themeColors.ts";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the committed theme-colors.generated.css is what the source renders", () => {
  assert.equal(fs.readFileSync(themeColorsFile(src), "utf8"), themeColorsCss());
});

test("every role of both themes becomes a variable, in a form CSS takes", () => {
  const css = themeColorsCss();
  for (const theme of ["light", "dark"] as const) {
    for (const [key, value] of Object.entries(themeColors[theme])) {
      assert.match(value, /^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [\d.]+\))$/, `${theme}.${key}`);
      assert.ok(css.includes(`--theme-${theme}-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${value};`), `${theme}.${key}`);
    }
  }
});

test("every --theme- variable index.css reads is defined in the generated file", () => {
  const defined = new Set([...themeColorsCss().matchAll(/(--theme-[a-z0-9-]+):/g)].map((m) => m[1]));
  const used = [...fs.readFileSync(path.join(src, "index.css"), "utf8").matchAll(/var\((--theme-[a-z0-9-]+)\)/g)].map((m) => m[1] as string);
  assert.ok(used.length > 0);
  assert.deepEqual(used.filter((name) => !defined.has(name)), []);
});
