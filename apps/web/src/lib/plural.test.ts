import assert from "node:assert/strict";
import test from "node:test";

import { monthDay } from "./dateText.ts";
import { plural } from "./plural.ts";

test("plural writes the count with the singular only for one", () => {
  assert.equal(plural(1, "file"), "1 file");
  assert.equal(plural(0, "file"), "0 files");
  assert.equal(plural(3, "directory", "directories"), "3 directories");
});

test("monthDay names the month and gives the day without padding", () => {
  assert.equal(monthDay(new Date(2026, 10, 5)), "Nov 5");
  assert.equal(monthDay(new Date(2026, 0, 31)), "Jan 31");
});
