// The colors the conversation draws that the web derives from its theme tokens: text-level status
// colors (the web's -foreground tokens), the find's painted ranges, and the chat code surface with
// its border and text. React Native-free, so node tests run them. Every value starts from the one
// source (packages/shared themeColors.ts, through the app's palette) and the web's own constants
// in index.css (chat code, find highlight).
import { themeColors } from "../../../../packages/shared/src/themeColors.ts";
import { lightPalette, type Palette } from "../palette.ts";
import { withAlpha } from "../components/markdownModel.ts";

/** Whether the palette is the light theme's (the settings derive palettes from it, so this reads the canvas color, not the object). */
export function isLightPalette(p: Palette): boolean {
  return p.bg === lightPalette.bg;
}

type Rgba = [number, number, number, number];

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()` as channels, or null for a form the theme does not use. */
export function parseColor(color: string): Rgba | null {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(c);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(c);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4] === undefined ? 1 : Number(fn[4])];
  return null;
}

function toCss([r, g, b, a]: Rgba): string {
  const ch = (v: number) => Math.round(Math.min(255, Math.max(0, v)));
  return a >= 1
    ? `#${[r, g, b].map((v) => ch(v).toString(16).padStart(2, "0")).join("")}`
    : `rgba(${ch(r)}, ${ch(g)}, ${ch(b)}, ${Math.round(a * 1000) / 1000})`;
}

/** `a` moved toward `b` by `amount` (0..1), channel by channel (the web's color-mix, in sRGB). */
export function mixColors(a: string, b: string, amount: number): string {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return a;
  return toCss([0, 1, 2, 3].map((i) => x[i]! + (y[i]! - x[i]!) * amount) as Rgba);
}

/** `fg` painted over the opaque `bg`: the one color a see-through fg shows. */
export function blendOver(fg: string, bg: string): string {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) return fg;
  return toCss([0, 1, 2].map((i) => f[i]! * f[3] + b[i]! * (1 - f[3])).concat(1) as Rgba);
}

/**
 * The web's text colors for a state (text-destructive-foreground, text-success-foreground,
 * text-warning-foreground), its control outline (--input) and the quiet surface (--muted). The palette's `danger`, `ok` and
 * `warn` are the fills (icons, dots, washes); text takes these.
 */
export function tones(p: Palette) {
  const c = isLightPalette(p) ? themeColors.light : themeColors.dark;
  return {
    error: c.errorForeground,
    success: c.successForeground,
    warning: c.warningForeground,
    input: c.input,
    /** The quiet surface of a chip or a badge (--muted: zinc-50, or white at 3% on dark). */
    muted: isLightPalette(p) ? "#fafafa" : "rgba(255, 255, 255, 0.03)",
  };
}

/** A find's painted range (index.css ::highlight maru-thread-find and maru-thread-find-active). */
export function findPaint(p: Palette, active: boolean): { backgroundColor: string; color: string } {
  if (active) return { backgroundColor: "#eea52b", color: "#21180a" };
  return isLightPalette(p) ? { backgroundColor: "#ffde8b", color: "#21180a" } : { backgroundColor: "#8c6c1f", color: "#f5f5f5" };
}

/**
 * The chat code surface (index.css chat-code tokens): the code background (in the user's bubble it
 * moves toward white by 60% in the light theme), a 1px border that is the surface moved toward the
 * code text by 20% (light) or 16% (dark), the text at 90% and the header label at 72%.
 */
export function chatCode(p: Palette & { codeScheme?: "light" | "dark" }, inBubble: boolean) {
  const light = isLightPalette(p);
  // A custom code background names the color scheme its text reads in (web data-chat-code-scheme); a preset keeps the theme's.
  const codeLight = p.codeScheme ? p.codeScheme === "light" : light;
  const ink = codeLight ? "#18181b" : "#f5f5f5";
  const surface = inBubble && light ? mixColors(p.code, "#ffffff", 0.6) : p.code;
  return {
    surface,
    border: mixColors(surface, ink, light ? 0.2 : 0.16),
    text: withAlpha(ink, 0.9),
    label: withAlpha(ink, 0.72),
    ink,
    /** The pressed wrap button (--secondary). */
    secondary: light ? "#fafafa" : "rgba(255, 255, 255, 0.03)",
  };
}
