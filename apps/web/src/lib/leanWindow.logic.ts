// The lean window's rules (DESIGN.md 6x): one session in a window of its own that shows the
// conversation with its header and the composer, with no sidebar, tab strip or right panel. This
// file holds what is decided without a page: the address, what a drag or menu choice does, the list
// of open lean windows, and the popup's features. lib/leanWindow.ts runs it.

export const LEAN_PARAM = "window";
export const LEAN_VALUE = "lean";

/** Whether the address asks for the lean window (`?window=lean`). */
export function isLeanSearch(search: string): boolean {
  return new URLSearchParams(search).get(LEAN_PARAM) === LEAN_VALUE;
}

/** The lean window's address for a session: `/?s=<id>&window=lean` (the id is the part after the last `:`). */
export function leanPath(sessionKey: string): string {
  const at = sessionKey.lastIndexOf(":");
  const id = at === -1 ? sessionKey : sessionKey.slice(at + 1);
  const q = new URLSearchParams({ s: id, [LEAN_PARAM]: LEAN_VALUE });
  return `/?${q.toString()}`;
}

/**
 * The drag type of a lean window's header in a browser (DESIGN.md 6x): its data is the session key.
 * A page that holds the split view takes it as a drop (components/ExternalSessionDrop.tsx).
 */
export const SESSION_DRAG_TYPE = "application/x-maru-session";

/** Whether a drop merges the lean window into the split view and so closes it: the session is now in a pane. */
export function closesLeanWindow(outcome: string): boolean {
  return outcome === "placed" || outcome === "focused";
}

// ---- Dragging out of the window ----

export interface Size {
  w: number;
  h: number;
}

/**
 * The pointer is outside the page's window. While a mouse button is held Chromium keeps sending
 * the page the pointer's moves and its release (implicit mouse capture), with coordinates beyond
 * the viewport, so this is the whole test. No pointer yet counts as inside.
 */
export function pointerOutside(p: { x: number; y: number } | null, viewport: Size): boolean {
  if (!p) return false;
  return p.x < 0 || p.y < 0 || p.x >= viewport.w || p.y >= viewport.h;
}

/** What is being dragged: a sidebar session row, or a split view pane (by its header). */
export type DragOrigin =
  | { kind: "sidebar"; sessionKey: string }
  | { kind: "pane"; sessionKey: string | null; paneId: string };

/**
 * What ending a drag does.
 *   none    nothing here (a drop inside the window is the sidebar's and the split view's own)
 *   open    a new lean window
 *   focus   the session's lean window already exists: it comes to the front
 * `closePaneId` is the split view pane to remove: only a pane dragged out of the window leaves the
 * split view, a sidebar row leaves the original window as it is.
 */
export type DragOutcome =
  | { type: "none" }
  | { type: "open" | "focus"; sessionKey: string; closePaneId: string | null };

export function dragOutcome(origin: DragOrigin, outside: boolean, open: ReadonlySet<string>): DragOutcome {
  if (!outside || origin.sessionKey === null) return { type: "none" };
  return {
    type: open.has(origin.sessionKey) ? "focus" : "open",
    sessionKey: origin.sessionKey,
    closePaneId: origin.kind === "pane" ? origin.paneId : null,
  };
}

// ---- The list of open lean windows ----

/** Window id to session key. A browser tab's id is its own random one; the desktop app's is the window's number. */
export type LeanRegistry = ReadonlyMap<string, string>;

export type LeanMessage =
  | { type: "open"; id: string; key: string }
  | { type: "close"; id: string }
  /** The whole list, as the desktop app's main process holds it. */
  | { type: "list"; entries: readonly { id: string; key: string }[] };

export const EMPTY_REGISTRY: LeanRegistry = new Map();

/** The registry after a message; the same object when nothing changed (a store can compare it). */
export function applyLeanMessage(reg: LeanRegistry, msg: LeanMessage): LeanRegistry {
  if (msg.type === "open") return reg.get(msg.id) === msg.key ? reg : new Map(reg).set(msg.id, msg.key);
  if (msg.type === "close") {
    if (!reg.has(msg.id)) return reg;
    const next = new Map(reg);
    next.delete(msg.id);
    return next;
  }
  const next = new Map(msg.entries.map((e) => [e.id, e.key] as const));
  if (next.size === reg.size && [...next].every(([id, key]) => reg.get(id) === key)) return reg;
  return next;
}

export function leanKeys(reg: LeanRegistry): ReadonlySet<string> {
  return new Set(reg.values());
}

export function windowIdFor(reg: LeanRegistry, sessionKey: string): string | null {
  for (const [id, key] of reg) if (key === sessionKey) return id;
  return null;
}

/** A session moved to another account: its lean window follows to the new key. */
export function rekeyRegistry(reg: LeanRegistry, from: string, to: string): LeanRegistry {
  if (![...reg.values()].includes(from)) return reg;
  return new Map([...reg].map(([id, key]) => [id, key === from ? to : key] as const));
}

// ---- The browser popup ----

export const LEAN_DEFAULT_SIZE: Size = { w: 480, h: 680 };
export const LEAN_MIN_SIZE: Size = { w: 320, h: 320 };

export type LeanSizes = Record<string, Size>;

export function parseLeanSizes(text: string | null): LeanSizes {
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: LeanSizes = {};
    for (const [key, s] of Object.entries(v as Record<string, unknown>)) {
      const o = s as Partial<Size> | null;
      if (o && typeof o.w === "number" && typeof o.h === "number" && Number.isFinite(o.w) && Number.isFinite(o.h) && o.w >= LEAN_MIN_SIZE.w && o.h >= LEAN_MIN_SIZE.h) {
        out[key] = { w: Math.round(o.w), h: Math.round(o.h) };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function rememberLeanSize(sizes: LeanSizes, key: string, size: Size): LeanSizes {
  if (size.w < LEAN_MIN_SIZE.w || size.h < LEAN_MIN_SIZE.h) return sizes;
  const cur = sizes[key];
  if (cur && cur.w === Math.round(size.w) && cur.h === Math.round(size.h)) return sizes;
  return { ...sizes, [key]: { w: Math.round(size.w), h: Math.round(size.h) } };
}

/**
 * `window.open` features for the popup: `popup` asks for a window without an address bar or tabs,
 * the size is the session's last one, and the window is centred on the drop's screen position
 * (`at`) when there is one. The browser keeps the window on the screen.
 */
export function popupFeatures(size: Size | undefined, at: { x: number; y: number } | null): string {
  const s = size ?? LEAN_DEFAULT_SIZE;
  const parts = ["popup=yes", `width=${Math.round(s.w)}`, `height=${Math.round(s.h)}`];
  if (at) parts.push(`left=${Math.max(0, Math.round(at.x - s.w / 2))}`, `top=${Math.max(0, Math.round(at.y - 16))}`);
  return parts.join(",");
}

/** The name a session's popup gets, so a second `window.open` for the session reaches the same window. */
export function popupName(sessionKey: string): string {
  return `maru-lean-${sessionKey.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}
