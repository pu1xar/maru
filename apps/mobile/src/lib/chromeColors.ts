// The colors of the app's screen chrome (header, sheets, forms, toasts, settings rows) that the web
// takes from tokens the palette has no role for: --accent, --input, --muted, --popover, the
// -foreground status texts and the surfaces tinted from them. They come from the same source as the
// palette (packages/shared themeColors.ts), by the web token's name, with the web's strengths
// (index.css dialog-glass, dropdown-glass, ui/button, ui/input, settingsLayout). React Native-free,
// by path, so a node test reads it.
import { themeColors, withAlpha, type ThemeColors } from "../../../../packages/shared/src/themeColors.ts";

/** `color` with its opacity multiplied by `k` (a rgba() string or a #rrggbb). */
export function scaleAlpha(color: string, k: number): string {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(color);
  if (!m) return withAlpha(color, k);
  const alpha = Math.round(Number(m[4]) * k * 10000) / 10000;
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
}

export interface ChromeColors {
  /** Hover, pressed and selected fill under controls (--accent). */
  accent: string;
  /** Control outlines (--input). */
  input: string;
  /** The field's fill: --background in light, --input at 32% in dark. */
  inputFill: string;
  /** An outline button's fill (--popover in light, --input at 32% in dark). */
  outlineFill: string;
  /** Quiet fills (--muted): zinc-50 in light, white at 3% in dark. */
  muted: string;
  /** The segmented ToggleGroup's track (--input at 40%). */
  segmentTrack: string;
  /** The dialog footer's band (--muted at 72%). */
  footerFill: string;
  /** A sheet's top edge (dialog-glass): the foreground at 10% in light, white at 8% in dark. */
  sheetBorder: string;
  /** A popup's outline (dropdown-glass): the foreground at 10%. */
  popupBorder: string;
  /** The layer behind a sheet (dialog-backdrop): the canvas at 60% in light, 64% in dark. */
  backdrop: string;
  /** Status texts and the fills tinted from their base (error-surface, warning-surface: 8% light, 16% dark). */
  errorForeground: string;
  errorSurface: string;
  warningForeground: string;
  /** A warning notice's fill (bg-warning/10). */
  warningNotice: string;
  successForeground: string;
  /** Toast icons (--destructive, --success, --info, --warning). */
  toastIcon: { error: string; success: string; info: string; warning: string };
  /** A settings group (settingsLayout): --card at 40%, its outline --border at 60%, its dividers at 50%. */
  groupFill: string;
  groupBorder: string;
  groupDivider: string;
  /** The text on a destructive button. */
  onDestructive: string;
  /** A found text in the all-session search results (ConversationSearchResults mark). */
  hitMark: { bg: string; fg: string };
}

export function chromeColorsFrom(c: ThemeColors, dark: boolean): ChromeColors {
  const tint = dark ? 0.16 : 0.08;
  const muted = dark ? "rgba(255, 255, 255, 0.03)" : c.sidebar;
  const inputFill = dark ? scaleAlpha(c.input, 0.32) : c.background;
  return {
    accent: c.accent,
    input: c.input,
    inputFill,
    outlineFill: dark ? scaleAlpha(c.input, 0.32) : c.card,
    muted,
    segmentTrack: scaleAlpha(c.input, 0.4),
    footerFill: scaleAlpha(muted, 0.72),
    sheetBorder: dark ? "rgba(255, 255, 255, 0.08)" : withAlpha(c.foreground, 0.1),
    popupBorder: withAlpha(c.foreground, 0.1),
    backdrop: withAlpha(c.background, dark ? 0.64 : 0.6),
    errorForeground: c.errorForeground,
    errorSurface: withAlpha(c.error, tint),
    warningForeground: c.warningForeground,
    warningNotice: withAlpha(c.warning, 0.1),
    successForeground: c.successForeground,
    toastIcon: { error: c.error, success: c.success, info: c.info, warning: c.warning },
    groupFill: withAlpha(c.card, 0.4),
    groupBorder: scaleAlpha(c.border, 0.6),
    groupDivider: scaleAlpha(c.border, 0.5),
    onDestructive: "#ffffff",
    // oklch(0.915 0.11 85) with oklch(0.216 0.028 77), and in dark oklch(0.55 0.1 85) with oklch(0.97 0 0).
    hitMark: dark ? { bg: "#8c6c1f", fg: "#f5f5f5" } : { bg: "#ffde8b", fg: "#21180a" },
  };
}

export const darkChrome: ChromeColors = chromeColorsFrom(themeColors.dark, true);
export const lightChrome: ChromeColors = chromeColorsFrom(themeColors.light, false);
