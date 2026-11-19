// The theme's choices and rules without the browser (theme.ts applies them to the page): the offered
// themes, the default, and what "System" resolves to. The Android app reads these too.

export const THEME_PREFS = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

export type ThemePref = (typeof THEME_PREFS)[number]["id"];
export type ResolvedTheme = "light" | "dark";

/** Dark, the only theme maru had before this setting, so an unset browser looks as it did. */
export const DEFAULT_THEME: ThemePref = "dark";

export const THEME_KEY = "maru_theme";

/** A stored value if it is one of the offered themes, else the default. */
export function normalizeTheme(value: unknown): ThemePref {
  return THEME_PREFS.find((t) => t.id === value)?.id ?? DEFAULT_THEME;
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}
