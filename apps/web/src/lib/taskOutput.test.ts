import { test } from "node:test";
import assert from "node:assert/strict";

import { formatBytes, nextOutputRead, OUTPUT_REFRESH_MS, truncationNote } from "./taskOutput.ts";

test("nextOutputRead: a running task on a visible page reads again, anything else does not", () => {
  assert.equal(nextOutputRead(true, false), OUTPUT_REFRESH_MS);
  assert.equal(nextOutputRead(true, true), null, "a hidden page waits for visibilitychange");
  assert.equal(nextOutputRead(false, false), null, "an ended task's output no longer changes");
});

test("truncationNote names how much shows of how much there is", () => {
  assert.equal(truncationNote({ truncated: false, totalBytes: 100 }, 100), null);
  assert.equal(truncationNote({ truncated: true, totalBytes: 1_300_000 }, 65536), "Showing only the last 64.0KB of 1.2MB");
  assert.equal([0, 1023, 1024, 1536, 1048576].map(formatBytes).join(" "), "0B 1023B 1.0KB 1.5KB 1.0MB");
});
