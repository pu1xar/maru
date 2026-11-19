// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: components/ui/calendar.tsx (the class names, cell size and navigation of its DayPicker
// month). Local change: the month grid is drawn here (calendarGrid.ts) instead of by DayPicker,
// which this app does not install; it offers T3's single-day mode with DayPicker's prop names
// (selected, onSelect, defaultMonth, disabled, weekStartsOn) and its keys: arrows by day and week,
// PageUp and PageDown by month (with Shift by year), Home and End in the week. Labels are Korean.
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { dayKey, keyMove, monthWeeks, moveDay, sameMonth, startOfDay, startOfMonth } from "./calendarGrid";

const buttonClassNames =
  "relative flex size-(--cell-size) text-base sm:text-sm items-center justify-center rounded-lg text-foreground not-in-data-selected:hover:bg-accent disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0";

const dayButtonClassNames = cn(
  buttonClassNames,
  "cursor-pointer in-data-disabled:pointer-events-none in-data-selected:bg-primary in-data-disabled:text-muted-foreground/72 in-data-outside:text-muted-foreground/72 in-data-selected:in-data-outside:text-primary-foreground in-data-selected:text-primary-foreground in-data-disabled:line-through outline-none in-data-selected:transition-[border-radius,box-shadow] focus-visible:z-1 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50",
);

const todayClassNames =
  "*:after:pointer-events-none *:after:absolute *:after:bottom-1 *:after:start-1/2 *:after:z-1 *:after:size-[3px] *:after:-translate-x-1/2 *:after:rounded-full *:after:bg-primary [&[data-selected]>*]:after:bg-background [&[data-disabled]>*]:after:bg-foreground/30";

const CAPTION = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long" });
const DAY_LABEL = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "narrow" });

export function Calendar(props: {
  selected?: Date | undefined;
  onSelect: (date: Date) => void;
  /** The month shown first when nothing is selected; this month by default. */
  defaultMonth?: Date | undefined;
  /** Days that cannot be picked; they stay reachable by the keys and read as unavailable. */
  disabled?: ((date: Date) => boolean) | undefined;
  weekStartsOn?: 0 | 1;
  /** Focus the selected day (else today, else the 1st) when the calendar mounts, as in a popover. */
  autoFocus?: boolean;
  className?: string;
}) {
  const weekStartsOn = props.weekStartsOn ?? 0;
  const today = startOfDay(new Date());
  const [month, setMonth] = useState(() => startOfMonth(props.selected ?? props.defaultMonth ?? today));
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const grid = useRef<HTMLTableElement>(null);
  const weeks = useMemo(() => monthWeeks(month, weekStartsOn), [month, weekStartsOn]);
  const weekdays = weeks[0]!.map((d) => WEEKDAY.format(d.date));

  const selectedKey = props.selected ? dayKey(props.selected) : null;
  const inMonth = (d: Date | undefined) => (d && sameMonth(d, month) ? dayKey(d) : null);
  // Roving tab stop: the day the keys last moved to, else the selected day, today, or the 1st.
  const tabKey =
    (focusKey && weeks.flat().some((d) => d.key === focusKey && !d.outside) ? focusKey : null) ??
    inMonth(props.selected) ??
    inMonth(today) ??
    dayKey(month);

  const focusDay = (key: string) => grid.current?.querySelector<HTMLButtonElement>(`[data-day="${key}"]`)?.focus();
  // Focus follows a key move once the month it lands in is drawn.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    if (pendingFocus.current) {
      focusDay(pendingFocus.current);
      pendingFocus.current = null;
    }
  });
  const { autoFocus } = props;
  useEffect(() => {
    if (autoFocus) focusDay(tabKey);
    // Only on mount: later focus moves come from the keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, date: Date) => {
    const move = keyMove(event.key, event.shiftKey);
    if (!move) return;
    event.preventDefault();
    const next = moveDay(date, move, weekStartsOn);
    const key = dayKey(next);
    setFocusKey(key);
    if (!sameMonth(next, month)) setMonth(startOfMonth(next));
    pendingFocus.current = key;
  };

  const caption = CAPTION.format(month);
  return (
    <div data-slot="calendar" className={cn("relative w-fit [--cell-size:--spacing(10)] sm:[--cell-size:--spacing(9)]", props.className)}>
      <div className="relative flex flex-col gap-2 sm:flex-row">
        <nav className="absolute top-0 z-1 flex w-full justify-between">
          <button type="button" aria-label="Previous month" className={cn(buttonClassNames, "cursor-pointer")} onClick={() => setMonth((m) => startOfMonth(new Date(m.getFullYear(), m.getMonth() - 1, 1)))}>
            <ChevronLeftIcon aria-hidden />
          </button>
          <button type="button" aria-label="Next month" className={cn(buttonClassNames, "cursor-pointer")} onClick={() => setMonth((m) => startOfMonth(new Date(m.getFullYear(), m.getMonth() + 1, 1)))}>
            <ChevronRightIcon aria-hidden />
          </button>
        </nav>
        <div className="w-full">
          <div className="relative z-2 mx-(--cell-size) mb-1 flex h-(--cell-size) items-center justify-center px-1">
            <span aria-live="polite" className="flex h-full items-center gap-2 text-base font-medium sm:text-sm">
              {caption}
            </span>
          </div>
          <table ref={grid} role="grid" aria-label={caption} className="border-collapse">
            <thead aria-hidden>
              <tr>
                {weekdays.map((w, i) => (
                  <th key={i} scope="col" className="size-(--cell-size) p-0 text-xs font-medium text-muted-foreground/72">
                    {w}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week) => (
                <tr key={week[0]!.key}>
                  {week.map((d) => {
                    const off = props.disabled?.(d.date) ?? false;
                    const selected = d.key === selectedKey;
                    const isToday = d.key === dayKey(today);
                    return (
                      <td
                        key={d.key}
                        role="gridcell"
                        aria-selected={selected || undefined}
                        data-selected={selected || undefined}
                        data-outside={d.outside || undefined}
                        data-disabled={off || undefined}
                        data-today={isToday || undefined}
                        className={cn("size-(--cell-size) py-px text-sm", isToday && todayClassNames)}
                      >
                        <button
                          type="button"
                          data-day={d.key}
                          tabIndex={d.key === tabKey ? 0 : -1}
                          aria-label={DAY_LABEL.format(d.date)}
                          aria-disabled={off || undefined}
                          aria-current={isToday ? "date" : undefined}
                          className={dayButtonClassNames}
                          onKeyDown={(e) => onKeyDown(e, d.date)}
                          onFocus={() => setFocusKey(d.key)}
                          onClick={() => {
                            if (!off) props.onSelect(d.date);
                          }}
                        >
                          {d.date.getDate()}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
