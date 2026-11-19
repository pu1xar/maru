import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  DEFAULT_THEME,
  SYSTEM_DARK_QUERY,
  THEME_KEY,
  THEME_PREFS,
  normalizeTheme,
  readThemePref,
  resolveTheme,
  systemPrefersDark,
} from "./theme.ts";

test("normalizeTheme keeps the offered themes and turns anything else into the default", () => {
  for (const t of THEME_PREFS) assert.equal(normalizeTheme(t.id), t.id);
  for (const v of [null, undefined, "", "Dark", "auto", 1, true, {}, ["dark"]]) assert.equal(normalizeTheme(v), DEFAULT_THEME);
});

test("resolveTheme follows the OS only for system", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  for (const os of [true, false]) {
    assert.equal(resolveTheme("light", os), "light");
    assert.equal(resolveTheme("dark", os), "dark");
  }
});

/** The inline script of index.html that sets the theme before the first paint. */
function bootScript(): string {
  const html = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const found = scripts.filter((s) => s.includes(THEME_KEY));
  assert.equal(found.length, 1, "index.html has one inline script that reads the theme key");
  return found[0]!;
}

/** A storage that holds one value for the theme key, or throws on every read. */
function storage(stored: string | null | "throws") {
  return {
    getItem: (key: string) => {
      if (stored === "throws") throw new Error("storage blocked");
      return key === THEME_KEY ? stored : null;
    },
  };
}

/** A matchMedia answering the dark query, or none at all. */
function media(systemDark: boolean | "none") {
  if (systemDark === "none") return undefined;
  return (query: string) => ({ matches: query === SYSTEM_DARK_QUERY && systemDark });
}

/** Runs the boot script with this storage and OS setting; what it left on the page. */
function runBoot(stored: string | null | "throws", systemDark: boolean | "none") {
  const classes = new Set<string>(["dark"]);
  const metas = [{ content: "#000000", setAttribute(_: string, v: string) { this.content = v; } }];
  const root = {
    classList: { toggle: (name: string, on: boolean) => void (on ? classes.add(name) : classes.delete(name)) },
    style: { backgroundColor: "" },
  };
  const context = {
    window: { localStorage: storage(stored), matchMedia: media(systemDark) },
    document: { documentElement: root, querySelectorAll: () => metas },
  };
  vm.runInNewContext(bootScript(), context);
  return { dark: classes.has("dark"), background: root.style.backgroundColor, meta: metas[0]!.content };
}

/** What theme.ts decides for the same storage and OS setting, through its own reader. */
function runtimeTheme(stored: string | null | "throws", systemDark: boolean | "none") {
  const g = globalThis as { window?: unknown };
  const saved = g.window;
  g.window = { localStorage: storage(stored) };
  try {
    const m = media(systemDark);
    return resolveTheme(readThemePref(), systemPrefersDark(m ? (m(SYSTEM_DARK_QUERY) as MediaQueryList) : null));
  } finally {
    g.window = saved;
  }
}

test("index.html's boot script and theme.ts pick the same theme for every stored value and OS setting", () => {
  assert.ok(bootScript().includes(`"${SYSTEM_DARK_QUERY}"`), "the boot script asks the same media query");
  const stored = [null, ...THEME_PREFS.map((t) => JSON.stringify(t.id)), '"auto"', "not json", "1", "null", "throws"] as const;
  for (const value of stored) {
    for (const systemDark of [true, false, "none"] as const) {
      const expected = runtimeTheme(value, systemDark);
      const got = runBoot(value, systemDark);
      assert.equal(got.dark, expected === "dark", `stored ${value}, system dark ${systemDark}`);
      assert.equal(got.background, expected === "dark" ? "#000000" : "#fcfcfc");
      assert.equal(got.meta, got.background);
    }
  }
});
