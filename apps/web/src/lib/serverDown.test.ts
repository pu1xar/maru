import { test } from "node:test";
import assert from "node:assert/strict";
import { serverDownAfter, shownConnection } from "./serverDown.ts";

test("the first connecting state of a page is not a failure", () => {
  assert.equal(serverDownAfter(false, "connecting"), false);
});

test("a failed attempt marks the server down until a socket opens", () => {
  let down = false;
  const seen: boolean[] = [];
  // Never reachable: the hub alternates closed (backoff) and connecting (retry).
  for (const c of ["connecting", "closed", "connecting", "closed", "connecting"] as const) {
    down = serverDownAfter(down, c);
    seen.push(down);
  }
  assert.deepEqual(seen, [false, true, true, true, true]);
  assert.equal(serverDownAfter(down, "open"), false);
});

test("a drop after a working connection stays down through the retries", () => {
  let down = serverDownAfter(false, "open");
  const seen: boolean[] = [];
  for (const c of ["closed", "connecting", "closed", "connecting", "open"] as const) {
    down = serverDownAfter(down, c);
    seen.push(down);
  }
  assert.deepEqual(seen, [true, true, true, true, false]);
});

test("the shown state holds through the retries of an unreachable server", () => {
  let down = false;
  const shown: string[] = [];
  for (const c of ["closed", "connecting", "closed", "connecting", "closed", "connecting"] as const) {
    down = serverDownAfter(down, c);
    shown.push(shownConnection(down, c));
  }
  assert.deepEqual(shown, ["closed", "closed", "closed", "closed", "closed", "closed"]);
  assert.equal(shownConnection(serverDownAfter(down, "open"), "open"), "open");
});

test("before the first failure the shown state is connecting, then open", () => {
  // The hub's state before it starts is "closed"; the first render may read it.
  assert.equal(shownConnection(false, "closed"), "connecting");
  assert.equal(shownConnection(false, "connecting"), "connecting");
  assert.equal(shownConnection(false, "open"), "open");
});
