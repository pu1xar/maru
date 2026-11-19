// The main window's place and size across launches (DESIGN.md 2e), after T3 Code
// (DesktopAppSettings.ts mainWindowBounds and mainWindowMaximized, DesktopWindow.ts): saved 500 ms
// after the last move or resize and at close, restored only when it still lies on a display.

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds: Bounds;
  maximized: boolean;
}

/** T3 Code's default and minimum sizes. */
export const DEFAULT_SIZE = { width: 1100, height: 780 } as const;
export const MIN_SIZE = { width: 400, height: 360 } as const;
export const SAVE_DELAY_MS = 500;

function isBounds(v: unknown): v is Bounds {
  const b = v as Bounds;
  return !!b && [b.x, b.y, b.width, b.height].every((n) => typeof n === "number" && Number.isFinite(n));
}

/** A saved file's state, or null when it is not one. */
export function parseWindowState(text: string): WindowState | null {
  try {
    const v = JSON.parse(text) as Partial<WindowState>;
    return isBounds(v.bounds) ? { bounds: v.bounds, maximized: v.maximized === true } : null;
  } catch {
    return null;
  }
}

/**
 * The saved bounds when the window fits inside one display's work area as it is now (a monitor
 * may have been unplugged since), else null for the default place.
 */
export function restorableBounds(saved: WindowState | null, workAreas: Bounds[]): Bounds | null {
  if (!saved) return null;
  const b = saved.bounds;
  if (b.width < MIN_SIZE.width || b.height < MIN_SIZE.height) return null;
  const inside = workAreas.some((a) => b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height);
  return inside ? b : null;
}
