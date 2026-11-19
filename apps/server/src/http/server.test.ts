import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { RenameSession, RenameSessionResult, ServerMessage, SessionSummary } from "@maru/shared";
import { SessionIndex } from "../index/store.ts";
import { ProjectStore } from "../projects/store.ts";
import { ChosenStore } from "../state/chosen.ts";
import { FoldedGroupStore } from "../state/foldedGroups.ts";
import { VisibleIndex } from "../index/visible.ts";
import { RenameError } from "../sessions/rename.ts";
import { DriveError, type ClaudeRuns } from "../drive/claudeRuns.ts";
import type { CodexRuns } from "../drive/codexRuns.ts";
import type { PendingSends } from "../drive/pendingSends.ts";
import { SessionCommandsError } from "../commands/sessionCommands.ts";
import { createServer } from "./server.ts";

function session(id: string): SessionSummary {
  return {
    key: `codex:acct:${id}`, provider: "codex", account: "acct", id, cwd: "/x", name: null, title: null,
    preview: null, status: "closed", owner: "none", pid: null, tmuxPane: null, parentKey: null,
    updatedAt: 1, createdAt: null, sizeBytes: null, entrypoint: null,
  };
}

test("project API round trip with live WebSocket updates", async () => {
  const projects = new ProjectStore(":memory:");
  const index = new SessionIndex((s) => ({ ...s, projectId: projects.projectOf(s.provider, s.id) }));
  projects.onChange((c) => {
    if (c.kind === "assignments") index.reannotate((s) => c.keys.includes(`${s.provider}:${s.id}`));
  });
  index.apply({ type: "upsert", session: session("t1") });
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const chosen = new ChosenStore(":memory:");
  chosen.set("codex", "t1", true);
  const view = new VisibleIndex(index, chosen);
  const server = createServer({ view, projects, chosen, guard, webDir: "/nonexistent" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  guard.origins.add(`http://127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;
  const json = { "content-type": "application/json" };

  const messages: ServerMessage[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r) => ws.once("message", (d) => { messages.push(JSON.parse(String(d))); r(null); }));
  ws.on("message", (d) => messages.push(JSON.parse(String(d))));
  assert.equal(messages[0]?.type, "hello");

  const created = await (await fetch(`${base}/api/projects`, { method: "POST", headers: json, body: JSON.stringify({ name: "P" }) })).json();
  const pid = created.project.id as string;
  const assigned = await fetch(`${base}/api/session-project`, {
    method: "PUT", headers: json, body: JSON.stringify({ provider: "codex", id: "t1", projectId: pid }),
  });
  assert.equal(assigned.status, 200);
  const bad = await fetch(`${base}/api/projects`, { method: "POST", headers: json, body: JSON.stringify({ name: "" }) });
  assert.equal(bad.status, 400);
  const noJson = await fetch(`${base}/api/projects`, { method: "POST", body: "name=x" });
  assert.equal(noJson.status, 415);
  const foreign = await fetch(`${base}/api/projects`, { method: "POST", headers: { ...json, origin: "https://evil.example" }, body: "{}" });
  assert.equal(foreign.status, 403);

  await new Promise((r) => setTimeout(r, 50));
  const kinds = messages.map((m) => m.type);
  assert.deepEqual(kinds, ["hello", "projects", "index"]);
  const upsert = messages[2];
  assert.ok(upsert?.type === "index" && upsert.event.type === "upsert" && upsert.event.session.projectId === pid);

  ws.close();
  server.close();
  projects.close();
});

test("POST /api/projects/order: every client hears the new Group order, a stale or partial list is a 400", async () => {
  const projects = new ProjectStore(":memory:");
  const [a, b, c] = [projects.create({ name: "A" }), projects.create({ name: "B" }), projects.create({ name: "C" })];
  const chosen = new ChosenStore(":memory:");
  const view = new VisibleIndex(new SessionIndex((s) => s), chosen);
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const server = createServer({ view, projects, chosen, guard, webDir: "/nonexistent" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  guard.origins.add(`http://127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;
  const json = { "content-type": "application/json" };
  const order = (ids: unknown) =>
    fetch(`${base}/api/projects/order`, { method: "POST", headers: json, body: JSON.stringify({ ids }) });

  // A second client, which only listens.
  const heard: ServerMessage[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((r) => ws.once("message", () => r()));
  ws.on("message", (d) => heard.push(JSON.parse(String(d))));

  const ok = await order([c.id, a.id, b.id]);
  assert.equal(ok.status, 200);
  assert.deepEqual(((await ok.json()) as { projects: { name: string }[] }).projects.map((p) => p.name), ["C", "A", "B"]);
  await new Promise((r) => setTimeout(r, 50));
  const lists = heard.filter((m) => m.type === "projects").map((m) => (m as { projects: { name: string }[] }).projects.map((p) => p.name));
  assert.deepEqual(lists, [["C", "A", "B"]]);

  assert.equal((await order([a.id])).status, 400);
  assert.equal((await order("nope")).status, 400);
  assert.equal((await order([a.id, b.id, "gone"])).status, 400);
  assert.deepEqual(projects.list().map((p) => p.name), ["C", "A", "B"]);

  ws.close();
  server.close();
  projects.close();
});

test("folded folders: hello carries the list, one key per command, every client hears the merge", async () => {
  const projects = new ProjectStore(":memory:");
  const chosen = new ChosenStore(":memory:");
  const folds = new FoldedGroupStore(":memory:");
  const view = new VisibleIndex(new SessionIndex((s) => s), chosen);
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const server = createServer({ view, projects, chosen, folds, guard, webDir: "/nonexistent" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  guard.origins.add(`http://127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;
  const json = { "content-type": "application/json" };
  const put = (key: string, folded: boolean) =>
    fetch(`${base}/api/group-fold`, { method: "PUT", headers: json, body: JSON.stringify({ key, folded }) });

  const seen: ServerMessage[][] = [[], []];
  const sockets = [new WebSocket(`ws://127.0.0.1:${port}/ws`), new WebSocket(`ws://127.0.0.1:${port}/ws`)];
  await Promise.all(sockets.map((ws, i) => new Promise<void>((r) => {
    ws.on("message", (d) => {
      seen[i]!.push(JSON.parse(String(d)));
      if (seen[i]!.length === 1) r();
    });
  })));
  assert.ok(seen[0]![0]?.type === "hello" && Array.isArray(seen[0]![0].foldedGroups) && seen[0]![0].foldedGroups.length === 0);

  // Two clients fold different folders; neither command carries a full list, so neither undoes the other.
  assert.equal((await put("pinned", true)).status, 200);
  assert.equal((await put("unassigned", true)).status, 200);
  assert.equal((await put("project:nope", true)).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  const lists = seen[1]!.filter((m) => m.type === "foldedGroups").map((m) => (m as { keys: string[] }).keys);
  assert.deepEqual(lists, [["pinned"], ["pinned", "unassigned"], ["pinned", "project:nope", "unassigned"]]);

  assert.equal((await put("bad key", true)).status, 400);
  assert.equal((await fetch(`${base}/api/group-fold/import`, { method: "POST", headers: json, body: JSON.stringify({ keys: "x" }) })).status, 400);
  // A fold was set, so an older client's list is no longer taken.
  const imp = await (await fetch(`${base}/api/group-fold/import`, { method: "POST", headers: json, body: JSON.stringify({ keys: ["archive:open"] }) })).json();
  assert.deepEqual(imp, { imported: false, keys: ["pinned", "project:nope", "unassigned"] });

  for (const ws of sockets) ws.close();
  server.close();
  projects.close();
  chosen.close();
  folds.close();
});

test("the server's version reaches the hello and /healthz", async () => {
  const projects = new ProjectStore(":memory:");
  const chosen = new ChosenStore(":memory:");
  const view = new VisibleIndex(new SessionIndex((s) => s), chosen);
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const server = createServer({ view, projects, chosen, guard, webDir: "/nonexistent", version: "0.1.52" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const hello = await new Promise<ServerMessage>((r) => ws.once("message", (d) => r(JSON.parse(String(d)))));
  assert.ok(hello.type === "hello" && hello.version === "0.1.52");
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(health.version, "0.1.52");
  ws.close();
  server.close();
  projects.close();
  chosen.close();
});

test("/ws pings every socket; one that leaves a ping unanswered until the next is closed (half-open peers)", async () => {
  const projects = new ProjectStore(":memory:");
  const chosen = new ChosenStore(":memory:");
  const view = new VisibleIndex(new SessionIndex((s) => s), chosen);
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const server = createServer({ view, projects, chosen, guard, webDir: "/nonexistent", wsPingMs: 60 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  const open = async (opts: { autoPong: boolean }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, opts);
    await new Promise((r) => ws.once("message", r));
    return ws;
  };
  // A live peer answers each ping (the ws client, like browsers and OkHttp, does it by itself).
  const live = await open({ autoPong: true });
  // A half-open peer: it never answers.
  const gone = await open({ autoPong: false });
  let pings = 0;
  gone.on("ping", () => pings++);
  const closed = new Promise<number>((r) => gone.once("close", (code) => r(code)));
  const code = await closed;
  assert.ok(pings >= 1, "it was pinged before it was closed");
  assert.equal(code, 1006, "terminated, not closed by handshake");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(live.readyState, WebSocket.OPEN, "the peer that answers stays");
  live.close();
  server.close();
  projects.close();
  chosen.close();
});

test("PUT /api/session-name answers with the rename result, or the refusal's status and message", async () => {
  const projects = new ProjectStore(":memory:");
  const chosen = new ChosenStore(":memory:");
  const view = new VisibleIndex(new SessionIndex(), chosen);
  const received: RenameSession[] = [];
  const renamer = {
    async rename(req: RenameSession): Promise<RenameSessionResult> {
      received.push(req);
      if (req.name === "open") throw new RenameError(409, "A Claude process (pid 1) has this session open");
      return { ok: true, name: req.name, stored: "transcript" };
    },
  };
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const server = createServer({ view, projects, chosen, renamer, guard, webDir: "/nonexistent" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  const url = `http://127.0.0.1:${port}/api/session-name`;
  const put = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
    fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });

  const req: RenameSession = { provider: "claude", account: "claude-a", id: "x", name: "새 이름" };
  const ok = await put(req);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, name: "새 이름", stored: "transcript" });
  assert.deepEqual(received, [req]);

  const refused = await put({ ...req, name: "open" });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "A Claude process (pid 1) has this session open" });

  assert.equal((await put(req, {})).status, 415);
  assert.equal(received.length, 2, "a body without the JSON content type never reaches the renamer");

  server.close();
  projects.close();
  chosen.close();
});


test("GET /api/file answers this app's pages and refuses other sites' requests", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srv-file-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "a.md");
  fs.writeFileSync(file, "# hi\n");

  const projects = new ProjectStore(":memory:");
  const chosen = new ChosenStore(":memory:");
  const view = new VisibleIndex(new SessionIndex(), chosen);
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const server = createServer({ view, projects, chosen, guard, webDir: "/nonexistent" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  const url = (p: string, q: string) => `http://127.0.0.1:${port}${p}?${new URLSearchParams({ path: q })}`;

  const ok = await fetch(url("/api/file", file), { headers: { "sec-fetch-site": "same-origin" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cross-origin-resource-policy"), "same-origin");
  const body = (await ok.json()) as { kind: string; language: string; text: string };
  assert.deepEqual([body.kind, body.language, body.text], ["text", "markdown", "# hi\n"]);

  const sibling = await fetch(url("/api/file/raw", file), { headers: { "sec-fetch-site": "same-site" } });
  assert.equal(sibling.status, 403);
  await sibling.text();

  const missing = await fetch(url("/api/file", path.join(dir, "nope")));
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "File not found" });

  const relative = await fetch(url("/api/file", "a.md"));
  assert.equal(relative.status, 400);
  assert.deepEqual(await relative.json(), { error: "Not an absolute path", detail: "a.md" });

  // The file tree's folder listing follows the same rule.
  fs.mkdirSync(path.join(dir, "sub"));
  const tree = (q: Record<string, string>) => `http://127.0.0.1:${port}/api/file/tree?${new URLSearchParams(q)}`;
  const listed = await fetch(tree({ root: dir, dir: "" }), { headers: { "sec-fetch-site": "same-origin" } });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("cross-origin-resource-policy"), "same-origin");
  const listing = (await listed.json()) as { dir: string; entries: { name: string; kind: string }[] };
  assert.equal(listing.dir, "");
  assert.deepEqual(
    listing.entries.map((e) => `${e.name}:${e.kind}`).sort(),
    ["a.md:file", "sub:directory"],
  );
  const foreignTree = await fetch(tree({ root: dir, dir: "" }), { headers: { "sec-fetch-site": "same-site" } });
  assert.equal(foreignTree.status, 403);
  await foreignTree.text();
  const escaping = await fetch(tree({ root: dir, dir: ".." }));
  assert.equal(escaping.status, 400);
  assert.deepEqual(await escaping.json(), { error: "Invalid folder path", detail: ".." });
});

test("GET /api/session finds a session on the list or off it, and 404s an unknown key", async (t) => {
  const projects = new ProjectStore(":memory:");
  const index = new SessionIndex();
  index.apply({ type: "upsert", session: session("on") });
  index.apply({ type: "upsert", session: session("off") });
  const chosen = new ChosenStore(":memory:");
  chosen.set("codex", "on", true);
  const view = new VisibleIndex(index, chosen);
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const server = createServer({ view, projects, chosen, guard, webDir: "/nonexistent" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  const get = (key: string) => fetch(`http://127.0.0.1:${port}/api/session?${new URLSearchParams({ key })}`);
  for (const id of ["on", "off"]) {
    const r = await get(`codex:acct:${id}`);
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { session: { id: string } }).session.id, id);
  }
  const missing = await get("codex:acct:nope");
  assert.equal(missing.status, 404);
  await missing.text();
});

test("pin, order pinned, place a pinned session and unpin reach every /ws client as upserts", async (t) => {
  const projects = new ProjectStore(":memory:");
  const index = new SessionIndex((s) => ({
    ...s, projectId: projects.projectOf(s.provider, s.id), pinPosition: projects.pinOf(s.provider, s.id),
  }));
  projects.onChange((c) => {
    if (c.kind === "assignments") index.reannotate((s) => c.keys.includes(`${s.provider}:${s.id}`));
  });
  const chosen = new ChosenStore(":memory:");
  for (const id of ["t1", "t2"]) {
    index.apply({ type: "upsert", session: session(id) });
    chosen.set("codex", id, true);
  }
  const view = new VisibleIndex(index, chosen);
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const server = createServer({ view, projects, chosen, guard, webDir: "/nonexistent" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  const put = (p: string, body: unknown) => fetch(`http://127.0.0.1:${port}${p}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  // Another tab: it only listens.
  const pins = new Map<string, number | null | undefined>();
  const places = new Map<string, string | null | undefined>();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.close());
  ws.on("message", (d) => {
    const m = JSON.parse(String(d)) as ServerMessage;
    const seen = (s: { id: string; pinPosition?: number | null; projectId?: string | null }) => {
      pins.set(s.id, s.pinPosition);
      places.set(s.id, s.projectId);
    };
    if (m.type === "hello") m.sessions.forEach(seen);
    if (m.type === "index" && m.event.type === "upsert") seen(m.event.session);
  });
  await new Promise((r) => ws.once("open", r));
  const settle = () => new Promise((r) => setTimeout(r, 50));

  assert.equal((await put("/api/session-pin", { provider: "codex", id: "t2", pinned: true })).status, 200);
  await settle();
  assert.deepEqual([pins.get("t1"), pins.get("t2")], [null, 0]);

  assert.equal((await put("/api/session-pins", { keys: ["codex:t1", "codex:t2"] })).status, 200);
  await settle();
  assert.deepEqual([pins.get("t1"), pins.get("t2")], [0, 1]);

  // A pinned session placed in a Group: the Group changes, the pin stays.
  const p = projects.create({ name: "P" });
  assert.equal((await put("/api/session-order", { projectId: p.id, keys: ["codex:t1"] })).status, 200);
  await settle();
  assert.deepEqual([pins.get("t1"), pins.get("t2")], [0, 1]);
  assert.equal(places.get("t1"), p.id);

  assert.equal((await put("/api/session-pin", { provider: "codex", id: "t2", pinned: false })).status, 200);
  await settle();
  assert.equal(pins.get("t2"), null);

  const bad = await put("/api/session-pin", { provider: "codex", id: "t2", pinned: "yes" });
  assert.equal(bad.status, 400);
  await bad.text();
  const badOrder = await put("/api/session-order", { projectId: null, keys: ["codex:t1", "codex:t1"] });
  assert.equal(badOrder.status, 400);
  await badOrder.text();
});

test("/ws thread.setPermissionMode reaches the Claude run; Codex sessions and refusals answer command.error; close reaches Codex too", async (t) => {
  const projects = new ProjectStore(":memory:");
  const index = new SessionIndex();
  const chosen = new ChosenStore(":memory:");
  const view = new VisibleIndex(index, chosen);
  const CLAUDE = "claude:acct:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const CODEX = "codex:acct:11111111-2222-4333-8444-555555555555";
  const modes: unknown[][] = [];
  const backgrounded: unknown[][] = [];
  const sentNow: unknown[][] = [];
  const closed: string[] = [];
  const runs = {
    handles: (k: string) => k.startsWith("claude:"),
    allPending: () => [],
    allForeground: () => [],
    async backgroundTasks(key: string, toolUseId?: string) {
      if (key !== CLAUDE) throw new DriveError("This session is not run by this server");
      backgrounded.push([key, toolUseId]);
      return toolUseId === undefined ? "Sent 1 foreground task to background" : "Sent the task to background";
    },
    async sendNow(key: string, messages: Array<{ id: string; content: unknown }>, hooks: { replacing(a: string, b: string): void; kept(a: string): void; replaced(a: string, b: string): void; handed(a: string): void; lost(a: string, e: string): void }) {
      if (key !== CLAUDE) throw new DriveError("This session is not run by this server");
      sentNow.push([key, messages]);
      // The first message is taken out and sent again, the second is left alone, the third fails after its take-out.
      hooks.replacing("q1", "n-1");
      hooks.replaced("q1", "n-1");
      hooks.handed("n-1");
      hooks.replacing("q2", "n-2");
      hooks.kept("q2");
      hooks.replacing("q3", "n-3");
      hooks.replaced("q3", "n-3");
      hooks.lost("n-3", "host connection lost");
      return { outcome: "sent" as const, moved: 2, sent: 1, notice: "Sent 2 foreground tasks to background, sent 1 queued message now" };
    },
    async setPermissionMode(key: string, mode: string) {
      if (mode === "plan" && key === CLAUDE) {
        modes.push([key, mode]);
        return;
      }
      throw new DriveError("This session is not run by this server");
    },
  } as unknown as ClaudeRuns;
  const codexRuns = {
    handles: (k: string) => k.startsWith("codex:"),
    allPending: () => [],
    async close(key: string) { closed.push(key); },
  } as unknown as CodexRuns;
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const pendingCalls: unknown[][] = [];
  const waiting = (id: string, state: string, text: string) => ({ id, text, attachments: [], sentAt: 1, state, error: null });
  const pendingSends = {
    all: () => [],
    list: () => [],
    stored: (k: string) => (k === CLAUDE ? [waiting("q1", "queued", "first"), waiting("q2", "queued", "second"), waiting("q3", "queued", "third"), waiting("s1", "sending", "no"), waiting("t1", "taken", "no"), waiting("f1", "failed", "no")] : []),
    replacing: (...a: unknown[]) => pendingCalls.push(["replacing", ...a.slice(1)]),
    kept: (...a: unknown[]) => pendingCalls.push(["kept", ...a.slice(1)]),
    replaced: (...a: unknown[]) => pendingCalls.push(["replaced", ...a.slice(1)]),
    apply: (_k: string, ev: unknown) => pendingCalls.push(["apply", ev]),
  } as unknown as PendingSends;
  const server = createServer({ view, projects, chosen, runs, codexRuns, pendingSends, guard, webDir: "/nonexistent" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  const messages: ServerMessage[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.close());
  ws.on("message", (d) => messages.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise((r) => ws.once("open", r));
  const sendMsg = (m: unknown) => ws.send(JSON.stringify(m));
  const settle = () => new Promise((r) => setTimeout(r, 50));

  sendMsg({ type: "thread.setPermissionMode", reqId: "r1", threadId: CLAUDE, mode: "plan" });
  sendMsg({ type: "thread.setPermissionMode", reqId: "r2", threadId: CODEX, mode: "plan" });
  sendMsg({ type: "thread.setPermissionMode", reqId: "r3", threadId: CLAUDE, mode: "acceptEdits" });
  sendMsg({ type: "thread.close", reqId: "r4", threadId: CODEX });
  // thread.background (DESIGN.md 4.5): all calls, one call, an empty id as none, and a Codex session.
  sendMsg({ type: "thread.background", reqId: "b1", threadId: CLAUDE });
  sendMsg({ type: "thread.background", reqId: "b2", threadId: CLAUDE, toolUseId: "toolu_1" });
  sendMsg({ type: "thread.background", reqId: "b3", threadId: CLAUDE, toolUseId: "" });
  sendMsg({ type: "thread.background", reqId: "b4", threadId: CODEX });
  // thread.sendNow: the messages the CLI queues (state queued) go to the server with their content, its answers reach the pending list, a Codex session is refused.
  sendMsg({ type: "thread.sendNow", reqId: "n1", threadId: CLAUDE });
  sendMsg({ type: "thread.sendNow", reqId: "n2", threadId: CODEX });
  await settle();
  assert.deepEqual(sentNow, [[CLAUDE, [{ id: "q1", content: "first" }, { id: "q2", content: "second" }, { id: "q3", content: "third" }]]]);
  assert.deepEqual(pendingCalls, [
    ["replacing", "q1", "n-1"], ["replaced", "q1", "n-1"], ["apply", { kind: "queued", id: "n-1" }],
    ["replacing", "q2", "n-2"], ["kept", "q2"],
    ["replacing", "q3", "n-3"], ["replaced", "q3", "n-3"], ["apply", { kind: "failed", id: "n-3", error: "Not sent again: host connection lost" }],
  ]);
  const nowResult = messages.find((m) => m.type === "command.result" && m.reqId === "n1");
  assert.deepEqual(nowResult && nowResult.type === "command.result" ? [nowResult.command, nowResult.sendNow] : null, ["sendNow", { outcome: "sent", moved: 2, sent: 1 }]);
  assert.deepEqual(modes, [[CLAUDE, "plan"]]);
  assert.deepEqual(closed, [CODEX]);
  assert.deepEqual(backgrounded, [[CLAUDE, undefined], [CLAUDE, "toolu_1"], [CLAUDE, undefined]]);
  const results = messages.filter((m) => m.type === "command.result" && m.command === "background").map((m) => (m.type === "command.result" ? [m.reqId, m.threadId, m.command, m.notice] : []));
  assert.deepEqual(results, [
    ["b1", CLAUDE, "background", "Sent 1 foreground task to background"],
    ["b2", CLAUDE, "background", "Sent the task to background"],
    ["b3", CLAUDE, "background", "Sent 1 foreground task to background"],
  ]);
  const errors = messages.filter((m) => m.type === "command.error").map((m) => (m.type === "command.error" ? [m.reqId, m.threadId, m.error] : []));
  assert.deepEqual(errors, [
    ["r2", CODEX, "Codex sessions have no permission mode"],
    ["b4", CODEX, "Codex sessions cannot send foreground work to background (app-server has no such request)"],
    ["n2", CODEX, "Codex sessions have no waiting messages to send now (a sent message steers the running turn at once)"],
    ["r3", CLAUDE, "This session is not run by this server"],
  ]);
  projects.close();
});

test("attachments: upload, read back only from this app's pages, send by id, and a device sends only its own uploads", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const http = await import("node:http");
  const { AttachmentStore } = await import("../attachments/store.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "srv-att-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const attachments = new AttachmentStore({ root, prepare: async (file, mime) => ({ ok: true, path: file, mime, width: 1, height: 1 }) });
  const projects = new ProjectStore(":memory:");
  const chosen = new ChosenStore(":memory:");
  const view = new VisibleIndex(new SessionIndex(), chosen);
  const CLAUDE = "claude:acct:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const sent: unknown[][] = [];
  const runs = {
    handles: (k: string) => k.startsWith("claude:"),
    allPending: () => [],
    allForeground: () => [],
    async send(key: string, text: string, atts: Array<{ id: string }>) {
      if (text === "/model opus") throw new DriveError("/model is a command, so it was not sent with the attachment. Send the command and the attachment separately");
      sent.push([key, text, atts.map((a) => a.id)]);
    },
  } as unknown as ClaudeRuns;
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const transcripts = fs.mkdtempSync(path.join(os.tmpdir(), "srv-tr-"));
  t.after(() => fs.rmSync(transcripts, { recursive: true, force: true }));
  const server = createServer({ view, projects, chosen, runs, guard, webDir: "/nonexistent", attachments, transcriptRoots: [transcripts] });
  assert.equal(server.requestTimeout, 0, "no total time cap on a request (a large upload on a slow link)");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;

  const up = await fetch(`${base}/api/attachments?name=${encodeURIComponent("메모.txt")}`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" });
  assert.equal(up.status, 200);
  const a = (await up.json()) as { id: string; kind: string; name: string; path: string; sizeBytes: number };
  assert.deepEqual([a.kind, a.name, a.sizeBytes], ["file", "메모.txt", 5]);
  assert.equal(path.dirname(a.path), path.join(root, a.id));
  assert.equal((await fetch(`${base}/api/attachments`, { method: "POST", body: "x" })).status, 400, "a name is required");

  const raw = await fetch(`${base}/api/attachments/${a.id}`);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("content-type"), "text/plain");
  assert.equal(raw.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(await raw.text(), "hello");
  assert.equal((await fetch(`${base}/api/attachments/${a.id}`, { headers: { "sec-fetch-site": "same-site" } })).status, 403);
  assert.equal((await fetch(`${base}/api/attachments/${a.id}/image`)).status, 404, "a text file has no picture");
  assert.equal((await fetch(`${base}/api/attachments/20261116-00000000-0000-4000-8000-000000000000`)).status, 404);
  assert.equal((await fetch(`${base}/api/attachments/%E0%A4%A`)).status, 400, "a broken % encoding is a bad id, not a 500");
  // Nothing an upload holds runs as this origin's page: a sandbox always, a download for non-pictures.
  assert.equal(raw.headers.get("content-security-policy"), "sandbox");
  assert.match(raw.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''/);
  const xml = (await (await fetch(`${base}/api/attachments?name=x.xml`, { method: "POST", headers: { "content-type": "text/xml" }, body: "<html xmlns='http://www.w3.org/1999/xhtml'><script>1</script></html>" })).json()) as { id: string };
  const xmlRes = await fetch(`${base}/api/attachments/${xml.id}`);
  assert.deepEqual([xmlRes.headers.get("content-security-policy"), (xmlRes.headers.get("content-disposition") ?? "").startsWith("attachment")], ["sandbox", true]);
  const pic = (await (await fetch(`${base}/api/attachments?name=p.png`, { method: "POST", headers: { "content-type": "image/png" }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]) })).json()) as { id: string };
  const picRes = await fetch(`${base}/api/attachments/${pic.id}/image`);
  assert.deepEqual([picRes.status, picRes.headers.get("content-security-policy"), picRes.headers.get("content-disposition")], [200, "sandbox", null]);
  // The blob route reads transcripts under the roots only (a device would hold the server).
  const blob = (q: string) => fetch(`${base}/api/file/blob?${q}`);
  assert.equal((await blob("path=/dev/zero&offset=0&pointer=$.data")).status, 403);
  fs.writeFileSync(path.join(transcripts, "s.jsonl"), `${JSON.stringify({ c: { source: { media_type: "image/png", data: "iVBORw0KGgo=" } } })}\n`);
  const okBlob = await blob(`path=${encodeURIComponent(path.join(transcripts, "s.jsonl"))}&offset=0&pointer=$.c.source.data`);
  assert.deepEqual([okBlob.status, okBlob.headers.get("content-type")], [200, "image/png"]);

  const open = async (url: string) => {
    const messages: ServerMessage[] = [];
    const ws = new WebSocket(url);
    t.after(() => ws.close());
    ws.on("message", (d) => messages.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise((r) => ws.once("open", r));
    return { ws, messages };
  };
  const web = await open(`ws://127.0.0.1:${port}/ws`);
  web.ws.send(JSON.stringify({ type: "thread.send", reqId: "s1", threadId: CLAUDE, text: "", attachments: [a.id] }));
  web.ws.send(JSON.stringify({ type: "thread.send", reqId: "s2", threadId: CLAUDE, text: "x", attachments: ["20261116-00000000-0000-4000-8000-000000000000", a.id] }));
  web.ws.send(JSON.stringify({ type: "thread.send", reqId: "s3", threadId: CLAUDE, text: "/model opus", attachments: [a.id] }));

  // The device listener hands its upgrades to serveUpgrade (devices/deviceServer.ts).
  const deviceSide = http.createServer();
  // The listener names the device that asks (serveRequest's third argument, serveUpgrade's fifth).
  let caller = "phone-1";
  deviceSide.on("request", (req, res) => server.serveRequest(req, res, { id: caller, kind: "android" }));
  deviceSide.on("upgrade", (req, socket, head) => server.serveUpgrade(req, socket, head, "android", caller));
  await new Promise<void>((r) => deviceSide.listen(0, "127.0.0.1", () => r()));
  t.after(() => deviceSide.close());
  const deviceBase = `http://127.0.0.1:${(deviceSide.address() as AddressInfo).port}`;
  const phoneUpload = (await (await fetch(`${deviceBase}/api/attachments?name=phone.txt`, { method: "POST", headers: { "content-type": "text/plain" }, body: "from the phone" })).json()) as { id: string };
  const device = await open(`${deviceBase.replace("http", "ws")}/ws`);
  device.ws.send(JSON.stringify({ type: "thread.send", reqId: "d1", threadId: CLAUDE, text: "from phone", attachments: [a.id] }));
  device.ws.send(JSON.stringify({ type: "thread.send", reqId: "d2", threadId: CLAUDE, text: "plain from phone" }));
  device.ws.send(JSON.stringify({ type: "thread.send", reqId: "d3", threadId: CLAUDE, text: "own upload", attachments: [phoneUpload.id] }));
  caller = "phone-2";
  const other = await open(`${deviceBase.replace("http", "ws")}/ws`);
  other.ws.send(JSON.stringify({ type: "thread.send", reqId: "o1", threadId: CLAUDE, text: "someone else's upload", attachments: [phoneUpload.id] }));
  await new Promise((r) => setTimeout(r, 80));
  // The desktop app uploads as the web does (DESIGN.md 2e), so its connection may name uploads.
  const desktopSide = http.createServer();
  desktopSide.on("upgrade", (req, socket, head) => server.serveUpgrade(req, socket, head, "desktop"));
  await new Promise<void>((r) => desktopSide.listen(0, "127.0.0.1", () => r()));
  t.after(() => desktopSide.close());
  const desktop = await open(`ws://127.0.0.1:${(desktopSide.address() as AddressInfo).port}/ws`);
  desktop.ws.send(JSON.stringify({ type: "thread.send", reqId: "k1", threadId: CLAUDE, text: "from desktop", attachments: [a.id] }));
  await new Promise((r) => setTimeout(r, 80));

  assert.deepEqual(sent, [[CLAUDE, "", [a.id]], [CLAUDE, "plain from phone", []], [CLAUDE, "own upload", [phoneUpload.id]], [CLAUDE, "from desktop", [a.id]]]);
  assert.deepEqual(desktop.messages.filter((x) => x.type === "command.error"), []);
  const errors = (m: ServerMessage[]) => m.flatMap((x) => (x.type === "command.error" ? [[x.reqId, x.error]] : []));
  const refusal = (reqId: string) => web.messages.find((x) => x.type === "command.error" && x.reqId === reqId) as Extract<ServerMessage, { type: "command.error" }>;
  assert.deepEqual(errors(web.messages).map((e) => e[0]), ["s2", "s3"]);
  // A missing id: the error names it, and the text and the uploads that exist come back.
  assert.match(refusal("s2").error, /Attachment not found/);
  assert.deepEqual([refusal("s2").unsent, refusal("s2").unsentAttachments?.map((x) => x.id)], ["x", [a.id]]);
  // Refused by the run (a maru command with attachments): both come back for the composer.
  assert.deepEqual([refusal("s3").unsent, refusal("s3").unsentAttachments?.map((x) => x.name)], ["/model opus", ["메모.txt"]]);
  assert.equal("imagePath" in (refusal("s3").unsentAttachments?.[0] ?? {}), false, "only the public view goes out");
  // A phone sends only what it uploaded: the web's upload and another phone's both answer as missing.
  assert.deepEqual(errors(device.messages), [["d1", `Attachment not found: ${a.id}`]]);
  assert.deepEqual(errors(other.messages), [["o1", `Attachment not found: ${phoneUpload.id}`]]);
  const deviceRefusal = device.messages.find((x) => x.type === "command.error") as Extract<ServerMessage, { type: "command.error" }>;
  assert.deepEqual([deviceRefusal.unsent, deviceRefusal.unsentAttachments], ["from phone", undefined], "a device learns nothing about uploads that are not its own");
  assert.equal(JSON.stringify(attachments.get(phoneUpload.id)).includes('"deviceId":"phone-1"'), true, "the upload keeps its device");
  assert.equal("deviceId" in ((await (await fetch(`${base}/api/attachments/${phoneUpload.id}/meta`)).json()) as object), false, "the public view leaves the device id out");
  projects.close();
  chosen.close();
});

test("/ws thread.configure reaches the session's driver with the fields alone; GET /api/session-models and /api/session-mcp answer with their status", async (t) => {
  const projects = new ProjectStore(":memory:");
  const index = new SessionIndex();
  const chosen = new ChosenStore(":memory:");
  const view = new VisibleIndex(index, chosen);
  const CLAUDE = "claude:acct:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const CODEX = "codex:acct:11111111-2222-4333-8444-555555555555";
  const configured: unknown[][] = [];
  const runs = {
    handles: (k: string) => k.startsWith("claude:"),
    allPending: () => [],
    allForeground: () => [],
    async configure(key: string, c: unknown) {
      configured.push(["claude", key, c]);
      return { command: "model", notice: "Model Sonnet 5.5" };
    },
    async mcpServers(key: string) {
      if (key !== CLAUDE) throw new DriveError("Only possible while the session is running");
      return [{ name: "docs", status: "connected", scope: "user", error: null, tools: 2 }];
    },
  } as unknown as ClaudeRuns;
  const codexRuns = {
    handles: (k: string) => k.startsWith("codex:"),
    allPending: () => [],
    async configure(key: string, c: unknown) {
      configured.push(["codex", key, c]);
      throw new DriveError("Unknown model: x");
    },
  } as unknown as CodexRuns;
  const commands = {
    async list() { throw new Error("unused"); },
    async models(key: string) {
      if (key === "bad") throw new SessionCommandsError(400, `Not a session key: ${key}`);
      return { key, options: [], from: "run" as const };
    },
  };
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const server = createServer({ view, projects, chosen, runs, codexRuns, commands, guard, webDir: "/nonexistent" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  const messages: ServerMessage[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.close());
  ws.on("message", (d) => messages.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "thread.configure", reqId: "c1", threadId: CLAUDE, model: "sonnet", effort: null }));
  ws.send(JSON.stringify({ type: "thread.configure", reqId: "c2", threadId: CODEX, model: "x" }));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(configured, [["claude", CLAUDE, { model: "sonnet", effort: null }], ["codex", CODEX, { model: "x" }]], "type, threadId and reqId stay out");
  const answers = messages.filter((m) => m.type === "command.result" || m.type === "command.error");
  assert.deepEqual(answers, [
    { type: "command.result", reqId: "c1", threadId: CLAUDE, command: "model", notice: "Model Sonnet 5.5" },
    { type: "command.error", reqId: "c2", threadId: CODEX, error: "Unknown model: x" },
  ]);

  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return [res.status, await res.json()] as const;
  };
  assert.deepEqual(await get(`/api/session-models?key=${encodeURIComponent(CLAUDE)}`), [200, { key: CLAUDE, options: [], from: "run" }]);
  assert.deepEqual(await get("/api/session-models?key=bad"), [400, { error: "Not a session key: bad" }]);
  assert.deepEqual(await get(`/api/session-mcp?key=${encodeURIComponent(CLAUDE)}`), [200, { key: CLAUDE, servers: [{ name: "docs", status: "connected", scope: "user", error: null, tools: 2 }] }]);
  assert.deepEqual(await get("/api/session-mcp?key=claude%3Aacct%3Aother"), [409, { error: "Only possible while the session is running" }]);
  assert.deepEqual(await get(`/api/session-mcp?key=${encodeURIComponent(CODEX)}`), [400, { error: "Only Claude sessions have an MCP server list" }]);
  projects.close();
});
