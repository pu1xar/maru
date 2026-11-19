import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { checkRequest, guardConfig } from "./guard.ts";

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

test("accepts loopback hosts with no origin or a same-origin browser", () => {
  const cfg = guardConfig(8024);
  assert.equal(checkRequest(req({ host: "127.0.0.1:8024" }), cfg), null);
  assert.equal(checkRequest(req({ host: "localhost:8024", origin: "http://localhost:8024" }), cfg), null);
});

test("rejects a foreign origin and a rebinding host", () => {
  const cfg = guardConfig(8024);
  assert.match(checkRequest(req({ host: "127.0.0.1:8024", origin: "https://evil.example" }), cfg) ?? "", /origin/);
  assert.match(checkRequest(req({ host: "evil.example:8024" }), cfg) ?? "", /host/);
});
