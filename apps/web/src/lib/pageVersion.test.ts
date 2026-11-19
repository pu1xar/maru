import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_VERSION, reloadSuggested } from "./pageVersion.ts";

test("no build define under node", () => {
  assert.equal(PAGE_VERSION, null);
});

test("a release page asks for a reload when the server runs another version", () => {
  assert.equal(reloadSuggested("0.1.52", { version: "0.1.60" }), true);
  // A rollback to an older release changes the server too.
  assert.equal(reloadSuggested("0.1.52", { version: "0.1.40" }), true);
  // A server from before versions sends no field at all.
  assert.equal(reloadSuggested("0.1.52", {}), true);
});

test("no reload when nothing would change or nothing is known", () => {
  assert.equal(reloadSuggested("0.1.52", { version: "0.1.52" }), false);
  // Before the first hello, and a server that could not read its version.
  assert.equal(reloadSuggested("0.1.52", null), false);
  assert.equal(reloadSuggested("0.1.52", { version: null }), false);
  // A working tree's page reloads into the same working tree's page.
  assert.equal(reloadSuggested("0.1.52-dev", { version: "0.1.60" }), false);
  assert.equal(reloadSuggested(null, { version: "0.1.60" }), false);
});
