// The calls of the session management section against a fake fetch: each one's method, path, query
// and body, and that the server lets a phone token pass exactly these (devices/access.ts).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { webRouteAllowed } from "../../../server/src/devices/access.ts";
import type { Pairing } from "./api.ts";
import {
  chooseSession,
  deleteOrphan,
  deleteSession,
  deleteUnit,
  fetchAllCandidates,
  fetchAllUnits,
  fetchOrphans,
  fetchSessionUnits,
  fetchTrash,
  fetchUnitLabels,
  moveSession,
  purgeTrash,
  rehomeSession,
  renameSession,
  restoreTrash,
  resumeCommand,
} from "./manageApi.ts";

const pairing = { server: "https://maru.test", token: "tok", device: {} } as unknown as Pairing;

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  authorization: string | null;
}
let seen: Seen[] = [];
let answers: unknown[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  seen = [];
  answers = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: headers.get("authorization"),
    });
    // Unless a test queued an answer: the empty form of what each read returns.
    const empty = url.pathname === "/api/session-agents" ? { agents: [] } : url.pathname === "/api/session-candidates" ? { sessions: [], total: 0, offset: 0 } : {};
    const body = answers.length ? answers.shift() : empty;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const target = { provider: "claude", account: "claude-a", id: "s1" } as const;

test("every call goes to the web's route with its method and the device token, and the server passes it to a phone", async () => {
  await fetchOrphans(pairing);
  await fetchAllUnits(pairing);
  await fetchSessionUnits(pairing, "claude-a", "s1");
  await fetchUnitLabels(pairing, "claude-a", "s1");
  await fetchTrash(pairing);
  await resumeCommand(pairing, target);
  await renameSession(pairing, { ...target, name: "n" });
  await chooseSession(pairing, { provider: "claude", id: "s1", chosen: true });
  await deleteSession(pairing, target);
  await deleteOrphan(pairing, target);
  await deleteUnit(pairing, { ...target, kind: "subagent", unitId: "agent-1" });
  await restoreTrash(pairing, "k");
  await purgeTrash(pairing, "k");
  await moveSession(pairing, { provider: "claude", id: "s1", from: "claude-a", to: "claude-b" });
  await rehomeSession(pairing, { ...target, cwd: "/w" });
  await fetchAllCandidates(pairing);
  assert.deepEqual(
    seen.map((s) => `${s.method} ${s.path}`),
    [
      "GET /api/orphans",
      "GET /api/session-units/all",
      "GET /api/session-units",
      "GET /api/session-agents",
      "GET /api/trash",
      "GET /api/session-resume-command",
      "PUT /api/session-name",
      "PUT /api/session-chosen",
      "POST /api/session-delete",
      "POST /api/orphans/delete",
      "POST /api/session-units/delete",
      "POST /api/trash/restore",
      "POST /api/trash/purge",
      "POST /api/session-move",
      "POST /api/session-rehome",
      "GET /api/session-candidates",
    ],
  );
  for (const s of seen) {
    assert.equal(s.authorization, "Bearer tok", s.path);
    assert.equal(webRouteAllowed("android", s.method, s.path, s.query), true, `${s.method} ${s.path}`);
  }
  assert.deepEqual(seen[2]!.query.get("provider"), "claude");
  assert.equal(seen[3]!.query.get("key"), "claude:claude-a:s1");
  assert.equal(seen[5]!.query.get("account"), "claude-a");
  assert.deepEqual(seen[6]!.body, { ...target, name: "n" });
  assert.deepEqual(seen[12]!.body, { key: "k" });
});

test("candidates are read page by page until the server's total, and an empty page ends the loop", async () => {
  const s = (id: string) => ({ key: `claude:claude-a:${id}`, id });
  answers = [
    { sessions: [s("a"), s("b")], total: 3, offset: 0 },
    { sessions: [s("c")], total: 3, offset: 2 },
  ];
  const all = await fetchAllCandidates(pairing);
  assert.deepEqual(all.map((x) => x.id), ["a", "b", "c"]);
  assert.deepEqual(seen.map((x) => x.query.get("offset")), ["0", "2"]);
  seen = [];
  answers = [{ sessions: [s("a")], total: 5, offset: 0 }, { sessions: [], total: 5, offset: 1 }];
  assert.equal((await fetchAllCandidates(pairing)).length, 1);
});

test("a refused write carries the server's reason", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "locked" }), { status: 409, headers: { "content-type": "application/json" } })) as typeof fetch;
  await assert.rejects(deleteSession(pairing, target), /locked/);
});
