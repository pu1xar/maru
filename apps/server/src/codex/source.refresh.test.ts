import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { sessionKey } from "@maru/shared";
import { SessionIndex } from "../index/store.ts";
import { FakeDaemon, makeThread, waitFor } from "./fake-daemon.ts";
import { STATE_DB_FILE, createCodexSource } from "./source.ts";

function db(home: string): DatabaseSync {
  const d = new DatabaseSync(path.join(home, STATE_DB_FILE));
  d.exec(`CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER,
    source TEXT, cwd TEXT, title TEXT, archived INTEGER NOT NULL DEFAULT 0, preview TEXT, name TEXT)`);
  return d;
}

test("daemon mode: refreshThreads reads restored threads from the daemon and drops removed or archived ones", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  const [A, B, C] = [randomUUID(), randomUUID(), randomUUID()];
  d.threads.set(A, makeThread(A));
  const s = db(d.home);
  s.prepare("INSERT INTO threads (id, title, source) VALUES (?, 'title A', 'cli')").run(A);
  await d.listen();
  const index = new SessionIndex();
  const src = createCodexSource([{ id: "codex-a", home: d.home }], { backoff: { initialMs: 10, maxMs: 40 } });
  t.after(() => src.stop());
  await src.start((e) => index.apply(e));
  const key = (id: string) => sessionKey("codex", "codex-a", id);
  assert.ok(index.get(key(A)));

  // Rows written behind the daemon's back (a restore): no notification announces them.
  d.threads.set(B, makeThread(B));
  d.threads.set(C, makeThread(C));
  s.prepare("INSERT INTO threads (id, title, source) VALUES (?, 'title B', 'cli')").run(B);
  s.prepare("INSERT INTO threads (id, title, source, archived) VALUES (?, 'title C', 'cli', 1)").run(C);
  s.prepare("DELETE FROM threads WHERE id = ?").run(A);
  src.refreshThreads("codex-a", [A, B, C]);
  await waitFor(() => index.get(key(B)) !== undefined, "restored thread B in the index");
  assert.equal(index.get(key(B))?.title, "title B");
  assert.equal(index.get(key(A)), undefined, "a thread without a row leaves the index");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(index.get(key(C)), undefined, "an archived row stays out");
  s.close();
});
