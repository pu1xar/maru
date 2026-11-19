// The one source of the base colors of both themes (DESIGN.md 7d). The web reads them as CSS
// variables generated from this file (apps/web/src/build/themeColors.ts writes
// theme-colors.generated.css, which index.css's tokens point at); the Android app imports them
// (apps/mobile/src/palette.ts). A color changed here changes both.
//
// Values are `#rrggbb` or `rgba(r, g, b, a)` strings, the forms CSS and React Native both take.
// What the web derives from these (hover tints, color-mix, the desktop backdrop) stays in
// index.css.

/** The role names both themes fill. */
export interface ThemeColors {
  /** The conversation canvas. */
  background: string;
  /** Cards, popovers and the composer's base. */
  card: string;
  /** The sessions sidebar and the side panels. */
  sidebar: string;
  foreground: string;
  mutedForeground: string;
  border: string;
  /** Control outlines (inputs, switches). */
  input: string;
  /** The accent, and the text on it. */
  primary: string;
  primaryForeground: string;
  /** Hover and selection fill under controls. */
  accent: string;
  /** The user's message bubble. */
  messageSurface: string;
  /** Code blocks in a conversation. */
  codeBackground: string;
  error: string;
  errorForeground: string;
  success: string;
  successForeground: string;
  warning: string;
  warningForeground: string;
  /** Dots and fills of the running state. */
  info: string;
  /** Links and the running state's text and marks. */
  infoForeground: string;
  /** Something waits for the user's answer (a question or an approval). */
  attention: string;
}

/** How much of its level a see-through surface (the user's bubble, dialogs, the composer) shows. */
export const glassOpacity = 0.8;

/**
 * The dark theme's five surface levels, one chroma (zero) and five lightnesses.
 * 0 canvas, 1 sidebar, side panels, cards, popovers, 2 code blocks and the composer,
 * 3 strong hover and selection, 4 strongest emphasis.
 */
export const darkSurfaces = ["#000000", "#0f0f0f", "#1c1c1c", "#2b2b2b", "#373737"] as const;

/** `#rrggbb` with an opacity, as the `rgba(...)` string both CSS and React Native take. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`withAlpha takes #rrggbb, got ${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h as string, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const light: ThemeColors = {
  background: "#fcfcfc", // zinc-25
  card: "#ffffff",
  sidebar: "#fafafa", // zinc-50
  foreground: "#18181b", // zinc-900
  mutedForeground: "#62626d", // between zinc-500 and zinc-600, 4.5:1 on the light fills
  border: "#e4e4e7", // zinc-200
  input: "#d4d4d8", // zinc-300
  // The light accents are one family of calmer colors (user 2026-11-17: the blue and the red were
  // too vivid): chroma about 0.10 to 0.17 instead of Tailwind's 0.2+. Text colors reach 4.5:1 on the
  // canvas, dot and icon colors 3:1, the error fill 4.5:1 under white text (a destructive button).
  primary: "#3568b2", // oklch(0.52 0.13 258), white text 5.6:1
  primaryForeground: "#ffffff",
  accent: "#f4f4f5", // zinc-100
  messageSurface: "#ebebed", // zinc-200 at 55% over zinc-100
  codeBackground: "#f1f1f3",
  error: "#c13c3b", // oklch(0.55 0.17 25), white text 5.3:1
  errorForeground: "#a83634", // oklch(0.50 0.15 25), 6.4:1
  success: "#288f5e", // oklch(0.58 0.12 158), 4.0:1
  successForeground: "#1c6e47", // oklch(0.48 0.10 158), 6.1:1
  warning: "#c87b13", // oklch(0.65 0.14 66), 3.3:1
  warningForeground: "#8c541f", // oklch(0.50 0.10 60), 6.1:1
  info: "#4682cc", // oklch(0.60 0.13 255), 3.9:1
  infoForeground: "#3568b2", // the primary
  attention: "#5955b0", // oklch(0.50 0.14 282), 6.2:1
};

const dark: ThemeColors = {
  background: darkSurfaces[0],
  card: darkSurfaces[1],
  sidebar: darkSurfaces[1],
  foreground: "#f5f5f5", // neutral-100
  mutedForeground: "#a1a1a1", // neutral-400
  border: "rgba(255, 255, 255, 0.08)",
  input: "rgba(255, 255, 255, 0.11)",
  primary: "#346bf1",
  primaryForeground: "#ffffff",
  accent: "rgba(255, 255, 255, 0.04)",
  // Opaque level 1 (user 2026-11-18: no transparency on the default bubble).
  messageSurface: darkSurfaces[1],
  codeBackground: darkSurfaces[2],
  error: "#fb414a", // red-500 at 90% over white
  errorForeground: "#ff6467", // red-400
  success: "#00bc7d", // emerald-500
  successForeground: "#00d492", // emerald-400
  warning: "#fe9a00", // amber-500
  warningForeground: "#ffb900", // amber-400
  info: "#2b7fff", // blue-500
  infoForeground: "#51a2ff", // blue-400
  attention: "#a3b3ff", // indigo-300
};

export const themeColors = { light, dark } as const;
