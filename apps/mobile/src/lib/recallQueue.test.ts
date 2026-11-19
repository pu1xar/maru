import { test } from "node:test";
import assert from "node:assert/strict";
import { textsToPutBack } from "./recallQueue.ts";

test("a recall puts the texts back, a discard puts nothing back", () => {
  const messages = [{ text: "first" }, { text: "second" }];
  assert.deepEqual(textsToPutBack({ key: "k", id: "a", discard: false }, messages), ["first", "second"]);
  assert.deepEqual(textsToPutBack({ key: "k", id: "a", discard: true }, messages), []);
});
