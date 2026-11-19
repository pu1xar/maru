// The shell calls against a fake fetch: each one's method, path, body and token, and that the server
// lets a phone token pass exactly these (devices/access.ts), with the web's own checks after it.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { upgradeAllowed, webRouteAllowed } from "../../../server/src/devices/access.ts";
import { SHELL_SOCKET_PATH } from "../../../../packages/shared/src/shell.ts";
import type { Pairing } from "../lib/api.ts";
import { serverOrigin, shellApi } from "./api.ts";

const pairing = { server: "https://maru.test", token: "tok", device: {} } as unknown as Pairing;
const shell = { id: "sh-0123456789ab", cwd: "/", createdAt: 1, command: "zsh", path: "/", clients: 0 };

interface Seen {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
  contentType: string | null;
}
let seen: Seen[] = [];
let status = 200;
let answer: unknown = {};
const realFetch = globalThis.fetch;

beforeEach(() => {
  seen = [];
  status = 200;
  answer = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      method: init?.method ?? "GET",
      path: new URL(String(input)).pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
    });
    return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("list, create and close use the routes the server gives a phone token", async () => {
  const api = shellApi(pairing);
  answer = { shells: [shell] };
  assert.deepEqual(await api.list(), [shell]);
  answer = shell;
  assert.deepEqual(await api.create({ cwd: "/Users/x/proj" }), shell);
  await api.create({ cwd: null });
  answer = { ok: true };
  await api.close(shell.id);
  assert.deepEqual(
    seen.map((s) => `${s.method} ${s.path}`),
    ["GET /api/shells", "POST /api/shells", "POST /api/shells", `DELETE /api/shells/${shell.id}`],
  );
  assert.deepEqual(seen[1]!.body, { cwd: "/Users/x/proj" });
  assert.deepEqual(seen[2]!.body, { cwd: null });
  assert.equal(seen[1]!.contentType, "application/json", "the web's guard takes a POST of application/json only");
  assert.ok(seen.every((s) => s.authorization === "Bearer tok"));
  for (const s of seen) assert.equal(webRouteAllowed("android", s.method, s.path), true, `${s.method} ${s.path} passes for a phone`);
  assert.equal(upgradeAllowed("android", SHELL_SOCKET_PATH), true, "the view socket too");
});

test("ending a shell that is already gone is not a failure; another failure is", async () => {
  const api = shellApi(pairing);
  status = 404;
  answer = { error: "Terminal not found" };
  await api.close(shell.id);
  status = 500;
  answer = { error: "tmux: boom" };
  await assert.rejects(api.close(shell.id), /tmux: boom/);
  await assert.rejects(api.list(), /tmux: boom/);
  status = 400;
  answer = { error: "Folder not found: /x" };
  await assert.rejects(api.create({ cwd: "/x" }), /Folder not found/);
});

test("the socket's address comes from the paired server's scheme and host", () => {
  assert.deepEqual(serverOrigin("https://maru.example.com"), { protocol: "https:", host: "maru.example.com" });
  assert.deepEqual(serverOrigin("http://192.168.0.10:8025"), { protocol: "http:", host: "192.168.0.10:8025" });
  assert.deepEqual(serverOrigin("HTTPS://Maru.test/"), { protocol: "https:", host: "Maru.test" });
  assert.deepEqual(serverOrigin(" https://maru.test/path?x#y "), { protocol: "https:", host: "maru.test" });
  for (const bad of ["", "maru.test", "ftp://maru.test", "https://", "ws://maru.test"]) assert.equal(serverOrigin(bad), null, bad);
});
