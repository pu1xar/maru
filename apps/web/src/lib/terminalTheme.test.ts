import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  BODY_MIN,
  DIM_MIN,
  DEFAULT_TERMINAL_THEME,
  ITERM_COLORSET_BG,
  ITERM_TOKENS,
  TERMINAL_COLORSETS,
  contrast,
  normalizeTerminalTheme,
  resolveTerminalTokens,
  setTerminalTheme,
  terminalThemeStyle,
  type TerminalTokens,
} from "./terminalTheme.ts";

/** Every colorset on its own background. */
function combos(): Array<{ id: string; surface: string; t: TerminalTokens }> {
  return TERMINAL_COLORSETS.map((set) => ({ id: set.id, surface: set.bg, t: resolveTerminalTokens(set.id) }));
}

test("the iTerm colorset's tokens are the stylesheet's .term-root tokens", () => {
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
  const block = css.slice(css.indexOf("--term-bg:"), css.indexOf("--term-cell:"));
  const names: Record<string, keyof TerminalTokens> = {
    "--term-bg": "bg",
    "--term-fg": "fg",
    "--term-bold": "bold",
    "--term-fg-strong": "fgStrong",
    "--term-cursor": "cursor",
    "--term-selection-bg": "selectionBg",
    "--term-selection-fg": "selectionFg",
    "--term-link": "link",
    "--term-dim": "dim",
    "--term-rule": "rule",
    "--term-subtle": "subtle",
    "--term-user-bg": "userBg",
    "--term-code": "code",
    "--term-code-faint": "codeFaint",
    "--term-claude": "claude",
    "--term-shimmer": "shimmer",
    "--term-ok": "ok",
    "--term-err": "err",
    "--term-warn": "warn",
    "--term-accent": "accent",
    "--term-plan": "plan",
    "--term-accept": "accept",
    "--term-del-fg": "delFg",
    "--term-del-bg": "delBg",
    "--term-add-fg": "addFg",
    "--term-add-bg": "addBg",
  };
  let seen = 0;
  for (const [name, key] of Object.entries(names)) {
    const m = new RegExp(`${name}: (#[0-9a-f]{6});`).exec(block);
    assert.ok(m, `${name} in index.css`);
    assert.equal(ITERM_TOKENS[key], m[1], name);
    seen++;
  }
  assert.equal(seen, Object.keys(names).length);
});

test("the iTerm colorset writes only its background, #0f0f0f; every other colorset writes all the tokens", () => {
  assert.deepEqual(terminalThemeStyle("iterm"), { "--term-bg": "#0f0f0f" });
  assert.equal(resolveTerminalTokens("iterm").bg, "#0f0f0f");
  assert.ok(Object.keys(terminalThemeStyle("dracula")).length > 20);
  assert.equal(terminalThemeStyle("dracula")["--term-bg"], "#282a36");
});

// OKLab (Ottosson) of an sRGB hex, to check the neutral surface.
function oklab(hex: string): { L: number; a: number; b: number } {
  const lin = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(1), lin(3), lin(5)] as const;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

test("the iTerm colorset's background is a gray, darker than #14191e and lighter than black", () => {
  const n = oklab(ITERM_COLORSET_BG);
  assert.ok(Math.abs(n.a) < 1e-3 && Math.abs(n.b) < 1e-3, `chroma a ${n.a} b ${n.b}`);
  assert.ok(n.L < oklab("#14191e").L, `L ${n.L} is not darker than #14191e`);
  assert.ok(n.L > oklab("#000000").L, "black is not the iTerm colorset's background");
});

test("the default is the iTerm colorset", () => {
  assert.deepEqual(DEFAULT_TERMINAL_THEME, { colorset: "iterm" });
});

test("the default's actual contrast values on its #0f0f0f background", () => {
  const t = resolveTerminalTokens(DEFAULT_TERMINAL_THEME.colorset);
  assert.equal(t.bg, ITERM_COLORSET_BG);
  const roles = ["claude", "ok", "err", "warn", "accent", "plan", "accept"] as const;
  const minRole = Math.min(...roles.map((r) => contrast(t[r], t.bg)));
  const diff = Math.min(...[t.addBg, t.delBg].flatMap((row) => [contrast(t.fg, row), contrast(t.fgStrong, row)]));
  assert.ok(contrast(t.fg, t.bg) >= BODY_MIN);
  assert.ok(contrast(t.dim, t.bg) >= DIM_MIN);
  assert.ok(diff >= BODY_MIN);
  assert.ok(contrast(t.fgStrong, t.userBg) >= BODY_MIN);
  assert.ok(minRole >= 3);
  console.log(
    `default contrast: body ${contrast(t.fg, t.bg).toFixed(2)} dim ${contrast(t.dim, t.bg).toFixed(2)} diff ${diff.toFixed(2)} user ${contrast(t.fgStrong, t.userBg).toFixed(2)} role ${minRole.toFixed(2)}`,
  );
});

test("body text holds 4.5, dim 3, the user row's text 4.5 and diff text 4.5 for every colorset on its own background", () => {
  for (const { id, surface, t } of combos()) {
    const where = `${id} on ${surface}`;
    assert.ok(contrast(t.fg, t.bg) >= BODY_MIN, `${where}: body ${contrast(t.fg, t.bg).toFixed(2)}`);
    assert.ok(contrast(t.dim, t.bg) >= DIM_MIN, `${where}: dim ${contrast(t.dim, t.bg).toFixed(2)}`);
    assert.ok(contrast(t.fgStrong, t.userBg) >= BODY_MIN, `${where}: user row ${contrast(t.fgStrong, t.userBg).toFixed(2)}`);
    for (const row of [t.addBg, t.delBg]) {
      assert.ok(contrast(t.fg, row) >= BODY_MIN, `${where}: diff fg ${contrast(t.fg, row).toFixed(2)}`);
      assert.ok(contrast(t.fgStrong, row) >= BODY_MIN, `${where}: diff strong ${contrast(t.fgStrong, row).toFixed(2)}`);
    }
  }
});

test("role colors hold 3 on the background, except Claude Code's own palettes which keep the CLI's values", () => {
  for (const { id, surface, t } of combos()) {
    if (id.startsWith("claude-")) continue;
    for (const role of ["claude", "ok", "err", "warn", "accent", "plan", "accept"] as const) {
      assert.ok(contrast(t[role], t.bg) >= 3 - 1e-9, `${id} on ${surface}: ${role} ${contrast(t[role], t.bg).toFixed(2)}`);
    }
  }
});

test("the selection text reads on the selection background and the chip text on the accent", () => {
  for (const { id, surface, t } of combos()) {
    assert.ok(contrast(t.selectionFg, t.selectionBg) >= BODY_MIN, `${id} on ${surface}: selection ${contrast(t.selectionFg, t.selectionBg).toFixed(2)}`);
    assert.ok(contrast(t.chipFg, t.accent) >= BODY_MIN, `${id} on ${surface}: chip ${contrast(t.chipFg, t.accent).toFixed(2)}`);
  }
});

test("colorsets differ in their resolved role colors, and ids are unique", () => {
  assert.equal(new Set(TERMINAL_COLORSETS.map((c) => c.id)).size, TERMINAL_COLORSETS.length);
  const sig = new Set(
    TERMINAL_COLORSETS.map((c) => {
      const t = resolveTerminalTokens(c.id);
      return [t.claude, t.ok, t.err, t.warn, t.accent, t.plan, t.accept].join();
    }),
  );
  assert.equal(sig.size, TERMINAL_COLORSETS.length);
});

test("a stored choice that is not offered falls back to the default", () => {
  assert.deepEqual(normalizeTerminalTheme({ colorset: "nope" }), { colorset: "iterm" });
  assert.deepEqual(normalizeTerminalTheme({ colorset: "dracula" }), { colorset: "dracula" });
});

test("every colorset's background is its own: dark ones as listed, light ones white or cream", () => {
  const bgs = Object.fromEntries(TERMINAL_COLORSETS.map((c) => [c.id, resolveTerminalTokens(c.id).bg]));
  assert.equal(bgs["iterm"], "#0f0f0f");
  assert.equal(bgs["claude-dark"], "#14191e");
  assert.equal(bgs["dracula"], "#282a36");
  assert.equal(bgs["catppuccin-latte"], "#eff1f5");
  assert.equal(bgs["github-light"], "#ffffff");
});

// A stand-in for the browser, enough for setTerminalTheme and applyTerminalThemeToRoot.
function installBrowser(initial: Record<string, string>): { store: Map<string, string>; root: { style: Map<string, string> } & { setProperty(n: string, v: string): void; removeProperty(n: string): void } } {
  const store = new Map(Object.entries(initial));
  const style = new Map<string, string>();
  const root = {
    style,
    setProperty: (n: string, v: string) => void style.set(n, v),
    removeProperty: (n: string) => void style.delete(n),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  g.document = { documentElement: { style: { setProperty: root.setProperty, removeProperty: root.removeProperty } } };
  return { store, root };
}

test("the retired background key is not read and is removed on the next write", () => {
  const { store } = installBrowser({ maru_terminal_colorset: JSON.stringify("dracula"), maru_terminal_surface: JSON.stringify("black") });
  setTerminalTheme({ colorset: "gruvbox-dark" });
  assert.equal(store.get("maru_terminal_colorset"), JSON.stringify("gruvbox-dark"));
  assert.equal(store.has("maru_terminal_surface"), false);
  // The default is stored as an absent key
  setTerminalTheme({ colorset: "iterm" });
  assert.equal(store.has("maru_terminal_colorset"), false);
  assert.equal(store.has("maru_terminal_surface"), false);
});

test("the chat code preset \"Terminal background\" follows the colorset's background", () => {
  const { root } = installBrowser({});
  const set = (id: string) => {
    setTerminalTheme({ colorset: id });
    return { dark: root.style.get("--chat-code-term-dark") ?? null, light: root.style.get("--chat-code-term-light") ?? null };
  };
  // The default's #0f0f0f reaches the dark preset, as before the background row was removed
  assert.deepEqual(set("iterm"), { dark: "#0f0f0f", light: null });
  // Every colorset's background is followed (all are inside the preset's luminance limits), a
  // dark one by the dark preset and a light one by the light preset; #14191e is the preset's own
  // fallback, so the colorsets on it (Claude Code dark) write nothing
  for (const c of TERMINAL_COLORSETS) {
    const got = set(c.id);
    if (c.bg === "#14191e") assert.deepEqual(got, { dark: null, light: null }, c.id);
    else if (c.scheme === "dark") assert.deepEqual(got, { dark: c.bg, light: null }, c.id);
    else assert.deepEqual(got, { dark: null, light: c.bg }, c.id);
  }
});
