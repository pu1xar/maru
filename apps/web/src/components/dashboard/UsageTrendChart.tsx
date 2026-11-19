// How each account's usage window moved over the last 7 days (DESIGN.md 6j): one step line per
// account on one 0 to 100% axis, a legend with each account's current value, and a crosshair that
// reads every line at the pointer's time. A reading holds until the next one, since the server
// writes a row only when a value changed (usage/history.ts). Colors are the chart's theme tokens
// (dashboard.css), fixed per account.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import {
  SERIES_SLOTS, dayLabel, dayTicks, pointLabel, stepPath, valueAt, type ChartSeries,
} from "~/lib/dashboardModel";
import { observeResize } from "~/lib/observeResize";
import { shortAccount } from "~/model";
import { ProviderMark } from "./parts";
import "./dashboard.css";

const HEIGHT = 200;
const PAD = { top: 8, right: 12, bottom: 22, left: 36 };
const GRID = [0, 25, 50, 75, 100];
const LABELED = new Set([0, 50, 100]);

export function seriesColor(slot: number): string {
  return slot < SERIES_SLOTS ? `var(--dashboard-series-${slot + 1})` : "var(--muted-foreground)";
}

export function UsageTrendChart(props: { series: readonly ChartSeries[]; from: number; to: number; label: string }) {
  const { series, from, to } = props;
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);

  // The chart draws at its box's width; the box follows the card.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    return observeResize(el, () => setWidth(el.clientWidth));
  }, []);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - from) / Math.max(1, to - from)) * plotW;
  const y = (v: number) => PAD.top + (1 - Math.max(0, Math.min(100, v)) / 100) * plotH;
  const ticks = dayTicks(from, to);

  const onMove = (event: ReactPointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = Math.max(0, Math.min(plotW, event.clientX - rect.left));
    setHover({ x: PAD.left + px, t: from + (px / Math.max(1, plotW)) * (to - from) });
  };

  const tipLeft = hover ? (hover.x > width - 180 ? hover.x - 172 : hover.x + 12) : 0;

  return (
    <div ref={box} className="relative w-full select-none" data-usage-chart="">
      {width > 0 ? (
        <svg width={width} height={HEIGHT} role="img" aria-label={props.label} className="block overflow-visible">
          {GRID.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} shapeRendering="crispEdges" />
              {LABELED.has(v) ? (
                <text x={PAD.left - 6} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
                  {v}%
                </text>
              ) : null}
            </g>
          ))}
          {ticks.map((t) => (
            <text key={t} x={x(t)} y={HEIGHT - 6} textAnchor="middle" className="fill-muted-foreground text-[10px] tabular-nums">
              {dayLabel(t)}
            </text>
          ))}
          {series.map((s) => (
            <path
              key={s.account}
              d={stepPath(s.points, x, y)}
              fill="none"
              stroke={seriesColor(s.slot)}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              data-series={s.account}
            />
          ))}
          {series.map((s) => {
            const last = s.points[s.points.length - 1]!;
            return <circle key={s.account} cx={x(last.t)} cy={y(last.v)} r={4} fill={seriesColor(s.slot)} className="stroke-background" strokeWidth={2} />;
          })}
          {hover ? (
            <line x1={hover.x} x2={hover.x} y1={PAD.top} y2={PAD.top + plotH} className="stroke-muted-foreground" strokeWidth={1} shapeRendering="crispEdges" />
          ) : null}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      ) : (
        <div style={{ height: HEIGHT }} />
      )}
      {hover ? (
        <div
          role="status"
          className="pointer-events-none absolute top-1 z-10 w-40 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
          style={{ left: tipLeft }}
        >
          <div className="mb-1 text-muted-foreground tabular-nums">{pointLabel(hover.t)}</div>
          {series.map((s) => {
            const v = valueAt(s.points, hover.t);
            return (
              <div key={s.account} className="flex items-center gap-1.5">
                <span aria-hidden className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: seriesColor(s.slot) }} />
                <span className="font-semibold text-foreground tabular-nums">{v === null ? "-" : `${Math.round(v)}%`}</span>
                <ProviderMark provider={s.provider} className="size-3" />
                <span className="min-w-0 truncate text-muted-foreground">{shortAccount(s.account)}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
