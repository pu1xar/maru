// A lean window's session let go on this page's split view (DESIGN.md 6x). The drag does not come
// through dnd-kit: the desktop app's main process follows the window and the browser hands the page
// HTML5 drag events, so both end here with a point in the page's client pixels.
//
// This module holds what the page shows while the window is over it (`useExternalDrag`, drawn by the
// split view as the sidebar row's drop preview), where the split view's area is (`registerSplitHost`),
// and what letting go does (`placeExternalSession`, lib/paneTabs.ts placeSessionAt).
import { useSyncExternalStore } from "react";

import { openPanesView } from "~/lib/panesRoute";
import type { PlaceOutcome } from "~/lib/paneLayout";
import { placeSessionAt } from "~/lib/paneTabs";
import { toastManager } from "../ui/toast";
import { NO_ROOM, PANE_FRAME } from "./paneFrame";
import { getPaneTabs, updatePaneTabs } from "./paneStore";

export interface ExternalDrag {
  /** The session being carried. */
  key: string;
  /** The pointer in the page's client pixels. */
  x: number;
  y: number;
}

let drag: ExternalDrag | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

/** The window is over the page at this point (null: it left). */
export function setExternalDrag(next: ExternalDrag | null): void {
  if (next === null && drag === null) return;
  if (next && drag && next.key === drag.key && next.x === drag.x && next.y === drag.y) return;
  drag = next;
  notify();
}

export function useExternalDrag(): ExternalDrag | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => drag,
  );
}

// ---- Where the split view is ----

export interface SplitBox {
  left: number;
  top: number;
  w: number;
  h: number;
}

let host: { box: () => SplitBox | null } | null = null;
const waiters = new Set<() => void>();

/** The mounted split view says where its area is (null when it unmounts). */
export function registerSplitHost(next: { box: () => SplitBox | null } | null): void {
  host = next;
  if (next) for (const w of [...waiters]) w();
}

/** How long a page that is switching to the split view waits for it to mount and measure itself. */
const HOST_WAIT_MS = 5000;

function whenHost(): Promise<SplitBox | null> {
  return new Promise((resolve) => {
    const done = () => {
      const box = host?.box() ?? null;
      if (!box) return;
      cleanup();
      resolve(box);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, HOST_WAIT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      waiters.delete(done);
    };
    waiters.add(done);
    done();
  });
}

function clamp(v: number, max: number): number {
  return Math.min(Math.max(v, 0), Math.max(0, max - 1));
}

/**
 * Lets the session go at `at` (client pixels). A page whose base is not the split view becomes the
 * split view first (as the sidebar's Split view row does), and the point, which was over some other
 * part of the page, is moved onto the area. "noRoom" says so in the page's usual toast. A session
 * a pane already shows only takes focus.
 */
export async function placeExternalSession(key: string, at: { x: number; y: number }): Promise<PlaceOutcome> {
  setExternalDrag(null);
  const switching = host === null || host.box() === null;
  if (switching) openPanesView();
  const box = switching ? await whenHost() : host!.box();
  if (!box) return "none";
  const point = switching ? { x: clamp(at.x - box.left, box.w), y: clamp(at.y - box.top, box.h) } : { x: at.x - box.left, y: at.y - box.top };
  const prev = getPaneTabs();
  const res = placeSessionAt(prev, key, point, { w: box.w, h: box.h }, PANE_FRAME);
  if (res.tabs !== prev) updatePaneTabs(() => res.tabs);
  if (res.outcome === "noRoom") toastManager.add({ type: "info", title: NO_ROOM });
  return res.outcome;
}
