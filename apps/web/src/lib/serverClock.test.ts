import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { noteServerTime, resetServerClock, serverNow } from "./serverClock.ts";

afterEach(resetServerClock);

test("server now follows the offset taken at hello", () => {
  assert.equal(serverNow(1000), 1000, "equal clocks before any hello");
  noteServerTime(61_000, 1000);
  assert.equal(serverNow(4000), 64_000, "the server is a minute ahead of this page");
  noteServerTime(500, 1000);
  assert.equal(serverNow(2000), 1500, "a later hello replaces the offset");
  noteServerTime(undefined, 9999);
  assert.equal(serverNow(2000), 1500, "a hello without serverTime keeps it");
});
