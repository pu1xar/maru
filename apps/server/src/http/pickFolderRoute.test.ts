import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { SessionIndex } from "../index/store.ts";
import { VisibleIndex } from "../index/visible.ts";
import { ProjectStore } from "../projects/store.ts";
import { ChosenStore } from "../state/chosen.ts";
import { createServer } from "./server.ts";

test("the Finder dialog is offered only to a request from this Mac itself (DESIGN.md 6z)", async () => {
  const projects = new ProjectStore(":memory:");
  const chosen = new ChosenStore(":memory:");
  const view = new VisibleIndex(new SessionIndex((s) => s), chosen);
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const server = createServer({ view, projects, chosen, guard, webDir: "/nonexistent" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  const url = `http://127.0.0.1:${port}/api/pick-folder`;
  const forwarded = { "x-forwarded-for": "203.0.113.5" };
  assert.deepEqual(await (await fetch(url)).json(), { available: process.platform === "darwin" });
  assert.deepEqual(await (await fetch(url, { headers: forwarded })).json(), { available: false });
  // Forwarded from elsewhere: refused before any dialog opens.
  const refused = await fetch(url, { method: "POST", headers: { ...forwarded, "content-type": "application/json" }, body: "{}" });
  assert.equal(refused.status, 403);
  server.close();
  projects.close();
  chosen.close();
});
