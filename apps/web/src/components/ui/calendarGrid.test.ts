import { test } from "node:test";
import assert from "node:assert/strict";
import { addMonths, dayKey, keyMove, monthWeeks, moveDay, parseDayKey } from "./calendarGrid.ts";

test("dayKey and parseDayKey round-trip local days and refuse impossible dates", () => {
  assert.equal(dayKey(new Date(2026, 10, 6)), "2026-11-06");
  assert.equal(dayKey(parseDayKey("2026-02-28")!), "2026-02-28");
  assert.equal(parseDayKey("2026-02-30"), null);
  assert.equal(parseDayKey("2026-2-3"), null);
  assert.equal(parseDayKey(""), null);
});

test("monthWeeks: six weeks from the week of the 1st, outside days marked", () => {
  // November 2026 starts on a Sunday.
  const sun = monthWeeks(new Date(2026, 10, 16), 0);
  assert.equal(sun.length, 6);
  assert.ok(sun.every((w) => w.length === 7));
  assert.equal(sun[0]![0]!.key, "2026-11-01");
  assert.equal(sun[0]![0]!.outside, false);
  assert.equal(sun[4]![2]!.key, "2026-12-01");
  assert.equal(sun[4]![2]!.outside, true);
  // Weeks starting Monday put October 26 first.
  const mon = monthWeeks(new Date(2026, 10, 1), 1);
  assert.equal(mon[0]![0]!.key, "2026-10-26");
  assert.equal(mon[0]![0]!.outside, true);
  const days = sun.flat().filter((d) => !d.outside).map((d) => d.date.getDate());
  assert.deepEqual(days, Array.from({ length: 30 }, (_, i) => i + 1));
});

test("addMonths holds the day to the end of a shorter month", () => {
  assert.equal(dayKey(addMonths(new Date(2026, 0, 31), 1)), "2026-02-28");
  assert.equal(dayKey(addMonths(new Date(2026, 2, 31), -1)), "2026-02-28");
  assert.equal(dayKey(addMonths(new Date(2026, 10, 16), 12)), "2027-11-16");
});

test("grid keys move by day, week, month, year and to the week's ends", () => {
  const d = new Date(2026, 10, 18); // Wednesday
  const go = (key: string, shift = false, start: 0 | 1 = 0) => dayKey(moveDay(d, keyMove(key, shift)!, start));
  assert.equal(go("ArrowLeft"), "2026-11-17");
  assert.equal(go("ArrowRight"), "2026-11-19");
  assert.equal(go("ArrowUp"), "2026-11-11");
  assert.equal(go("ArrowDown"), "2026-11-25");
  assert.equal(go("PageUp"), "2026-10-18");
  assert.equal(go("PageDown", true), "2027-11-18");
  assert.equal(go("Home"), "2026-11-15");
  assert.equal(go("End"), "2026-11-21");
  assert.equal(go("Home", false, 1), "2026-11-16");
  assert.equal(keyMove("Enter", false), null);
});
