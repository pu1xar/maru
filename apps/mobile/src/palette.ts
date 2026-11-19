// The app's colors are the web's: packages/shared's themeColors.ts is the one source, and this file
// names the app's roles after the web's tokens (DESIGN.md 7d). React Native-free, and it reads the file by
// path (a node test cannot resolve @maru/shared here; Metro watches packages/shared).
import { themeColors, type ThemeColors } from "../../../packages/shared/src/themeColors.ts";

export interface Palette {
  /** The conversation canvas (web --background). */
  bg: string;
  /** Cards, sheets and the composer (--card). */
  surface: string;
  /** Wells under surfaces: the composer's field and code (--chat-code-background). */
  sunken: string;
  border: string;
  text: string;
  muted: string;
  /** The accent (--primary) and the text on it. */
  accent: string;
  onAccent: string;
  /** The user's bubble (--message-surface). */
  userBubble: string;
  danger: string;
  ok: string;
  warn: string;
  /** Links and the running state (--info-foreground). */
  info: string;
  /** Waiting for the user's answer (--attention). */
  attention: string;
  /** The dim layer behind a sheet; the app's own, the web has no equal. */
  scrim: string;
  code: string;
}

/** The app's palette of a theme's base colors. */
export function paletteFrom(c: ThemeColors, scrim: string): Palette {
  return {
    bg: c.background,
    surface: c.card,
    sunken: c.codeBackground,
    border: c.border,
    text: c.foreground,
    muted: c.mutedForeground,
    accent: c.primary,
    onAccent: c.primaryForeground,
    userBubble: c.messageSurface,
    danger: c.error,
    ok: c.success,
    warn: c.warning,
    info: c.infoForeground,
    attention: c.attention,
    scrim,
    code: c.codeBackground,
  };
}

export const darkPalette: Palette = paletteFrom(themeColors.dark, "rgba(0,0,0,0.55)");
export const lightPalette: Palette = paletteFrom(themeColors.light, "rgba(0,0,0,0.35)");
