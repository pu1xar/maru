// Zoom by area (DESIGN.md 6g): Ctrl+wheel over an area (on a Mac also Cmd+wheel and a trackpad
// pinch, which Chrome sends as a wheel with ctrlKey) steps that area's size and leaves the rest of
// the page as it is.
//
// An area is an element marked `data-zoom-area="<area>"` and `data-zoom-key="<instance>"`. The
// conversation moves its existing values: the conversation text size in the chat mode
// (displayPrefs.ts) and the terminal text size in the terminal mode (viewMode.ts), both sizes in
// pt, so a wheel notch moves one pt step. The sidebar and the right panel have their own values
// here, percents, which their elements take as `--area-zoom` with `data-area-zoom` (index.css
// scales the theme's text sizes and spacing by it). Each value is per browser in localStorage,
// like the other display preferences.
//
// One listener on the window, in the capture phase and not passive, sees every wheel. A zoom wheel
// over an area is cancelled (no browser zoom, no scroll) and steps the area; any other wheel, and a
// zoom wheel outside every area, goes on as the browser has it.
import { useSyncExternalStore, type CSSProperties } from "react";

import { CHAT_TEXT_STEPS, DEFAULT_DISPLAY_PREFS, currentDisplayPrefs, setDisplayPrefs, useDisplayPrefs } from "./displayPrefs.ts";
import { desktopBridge } from "./desktopBridge.ts";
import { inIntRange } from "./settingControl.logic.ts";
import {
  AREA_ZOOM_DEFAULTS,
  AREA_ZOOM_RANGE,
  AREA_ZOOM_STEPS,
  AREA_ZOOM_STORAGE_KEY,
  type ScaledArea,
} from "./areaZoom.logic.ts";
import { DEFAULT_TERMINAL_PREFS, TERMINAL_FONT_SIZES, currentTerminalPrefs, setTerminalPrefs, useTerminalPrefs } from "./viewMode.ts";

export * from "./areaZoom.logic.ts";

export type ZoomArea = "chat" | "terminal" | "sidebar" | "panel";
/** Names in Settings and in the zoom mark's reset button. */
export const ZOOM_AREA_LABEL: Record<ZoomArea, string> = {
  chat: "Conversation text size",
  terminal: "Terminal text size",
  sidebar: "Sidebar scale",
  panel: "Right panel scale",
};

export function isZoomArea(value: unknown): value is ZoomArea {
  return value === "chat" || value === "terminal" || value === "sidebar" || value === "panel";
}

export function zoomSteps(area: ZoomArea): readonly number[] {
  return area === "terminal" ? TERMINAL_FONT_SIZES : area === "chat" ? CHAT_TEXT_STEPS : AREA_ZOOM_STEPS;
}

export function zoomDefault(area: ZoomArea): number {
  return area === "terminal" ? DEFAULT_TERMINAL_PREFS.fontSize : area === "chat" ? DEFAULT_DISPLAY_PREFS.chatText : AREA_ZOOM_DEFAULTS[area];
}

/** How a value reads in the zoom mark: pt for the two text sizes, percent for the sidebar and the panel. */
export function zoomLabel(area: ZoomArea, value: number): string {
  return area === "terminal" || area === "chat" ? `${value}pt` : `${value}%`;
}

/**
 * The value one step from `value` in `direction`, held at the ends of the list. A value off the
 * list (a hand-edited one is normalized away before this) moves to the nearest step that way.
 */
export function stepValue(steps: readonly number[], value: number, direction: 1 | -1): number {
  const index = steps.indexOf(value);
  if (index >= 0) return steps[Math.min(steps.length - 1, Math.max(0, index + direction))]!;
  const beyond = direction > 0 ? steps.find((s) => s > value) : steps.findLast((s) => s < value);
  return beyond ?? value;
}

// ---- Wheel input ----

/**
 * Wheels this close together are one gesture (VS Code mouseHandler.ts, 50ms). Whether a gesture
 * zooms is decided by its first wheel: a Mac's momentum scroll keeps sending wheels after the
 * fingers lift, and pressing Ctrl then (Ctrl+Tab) must not zoom. Chromium leaves Ctrl+wheel zoom
 * out on the Mac for the same reason (web_contents_impl.cc HandleWheelEvent).
 */
export const ZOOM_GESTURE_GAP_MS = 50;
/**
 * Wheel distance (px) per step. A pinch arrives as wheels whose deltaY is 100 x ln(1/scale), so
 * 10 is a pinch of about 10%, close to the steps' own spacing (100 to 110 to 120%, 14pt to 15pt
 * is 7%). A mouse notch
 * (Windows 100, Mac 40 per tick) or a line-mode wheel is past it in one event, and one event never
 * moves more than one step.
 */
export const ZOOM_STEP_DELTA = 10;
/** px per line and per page for wheels that count in lines (Firefox) or pages. */
const LINE_PX = 40;
const PAGE_PX = 800;

export interface WheelSample {
  timeStamp: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface ZoomGesture {
  /** Time of the gesture's last wheel. */
  last: number;
  /** The gesture began with the zoom modifiers. */
  zooming: boolean;
  /** Wheel distance since the last step (px, negative zooms in). */
  pending: number;
}

/**
 * Whether a wheel carries the zoom modifiers. On a Mac: Cmd or Ctrl (a pinch sets ctrlKey), as VS
 * Code's editor zoom takes them there; elsewhere Ctrl alone. Shift and Alt wheels are other input.
 */
export function isZoomWheel(e: Pick<WheelSample, "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, mac: boolean): boolean {
  if (e.altKey || e.shiftKey) return false;
  return mac ? e.ctrlKey || e.metaKey : e.ctrlKey && !e.metaKey;
}

function wheelPx(e: WheelSample): number {
  return e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * PAGE_PX : e.deltaY;
}

/**
 * Feeds one wheel to the gesture. `zoomInput` says the wheel carries the zoom modifiers (over an
 * area it is cancelled even when it does not step, so a held Ctrl never zooms the page there);
 * `step` is +1 (larger), -1 (smaller) or 0.
 */
export function feedZoomGesture(
  gesture: ZoomGesture | null,
  e: WheelSample,
  mac: boolean,
): { gesture: ZoomGesture; zoomInput: boolean; step: -1 | 0 | 1 } {
  const zoomInput = isZoomWheel(e, mac);
  const fresh = gesture === null || e.timeStamp - gesture.last > ZOOM_GESTURE_GAP_MS || e.timeStamp < gesture.last;
  const base: ZoomGesture = fresh ? { last: e.timeStamp, zooming: zoomInput, pending: 0 } : { ...gesture, last: e.timeStamp };
  if (!zoomInput || !base.zooming) return { gesture: base, zoomInput, step: 0 };
  const pending = base.pending + wheelPx(e);
  if (Math.abs(pending) < ZOOM_STEP_DELTA) return { gesture: { ...base, pending }, zoomInput, step: 0 };
  return { gesture: { ...base, pending: 0 }, zoomInput, step: pending < 0 ? 1 : -1 };
}

// ---- The sidebar's and the right panel's values ----

function readStored(area: ScaledArea): number {
  try {
    const raw = window.localStorage.getItem(AREA_ZOOM_STORAGE_KEY[area]);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return inIntRange(value, AREA_ZOOM_RANGE) ? value : AREA_ZOOM_DEFAULTS[area];
  } catch {
    // Storage blocked or a value that is not JSON: the default applies.
    return AREA_ZOOM_DEFAULTS[area];
  }
}

const values: Partial<Record<ScaledArea, number>> = {};
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

function onStorage(event: StorageEvent): void {
  // Another tab of this browser changed one.
  if (event.key !== null && event.key !== AREA_ZOOM_STORAGE_KEY.sidebar && event.key !== AREA_ZOOM_STORAGE_KEY.panel) return;
  delete values.sidebar;
  delete values.panel;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function readAreaZoom(area: ScaledArea): number {
  values[area] ??= readStored(area);
  return values[area];
}

export function useAreaZoom(area: ScaledArea): number {
  return useSyncExternalStore(subscribe, () => readAreaZoom(area));
}

/** Stores a value that differs from the default and removes the default. */
export function setAreaZoom(area: ScaledArea, value: number): void {
  const next = inIntRange(value, AREA_ZOOM_RANGE) ? value : AREA_ZOOM_DEFAULTS[area];
  values[area] = next;
  try {
    if (next === AREA_ZOOM_DEFAULTS[area]) window.localStorage.removeItem(AREA_ZOOM_STORAGE_KEY[area]);
    else window.localStorage.setItem(AREA_ZOOM_STORAGE_KEY[area], JSON.stringify(next));
  } catch {
    // Storage blocked: the change holds for this page only.
  }
  notify();
}

// ---- Any area's value ----

/** The value an area shows now. */
export function readZoomValue(area: ZoomArea): number {
  if (area === "chat") return currentDisplayPrefs().chatText;
  if (area === "terminal") return currentTerminalPrefs().fontSize;
  return readAreaZoom(area);
}

/** The value an area shows, as a hook (re-renders when it changes). */
export function useZoomValue(area: ZoomArea): number {
  const chat = useDisplayPrefs().chatText;
  const terminal = useTerminalPrefs().fontSize;
  const sidebar = useAreaZoom("sidebar");
  const panel = useAreaZoom("panel");
  return area === "chat" ? chat : area === "terminal" ? terminal : area === "sidebar" ? sidebar : panel;
}

export function setZoomValue(area: ZoomArea, value: number): void {
  if (area === "chat") setDisplayPrefs({ chatText: value });
  else if (area === "terminal") setTerminalPrefs({ fontSize: value });
  else setAreaZoom(area, value);
}

/** The style that scales an element marked `data-area-zoom` (index.css) by a percent value. */
export function areaZoomStyle(zoom: number): CSSProperties {
  return { "--area-zoom": String(zoom / 100) } as CSSProperties;
}

/** The element attributes that make an area: the wheel finds it by them, and `zoom` scales a sidebar or panel. */
export function areaZoomAttributes(area: ZoomArea, key: string, zoom?: number): Record<string, unknown> {
  return {
    "data-zoom-area": area,
    "data-zoom-key": key,
    ...(zoom === undefined ? {} : { "data-area-zoom": "", style: areaZoomStyle(zoom) }),
  };
}

// ---- Zoom events (the mark in the area that was zoomed) ----

export interface ZoomEvent {
  /** The area instance the wheel was over (its `data-zoom-key`). */
  key: string;
  area: ZoomArea;
  /** Counts up, so a step that lands on the same value still shows the mark again. */
  seq: number;
}

let lastEvent: ZoomEvent | null = null;
const eventListeners = new Set<() => void>();

function subscribeEvents(listener: () => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

export function useLastZoomEvent(): ZoomEvent | null {
  return useSyncExternalStore(subscribeEvents, () => lastEvent);
}

/** Steps an area's value and tells its mark; at an end the value stays and the mark still shows it. */
export function stepZoom(area: ZoomArea, key: string, direction: 1 | -1): void {
  const next = stepValue(zoomSteps(area), readZoomValue(area), direction);
  if (next !== readZoomValue(area)) setZoomValue(area, next);
  lastEvent = { key, area, seq: (lastEvent?.seq ?? 0) + 1 };
  for (const l of [...eventListeners]) l();
}

// ---- The window's wheel listener ----

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
let gesture: ZoomGesture | null = null;
let installed = 0;

function onWheel(event: WheelEvent): void {
  const fed = feedZoomGesture(gesture, event, IS_MAC);
  gesture = fed.gesture;
  if (!fed.zoomInput || !(event.target instanceof Element)) return;
  const element = event.target.closest<HTMLElement>("[data-zoom-area]");
  const area = element?.dataset.zoomArea;
  const key = element?.dataset.zoomKey;
  if (!isZoomArea(area) || !key) return;
  event.preventDefault();
  // The area's own wheel handlers (the timeline's follow, the tab strip's sideways scroll) do not
  // see a zoom wheel.
  event.stopPropagation();
  if (fed.step !== 0) stepZoom(area, key, fed.step);
}

/** Installs the window listener while at least one area is mounted; returns the uninstall. */
export function installZoomWheel(): () => void {
  if (installed++ === 0) window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => {
    if (--installed === 0) {
      window.removeEventListener("wheel", onWheel, { capture: true });
      gesture = null;
    }
  };
}

// ---- The desktop app's zoom shortcut ----
//
// The desktop menu's Zoom in and Zoom out keys (and a mouse driver's Cmd+wheel, which it sends as
// those keys, so no wheel reaches the page) arrive as a direction (DESIGN.md 2e). The page zooms
// the area under the pointer the way the wheel does, and asks the shell for the whole-page zoom
// when no area is there.

export interface ZoomShortcutDeps {
  /** The last pointer position in the page, or null when it is not known (it left the window). */
  pointer: { x: number; y: number } | null;
  elementAt(x: number, y: number): Element | null;
  step(area: ZoomArea, key: string, direction: 1 | -1): void;
  zoomPage(direction: 1 | -1): void;
}

/** The zoom area an element is in, or null. */
export function zoomAreaOf(element: Element | null): { area: ZoomArea; key: string } | null {
  const hit = element?.closest<HTMLElement>("[data-zoom-area]");
  const area = hit?.dataset.zoomArea;
  const key = hit?.dataset.zoomKey;
  return isZoomArea(area) && key ? { area, key } : null;
}

/** Steps the area under the pointer, else zooms the page. */
export function applyZoomShortcut(direction: 1 | -1, deps: ZoomShortcutDeps): "area" | "page" {
  const hit = deps.pointer ? zoomAreaOf(deps.elementAt(deps.pointer.x, deps.pointer.y)) : null;
  if (hit) {
    deps.step(hit.area, hit.key, direction);
    return "area";
  }
  deps.zoomPage(direction);
  return "page";
}

/**
 * The direction of a page zoom key (Cmd/Ctrl with =, +, - or the keypad's + and -), or null. A
 * mouse tool such as Logi Options+ turns Cmd+wheel into these keys, so the page sees keys where
 * the user turned the wheel (user report 2026-11-19).
 */
export function zoomKeyDirection(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey">, mac: boolean): 1 | -1 | null {
  if (e.altKey || !(mac ? e.metaKey || e.ctrlKey : e.ctrlKey)) return null;
  if (e.key === "=" || e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd") return 1;
  if (e.key === "-" || e.key === "_" || e.code === "Minus" || e.code === "NumpadSubtract") return -1;
  return null;
}

/**
 * Remembers the pointer and answers the page zoom keys for the life of the page; returns the
 * uninstall. Over an area the keys step that area (as its wheel does), elsewhere they zoom the page
 * as before:
 * - desktop shell: its View menu takes the keys and sends them here (onZoomShortcut); away from an
 *   area this asks the shell to zoom the page
 * - browser: a capture keydown listener cancels the key over an area; away from one the key goes
 *   on to the browser's own page zoom
 */
export function startZoomShortcut(): () => void {
  let pointer: { x: number; y: number } | null = null;
  const remember = (e: MouseEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
  };
  const forget = () => {
    pointer = null;
  };
  window.addEventListener("pointermove", remember, { capture: true, passive: true });
  window.addEventListener("wheel", remember, { capture: true, passive: true });
  document.documentElement.addEventListener("pointerleave", forget);
  const elementAt = (x: number, y: number) => document.elementFromPoint(x, y);
  const bridge = desktopBridge();
  let off: () => void;
  if (bridge) {
    off =
      typeof bridge.onZoomShortcut === "function"
        ? bridge.onZoomShortcut((direction) =>
            applyZoomShortcut(direction, { pointer, elementAt, step: stepZoom, zoomPage: (d) => void bridge.zoomPage?.(d) }),
          )
        : () => {};
  } else {
    const onKey = (e: KeyboardEvent) => {
      const direction = zoomKeyDirection(e, IS_MAC);
      if (direction === null) return;
      const hit = pointer ? zoomAreaOf(elementAt(pointer.x, pointer.y)) : null;
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      stepZoom(hit.area, hit.key, direction);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    off = () => window.removeEventListener("keydown", onKey, { capture: true });
  }
  return () => {
    off();
    window.removeEventListener("pointermove", remember, { capture: true });
    window.removeEventListener("wheel", remember, { capture: true });
    document.documentElement.removeEventListener("pointerleave", forget);
  };
}
