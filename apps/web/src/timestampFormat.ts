// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/timestampFormat.ts
// Local changes: only the formatters the timeline uses. The locale is en-US; T3's settings type is a local union with its default ("locale"). The tooltip spells
// the full date instead of T3's English ordinal date.

export type TimestampFormat = "locale" | "12-hour" | "24-hour";

// Local change: 24-hour by default ("00:41", not "12:41 AM"), the shorter form (user request).
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "24-hour";

const TIMESTAMP_LOCALE = "en-US";

function getTimestampFormatOptions(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormatOptions {
  const baseOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
  };
  if (timestampFormat === "locale") return baseOptions;
  return timestampFormat === "12-hour" ? { ...baseOptions, hour12: true } : { ...baseOptions, hourCycle: "h23" };
}

const timestampFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getTimestampFormatter(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
  timeZone?: string,
): Intl.DateTimeFormat {
  const cacheKey = `${timestampFormat}:${includeSeconds ? "seconds" : "minutes"}:${timeZone ?? ""}`;
  const cached = timestampFormatterCache.get(cacheKey);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(TIMESTAMP_LOCALE, {
    ...getTimestampFormatOptions(timestampFormat, includeSeconds),
    ...(timeZone ? { timeZone } : {}),
  });
  timestampFormatterCache.set(cacheKey, formatter);
  return formatter;
}

export function parseTimestampDate(isoDate: string): Date | null {
  const date = new Date(isoDate);
  return Number.isNaN(date.getTime()) ? null : date;
}

const fullDateFormatter = new Intl.DateTimeFormat(TIMESTAMP_LOCALE, {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
});

export function formatChatTimestampTooltip(
  isoDate: string,
  timestampFormat: TimestampFormat,
): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  return `${fullDateFormatter.format(date)} ${getTimestampFormatter(timestampFormat, true).format(date)}`;
}

export function formatShortTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  return getTimestampFormatter(timestampFormat, false).format(date);
}

const numericDateOptions: Intl.DateTimeFormatOptions = { month: "numeric", day: "numeric" };
const numericDateWithYearOptions: Intl.DateTimeFormatOptions = {
  ...numericDateOptions,
  year: "numeric",
};
const numericDateFormatter = new Intl.DateTimeFormat(TIMESTAMP_LOCALE, numericDateOptions);
const numericDateWithYearFormatter = new Intl.DateTimeFormat(
  TIMESTAMP_LOCALE,
  numericDateWithYearOptions,
);

interface CalendarDay {
  year: number;
  /** Days since the epoch, so differences are whole days across DST shifts. */
  index: number;
}

function calendarDay(date: Date, timeZone: string | undefined): CalendarDay {
  if (!timeZone) {
    const year = date.getFullYear();
    return { year, index: Date.UTC(year, date.getMonth(), date.getDate()) / 86_400_000 };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  const year = part("year");
  return { year, index: Date.UTC(year, part("month") - 1, part("day")) / 86_400_000 };
}

function formatNumericDate(date: Date, sameYear: boolean, timeZone: string | undefined): string {
  if (!timeZone) {
    return (sameYear ? numericDateFormatter : numericDateWithYearFormatter).format(date);
  }
  return new Intl.DateTimeFormat(TIMESTAMP_LOCALE, {
    ...(sameYear ? numericDateOptions : numericDateWithYearOptions),
    timeZone,
  }).format(date);
}

export function formatDayAwareTimestamp(
  isoDate: string,
  timestampFormat: TimestampFormat,
  nowMs: number = Date.now(),
  timeZone?: string,
): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  const time = getTimestampFormatter(timestampFormat, false, timeZone).format(date);
  const today = calendarDay(new Date(nowMs), timeZone);
  const messageDay = calendarDay(date, timeZone);
  const dayDiff = today.index - messageDay.index;
  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `Yesterday ${time}`;
  return `${formatNumericDate(date, messageDay.year === today.year, timeZone)} ${time}`;
}

/** `timeZone` overrides the zone the formatters cached when they were built. */
export function formatUpcomingTimestamp(
  isoDate: string,
  timestampFormat: TimestampFormat,
  nowMs: number = Date.now(),
  timeZone?: string,
): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  const time = getTimestampFormatter(timestampFormat, false, timeZone).format(date);
  const today = calendarDay(new Date(nowMs), timeZone);
  const targetDay = calendarDay(date, timeZone);
  const dayDiff = targetDay.index - today.index;
  if (dayDiff < 0) return formatDayAwareTimestamp(isoDate, timestampFormat, nowMs, timeZone);
  if (dayDiff === 0) return time;
  if (dayDiff === 1) return `Tomorrow ${time}`;
  return `${formatNumericDate(date, targetDay.year === today.year, timeZone)} ${time}`;
}
