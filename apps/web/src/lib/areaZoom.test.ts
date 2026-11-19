import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  zoomKeyDirection,
  AREA_ZOOM_STEPS,
  DEFAULT_AREA_ZOOM,
  ZOOM_GESTURE_GAP_MS,
  ZOOM_STEP_DELTA,
  applyZoomShortcut,
  areaZoomAttributes,
  zoomAreaOf,
  feedZoomGesture,
  isZoomWheel,
  readAreaZoom,
  readZoomValue,
  setAreaZoom,
  stepValue,
  stepZoom,
  zoomLabel,
  type WheelSample,
  type ZoomGesture,
} from "./areaZoom.ts";
import { CHAT_TEXT_STEPS, currentDisplayPrefs, setDisplayPrefs } from "./displayPrefs.ts";
import { TERMINAL_FONT_SIZES, currentTerminalPrefs, setTerminalPrefs } from "./viewMode.ts";

class FakeStorage {
  map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  const root = { style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, removeAttribute() {} };
  Object.assign(globalThis, {
    window: { localStorage: storage, addEventListener() {}, removeEventListener() {} },
    document: { documentElement: root },
  });
});

/** A wheel with no modifiers; `over` replaces fields. */
function wheel(over: Partial<WheelSample>): WheelSample {
  return { timeStamp: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over };
}

/** Feeds wheels in order and returns each step. */
function steps(samples: WheelSample[], mac = true): number[] {
  let gesture: ZoomGesture | null = null;
  return samples.map((s) => {
    const fed = feedZoomGesture(gesture, s, mac);
    gesture = fed.gesture;
    return fed.step;
  });
}

test("stepValue moves one step and holds at the ends", () => {
  assert.equal(stepValue(CHAT_TEXT_STEPS, 14, 1), 15);
  assert.equal(stepValue(CHAT_TEXT_STEPS, 14, -1), 13);
  assert.equal(stepValue(CHAT_TEXT_STEPS, 22, 1), 22);
  assert.equal(stepValue(CHAT_TEXT_STEPS, 11, -1), 11);
  assert.equal(stepValue(AREA_ZOOM_STEPS, 100, 1), 110);
  assert.equal(stepValue(AREA_ZOOM_STEPS, 100, -1), 90);
  assert.equal(stepValue(AREA_ZOOM_STEPS, 150, 1), 150);
  assert.equal(stepValue(AREA_ZOOM_STEPS, 85, -1), 85);
  assert.equal(stepValue(TERMINAL_FONT_SIZES, 15, 1), 16);
  assert.equal(stepValue(TERMINAL_FONT_SIZES, 22, 1), 22);
  // A value off the list moves to the nearest step that way.
  assert.equal(stepValue(AREA_ZOOM_STEPS, 105, 1), 110);
  assert.equal(stepValue(AREA_ZOOM_STEPS, 105, -1), 100);
  assert.equal(stepValue(AREA_ZOOM_STEPS, 200, 1), 200);
  assert.equal(stepValue(CHAT_TEXT_STEPS, 14.5, 1), 15);
});

test("the sidebar and panel steps are percents around 100", () => {
  assert.deepEqual([...AREA_ZOOM_STEPS], [85, 90, 100, 110, 120, 135, 150]);
  assert.ok(AREA_ZOOM_STEPS.includes(DEFAULT_AREA_ZOOM));
});

test("zoom modifiers: Cmd or Ctrl on a Mac, Ctrl alone elsewhere, never with Shift or Alt", () => {
  assert.equal(isZoomWheel(wheel({ ctrlKey: true }), true), true);
  assert.equal(isZoomWheel(wheel({ metaKey: true }), true), true);
  assert.equal(isZoomWheel(wheel({ ctrlKey: true }), false), true);
  assert.equal(isZoomWheel(wheel({ metaKey: true }), false), false);
  assert.equal(isZoomWheel(wheel({ ctrlKey: true, metaKey: true }), false), false);
  assert.equal(isZoomWheel(wheel({ ctrlKey: true, shiftKey: true }), true), false);
  assert.equal(isZoomWheel(wheel({ ctrlKey: true, altKey: true }), false), false);
  assert.equal(isZoomWheel(wheel({}), true), false);
});

test("a pinch (small ctrl wheels 16ms apart) steps every 10px of wheel, and spreading zooms in", () => {
  const out = steps(Array.from({ length: 8 }, (_, i) => wheel({ timeStamp: i * 16, deltaY: -3, ctrlKey: true })));
  // -3, -6, -9, -12 (step), -3, -6, -9, -12 (step)
  assert.deepEqual(out, [0, 0, 0, 1, 0, 0, 0, 1]);
  const pinchIn = steps(Array.from({ length: 4 }, (_, i) => wheel({ timeStamp: i * 16, deltaY: 2.5, ctrlKey: true })));
  assert.deepEqual(pinchIn, [0, 0, 0, -1]);
  assert.equal(ZOOM_STEP_DELTA, 10);
});

test("each mouse notch is one step, a large one too", () => {
  // Windows (100 per notch) and Mac (40 per tick), notches 120ms apart: wheel down is smaller.
  assert.deepEqual(steps([100, 100, 100].map((d, i) => wheel({ timeStamp: i * 120, deltaY: d, ctrlKey: true })), false), [-1, -1, -1]);
  assert.deepEqual(steps([-40, -40].map((d, i) => wheel({ timeStamp: i * 120, deltaY: d, metaKey: true }))), [1, 1]);
  assert.deepEqual(steps([wheel({ deltaY: -400, ctrlKey: true })]), [1]);
  // Firefox counts lines.
  assert.deepEqual(steps([wheel({ deltaY: 3, deltaMode: 1, ctrlKey: true })], false), [-1]);
});

test("Ctrl pressed during a momentum scroll does not zoom until a new gesture starts", () => {
  const scroll = Array.from({ length: 5 }, (_, i) => wheel({ timeStamp: i * 16, deltaY: 30 }));
  const momentumWithCtrl = Array.from({ length: 5 }, (_, i) => wheel({ timeStamp: 80 + i * 16, deltaY: 30, ctrlKey: true }));
  let gesture: ZoomGesture | null = null;
  const fed = [...scroll, ...momentumWithCtrl].map((s) => {
    const r = feedZoomGesture(gesture, s, true);
    gesture = r.gesture;
    return r;
  });
  assert.deepEqual(
    fed.map((r) => r.step),
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  // The ctrl wheels still count as zoom input (cancelled over an area) though they do not step.
  assert.deepEqual(
    fed.map((r) => r.zoomInput),
    [false, false, false, false, false, true, true, true, true, true],
  );
  // After a pause longer than the gap, the next ctrl wheel starts a zoom gesture.
  const later = feedZoomGesture(gesture, wheel({ timeStamp: 144 + ZOOM_GESTURE_GAP_MS + 1, deltaY: 30, ctrlKey: true }), true);
  assert.equal(later.step, -1);
});

test("the sidebar and panel values are stored when they differ from their defaults (sidebar 90, panel 100) and read back", () => {
  assert.equal(readAreaZoom("panel"), 100);
  setAreaZoom("panel", 120);
  assert.equal(storage.getItem("maru_right_panel_zoom"), "120");
  assert.equal(readAreaZoom("panel"), 120);
  setAreaZoom("panel", 100);
  assert.equal(storage.getItem("maru_right_panel_zoom"), null);
  // A typed whole percent between the steps is kept; the wheel then moves to the step next to it.
  setAreaZoom("sidebar", 123);
  assert.equal(readAreaZoom("sidebar"), 123);
  assert.equal(storage.getItem("maru_sidebar_zoom"), "123");
  // A value outside the first and last step, or not whole, is the default.
  setAreaZoom("sidebar", 200);
  assert.equal(readAreaZoom("sidebar"), 90);
  assert.equal(storage.getItem("maru_sidebar_zoom"), null);
  setAreaZoom("sidebar", 84);
  assert.equal(readAreaZoom("sidebar"), 90);
  setAreaZoom("sidebar", 100.5);
  assert.equal(readAreaZoom("sidebar"), 90);
});

test("stepZoom moves the conversation and terminal values themselves", () => {
  setDisplayPrefs({ chatText: 16 });
  setTerminalPrefs({ fontSize: 15 });
  stepZoom("chat", "k", 1);
  assert.equal(currentDisplayPrefs().chatText, 17);
  assert.equal(storage.getItem("maru_chat_text_pt"), "17");
  stepZoom("chat", "k", -1);
  stepZoom("chat", "k", -1);
  assert.equal(currentDisplayPrefs().chatText, 15);
  setDisplayPrefs({ chatText: 14 });
  stepZoom("terminal", "k", -1);
  assert.equal(currentTerminalPrefs().fontSize, 14);
  assert.equal(storage.getItem("maru_terminal_font_size"), "14");
  stepZoom("sidebar", "k", 1);
  assert.equal(readZoomValue("sidebar"), 100);
  // At an end the value stays.
  setDisplayPrefs({ chatText: 22 });
  stepZoom("chat", "k", 1);
  assert.equal(currentDisplayPrefs().chatText, 22);
  setDisplayPrefs({ chatText: 15 });
  setTerminalPrefs({ fontSize: 13 });
  setAreaZoom("sidebar", 90);
});

test("labels and area attributes", () => {
  assert.equal(zoomLabel("terminal", 16), "16pt");
  assert.equal(zoomLabel("chat", 15), "15pt");
  assert.equal(zoomLabel("panel", 120), "120%");
  assert.deepEqual(areaZoomAttributes("chat", "k"), { "data-zoom-area": "chat", "data-zoom-key": "k" });
  assert.deepEqual(areaZoomAttributes("panel", "k", 135), {
    "data-zoom-area": "panel",
    "data-zoom-key": "k",
    "data-area-zoom": "",
    style: { "--area-zoom": "1.35" },
  });
});

function fakeEl(dataset?: { zoomArea?: string; zoomKey?: string }): Element {
  return { closest: () => (dataset ? { dataset } : null) } as unknown as Element;
}

test("zoom shortcut: over an area it steps that area, with the wheel's function", () => {
  const steps: unknown[][] = [];
  const pages: number[] = [];
  const hit = applyZoomShortcut(-1, {
    pointer: { x: 5, y: 6 },
    elementAt: (x, y) => (x === 5 && y === 6 ? fakeEl({ zoomArea: "sidebar", zoomKey: "side" }) : null),
    step: (...a) => void steps.push(a),
    zoomPage: (d) => void pages.push(d),
  });
  assert.equal(hit, "area");
  assert.deepEqual(steps, [["sidebar", "side", -1]]);
  assert.deepEqual(pages, []);
});

test("zoom shortcut: no area under the pointer, no pointer, or a half-marked element zooms the page", () => {
  for (const [pointer, el] of [
    [{ x: 1, y: 1 }, fakeEl()],
    [{ x: 1, y: 1 }, null],
    [{ x: 1, y: 1 }, fakeEl({ zoomArea: "nope", zoomKey: "k" })],
    [{ x: 1, y: 1 }, fakeEl({ zoomArea: "chat" })],
    [null, fakeEl({ zoomArea: "chat", zoomKey: "k" })],
  ] as const) {
    const steps: unknown[] = [];
    const pages: number[] = [];
    const hit = applyZoomShortcut(1, { pointer, elementAt: () => el, step: () => void steps.push(1), zoomPage: (d) => void pages.push(d) });
    assert.equal(hit, "page");
    assert.deepEqual([steps.length, pages], [0, [1]]);
  }
  assert.equal(zoomAreaOf(null), null);
  assert.deepEqual(zoomAreaOf(fakeEl({ zoomArea: "panel", zoomKey: "p" })), { area: "panel", key: "p" });
});

test("the page zoom keys: Cmd or Ctrl on a Mac, Ctrl elsewhere, with =, +, - and the keypad", () => {
  const k = (key: string, code: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  assert.equal(zoomKeyDirection(k("=", "Equal", { metaKey: true }), true), 1);
  assert.equal(zoomKeyDirection(k("+", "Equal", { metaKey: true }), true), 1);
  assert.equal(zoomKeyDirection(k("-", "Minus", { metaKey: true }), true), -1);
  assert.equal(zoomKeyDirection(k("+", "NumpadAdd", { ctrlKey: true }), false), 1);
  assert.equal(zoomKeyDirection(k("-", "NumpadSubtract", { ctrlKey: true }), false), -1);
  assert.equal(zoomKeyDirection(k("=", "Equal", { metaKey: true }), false), null, "Cmd is not the zoom key off a Mac");
  assert.equal(zoomKeyDirection(k("=", "Equal", {}), true), null);
  assert.equal(zoomKeyDirection(k("=", "Equal", { metaKey: true, altKey: true }), true), null);
  assert.equal(zoomKeyDirection(k("0", "Digit0", { metaKey: true }), true), null, "Cmd+0 stays the page reset");
});
