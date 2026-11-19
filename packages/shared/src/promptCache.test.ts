import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCacheRemaining, promptCacheTtlOf, promptCacheView } from "./promptCache.ts";

const AT = "2026-11-17T01:00:00.000Z";
const at = Date.parse(AT);

test("ttl: 5m tokens win, 1h only is one hour, a pure read keeps the previous", () => {
  assert.equal(promptCacheTtlOf({ fiveMinute: 10, oneHour: 0 }, 3_600_000), 300_000);
  assert.equal(promptCacheTtlOf({ fiveMinute: 10, oneHour: 5 }, null), 300_000, "mixed: the shorter decides");
  assert.equal(promptCacheTtlOf({ fiveMinute: 0, oneHour: 5 }, 300_000), 3_600_000);
  assert.equal(promptCacheTtlOf({ fiveMinute: 0, oneHour: 0 }, 3_600_000), 3_600_000);
  assert.equal(promptCacheTtlOf({ fiveMinute: 0, oneHour: 0 }, null), null);
});

test("remaining text rounds up and never says 0", () => {
  assert.equal(formatCacheRemaining(4 * 60_000 + 1), "5m");
  assert.equal(formatCacheRemaining(4 * 60_000), "4m");
  assert.equal(formatCacheRemaining(59_999), "under 1m");
  assert.equal(formatCacheRemaining(52 * 60_000), "52m");
});

test("view: five-minute cache counts down then expires", () => {
  const c = { at: AT, ttlMs: 300_000 };
  const warm = promptCacheView(c, at + 60_000, false, "10:00");
  assert.equal(warm?.state, "warm");
  assert.equal(warm?.label, "Cache 4m");
  assert.match(warm?.tooltip ?? "", /Last response 10:00, cache lifetime 5m/);
  const edge = promptCacheView(c, at + 300_000, false, "10:00");
  assert.equal(edge?.state, "expired");
  assert.equal(edge?.label, "Cache expired");
  assert.match(edge?.tooltip ?? "", /rewrites/);
});

test("view: one-hour cache shows its minutes", () => {
  const v = promptCacheView({ at: AT, ttlMs: 3_600_000 }, at + 8 * 60_000, false, "10:00");
  assert.equal(v?.label, "Cache 52m");
  assert.match(v?.tooltip ?? "", /1h/);
});

test("view: compaction leaves the cache cold regardless of time, running and missing hide it", () => {
  const cold = promptCacheView({ at: AT, ttlMs: 3_600_000, cold: true }, at + 1000, false, "10:00");
  assert.equal(cold?.state, "expired");
  assert.equal(cold?.label, "No cache");
  assert.equal(promptCacheView({ at: AT, ttlMs: 300_000 }, at, true, "10:00"), null);
  assert.equal(promptCacheView(null, at, false, ""), null);
  assert.equal(promptCacheView(undefined, at, false, ""), null);
  assert.equal(promptCacheView({ at: "garbage", ttlMs: 300_000 }, at, false, ""), null);
});
