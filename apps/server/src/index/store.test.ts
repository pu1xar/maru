import { test } from "node:test";
import assert from "node:assert/strict";
import type { IndexEvent, SessionSummary } from "@maru/shared";
import { SessionIndex } from "./store.ts";

function s(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    key: `claude:a:${id}`, provider: "claude", account: "a", id, cwd: "/x", name: null, title: null,
    preview: null, status: "closed", owner: "none", pid: null, tmuxPane: null, parentKey: null,
    updatedAt: 1, createdAt: null, sizeBytes: null, entrypoint: null, ...over,
  };
}

test("emits upserts only when a summary changes", () => {
  const idx = new SessionIndex();
  const seen: IndexEvent[] = [];
  idx.subscribe((e) => seen.push(e));
  idx.apply({ type: "upsert", session: s("1") });
  idx.apply({ type: "upsert", session: s("1") });
  idx.apply({ type: "upsert", session: s("1", { status: "running" }) });
  assert.equal(seen.length, 2);
  assert.equal(idx.get("claude:a:1")?.status, "running");
});

test("removes only known sessions and sorts the snapshot by activity", () => {
  const idx = new SessionIndex();
  const seen: IndexEvent[] = [];
  idx.subscribe((e) => seen.push(e));
  idx.apply({ type: "upsert", session: s("old", { updatedAt: 1 }) });
  idx.apply({ type: "upsert", session: s("new", { updatedAt: 5 }) });
  assert.deepEqual(idx.snapshot().map((x) => x.id), ["new", "old"]);
  idx.apply({ type: "remove", key: "claude:a:missing" });
  idx.apply({ type: "remove", key: "claude:a:old" });
  assert.equal(seen.filter((e) => e.type === "remove").length, 1);
});
