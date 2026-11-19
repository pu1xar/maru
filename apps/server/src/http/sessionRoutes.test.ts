import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { ServerMessage } from "@maru/shared";
import { assignmentKey } from "@maru/shared";
import type { ClaudeAccount } from "../config.ts";
import { SessionIndex } from "../index/store.ts";
import { VisibleIndex } from "../index/visible.ts";
import { ProjectStore } from "../projects/store.ts";
import { ChosenStore } from "../state/chosen.ts";
import { createClaudeSource } from "../claude/source.ts";
import { SessionManager } from "../sessions/manage.ts";
import { TrashStore } from "../sessions/trash.ts";
import { createServer } from "./server.ts";

test("session management routes: statuses, the JSON content type, and /ws index events after leaving the list (which unlocks) and a delete", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "routes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accounts: ClaudeAccount[] = [{ id: "claude-a", dir: path.join(root, "a") }];
  const sid = randomUUID();
  const file = path.join(accounts[0]!.dir, "projects", "-w", `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(accounts[0]!.dir, "sessions"));
  fs.writeFileSync(file, JSON.stringify({ type: "user", cwd: "/w", message: { role: "user", content: "hi" } }) + "\n");

  const projects = new ProjectStore(":memory:");
  const chosen = new ChosenStore(":memory:");
  t.after(() => {
    projects.close();
    chosen.close();
  });
  const index = new SessionIndex((s) => ({ ...s, locked: chosen.has(s.provider, s.id) }));
  chosen.onChange((keys) => index.reannotate((s) => keys.includes(assignmentKey(s.provider, s.id))));
  const source = createClaudeSource(accounts, { debounceMs: 60_000, sweepMs: 60_000 });
  t.after(() => source.stop());
  await source.start((e) => index.apply(e));
  chosen.set("claude", sid, true);
  const view = new VisibleIndex(index, chosen);
  const manage = new SessionManager({
    claudeAccounts: accounts, codexAccounts: [], index, chosen,
    trash: new TrashStore({ root: path.join(root, "trash"), claudeAccounts: accounts, codexAccounts: [] }),
    claudeWritten: (a, f) => source.reread(a, f), stubDir: path.join(root, "stubs"), home: root, display: (p) => p,
  });
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const server = createServer({ view, projects, chosen, manage, guard, webDir: "/nonexistent" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;
  const json = { "content-type": "application/json" };
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = json) => {
    const res = await fetch(base + p, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const messages: ServerMessage[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.close());
  await new Promise((r) => ws.once("message", (d) => r(messages.push(JSON.parse(String(d))))));
  ws.on("message", (d) => messages.push(JSON.parse(String(d))));
  const hello = messages[0];
  assert.ok(hello?.type === "hello" && hello.sessions.length === 1 && hello.sessions[0]!.locked === true, "in the list means locked");

  const target = { provider: "claude", account: "claude-a", id: sid };
  const refused = await call("POST", "/api/session-delete", target);
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), /locked/);
  assert.equal((await call("POST", "/api/session-delete", target, {})).status, 415, "a body without the JSON content type is refused");
  assert.equal((await call("POST", "/api/session-delete", { ...target, id: "x" })).status, 400);
  assert.equal((await call("PUT", "/api/session-lock", { provider: "claude", id: sid, locked: false })).status, 404, "no hand-set lock route");
  // Taking it out of the list is what unlocks it.
  assert.equal((await call("PUT", "/api/session-chosen", { provider: "claude", id: sid, chosen: false })).status, 200);

  const deleted = await call("POST", "/api/session-delete", target);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.outcome, "deleted");
  assert.ok(!fs.existsSync(file));
  assert.deepEqual(await call("GET", "/api/trash"), { status: 200, body: { items: [], totalBytes: 0, unreadable: [] } });
  assert.equal((await call("POST", "/api/trash/restore", { key: "nope" })).status, 400);
  assert.equal((await call("GET", `/api/session-units?provider=codex&account=claude-a&id=${sid}`)).status, 400);
  fs.mkdirSync(path.join(root, "work", "alpha"), { recursive: true });
  fs.mkdirSync(path.join(root, "work", "Beta"));
  fs.mkdirSync(path.join(root, "work", ".hidden"));
  fs.writeFileSync(path.join(root, "work", "note.txt"), "secret contents");
  const listed = await call("GET", "/api/fs-complete?path=" + encodeURIComponent("~/work/"));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, {
    dirs: [path.join(root, "work", "Beta"), path.join(root, "work", "alpha")],
    expanded: path.join(root, "work") + "/",
    parent: path.join(root, "work"),
    status: "ok",
  }, "folder paths only: no file, no hidden folder, no contents");
  assert.equal((await call("GET", "/api/fs-complete?path=" + encodeURIComponent("~/work/nope/"))).body.status, "missing");
  assert.equal((await call("GET", "/api/fs-complete?path=" + encodeURIComponent("~/work/note.txt/"))).body.status, "not-folder");
  assert.equal((await call("GET", "/api/not-a-route")).status, 404);

  await new Promise((r) => setTimeout(r, 50));
  const events = messages.filter((m) => m.type === "index").map((m) => (m.type === "index" ? m.event : null));
  assert.deepEqual(events.map((e) => (e?.type === "upsert" ? `upsert locked=${e.session.locked}` : e?.type)), [
    "remove", // leaving the list takes it off the UI's view; the later delete has nothing more to tell
  ]);
});
