// The colors of the input area that the web derives in CSS (ThreadComposer's COMPOSER_SURFACE_CLASS,
// the error and notice cards, Tailwind's `/60` opacity steps), worked out from the shared theme
// colors so the app draws the same fills. Pure; no React Native.
import { glassOpacity, themeColors, withAlpha } from "../../../../packages/shared/src/themeColors.ts";
import type { Palette } from "../palette.ts";

export type Scheme = "light" | "dark";

/** A color with its alpha multiplied by `k` (Tailwind's `bg-x/60`): takes `#rrggbb` and `rgba(r, g, b, a)`. */
export function scaleAlpha(color: string, k: number): string {
  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(color);
  if (rgba) return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, ${Math.round(Number(rgba[4]) * k * 1000) / 1000})`;
  return withAlpha(color, k);
}

export interface ComposerColors {
  /** The composer box: the card in light, surface level 2 in dark, at the glass opacity. */
  box: string;
  /** The box's 1px outline, and its step while focus is inside. */
  outline: string;
  outlineFocus: string;
  /** Control outlines (web --input): the answer fields, the option marks, the outline button. */
  input: string;
  /** Hover and selection fill (web --accent). */
  fill: string;
  /** The error card's fill and text (web bg-error-surface, text-error-foreground). */
  errorSurface: string;
  errorText: string;
  /** Warnings (web text-warning-foreground). */
  warnText: string;
  /** The model button's text (web text-foreground/70, in dark text-muted-foreground). */
  modelText: string;
  /** The stop button's fill and a disabled send button's fill (web bg-foreground/12). */
  chip: string;
  /** A picture tile's remove button (web variant media-close: black/65, white, a white/20 ring), the same in both themes. */
  mediaFill: string;
  mediaRing: string;
  mediaIcon: string;
}

export function composerColors(scheme: Scheme, p: Palette): ComposerColors {
  const light = scheme === "light";
  const t = themeColors[scheme];
  return {
    box: withAlpha(light ? p.surface : p.sunken, glassOpacity),
    outline: withAlpha(p.text, light ? 0.08 : 0.05),
    outlineFocus: withAlpha(p.text, light ? 0.22 : 0.16),
    input: t.input,
    fill: t.accent,
    errorSurface: withAlpha(p.danger, light ? 0.08 : 0.16),
    errorText: t.errorForeground,
    warnText: t.warningForeground,
    modelText: light ? withAlpha(p.text, 0.7) : p.muted,
    chip: withAlpha(p.text, 0.12),
    mediaFill: "rgba(0, 0, 0, 0.65)",
    mediaRing: "rgba(255, 255, 255, 0.2)",
    mediaIcon: "#ffffff",
  };
}
