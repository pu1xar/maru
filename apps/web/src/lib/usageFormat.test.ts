import assert from "node:assert/strict";
import { test } from "node:test";

import type { UsageWindow } from "@maru/shared";
import { footerWindows, resetIn, usageNote, windowLine, windowResetText, windowSlots } from "./usageFormat.ts";

const NOW = Date.UTC(2026, 10, 16, 4, 0, 0);
const H = 3_600_000;
const win = (id: string, minutes: number | null, usedPercent: number | null, resetsAt: number | null): UsageWindow =>
  ({ id, minutes, usedPercent, resetsAt }) as UsageWindow;

test("resetIn is short: minutes, hours and days with one decimal rounded down", () => {
  assert.equal(resetIn(null, NOW), "");
  assert.equal(resetIn(NOW + 45 * 60_000, NOW), "45m");
  assert.equal(resetIn(NOW + 10_000, NOW), "1m");
  assert.equal(resetIn(NOW - 5_000, NOW), "");
  assert.equal(resetIn(NOW + 59.5 * 60_000, NOW), "1h");
  assert.equal(resetIn(NOW + 3.47 * H, NOW), "3.4h");
  assert.equal(resetIn(NOW + 3 * H, NOW), "3h");
  assert.equal(resetIn(NOW + 2.15 * 24 * H, NOW), "2.1d");
});

test("windowLine reads like 5h 77% (2.1h)", () => {
  assert.equal(windowLine(win("five_hour", 300, 77, NOW + 2.1 * H), NOW), "5h 77% (2.1h)");
  assert.equal(windowLine(win("seven_day", 10080, 40, NOW + 2.1 * 24 * H), NOW), "7d 40% (2.1d)");
  assert.equal(windowLine(win("seven_day", 10080, null, null), NOW), "7d -");
  assert.equal(windowLine(win("five_hour", 300, 12.4, NOW + 2 * H), NOW), "5h 12% (2h)");
  assert.equal(windowLine(win("five_hour", 300, 50, NOW + 2 * H), NOW, true), "5h 50%");
});

test("footerWindows: 5h first when there is one, then the weekly window, never twice", () => {
  const five = win("five_hour", 300, 10, null);
  const week = win("seven_day", 10080, 20, null);
  const month = win("month", 43200, 30, null);
  assert.deepEqual(footerWindows([week, five]), [five, week]);
  assert.deepEqual(footerWindows([week]), [week]);
  assert.deepEqual(footerWindows([five]), [five]);
  assert.deepEqual(footerWindows([five, month]), [five, month]);
  assert.deepEqual(footerWindows([]), []);
});

test("windowSlots: the 5h column first (empty when there is none), then the others", () => {
  const five = win("five_hour", 300, 10, null);
  const week = win("seven_day", 10080, 20, null);
  const month = win("month", 43200, 30, null);
  assert.deepEqual(windowSlots([week, five]), [five, week]);
  assert.deepEqual(windowSlots([week]), [null, week]);
  assert.deepEqual(windowSlots([five]), [five]);
  assert.deepEqual(windowSlots([five, week, month]), [five, week, month]);
  assert.deepEqual(windowSlots([]), []);
});

test("windowResetText: the time left, or old for a stale reading", () => {
  assert.equal(windowResetText({ resetsAt: NOW + 2 * H }, NOW, false), "2h");
  assert.equal(windowResetText({ resetsAt: NOW - H }, NOW, false), "");
  assert.equal(windowResetText({ resetsAt: NOW - H }, NOW, true), "old");
});

test("usageNote: the reason for no bars, flagged when the account needs attention", () => {
  assert.deepEqual(usageNote({ status: "expired", error: null }), { text: "Token expired", attention: true });
  assert.deepEqual(usageNote({ status: "error", error: "HTTP 500" }), { text: "HTTP 500", attention: true });
  assert.deepEqual(usageNote({ status: "rate_limited", error: null }), { text: "Rate limited", attention: false });
  assert.deepEqual(usageNote({ status: "no_data", error: null }), { text: "No data yet", attention: false });
  assert.equal(usageNote({ status: "ok", error: null }), null);
});
