import { test } from "node:test";
import assert from "node:assert/strict";
import { darkSurfaces } from "../../../../packages/shared/src/themeColors.ts";

// The dark theme's surface levels (DESIGN.md 7d) are declared once in packages/shared's
// themeColors.ts (index.css's --surface-N point at the generated variables); this checks them so a
// later edit cannot drop the single chroma or reorder the lightness.
function level(n: number): string {
  const hex = darkSurfaces[n];
  assert.ok(hex && /^#[0-9a-fA-F]{6}$/.test(hex), `surface level ${n} is a hex color`);
  return hex.toLowerCase();
}

function oklabL(hex: string): number {
  const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16))) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

test("surface levels: five grays (chroma 0) in strictly rising lightness, level 0 black", () => {
  const levels = [0, 1, 2, 3, 4].map(level);
  for (const hex of levels) {
    assert.equal(hex.slice(1, 3), hex.slice(3, 5), `${hex} has equal red and green`);
    assert.equal(hex.slice(3, 5), hex.slice(5, 7), `${hex} has equal green and blue`);
  }
  assert.equal(levels[0], "#000000");
  const ls = levels.map(oklabL);
  for (let i = 1; i < ls.length; i++) assert.ok(ls[i]! > ls[i - 1]!, `level ${i} is lighter than level ${i - 1}`);
  // Level 1 is the terminal's neutral background (lib/terminalTheme.ts), so the two stay one tone.
  assert.equal(levels[1], "#0f0f0f");
});
