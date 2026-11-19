// A lean window moved over the main window goes back into its split view (DESIGN.md 6x). The OS
// moves the window (its header is the window's drag region), so the page never sees a drag: the
// main process watches the lean window's `move` events and the cursor, tells the main page where
// the cursor is while it is over the page (the page draws the drop preview), and when the window is
// let go over the page it asks the page to place the session there. Everything that is decided
// without Electron is here.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function inside(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

/**
 * The cursor in the page's client pixels, or null when it is outside the content area. `bounds` is
 * the window's content area and the cursor in screen points; a page zoomed by `zoom` has client
 * pixels that are 1/zoom of a screen point.
 */
export function contentPoint(cursor: Point, bounds: Rect, zoom: number): Point | null {
  if (!inside(bounds, cursor) || !(zoom > 0)) return null;
  return { x: (cursor.x - bounds.x) / zoom, y: (cursor.y - bounds.y) / zoom };
}

/** How far outside the lean window the cursor may be while the window still follows it (the OS lags a frame behind a fast drag). */
const GRAB_SLACK = 40;

export interface TrackerDeps {
  /** The cursor in screen points. */
  cursor(): Point;
  /** The lean window's bounds in screen points. */
  windowBounds(): Rect;
  /** The cursor in the main page's client pixels; null when it is not over the page (or the page is not the app). */
  mainPoint(cursor: Point): Point | null;
  /** The cursor is over the main page at this point (null: it is not any more). */
  preview(p: Point | null): void;
  /** The window was let go over the main page at this point. */
  drop(p: Point): void;
  /**
   * How the end of a move is known. A number: the window has not moved for that many ms (macOS,
   * where `moved` is another name for `move` and the OS gives no end of the move). null: the
   * platform's own `moved` event ends it (Windows), and `ended()` is what calls.
   */
  idleMs: number | null;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/**
 * One lean window's move. `moved()` is called for each `move` event; `ended()` for the platform's
 * own end of a move. A move counts only while the cursor is on the lean window (the user holds its
 * header); a window moved by the program, with the cursor elsewhere, is not a drag.
 */
export class SplitDragTracker {
  private deps: TrackerDeps;
  private timer: unknown = null;
  private shown = false;

  constructor(deps: TrackerDeps) {
    this.deps = deps;
  }

  private grabbed(cursor: Point): boolean {
    const b = this.deps.windowBounds();
    return inside({ x: b.x - GRAB_SLACK, y: b.y - GRAB_SLACK, width: b.width + 2 * GRAB_SLACK, height: b.height + 2 * GRAB_SLACK }, cursor);
  }

  moved(): void {
    const cursor = this.deps.cursor();
    if (!this.grabbed(cursor)) return this.hide();
    const p = this.deps.mainPoint(cursor);
    if (p) {
      this.shown = true;
      this.deps.preview(p);
    } else this.hide();
    if (this.deps.idleMs !== null) {
      if (this.timer !== null) this.deps.clearTimer(this.timer);
      this.timer = this.deps.setTimer(() => this.ended(), this.deps.idleMs);
    }
  }

  /** The window was let go: over the page it is a drop, anywhere else nothing happens. */
  ended(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    const cursor = this.deps.cursor();
    const p = this.grabbed(cursor) ? this.deps.mainPoint(cursor) : null;
    this.hide();
    if (p) this.deps.drop(p);
  }

  /** The window closed. */
  dispose(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.hide();
  }

  private hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.deps.preview(null);
  }
}

/**
 * The answers the main page owes for drops it was asked to place. A drop is a request with an id;
 * the page's reply resolves it. A page that never answers (reloading, not the app) resolves it
 * "none" after `timeoutMs`.
 */
export class DropReplies {
  private pending = new Map<string, { resolve: (outcome: string) => void; timer: NodeJS.Timeout }>();
  private n = 0;

  ask(send: (id: string) => void, timeoutMs: number): Promise<string> {
    const id = `d${++this.n}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve("none");
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      send(id);
    });
  }

  /** The page's answer; false for an id that is not waiting (late or made up). */
  answer(id: string, outcome: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(outcome);
    return true;
  }
}

/** Whether the page's outcome means the session is now in a pane, so the lean window closes. */
export function closesAfter(outcome: string): boolean {
  return outcome === "placed" || outcome === "focused";
}
