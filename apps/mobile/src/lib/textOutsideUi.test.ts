// Every screen draws its text through components/ui/Text.tsx, which applies the display settings
// (the UI scale, the conversation's and the drawer's sizes, the chosen fonts). A Text or TextInput
// taken from react-native directly would ignore them, so this keeps every file but the wrapper
// itself off that import.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Files that still draw React Native's own Text: the screen header, which another change is rewriting; its import follows at the merge. */
const NOT_YET = new Set<string>();

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

test("no screen imports Text or TextInput from react-native", () => {
  const all = files(src).map((f) => path.relative(src, f));
  const violations: string[] = [];
  for (const rel of all) {
    if (rel === "components/ui/Text.tsx" || NOT_YET.has(rel)) continue;
    const text = fs.readFileSync(path.join(src, rel), "utf8");
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"react-native";/g)) {
      const names = m[1]!.split(",").map((n) => n.trim());
      if (names.includes("Text") || names.includes("TextInput")) violations.push(rel);
    }
  }
  assert.deepEqual(violations, []);
  console.log(`tsx files checked: ${all.length - 1 - NOT_YET.size}, left to connect: ${[...NOT_YET].join(", ")}`);
});
