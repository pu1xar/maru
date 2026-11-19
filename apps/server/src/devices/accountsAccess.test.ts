import { test } from "node:test";
import assert from "node:assert/strict";
import { webRouteAllowed } from "./access.ts";

test("a phone reads the accounts' login status and edits nothing, a desktop token edits them", () => {
  assert.equal(webRouteAllowed("android", "GET", "/api/accounts/status"), true);
  const edits: [string, string][] = [
    ["POST", "/api/accounts"],
    ["DELETE", "/api/accounts/claude-work"],
    ["POST", "/api/accounts/claude-work/login"],
    ["PUT", "/api/settings/claude-usage"],
  ];
  for (const [method, p] of edits) {
    assert.equal(webRouteAllowed("android", method, p), false, `android ${method} ${p}`);
    assert.equal(webRouteAllowed("desktop", method, p), true, `desktop ${method} ${p}`);
  }
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal(webRouteAllowed("android", method, "/api/accounts/status"), false, method);
});
