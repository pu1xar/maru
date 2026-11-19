import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCompactElapsedSeconds, formatElapsedSeconds } from "./agentElapsed.logic.ts";

test("compact: under an hour counts seconds, then whole minutes", () => {
  assert.equal(formatCompactElapsedSeconds(-5), "0s");
  assert.equal(formatCompactElapsedSeconds(0), "0s");
  assert.equal(formatCompactElapsedSeconds(45), "45s");
  assert.equal(formatCompactElapsedSeconds(59.9), "59s");
  assert.equal(formatCompactElapsedSeconds(60), "1m");
  assert.equal(formatCompactElapsedSeconds(24 * 60), "24m");
  assert.equal(formatCompactElapsedSeconds(59 * 60 + 59), "59m");
});

test("compact: from an hour it is hours and minutes", () => {
  assert.equal(formatCompactElapsedSeconds(60 * 60), "1h");
  assert.equal(formatCompactElapsedSeconds(60 * 60 + 59), "1h");
  assert.equal(formatCompactElapsedSeconds(60 * 60 + 60), "1h 1m");
  assert.equal(formatCompactElapsedSeconds(84 * 60), "1h 24m");
  assert.equal(formatCompactElapsedSeconds(84 * 60 + 59), "1h 24m");
  assert.equal(formatCompactElapsedSeconds(2 * 3600), "2h");
  assert.equal(formatCompactElapsedSeconds(10 * 3600), "10h");
  assert.equal(formatCompactElapsedSeconds(10 * 3600 + 30 * 60), "10h 30m");
  assert.equal(formatCompactElapsedSeconds(23 * 3600 + 59 * 60 + 59), "23h 59m");
});

test("compact: from 24 hours it is days and hours", () => {
  assert.equal(formatCompactElapsedSeconds(24 * 3600), "1d");
  assert.equal(formatCompactElapsedSeconds(24 * 3600 + 59 * 60), "1d");
  assert.equal(formatCompactElapsedSeconds(30 * 3600), "1d 6h");
  assert.equal(formatCompactElapsedSeconds(3 * 24 * 3600), "3d");
  assert.equal(formatCompactElapsedSeconds(50 * 3600 + 120), "2d 2h");
});

test("full form is unchanged", () => {
  assert.equal(formatElapsedSeconds(45), "45s");
  assert.equal(formatElapsedSeconds(185), "3m 05s");
  assert.equal(formatElapsedSeconds(3720), "1h 02m");
});
