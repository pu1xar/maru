import { test } from "node:test";
import assert from "node:assert/strict";
import type { IndexEvent, SessionSummary } from "@maru/shared";
import { ChosenStore } from "../state/chosen.ts";
import { SessionIndex } from "./store.ts";
import { VisibleIndex } from "./visible.ts";

function s(provider: "claude" | "codex", id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    key: `${provider}:acct:${id}`, provider, account: "acct", id, cwd: "/x", name: id, title: null,
    preview: null, status: "closed", owner: "none", pid: null, tmuxPane: null, parentKey: null,
    updatedAt: 1, createdAt: null, sizeBytes: null, entrypoint: null, ...over,
  };
}

test("only chosen sessions and their subagent threads reach the UI", () => {
  const index = new SessionIndex();
  const chosen = new ChosenStore(":memory:");
  chosen.set("codex", "p", true);
  index.apply({ type: "upsert", session: s("codex", "p") });
  index.apply({ type: "upsert", session: s("codex", "child", { parentKey: "codex:acct:p" }) });
  index.apply({ type: "upsert", session: s("claude", "noise", { updatedAt: 5 }) });
  const view = new VisibleIndex(index, chosen);
  const seen: IndexEvent[] = [];
  view.subscribe((e) => seen.push(e));
  assert.deepEqual(view.snapshot().map((x) => x.id).sort(), ["child", "p"]);
  assert.deepEqual(view.candidates("").map((x) => x.id), ["noise"]);
  assert.deepEqual(view.candidates("nois").map((x) => x.id), ["noise"]);

  // Updates of hidden sessions stay on the server.
  index.apply({ type: "upsert", session: s("claude", "noise", { updatedAt: 6 }) });
  assert.equal(seen.length, 0);

  // Adding a session sends it; removing the parent takes its subagent thread along.
  chosen.set("claude", "noise", true);
  assert.deepEqual(seen.map((e) => (e.type === "upsert" ? `+${e.session.id}` : `-${e.key}`)), ["+noise"]);
  chosen.set("codex", "p", false);
  assert.deepEqual(seen.slice(1).map((e) => (e.type === "upsert" ? `+${e.session.id}` : `-${e.key}`)).sort(), [
    "-codex:acct:child", "-codex:acct:p",
  ]);
  assert.deepEqual(view.candidates("").map((x) => x.id), ["p"]);
});
