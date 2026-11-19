// The window's title bar and backdrop (DESIGN.md 2e, title bar와 창 배경), after T3 Code's
// DesktopWindow.ts getWindowTitleBarOptions and syncMacosWindowButtons.
//
// Mac: no title bar of its own (`hiddenInset`); the traffic lights sit in the page's top bar, 16 px
// from the left edge and centred on the bar's height, and the page keeps 90 px clear for them
// (the preload's --desktop-window-controls-inset). The bar's height follows the page's UI scale
// (2.75rem), so the page reports it and the buttons move with it.
// Windows: a hidden title bar with the system's minimize, maximize and close drawn over the page's
// top bar (`titleBarOverlay`), the bar's height, on a transparent color, with symbols in the page's
// theme. The page keeps their width clear through env(titlebar-area-*).
// Backdrop: Mac vibrancy, Windows 11 acrylic, behind what the page draws transparent.
import type { BrowserWindowConstructorOptions } from "electron";

/** The page's top bar at 100 % UI scale (web index.css --workspace-topbar-height, 2.75rem). */
export const TOPBAR_PX = 44;
/** T3's traffic light placement: x, and the button radius the centring takes off. */
export const MAC_BUTTON_X = 16;
export const MAC_BUTTON_RADIUS = 7;
/** What the page keeps clear on a Mac, in window points (T3's preload). */
export const MAC_CONTROLS_INSET = 90;

/** T3: a fully transparent overlay color does not work everywhere, so one step of alpha. */
const OVERLAY_COLOR = "#01000000";
const OVERLAY_SYMBOL = { light: "#1f2937", dark: "#f8fafc" };
/** maru's page background (index.css --background): black in the dark theme, zinc-25 in the light. */
export const PAGE_BACKGROUND = { dark: "#000000", light: "#fcfcfc" };

export interface BarRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The height of the top bar that lies under a point, or null when none does. The window's controls
 * sit over one bar: the traffic lights over the bar at the top left, the Windows buttons over the
 * one at the top right. That bar is the sidebar's header while the sidebar is open and the tab
 * strip (a shorter bar, DESIGN.md 6k) once it is collapsed, so the buttons are placed by the bar
 * they are over and not by the first bar in the document.
 */
export function barHeightAt(bars: readonly BarRect[], x: number, y: number): number | null {
  const hit = bars.find((b) => x >= b.left && x < b.right && y >= b.top && y < b.bottom);
  return hit ? hit.bottom - hit.top : null;
}

export function macButtonPosition(topbarPx: number): { x: number; y: number } {
  return { x: MAC_BUTTON_X, y: Math.round(topbarPx / 2 - MAC_BUTTON_RADIUS) };
}

export function overlayOptions(dark: boolean, topbarPx: number): { color: string; symbolColor: string; height: number } {
  return { color: OVERLAY_COLOR, symbolColor: dark ? OVERLAY_SYMBOL.dark : OVERLAY_SYMBOL.light, height: Math.round(topbarPx) };
}

type TitleBar = Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "trafficLightPosition" | "titleBarOverlay">;
type Backdrop = Pick<BrowserWindowConstructorOptions, "vibrancy" | "visualEffectState" | "backgroundMaterial" | "backgroundColor" | "transparent">;

export function titleBarOptions(platform: NodeJS.Platform, dark: boolean, topbarPx = TOPBAR_PX): TitleBar {
  if (platform === "darwin") return { titleBarStyle: "hiddenInset", trafficLightPosition: macButtonPosition(topbarPx) };
  if (platform === "win32") return { titleBarStyle: "hidden", titleBarOverlay: overlayOptions(dark, topbarPx) };
  return {};
}

/** The background a window gets: see-through behind the page when translucent, else the page's color. */
export function backgroundColor(translucent: boolean, dark: boolean): string {
  return translucent ? "#00000000" : dark ? PAGE_BACKGROUND.dark : PAGE_BACKGROUND.light;
}

export function backdropOptions(platform: NodeJS.Platform, translucent: boolean, dark: boolean): Backdrop {
  const color = backgroundColor(translucent && platform !== "linux", dark);
  if (platform === "darwin") {
    // The material follows the window: dimmed while another app is in front, as Finder's sidebar.
    return { backgroundColor: color, visualEffectState: "followWindow", ...(translucent ? { vibrancy: "sidebar" as const } : {}) };
  }
  if (platform === "win32") return { backgroundColor: color, backgroundMaterial: translucent ? "acrylic" : "none" };
  return { backgroundColor: color };
}
