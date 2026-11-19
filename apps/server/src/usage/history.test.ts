import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountUsage } from "@maru/shared";
import { UsageHistoryStore } from "./history.ts";

const H = 3_600_000;

function usage(over: Partial<AccountUsage> & { five?: number | null; seven?: number | null; reset?: number }): AccountUsage {
  const reset = over.reset ?? Date.parse("2026-11-20T00:00:00Z");
  const windows = [
    ...(over.five === undefined ? [] : [{ id: "five_hour", minutes: 300, usedPercent: over.five, resetsAt: reset - 100 * H }]),
    ...(over.seven === undefined ? [] : [{ id: "seven_day", minutes: 10080, usedPercent: over.seven, resetsAt: reset }]),
  ];
  return {
    provider: "claude", account: "claude-a", email: null, plan: null, free: false, active: false,
    status: "ok", error: null, windows, source: "anthropic_oauth", stale: false, capturedAt: null, ...over,
  };
}

test("a reading is written only when the series' value or reset time changed", () => {
  const h = new UsageHistoryStore(":memory:");
  const t0 = Date.parse("2026-11-16T00:00:00Z");
  assert.equal(h.record(usage({ five: 10, seven: 40, capturedAt: t0 }), t0), 2);
  // The same values a minute later: nothing new.
  assert.equal(h.record(usage({ five: 10, seven: 40, capturedAt: t0 + 60_000 }), t0 + 60_000), 0);
  // The endpoint's sub-second jitter on the reset time is the same reading.
  assert.equal(h.record(usage({ five: 10, seven: 40, capturedAt: t0 + 120_000, reset: Date.parse("2026-11-20T00:00:00.101Z") }), 0), 0);
  // One window moved.
  assert.equal(h.record(usage({ five: 12, seven: 40, capturedAt: t0 + 180_000 }), 0), 1);
  // The 5h window reset: same percent, new reset time.
  assert.equal(h.record(usage({ five: 12, seven: 40, capturedAt: t0 + 240_000, reset: Date.parse("2026-11-20T05:00:00Z") }), 0), 2);
  assert.equal(h.size().rows, 5);
  h.close();
});

test("readings that are not fresh values are skipped", () => {
  const h = new UsageHistoryStore(":memory:");
  const t0 = Date.parse("2026-11-16T00:00:00Z");
  assert.equal(h.record(usage({ five: 1, status: "rate_limited" }), t0), 0);
  assert.equal(h.record(usage({ five: 1, stale: true, capturedAt: t0 }), t0), 0, "a Codex rollout snapshot older than 6h");
  assert.equal(h.record(usage({ five: null, seven: 3, capturedAt: t0 }), t0), 1, "a window without a value");
  // The last good read shown again after a failed read keeps its old capturedAt.
  assert.equal(h.record(usage({ seven: 3, capturedAt: t0 }), t0 + 60_000), 0);
  // A reading older than the series' last row (a rollout read after a live read) is left out.
  assert.equal(h.record(usage({ seven: 2, capturedAt: t0 - 60_000 }), t0 + 60_000), 0);
  // No capturedAt: the time of the record call.
  assert.equal(h.record(usage({ seven: 5 }), t0 + 120_000), 1);
  const r = h.read(t0 - H, t0 + H);
  assert.deepEqual(r.series[0]?.points.map((p) => [p.at - t0, p.usedPercent]), [[0, 3], [120_000, 5]]);
  h.close();
});

test("read: the span's rows, led by each series' last row before it; every account and window apart", () => {
  const h = new UsageHistoryStore(":memory:");
  const t0 = Date.parse("2026-11-01T00:00:00Z");
  h.record(usage({ seven: 5, capturedAt: t0 }), 0);
  h.record(usage({ seven: 6, capturedAt: t0 + H }), 0);
  h.record(usage({ seven: 7, capturedAt: t0 + 10 * H }), 0);
  h.record(usage({ account: "codex-a", provider: "codex", windows: [{ id: "primary", minutes: 300, usedPercent: 50, resetsAt: null }], capturedAt: t0 + 11 * H }), 0);
  const r = h.read(t0 + 2 * H, t0 + 20 * H);
  assert.equal(r.from, t0 + 2 * H);
  const claude = r.series.find((s) => s.account === "claude-a" && s.window === "seven_day");
  assert.deepEqual(claude?.points.map((p) => p.usedPercent), [6, 7], "the row before the span, then the span");
  assert.equal(claude?.minutes, 10080);
  const codex = r.series.find((s) => s.account === "codex-a");
  assert.deepEqual(codex && { provider: codex.provider, window: codex.window, points: codex.points }, {
    provider: "codex", window: "primary", points: [{ at: t0 + 11 * H, usedPercent: 50, resetsAt: null }],
  });
  assert.equal(h.read(t0 - 2 * H, t0 - H).series.length, 0, "nothing before the first row");
  h.close();
});

test("a restart continues each series from its newest row in the file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.sqlite");
  const t0 = Date.parse("2026-11-16T00:00:00Z");
  const a = new UsageHistoryStore(file);
  a.record(usage({ seven: 40, capturedAt: t0 }), 0);
  a.record(usage({ seven: 41, capturedAt: t0 + H }), 0);
  a.close();
  const b = new UsageHistoryStore(file);
  assert.equal(b.record(usage({ seven: 41, capturedAt: t0 + 2 * H }), 0), 0, "the same as the last row before the restart");
  assert.equal(b.record(usage({ seven: 42, capturedAt: t0 + 3 * H }), 0), 1);
  assert.deepEqual(b.size(), { rows: 3, oldest: t0 });
  b.close();
});
