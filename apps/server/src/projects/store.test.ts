import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionSummary } from "@maru/shared";
import { SessionIndex } from "../index/store.ts";
import { ProjectError, ProjectStore, type ProjectChange } from "./store.ts";

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maru-projects-"));
  tmpDirs.push(dir);
  return path.join(dir, "state.sqlite");
}

function s(id: string, account = "a"): SessionSummary {
  return {
    key: `claude:${account}:${id}`, provider: "claude", account, id, cwd: "/x", name: null, title: null,
    preview: null, status: "closed", owner: "none", pid: null, tmuxPane: null, parentKey: null,
    updatedAt: 1, createdAt: null, sizeBytes: null, entrypoint: null,
  };
}

test("create, rename, reorder and persist across reopen", () => {
  const file = tmpFile();
  const a = new ProjectStore(file);
  const p1 = a.create({ name: "  Project A  ", defaultCwd: os.tmpdir() });
  const p2 = a.create({ name: "Infra" });
  assert.equal(p1.name, "Project A");
  assert.equal(p1.defaultCwd, path.resolve(os.tmpdir()));
  assert.deepEqual(a.list().map((p) => p.id), [p1.id, p2.id]);
  a.update(p2.id, { name: "Infra B", defaultCwd: null });
  a.reorder([p2.id, p1.id]);
  a.close();
  const b = new ProjectStore(file);
  assert.deepEqual(b.list().map((p) => [p.name, p.sortOrder]), [["Infra B", 0], ["Project A", 1]]);
  b.close();
});

test("rejects bad input with a status", () => {
  const st = new ProjectStore(":memory:");
  const p = st.create({ name: "x" });
  const bad: [() => unknown, RegExp][] = [
    [() => st.create({ name: "  " }), /name required/],
    [() => st.create({ name: "x", defaultCwd: "relative/dir" }), /absolute/],
    [() => st.create({ name: "x", defaultCwd: "/definitely/not/here" }), /does not exist/],
    [() => st.update("nope", { name: "y" }), /not found/],
    [() => st.reorder([]), /every project/],
    [() => st.assign("claude", "s1", "nope"), /not found/],
  ];
  for (const [fn, re] of bad) {
    assert.throws(fn, (e: unknown) => e instanceof ProjectError && re.test(e.message) && e.status >= 400);
  }
  assert.equal(st.list()[0]?.id, p.id);
});

test("assignment follows the session across accounts and deleting a project frees its sessions", () => {
  const st = new ProjectStore(":memory:");
  const p = st.create({ name: "P" });
  const changes: ProjectChange[] = [];
  st.onChange((c) => changes.push(c));
  const index = new SessionIndex((x) => ({ ...x, projectId: st.projectOf(x.provider, x.id) }));
  st.onChange((c) => {
    if (c.kind === "assignments") index.reannotate((x) => c.keys.includes(`${x.provider}:${x.id}`));
  });
  index.apply({ type: "upsert", session: s("s1", "acct-1") });
  assert.equal(index.get("claude:acct-1:s1")?.projectId, null);

  st.assign("claude", "s1", p.id);
  assert.equal(index.get("claude:acct-1:s1")?.projectId, p.id);
  // Same session id under another account (after a move) keeps the project.
  index.apply({ type: "upsert", session: s("s1", "acct-2") });
  assert.equal(index.get("claude:acct-2:s1")?.projectId, p.id);

  st.assign("claude", "s1", p.id);   // no-op
  st.remove(p.id);
  assert.equal(index.get("claude:acct-1:s1")?.projectId, null);
  assert.equal(st.projectOf("claude", "s1"), null);
  assert.deepEqual(changes.map((c) => c.kind), ["assignments", "projects", "assignments"]);
});

test("a session's position is fixed when first seen and changes only when placed", () => {
  const s = new ProjectStore(":memory:");
  const changes: string[][] = [];
  s.onChange((c) => {
    if (c.kind === "assignments") changes.push(c.keys);
  });
  // First sight: minus the update time, so the newer one sorts first.
  assert.equal(s.ensurePosition("claude", "a", 1000), -1000);
  assert.equal(s.ensurePosition("codex", "b", 2000), -2000);
  // A later update does not move it.
  assert.equal(s.ensurePosition("claude", "a", 9000), -1000);

  const p = s.create({ name: "P" });
  s.placeSessions(p.id, ["claude:a", "codex:b"]);
  assert.equal(s.projectOf("claude", "a"), p.id);
  assert.equal(s.projectOf("codex", "b"), p.id);
  assert.equal(s.ensurePosition("claude", "a", 9999), 0);
  assert.equal(s.ensurePosition("codex", "b", 9999), 1);
  assert.deepEqual(changes.at(-1), ["claude:a", "codex:b"]);

  // Back to 미분류 at the top.
  s.placeSessions(null, ["codex:b"]);
  assert.equal(s.projectOf("codex", "b"), null);
  assert.equal(s.ensurePosition("codex", "b", 0), 0);

  assert.throws(() => s.placeSessions(p.id, ["nope"]), /provider:id/);
  assert.throws(() => s.placeSessions(p.id, ["claude:a", "claude:a"]), /repeat/);
  assert.throws(() => s.placeSessions("missing", ["claude:a"]), /not found/);
});

test("pins are an order of their own: the session keeps its project and position, pinned or not", () => {
  const st = new ProjectStore(":memory:");
  const changes: string[][] = [];
  st.onChange((c) => {
    if (c.kind === "assignments") changes.push(c.keys);
  });
  const p = st.create({ name: "P" });
  st.placeSessions(p.id, ["claude:a", "codex:b", "claude:c"]);
  assert.equal(st.pinOf("codex", "b"), null);

  // The menu pins at the bottom of 고정됨, Claude and Codex alike.
  st.pin("codex", "b", true);
  st.pin("claude", "c", true);
  assert.equal(st.pinOf("codex", "b"), 0);
  assert.equal(st.pinOf("claude", "c"), 1);
  st.pin("codex", "b", true);   // no-op
  assert.deepEqual(changes.slice(-2), [["codex:b"], ["claude:c"]]);
  // Project and position stay while pinned.
  assert.equal(st.projectOf("codex", "b"), p.id);
  assert.equal(st.ensurePosition("codex", "b", 0), 1);

  // Reorder 고정됨 and pin a new one at a chosen place in one write.
  st.pinSessions(["claude:c", "claude:a", "codex:b"]);
  assert.deepEqual(["claude:c", "claude:a", "codex:b"].map((k) => st.pinOf(...splitKey(k))), [0, 1, 2]);
  assert.deepEqual(changes.at(-1), ["claude:c", "claude:a", "codex:b"]);

  // Unpin from the menu: back in P at its kept position.
  st.pin("claude", "a", false);
  assert.equal(st.pinOf("claude", "a"), null);
  assert.equal(st.projectOf("claude", "a"), p.id);
  assert.equal(st.ensurePosition("claude", "a", 0), 0);

  // A pinned session placed in another Group: the Group place changes, the pin stays. One change.
  const q = st.create({ name: "Q" });
  const before = changes.length;
  st.placeSessions(q.id, ["codex:b"]);
  assert.equal(st.pinOf("codex", "b"), 2);
  assert.equal(st.projectOf("codex", "b"), q.id);
  assert.equal(st.ensurePosition("codex", "b", 0), 0);
  assert.equal(changes.length, before + 1);
  // A pin appended after a reorder lands below every pin.
  st.pin("codex", "b", false);
  st.pin("codex", "b", true);
  assert.equal(st.pinOf("codex", "b"), 1);

  assert.throws(() => st.pinSessions([]), /provider:id/);
  assert.throws(() => st.pinSessions(["claude:a", "claude:a"]), /repeat/);
  assert.throws(() => st.pin("nope" as "claude", "a", true), /provider/);
  assert.throws(() => st.pin("claude", "", true), /session id/);
  // A failed write changes nothing.
  assert.equal(st.pinOf("claude", "c"), 0);
});

test("a pin follows the session across accounts and survives a restart", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "proj-pin-")), "state.sqlite");
  const a = new ProjectStore(file);
  const index = new SessionIndex((x) => ({ ...x, pinPosition: x.parentKey ? null : a.pinOf(x.provider, x.id) }));
  a.onChange((c) => {
    if (c.kind === "assignments") index.reannotate((x) => c.keys.includes(`${x.provider}:${x.id}`));
  });
  index.apply({ type: "upsert", session: s("s1", "acct-1") });
  assert.equal(index.get("claude:acct-1:s1")?.pinPosition, null);
  a.pin("claude", "s1", true);
  assert.equal(index.get("claude:acct-1:s1")?.pinPosition, 0);
  // Moved to another account: same `provider:id`, still pinned.
  index.apply({ type: "remove", key: "claude:acct-1:s1" });
  index.apply({ type: "upsert", session: s("s1", "acct-2") });
  assert.equal(index.get("claude:acct-2:s1")?.pinPosition, 0);
  // A subagent thread is never pinned.
  index.apply({ type: "upsert", session: { ...s("s1", "acct-2"), key: "claude:acct-2:s1:agent-x", parentKey: "claude:acct-2:s1" } });
  assert.equal(index.get("claude:acct-2:s1:agent-x")?.pinPosition, null);
  a.pinSessions(["codex:t", "claude:s1"]);
  a.close();
  const b = new ProjectStore(file);
  assert.equal(b.pinOf("codex", "t"), 0);
  assert.equal(b.pinOf("claude", "s1"), 1);
  b.close();
});

function splitKey(key: string): ["claude" | "codex", string] {
  const [provider, id] = key.split(":") as ["claude" | "codex", string];
  return [provider, id];
}

test("positions survive a restart", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "proj-pos-")), "state.sqlite");
  const a = new ProjectStore(file);
  a.ensurePosition("claude", "x", 500);
  a.placeSessions(null, ["claude:y", "claude:x"]);
  a.close();
  const b = new ProjectStore(file);
  assert.equal(b.ensurePosition("claude", "x", 1), 1);
  assert.equal(b.ensurePosition("claude", "y", 1), 0);
  b.close();
});

test("archiving keeps the project, position and pin, and taking out puts the session back", () => {
  const file = tmpFile();
  const a = new ProjectStore(file);
  const p = a.create({ name: "P" });
  a.placeSessions(p.id, ["claude:s1", "claude:s2"]);
  a.pin("claude", "s1", true);
  const changes: string[][] = [];
  a.onChange((c) => {
    if (c.kind === "assignments") changes.push(c.keys);
  });
  const index = new SessionIndex((x) => ({
    ...x, projectId: a.projectOf(x.provider, x.id), pinPosition: a.pinOf(x.provider, x.id), archivedAt: a.archivedOf(x.provider, x.id),
  }));
  a.onChange((c) => {
    if (c.kind === "assignments") index.reannotate((x) => c.keys.includes(`${x.provider}:${x.id}`));
  });
  index.apply({ type: "upsert", session: s("s1", "acct-1") });
  assert.equal(index.get("claude:acct-1:s1")?.archivedAt, null);

  a.archive("claude", "s1", true);
  const at = index.get("claude:acct-1:s1")?.archivedAt;
  assert.equal(typeof at, "number");
  // Only the archive row changed.
  assert.equal(index.get("claude:acct-1:s1")?.projectId, p.id);
  assert.equal(index.get("claude:acct-1:s1")?.pinPosition, 0);
  a.archive("claude", "s1", true);   // no-op: no second event, the time stays
  assert.deepEqual(changes, [["claude:s1"]]);
  assert.equal(a.archivedOf("claude", "s1"), at);
  // The archive follows the session to another account and survives a restart.
  index.apply({ type: "upsert", session: s("s1", "acct-2") });
  assert.equal(index.get("claude:acct-2:s1")?.archivedAt, at);
  a.close();
  const b = new ProjectStore(file);
  assert.equal(b.archivedOf("claude", "s1"), at);
  assert.deepEqual([...b.keys()].sort(), ["claude:s1", "claude:s2"]);

  b.archive("claude", "s1", false);
  assert.equal(b.archivedOf("claude", "s1"), null);
  assert.equal(b.projectOf("claude", "s1"), p.id);
  assert.equal(b.pinOf("claude", "s1"), 0);
  b.close();
});

test("placing or pinning an archived session takes it out of the archive; unlisted ones stay", () => {
  const st = new ProjectStore(":memory:");
  const p = st.create({ name: "P" });
  st.archive("claude", "a", true);
  st.archive("claude", "b", true);
  st.archive("codex", "c", true);
  st.placeSessions(p.id, ["claude:a"]);
  assert.equal(st.archivedOf("claude", "a"), null);
  assert.equal(st.projectOf("claude", "a"), p.id);
  assert.notEqual(st.archivedOf("claude", "b"), null);
  st.pinSessions(["codex:c"]);
  assert.equal(st.archivedOf("codex", "c"), null);
  assert.equal(st.pinOf("codex", "c"), 0);
  assert.notEqual(st.archivedOf("claude", "b"), null);
  // forget drops the row with the others.
  assert.equal(st.forget(["claude:b"]).archived, 1);
  assert.equal(st.archivedOf("claude", "b"), null);
});

test("archive rejects bad input", () => {
  const st = new ProjectStore(":memory:");
  const bad: [() => unknown, RegExp][] = [
    [() => st.archive("nope" as "claude", "x", true), /bad provider/],
    [() => st.archive("claude", "", true), /session id/],
    [() => st.archive("claude", "x", "yes" as unknown as boolean), /boolean/],
  ];
  for (const [fn, re] of bad) {
    assert.throws(fn, (e: unknown) => e instanceof ProjectError && re.test(e.message) && e.status === 400);
  }
});

test("Group order: a new Group lands last, a reorder persists and leaves sessions and pins alone", () => {
  const file = tmpFile();
  const a = new ProjectStore(file);
  const [x, y, z] = [a.create({ name: "X" }), a.create({ name: "Y" }), a.create({ name: "Z" })];
  assert.deepEqual(a.list().map((p) => p.name), ["X", "Y", "Z"]);
  a.placeSessions(x.id, ["claude:s1", "claude:s2"]);
  a.pin("claude", "s1", true);
  const changes: ProjectChange[] = [];
  a.onChange((c) => changes.push(c));
  assert.deepEqual(a.reorder([z.id, x.id, y.id]).map((p) => p.name), ["Z", "X", "Y"]);
  // One "projects" change and nothing about assignments: sessions, positions and pins are not touched.
  assert.deepEqual(changes, [{ kind: "projects" }]);
  assert.equal(a.projectOf("claude", "s1"), x.id);
  assert.equal(a.pinOf("claude", "s1"), 0);
  // A Group made after a reorder goes below every Group, i.e. last before Unsorted.
  const w = a.create({ name: "W" });
  assert.deepEqual(a.list().map((p) => p.name), ["Z", "X", "Y", "W"]);
  assert.equal(w.sortOrder, 3);
  a.close();
  const b = new ProjectStore(file);
  assert.deepEqual(b.list().map((p) => p.name), ["Z", "X", "Y", "W"]);
  b.close();
});

test("Group order: deleting a Group keeps the others in order and a stale list is refused", () => {
  const st = new ProjectStore(":memory:");
  const [a, b, c] = [st.create({ name: "A" }), st.create({ name: "B" }), st.create({ name: "C" })];
  st.reorder([c.id, a.id, b.id]);
  st.remove(a.id);
  assert.deepEqual(st.list().map((p) => p.name), ["C", "B"]);
  // Another client still holding the old three ids cannot write them: the list must be exact.
  assert.throws(() => st.reorder([b.id, a.id, c.id]), (e: unknown) => e instanceof ProjectError && e.status === 400);
  assert.throws(() => st.reorder([b.id]), (e: unknown) => e instanceof ProjectError && e.status === 400);
  assert.throws(() => st.reorder([b.id, b.id]), (e: unknown) => e instanceof ProjectError && e.status === 400);
  assert.deepEqual(st.list().map((p) => p.name), ["C", "B"]);
  // A new Group still lands last.
  st.create({ name: "D" });
  assert.deepEqual(st.list().map((p) => p.name), ["C", "B", "D"]);
  st.reorder(st.list().map((p) => p.id).reverse());
  assert.deepEqual(st.list().map((p) => [p.name, p.sortOrder]), [["D", 0], ["B", 1], ["C", 2]]);
});

test("Group order: rows with equal sort_order show in creation order and the first reorder writes it down", () => {
  const file = tmpFile();
  const first = new ProjectStore(file);
  const [p, q, r] = [first.create({ name: "P" }), first.create({ name: "Q" }), first.create({ name: "R" })];
  first.close();
  // The shown order before any reorder is `sort_order, created_at`. Flatten sort_order and set
  // the creation times, as a database that never stored an order would look.
  const raw = new DatabaseSync(file);
  raw.exec("UPDATE projects SET sort_order = 0");
  raw.prepare("UPDATE projects SET created_at = ? WHERE id = ?").run(300, p.id);
  raw.prepare("UPDATE projects SET created_at = ? WHERE id = ?").run(100, q.id);
  raw.prepare("UPDATE projects SET created_at = ? WHERE id = ?").run(200, r.id);
  raw.close();
  const again = new ProjectStore(file);
  assert.deepEqual(again.list().map((x) => x.name), ["Q", "R", "P"]);
  again.reorder(again.list().map((x) => x.id));
  assert.deepEqual(again.list().map((x) => [x.name, x.sortOrder]), [["Q", 0], ["R", 1], ["P", 2]]);
  again.close();
});
