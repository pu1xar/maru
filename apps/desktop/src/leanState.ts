// The lean windows' places and the open request's check (DESIGN.md 6x, 2e): each session's lean
// window remembers its own size and place across opens, in `lean-windows.json` next to the main
// window's state. Pure rules; leanWindows.ts runs them.
import { isServerUrl } from "./links.ts";
import { restorableBounds, type Bounds } from "./windowState.ts";

export const LEAN_DEFAULT_SIZE = { width: 480, height: 680 } as const;
export const LEAN_MIN_SIZE = { width: 320, height: 320 } as const;

export type LeanStates = Record<string, Bounds>;

export function parseLeanStates(text: string | null): LeanStates {
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: LeanStates = {};
    for (const [key, b] of Object.entries(v as Record<string, unknown>)) {
      const o = b as Partial<Bounds> | null;
      if (o && [o.x, o.y, o.width, o.height].every((n) => typeof n === "number" && Number.isFinite(n))) out[key] = o as Bounds;
    }
    return out;
  } catch {
    return {};
  }
}

function areaFor(workAreas: Bounds[], x: number, y: number): Bounds | null {
  return workAreas.find((a) => x >= a.x && y >= a.y && x < a.x + a.width && y < a.y + a.height) ?? workAreas[0] ?? null;
}

/**
 * Where a lean window opens. The size is the session's last one (else the default). The place is
 * the drop's screen position when there is one (the window centred on it, a little below the
 * pointer's top), else the last place if it still lies on a display; with neither, no place (the
 * system centres it). The result is kept inside the display's work area.
 */
export function leanBounds(
  saved: Bounds | null,
  at: { x: number; y: number } | null,
  workAreas: Bounds[],
): { x?: number; y?: number; width: number; height: number } {
  const restored = restorableBounds(saved ? { bounds: saved, maximized: false } : null, workAreas);
  const size = saved && saved.width >= LEAN_MIN_SIZE.width && saved.height >= LEAN_MIN_SIZE.height
    ? { width: Math.round(saved.width), height: Math.round(saved.height) }
    : { ...LEAN_DEFAULT_SIZE };
  if (at) {
    const area = areaFor(workAreas, at.x, at.y);
    let x = Math.round(at.x - size.width / 2);
    let y = Math.round(at.y - 16);
    if (area) {
      const width = Math.min(size.width, area.width);
      const height = Math.min(size.height, area.height);
      x = Math.min(Math.max(x, area.x), area.x + area.width - width);
      y = Math.min(Math.max(y, area.y), area.y + area.height - height);
      return { x, y, width, height };
    }
    return { x, y, ...size };
  }
  if (restored) return { x: restored.x, y: restored.y, width: restored.width, height: restored.height };
  return size;
}

export interface LeanRequest {
  key: string;
  url: string;
  at: { x: number; y: number } | null;
}

/**
 * An open request from the page, checked: the key is a session key (provider:account:id, no
 * control characters) and the path is an address on the paired server that asks for the lean window
 * of the one session. The window loads the address rebuilt from the server's origin, never the
 * text it was given.
 */
export function readLeanRequest(raw: unknown, server: string | null): LeanRequest | null {
  if (!raw || typeof raw !== "object" || server === null) return null;
  const r = raw as { key?: unknown; path?: unknown; at?: unknown };
  if (typeof r.key !== "string" || !/^[A-Za-z0-9_.@:-]{1,256}$/.test(r.key)) return null;
  if (typeof r.path !== "string" || r.path.length > 600 || !r.path.startsWith("/") || r.path.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(r.path, `${server}/`);
  } catch {
    return null;
  }
  if (!isServerUrl(url.href, server) || url.pathname !== "/" || url.searchParams.get("window") !== "lean") return null;
  const id = url.searchParams.get("s");
  if (!id || !r.key.endsWith(id)) return null;
  const at = r.at as { x?: unknown; y?: unknown } | null | undefined;
  const point = at && typeof at.x === "number" && typeof at.y === "number" && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: at.x, y: at.y } : null;
  const clean = new URL("/", `${server}/`);
  clean.searchParams.set("s", id);
  clean.searchParams.set("window", "lean");
  return { key: r.key, url: clean.href, at: point };
}
