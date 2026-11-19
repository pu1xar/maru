import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionSummary } from "@maru/shared";
import { createClaudeProjector } from "../claude/projection/projector.ts";
import { configDirsResolver, createFsSidecars } from "../claude/projection/sidecars.ts";
import { codexItemRowId } from "../codex/projection/mapItems.ts";
import { readTail } from "../transcript/claudeTranscript.ts";
import { SessionSearch } from "./sessionSearch.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ts = (n: number) => new Date(Date.UTC(2026, 10, 15, 0, 0, n)).toISOString();
const prompt = (n: number, text: string) => ({ parentUuid: n === 1 ? null : U(n - 1), type: "user", message: { role: "user", content: text }, uuid: U(n), timestamp: ts(n), sessionId: SID, cwd: "/w" });
const answer = (n: number, text: string) => ({
  parentUuid: U(n - 1), type: "assistant", uuid: U(n), timestamp: ts(n), sessionId: SID,
  message: { model: "claude-opus-5-5", id: `msg${n}`, type: "message", role: "assistant", content: [{ type: "text", text }] },
});
const toolResult = (n: number) => ({ parentUuid: U(n - 1), type: "user", uuid: U(n), timestamp: ts(n), sessionId: SID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "검색 in a tool output" }] } });
const lines = (rows: unknown[]) => rows.map((r) => JSON.stringify(r) + "\n").join("");

function summary(key: string, name: string): SessionSummary {
  const [provider, account, id] = key.split(":") as ["claude" | "codex", string, string];
  return {
    key, provider, account, id, cwd: null, name, title: null, preview: null, status: "closed", owner: "none", pid: null, tmuxPane: null,
    parentKey: null, updatedAt: 0, createdAt: null, sizeBytes: null, entrypoint: null,
  };
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maru-search-"));
  const claude = path.join(root, ".claude");
  const codex = path.join(root, ".codex");
  fs.mkdirSync(path.join(claude, "projects", "-w"), { recursive: true });
  fs.mkdirSync(path.join(claude, "projects", "-w", SID, "subagents"), { recursive: true });
  fs.mkdirSync(path.join(codex, "sessions", "2026", "11", "15"), { recursive: true });
  const file = path.join(claude, "projects", "-w", `${SID}.jsonl`);
  fs.writeFileSync(file, lines([prompt(1, "대화 검색을 만들자"), answer(2, "Search over every SESSION"), toolResult(3), prompt(4, "검색 다시")]));
  // A subagent transcript and a session the server does not list stay out of the hits.
  fs.writeFileSync(path.join(claude, "projects", "-w", SID, "subagents", "agent-a1.jsonl"), lines([prompt(1, "검색 in a subagent")]));
  fs.writeFileSync(path.join(claude, "projects", "-w", `${OTHER}.jsonl`), lines([prompt(1, "검색 unlisted")]));
  const rec = (type: string, payload: unknown, n: number) => JSON.stringify({ timestamp: ts(n), type, payload }) + "\n";
  const rollout = path.join(codex, "sessions", "2026", "11", "15", "rollout-2026-11-15T00-00-00-th1.jsonl");
  fs.writeFileSync(rollout,
    rec("session_meta", { id: "th1", cwd: "/w" }, 0) +
    rec("event_msg", { type: "item_completed", thread_id: "th1", turn_id: "t1", started_at_ms: Date.parse(ts(10)), completed_at_ms: Date.parse(ts(11)), item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "codex 검색", text_elements: [] }] } }, 10) +
    rec("event_msg", { type: "item_completed", thread_id: "th1", turn_id: "t1", started_at_ms: Date.parse(ts(12)), completed_at_ms: Date.parse(ts(13)), item: { type: "AgentMessage", id: "a1", content: [{ type: "Text", text: "answer" }], phase: "final_answer" } }, 12));
  // A rollout from before item records: events with the time only.
  const legacy = path.join(codex, "sessions", "2026", "11", "15", "rollout-2026-07-07T00-00-00-th2.jsonl");
  fs.writeFileSync(legacy, rec("session_meta", { id: "th2" }, 0) + rec("event_msg", { type: "user_message", message: "old 검색" }, 20) + rec("event_msg", { type: "agent_message", message: "old answer" }, 21));
  const listed = new Map([
    [`claude:acct:${SID}`, summary(`claude:acct:${SID}`, "만들기")],
    ["codex:cx:th1", summary("codex:cx:th1", "codex one")],
    ["codex:cx:th2", summary("codex:cx:th2", "codex old")],
  ]);
  const search = new SessionSearch({ claudeAccounts: [{ id: "acct", dir: claude }], codexAccounts: [{ id: "cx", home: codex }], session: (k) => listed.get(k) });
  return { root, file, rollout, search };
}

test("search over every session: hits newest first, the projection's item ids, the denominator, paging", async () => {
  const { root, file, rollout, search } = setup();
  try {
    const r = await search.search("검색");
    assert.deepEqual(r.hits.map((h) => [h.key.split(":")[0], h.role, h.snippet.match]), [
      ["codex", "user", "검색"],
      ["codex", "user", "검색"],
      ["claude", "user", "검색"],
      ["claude", "user", "검색"],
    ], "newest first by time");
    assert.deepEqual(r.hits.map((h) => h.at), [ts(20), ts(10), ts(4), ts(1)]);
    assert.equal(r.total, 4, "the tool output, the subagent and the unlisted session are not hits");
    assert.equal(r.searchedSessions, 3);
    assert.equal(r.unlistedFiles, 1);
    assert.equal(r.searchedTexts, 3 + 2 + 2);
    assert.deepEqual(r.sessions.map((s) => s.name).sort(), ["codex old", "codex one", "만들기"]);
    // Claude ids are the projection's.
    const projector = createClaudeProjector({
      threadId: `claude:acct:${SID}`, account: "acct", sessionId: SID, path: file, readonly: true, live: null,
      sidecars: createFsSidecars(file, configDirsResolver([path.join(root, ".claude")])),
    });
    projector.push((await readTail(file, { maxRecords: 1000 })).records);
    const userIds = projector.snapshot().visibleTurnItems.filter((x) => x.item.type === "user_message").map((x) => x.item.id);
    assert.deepEqual(r.hits.filter((h) => h.key.startsWith("claude")).map((h) => h.itemId).reverse(), userIds);
    assert.equal(r.hits[1]!.itemId, codexItemRowId("codex:cx:th1", "u1"));
    assert.equal(r.hits[0]!.itemId, null, "an event-only rollout names no item");
    // Case folded; the snippet keeps the text's own case.
    const upper = await search.search("session");
    assert.deepEqual(upper.hits.map((h) => [h.role, h.snippet.match, h.count]), [["assistant", "SESSION", 1]]);
    // Paging: every hit stays reachable.
    const page = await search.search("검색", { offset: 1, limit: 2 });
    assert.deepEqual(page.hits.map((h) => h.at), [ts(10), ts(4)]);
    assert.equal(page.total, 4);

    // Appended lines are read from where the last read stopped; a rewritten file is read again.
    fs.appendFileSync(file, lines([answer(5, "새 검색 결과")]));
    const grown = await search.search("검색");
    assert.equal(grown.total, 5);
    assert.ok(grown.hits.some((h) => h.snippet.match === "검색" && h.role === "assistant" && h.at === ts(5)));
    fs.writeFileSync(rollout, JSON.stringify({ timestamp: ts(0), type: "session_meta", payload: { id: "th1" } }) + "\n");
    const rewritten = await search.search("codex");
    assert.equal(rewritten.total, 0);
    const none = await search.search("   ");
    assert.equal(none.total, 0);
    assert.equal(none.searchedSessions, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
