// The desktop app's window backdrop (DESIGN.md 2e, 창 배경): blur and see-through like iTerm's
// transparency, set in Settings, Appearance. Only inside the desktop app (window.maruDesktop); a browser
// keeps an opaque page.
//
// The page draws the chosen parts transparent and the window shows its backdrop there (Mac
// vibrancy, Windows 11 acrylic):
//   off      an opaque window
//   sidebar  the session sidebar only, the Mac convention (Finder, Mail, Notes)
//   all      the sidebar and the conversation, as iTerm does
// Transparency is how much of the backdrop shows through. Dialogs, menus, the composer, cards and
// the terminal mode stay opaque. The root gets `data-desktop-backdrop` and
// `--desktop-backdrop-opacity`; index.css draws from them.
import { useSyncExternalStore } from "react";
import { desktopBridge } from "./desktopBridge.ts";
import { inIntRange, rangeOfSteps } from "./settingControl.logic.ts";

export type WindowBackdrop = "off" | "sidebar" | "all";

export const BACKDROP_CHOICES: ReadonlyArray<{ id: WindowBackdrop; label: string }> = [
  { id: "off", label: "Off" },
  { id: "sidebar", label: "Sidebar" },
  { id: "all", label: "Sidebar and conversation" },
];

/**
 * Percent of the backdrop that shows through. Over the worst backdrop (white behind the dark theme,
 * black behind the light, no blur tint; see worstContrast and its test, which measures every step
 * against the theme tokens), body text keeps 4.5:1 at every step and the muted text up to 10 %,
 * the default.
 */
export const BACKDROP_STEPS = [10, 20, 30, 40] as const;
/** The whole percents a typed transparency may take: from the first to the last step. */
export const BACKDROP_RANGE = rangeOfSteps(BACKDROP_STEPS);

export interface BackdropPrefs {
  backdrop: WindowBackdrop;
  transparency: number;
}

export const DEFAULT_BACKDROP: BackdropPrefs = { backdrop: "all", transparency: 30 }; // the user's setting, 2026-11-16

const KEY = "maru_window_backdrop";

export function normalizeBackdrop(value: unknown): BackdropPrefs {
  const v = (value ?? {}) as Partial<BackdropPrefs>;
  const backdrop = BACKDROP_CHOICES.some((c) => c.id === v.backdrop) ? (v.backdrop as WindowBackdrop) : DEFAULT_BACKDROP.backdrop;
  const transparency = inIntRange(v.transparency, BACKDROP_RANGE) ? v.transparency : DEFAULT_BACKDROP.transparency;
  return { backdrop, transparency };
}

function read(): BackdropPrefs {
  try {
    return normalizeBackdrop(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return DEFAULT_BACKDROP;
  }
}

/** The root's attributes for a choice (none in a browser), and whether the window shows its backdrop. */
export function backdropRoot(prefs: BackdropPrefs, inDesktop: boolean): { attr: WindowBackdrop | null; opacity: string | null; translucent: boolean } {
  if (!inDesktop || prefs.backdrop === "off") return { attr: null, opacity: null, translucent: false };
  return { attr: prefs.backdrop, opacity: `${100 - prefs.transparency}%`, translucent: true };
}

export function applyBackdrop(prefs: BackdropPrefs, root: HTMLElement = document.documentElement): void {
  const bridge = desktopBridge();
  const r = backdropRoot(prefs, bridge !== null);
  if (r.attr) root.dataset.desktopBackdrop = r.attr;
  else delete root.dataset.desktopBackdrop;
  if (r.opacity) root.style.setProperty("--desktop-backdrop-opacity", r.opacity);
  else root.style.removeProperty("--desktop-backdrop-opacity");
  void bridge?.setWindowBackdrop(r.translucent).catch(() => {});
}

let current: BackdropPrefs | null = null;
const listeners = new Set<() => void>();

export function initBackdrop(): void {
  current = read();
  applyBackdrop(current);
}

export function useBackdrop(): BackdropPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (current ??= read()),
  );
}

export function setBackdrop(change: Partial<BackdropPrefs>): void {
  current = normalizeBackdrop({ ...(current ?? read()), ...change });
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // The choice holds until the page reloads.
  }
  applyBackdrop(current);
  for (const l of [...listeners]) l();
}

// Contrast over a see-through surface (WCAG 2 relative luminance). The page's surface at `opacity`
// is composited over whatever the window shows behind it; the worst case is the backdrop at the
// far end from the text: white behind light text, black behind dark text. The real backdrop is a
// blurred, tinted material, so the worst case is an upper bound on how much contrast is lost.

type Rgb = readonly [number, number, number];

export function parseRgb(css: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as unknown as Rgb;
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(css);
  if (!m) throw new Error(`not a color: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `surface` at `opacity` (0..1) over `behind`, blended the way the compositor blends (sRGB). */
export function composite(surface: Rgb, opacity: number, behind: Rgb): Rgb {
  return surface.map((c, i) => c * opacity + behind[i]! * (1 - opacity)) as unknown as Rgb;
}

/** The lower contrast of `text` on `surface` at `opacity` over a black and over a white backdrop. */
export function worstContrast(text: Rgb, surface: Rgb, opacity: number): number {
  return Math.min(contrast(text, composite(surface, opacity, [0, 0, 0])), contrast(text, composite(surface, opacity, [255, 255, 255])));
}
