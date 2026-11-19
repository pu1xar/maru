import { test } from "node:test";
import assert from "node:assert/strict";
import { themeColors } from "../../../../packages/shared/src/themeColors.ts";
import { darkSidebar, lightSidebar, sidebarColorsFrom } from "./sidebarColors.ts";

test("the drawer surface and the open row are the web's --sidebar and --sidebar-row-active", () => {
  assert.equal(darkSidebar.bg, themeColors.dark.sidebar);
  assert.equal(lightSidebar.bg, themeColors.light.sidebar);
  // Dark: the accent fill; light: the card's white, ringed with the border at 70%.
  assert.equal(darkSidebar.rowActive, themeColors.dark.accent);
  assert.equal(darkSidebar.rowActiveRing, null);
  assert.equal(lightSidebar.rowActive, themeColors.light.card);
  assert.match(lightSidebar.rowActiveRing ?? "", /^rgba\(\d+, \d+, \d+, 0\.7\)$/);
});

test("badges tint the fill 8% in light and 16% in dark, text in the foreground color", () => {
  assert.equal(lightSidebar.badge.warning.bg, "rgba(200, 123, 19, 0.08)");
  assert.equal(darkSidebar.badge.warning.bg, "rgba(254, 154, 0, 0.16)");
  assert.equal(darkSidebar.badge.info.fg, themeColors.dark.infoForeground);
  assert.equal(lightSidebar.badge.error.fg, themeColors.light.errorForeground);
  assert.equal(darkSidebar.pill.bg, "rgba(43, 127, 255, 0.12)");
});

test("a changed source color reaches the drawer colors", () => {
  const changed = sidebarColorsFrom({ ...themeColors.dark, sidebar: "#123456" }, true);
  assert.equal(changed.bg, "#123456");
});

test("every drawer color is one React Native takes", () => {
  for (const colors of [darkSidebar, lightSidebar]) {
    const values = [colors.bg, colors.rowActive, colors.rowActiveRing, colors.info, colors.warning, colors.error, colors.errorForeground, colors.pill.bg, colors.pill.fg, colors.track, colors.warningTrack];
    for (const b of Object.values(colors.badge)) values.push(b.bg, b.fg);
    for (const v of values) {
      if (v === null) continue;
      assert.match(v, /^(#[0-9a-f]{6}|rgba\(\d+, ?\d+, ?\d+, ?[\d.]+\))$/);
    }
  }
});
