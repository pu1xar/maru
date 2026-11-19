// Dragging a session out of the window opens its lean window (DESIGN.md 6x). It listens to the
// page's one drag context (paneDnd.tsx) beside the sidebar and the split view, which keep every drop
// inside the window. A sidebar row let go outside the window opens the session's lean window and
// leaves the window as it is; a split view pane let go outside leaves the split view and its session
// moves to the lean window. A session that already has a lean window brings it forward instead.
//
// While a mouse button is held Chromium keeps sending the page the pointer's moves and its release
// with coordinates beyond the viewport (implicit mouse capture), in the desktop app and in a
// browser alike, so "outside" is the pointer's own position (lib/leanWindow.logic.ts
// pointerOutside). The dragged chip is part of the page and cannot be drawn out there, so while the
// pointer is outside the window's edge lights up and a label at the bottom says what letting go does.
import { useDndMonitor, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { AppWindowIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { dragOutcome, pointerOutside, type DragOrigin } from "~/lib/leanWindow.logic";
import { leanKeysNow, openLeanWindow } from "~/lib/leanWindow";
import { dragSourceOf } from "~/lib/paneDrag";
import { paneActions } from "./split/paneStore";

interface Pointer {
  x: number;
  y: number;
  screenX: number;
  screenY: number;
}

function originOf(data: unknown): DragOrigin | null {
  const source = dragSourceOf(data);
  if (!source) return null;
  if (source.kind === "session") return { kind: "sidebar", sessionKey: source.sessionKey };
  if (source.kind === "pane" && source.sessionKey !== null) return { kind: "pane", sessionKey: source.sessionKey, paneId: source.paneId };
  return null;
}

export function LeanDragOut() {
  const [hint, setHint] = useState<{ label: string } | null>(null);
  const origin = useRef<DragOrigin | null>(null);
  const pointer = useRef<Pointer | null>(null);
  const stop = useRef<(() => void) | null>(null);

  const outcomeNow = () => {
    const o = origin.current;
    const p = pointer.current;
    if (!o) return null;
    const outside = pointerOutside(p, { w: window.innerWidth, h: window.innerHeight });
    return dragOutcome(o, outside, leanKeysNow());
  };

  const refresh = () => {
    const out = outcomeNow();
    if (!out || out.type === "none") return setHint((h) => (h === null ? h : null));
    const label =
      out.type === "focus"
        ? "Release to bring its window forward"
        : out.closePaneId
          ? "Release to move it to a new window"
          : "Release to open in a new window";
    setHint((h) => (h?.label === label ? h : { label }));
  };

  const finish = () => {
    stop.current?.();
    stop.current = null;
    origin.current = null;
    pointer.current = null;
    setHint(null);
  };

  useDndMonitor({
    onDragStart(event: DragStartEvent) {
      origin.current = originOf(event.active.data.current);
      if (!origin.current) return;
      const start = event.activatorEvent as MouseEvent | null;
      pointer.current = start && "clientX" in start ? { x: start.clientX, y: start.clientY, screenX: start.screenX, screenY: start.screenY } : null;
      const onMove = (e: PointerEvent | MouseEvent) => {
        pointer.current = { x: e.clientX, y: e.clientY, screenX: e.screenX, screenY: e.screenY };
        refresh();
      };
      const events = ["pointermove", "mousemove", "pointerup", "mouseup"] as const;
      // Capture on the window: this runs before dnd-kit's own listeners, so a drop reads the release position.
      for (const name of events) window.addEventListener(name, onMove, true);
      stop.current = () => {
        for (const name of events) window.removeEventListener(name, onMove, true);
      };
    },
    onDragEnd(_event: DragEndEvent) {
      const out = outcomeNow();
      const at = pointer.current ? { x: pointer.current.screenX, y: pointer.current.screenY } : null;
      finish();
      if (!out || out.type === "none") return;
      openLeanWindow(out.sessionKey, at);
      if (out.closePaneId) paneActions.close(out.closePaneId);
    },
    onDragCancel: finish,
  });

  // A drag that outlives the page's view stops following the pointer.
  useEffect(() => () => stop.current?.(), []);

  if (!hint) return null;
  return createPortal(
    <div data-lean-drop-preview="" aria-hidden className="pointer-events-none fixed inset-0 z-[100] rounded-sm ring-4 ring-inset ring-primary/60">
      <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-sm font-medium text-popover-foreground shadow-lg">
        <AppWindowIcon className="size-4" />
        {hint.label}
      </div>
    </div>,
    document.body,
  );
}
