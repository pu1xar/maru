import assert from "node:assert/strict";
import { test } from "node:test";

import { isLocalRequest } from "./localRequest.ts";

test("a request straight to the loopback port is local", () => {
  assert.equal(isLocalRequest("127.0.0.1", { host: "127.0.0.1:8024" }), true);
  assert.equal(isLocalRequest("::ffff:127.0.0.1", { host: "localhost:8024" }), true);
  assert.equal(isLocalRequest("::1", { host: "[::1]:8024" }), true);
});

test("a request through a reverse proxy is remote, though its socket is loopback", () => {
  assert.equal(isLocalRequest("127.0.0.1", { host: "maru.example.com" }), false, "a public host name");
  assert.equal(isLocalRequest("127.0.0.1", { host: "127.0.0.1:8024", "x-forwarded-for": "203.0.113.5" }), false);
  assert.equal(isLocalRequest("127.0.0.1", { host: "127.0.0.1:8024", "cf-connecting-ip": "203.0.113.5" }), false);
  assert.equal(isLocalRequest("127.0.0.1", {}), false, "no Host");
});

test("a socket that is not loopback is remote", () => {
  assert.equal(isLocalRequest("192.168.0.9", { host: "127.0.0.1:8024" }), false);
  assert.equal(isLocalRequest(undefined, { host: "127.0.0.1:8024" }), false);
});
