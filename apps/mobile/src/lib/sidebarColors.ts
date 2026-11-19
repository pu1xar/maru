// The drawer's colors that the web's sidebar takes from tokens the app palette has no role for
// (--sidebar, --sidebar-row-active, the badge and pill tints, the usage track). They are read from
// the same source as the palette (packages/shared themeColors.ts), by the web token's name, and
// the tint strengths are the web's (ui/badge.tsx: 8% light and 16% dark; VersionNotice: 12%).
// React Native-free, by path, so a node test reads it.
import { themeColors, withAlpha, type ThemeColors } from "../../../../packages/shared/src/themeColors.ts";

export type BadgeVariant = "warning" | "info" | "error" | "success" | "outline";

export interface SidebarColors {
  /** The drawer's surface (--sidebar). */
  bg: string;
  /** The open session's row (--sidebar-row-active). */
  rowActive: string;
  /** The light theme rings the open row (border at 70%); the dark theme does not. */
  rowActiveRing: string | null;
  /** Dots and fills (--info, --warning, --error) and the error text color. */
  info: string;
  warning: string;
  error: string;
  errorForeground: string;
  /** Header count badges: a tint of the fill with the foreground text. */
  badge: Record<BadgeVariant, { bg: string; fg: string }>;
  /** The update pill (--info at 12%, --info-foreground text). */
  pill: { bg: string; fg: string };
  /** The empty track of a usage bar (--foreground at 10%), and its amber form (--warning at 40%). */
  track: string;
  warningTrack: string;
}

export function sidebarColorsFrom(c: ThemeColors, dark: boolean): SidebarColors {
  const tint = dark ? 0.16 : 0.08;
  return {
    bg: c.sidebar,
    rowActive: dark ? c.accent : c.card,
    rowActiveRing: dark ? null : withAlpha(c.border, 0.7),
    info: c.info,
    warning: c.warning,
    error: c.error,
    errorForeground: c.errorForeground,
    badge: {
      warning: { bg: withAlpha(c.warning, tint), fg: c.warningForeground },
      info: { bg: withAlpha(c.info, tint), fg: c.infoForeground },
      error: { bg: withAlpha(c.error, tint), fg: c.errorForeground },
      // The account status badge (settings Accounts page): --success tint, and the outline badge's text on a faint fill.
      success: { bg: withAlpha(c.success, tint), fg: c.successForeground },
      outline: { bg: withAlpha(c.foreground, 0.08), fg: c.foreground },
    },
    pill: { bg: withAlpha(c.info, 0.12), fg: c.infoForeground },
    track: withAlpha(c.foreground, 0.1),
    warningTrack: withAlpha(c.warning, 0.4),
  };
}

export const darkSidebar: SidebarColors = sidebarColorsFrom(themeColors.dark, true);
export const lightSidebar: SidebarColors = sidebarColorsFrom(themeColors.light, false);
