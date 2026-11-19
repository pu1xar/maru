// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: components/preview/ZoomIndicator.tsx (a pill with the zoom percent that fades in on a
// zoom change and hides after 1.5s). Local changes: one mark per zoom area (lib/areaZoom.ts),
// shown only in the area the wheel was over; the terminal's value reads in px; a reset button
// beside a value other than the default, and the mark stays while the pointer or focus is on it.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Undo2Icon } from "lucide-react";

import {
  ZOOM_AREA_LABEL,
  areaZoomAttributes,
  installZoomWheel,
  setZoomValue,
  useAreaZoom,
  useLastZoomEvent,
  useZoomValue,
  zoomDefault,
  zoomLabel,
  type ScaledArea,
  type ZoomArea,
} from "~/lib/areaZoom";
import { cn } from "~/lib/utils";

const HIDE_AFTER_MS = 1500;

/**
 * The zoom mark of one area instance (`zoomKey`, the area's `data-zoom-key`). Mounting it also keeps
 * the window's zoom wheel listener installed. Placed by the caller's `className` inside a
 * positioned box of the area; index.css gives it the page's sizes, not the area's.
 */
export function AreaZoomIndicator({ zoomKey, area, className }: { zoomKey: string; area: ZoomArea; className?: string }) {
  useEffect(installZoomWheel, []);
  const value = useZoomValue(area);
  const event = useLastZoomEvent();
  const [visible, setVisible] = useState(false);
  const held = useRef(false);
  const timer = useRef<number | null>(null);

  const scheduleHide = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (!held.current) setVisible(false);
    }, HIDE_AFTER_MS);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shows the mark on a zoom wheel over this area and hides it with a timer
  useEffect(() => {
    if (!event || event.key !== zoomKey) return;
    setVisible(true);
    scheduleHide();
  }, [event, zoomKey]);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const hold = (on: boolean) => {
    held.current = on;
    if (!on) scheduleHide();
  };
  const changed = value !== zoomDefault(area);
  return (
    <div
      data-zoom-indicator=""
      aria-hidden={!visible}
      inert={!visible}
      className={cn(
        "absolute z-30 flex select-none items-center gap-1 rounded-full border border-border/70 bg-popover/95 py-0.5 ps-2.5 pe-0.5 text-xs font-medium text-foreground tabular-nums shadow-md/10 backdrop-blur transition-all duration-200 ease-out",
        !changed && "pe-2.5",
        visible ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
        className,
      )}
      onPointerEnter={() => hold(true)}
      onPointerLeave={() => hold(false)}
      onFocus={() => hold(true)}
      onBlur={() => hold(false)}
    >
      <span role="status">{zoomLabel(area, value)}</span>
      {changed ? (
        <button
          type="button"
          aria-label={`Reset ${ZOOM_AREA_LABEL[area]} to default`}
          title={`Reset to default (${zoomLabel(area, zoomDefault(area))})`}
          className="flex size-5 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            setZoomValue(area, zoomDefault(area));
            scheduleHide();
          }}
        >
          <Undo2Icon aria-hidden className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * A sidebar or panel area that adds no box (`display: contents`): its children take the area's
 * scale, and the mark sits in the nearest positioned box around it.
 */
export function AreaZoomScope({ area, indicatorClassName, children }: { area: ScaledArea; indicatorClassName: string; children: ReactNode }) {
  const zoomKey = useId();
  const zoom = useAreaZoom(area);
  return (
    <div {...areaZoomAttributes(area, zoomKey, zoom)} className="contents">
      {children}
      <AreaZoomIndicator zoomKey={zoomKey} area={area} className={indicatorClassName} />
    </div>
  );
}
