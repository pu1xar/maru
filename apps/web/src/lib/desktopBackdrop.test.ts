import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKDROP_STEPS, DEFAULT_BACKDROP, backdropRoot, contrast, normalizeBackdrop, parseRgb, worstContrast } from "./desktopBackdrop.ts";

// The theme tokens as the page computes them (measured 2026-11-16 in headless Chromium through a
// canvas read-back: the dark sidebar is the surface the sidebar element paints, level 1 #0f0f0f).
const THEMES = {
  dark: { sidebar: "#0f0f0f", background: "#000000", foreground: "#f5f5f5", muted: "#a1a1a1" },
  light: { sidebar: "#fafafa", background: "#fcfcfc", foreground: "#18181b", muted: "#62626d" },
};

test("backdrop: every whole percent from the first to the last step keeps body text at 4.5:1 over the worst backdrop, in both themes", () => {
  for (const [name, t] of Object.entries(THEMES)) {
    for (let step: number = BACKDROP_STEPS[0]; step <= BACKDROP_STEPS[BACKDROP_STEPS.length - 1]!; step++) {
      const opacity = 1 - step / 100;
      for (const surface of [t.sidebar, t.background]) {
        const c = worstContrast(parseRgb(t.foreground), parseRgb(surface), opacity);
        assert.ok(c >= 4.5, `${name} ${step}% on ${surface}: ${c.toFixed(2)}`);
      }
    }
    // The default is the user's own setting (all, 30%, 2026-11-16). Over the worst backdrop (pure
    // white or black straight behind, no material) the muted text there falls to 2.75 to 3.30:1;
    // the window's blur material sits between in practice. It keeps 2.7:1 at least.
    const d = 1 - DEFAULT_BACKDROP.transparency / 100;
    for (const surface of [t.sidebar, t.background]) {
      const c = worstContrast(parseRgb(t.muted), parseRgb(surface), d);
      assert.ok(c >= 2.7, `${name} muted at the default on ${surface}: ${c.toFixed(2)}`);
    }
  }
  // One step past the top would not hold in the dark theme: the cap is the measurement's.
  assert.ok(worstContrast(parseRgb(THEMES.dark.foreground), parseRgb(THEMES.dark.sidebar), 0.5) < 4.5);
});

test("backdrop: contrast math matches WCAG reference values", () => {
  assert.equal(contrast([0, 0, 0], [255, 255, 255]).toFixed(1), "21.0");
  assert.equal(contrast(parseRgb("#777777"), [255, 255, 255]).toFixed(2), "4.48");
  assert.equal(worstContrast(parseRgb("#f5f5f5"), [0, 0, 0], 1).toFixed(1), contrast(parseRgb("#f5f5f5"), [0, 0, 0]).toFixed(1), "opaque: the backdrop does not matter");
  assert.deepEqual(parseRgb("rgb(14, 14, 16)"), [14, 14, 16]);
});

test("backdrop: stored choices are checked; a browser gets no backdrop", () => {
  assert.deepEqual(normalizeBackdrop(null), DEFAULT_BACKDROP);
  assert.deepEqual(normalizeBackdrop({ backdrop: "all", transparency: 30 }), { backdrop: "all", transparency: 30 });
  assert.deepEqual(normalizeBackdrop({ backdrop: "glass", transparency: 33 }), { backdrop: DEFAULT_BACKDROP.backdrop, transparency: 33 });
  assert.equal(normalizeBackdrop({ backdrop: "all", transparency: 9 }).transparency, DEFAULT_BACKDROP.transparency);
  assert.equal(normalizeBackdrop({ backdrop: "all", transparency: 41 }).transparency, DEFAULT_BACKDROP.transparency);
  assert.equal(normalizeBackdrop({ backdrop: "all", transparency: 25.5 }).transparency, DEFAULT_BACKDROP.transparency);
  assert.deepEqual(backdropRoot({ backdrop: "all", transparency: 30 }, true), { attr: "all", opacity: "70%", translucent: true });
  assert.deepEqual(backdropRoot({ backdrop: "all", transparency: 30 }, false), { attr: null, opacity: null, translucent: false });
  assert.deepEqual(backdropRoot({ backdrop: "off", transparency: 30 }, true), { attr: null, opacity: null, translucent: false });
});
