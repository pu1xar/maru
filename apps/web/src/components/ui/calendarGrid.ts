// Date arithmetic behind ui/calendar.tsx: the weeks of a month view, moves by day, week and month,
// and the `YYYY-MM-DD` text a date input holds. Dates are local days at midnight.

export interface CalendarDay {
  date: Date;
  /** `YYYY-MM-DD` of the local day. */
  key: string;
  /** In the weeks around the shown month. */
  outside: boolean;
}

/** `YYYY-MM-DD` of the local day. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The local day a `YYYY-MM-DD` text names, or null for anything else (an impossible date too). */
export function parseDayKey(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dayKey(d) === value ? d : null;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** The same day `n` months on, held to the last day of a shorter month (Jan 31 + 1 -> Feb 28). */
export function addMonths(d: Date, n: number): Date {
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last));
}

export function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/** Six weeks from the week holding the month's first day, so the view keeps one height. */
export function monthWeeks(month: Date, weekStartsOn: 0 | 1): CalendarDay[][] {
  const first = startOfMonth(month);
  const lead = (first.getDay() - weekStartsOn + 7) % 7;
  const start = addDays(first, -lead);
  const weeks: CalendarDay[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: CalendarDay[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, w * 7 + i);
      week.push({ date, key: dayKey(date), outside: !sameMonth(date, first) });
    }
    weeks.push(week);
  }
  return weeks;
}

export type CalendarMove = "prevDay" | "nextDay" | "prevWeek" | "nextWeek" | "prevMonth" | "nextMonth" | "prevYear" | "nextYear" | "weekStart" | "weekEnd";

/** The day a grid key moves focus to (arrows by day and week, Page keys by month, Home and End in the week). */
export function moveDay(d: Date, move: CalendarMove, weekStartsOn: 0 | 1): Date {
  switch (move) {
    case "prevDay":
      return addDays(d, -1);
    case "nextDay":
      return addDays(d, 1);
    case "prevWeek":
      return addDays(d, -7);
    case "nextWeek":
      return addDays(d, 7);
    case "prevMonth":
      return addMonths(d, -1);
    case "nextMonth":
      return addMonths(d, 1);
    case "prevYear":
      return addMonths(d, -12);
    case "nextYear":
      return addMonths(d, 12);
    case "weekStart":
      return addDays(d, -((d.getDay() - weekStartsOn + 7) % 7));
    case "weekEnd":
      return addDays(d, 6 - ((d.getDay() - weekStartsOn + 7) % 7));
  }
}

/** The move a key asks for in the day grid, or null for keys the grid leaves alone. */
export function keyMove(key: string, shift: boolean): CalendarMove | null {
  switch (key) {
    case "ArrowLeft":
      return "prevDay";
    case "ArrowRight":
      return "nextDay";
    case "ArrowUp":
      return "prevWeek";
    case "ArrowDown":
      return "nextWeek";
    case "PageUp":
      return shift ? "prevYear" : "prevMonth";
    case "PageDown":
      return shift ? "nextYear" : "nextMonth";
    case "Home":
      return "weekStart";
    case "End":
      return "weekEnd";
    default:
      return null;
  }
}
