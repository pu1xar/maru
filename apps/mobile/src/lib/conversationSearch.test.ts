import { test } from "node:test";
import assert from "node:assert/strict";
import type { SearchHit, SearchResponse, SessionSummary } from "@maru/shared";
import { afterPage, hitKey, hitRoleLabel, remainingHits, searchQueryOf } from "./conversationSearch.ts";

const session = (key: string) => ({ key, id: key.slice(-4) }) as unknown as SessionSummary;
const hit = (key: string, itemId: string | null, at: string | null = null): SearchHit => ({
  key, itemId, role: "user", at, count: 1, snippet: { before: "", match: "q", after: "" },
});
const response = (query: string, hits: SearchHit[], sessions: SessionSummary[], total: number, offset = 0): SearchResponse => ({
  query, hits, sessions, total, offset, searchedSessions: 0, searchedTexts: 0, unlistedFiles: 0, refreshMs: 0, searchMs: 0,
});

test("the first page replaces the list and a later page of the same query goes on after it", () => {
  const first = afterPage(null, response("q", [hit("a", "1"), hit("b", "2")], [session("a"), session("b")], 3), 0);
  assert.equal(first.hits.length, 2);
  assert.equal(remainingHits(first), 1);
  const second = afterPage(first, response("q", [hit("c", "3")], [session("c")], 3, 2), 2);
  assert.deepEqual(second.hits.map((h) => h.key), ["a", "b", "c"]);
  assert.deepEqual([...second.sessions.keys()].sort(), ["a", "b", "c"], "the sessions of every page are kept");
  assert.equal(remainingHits(second), 0);
});

test("a page of another query, or offset 0 again, starts the list over", () => {
  const first = afterPage(null, response("q", [hit("a", "1")], [session("a")], 5), 0);
  const other = afterPage(first, response("r", [hit("z", "9")], [session("z")], 1, 1), 1);
  assert.deepEqual(other.hits.map((h) => h.key), ["z"]);
  assert.deepEqual([...other.sessions.keys()], ["z"]);
  const again = afterPage(first, response("q", [hit("y", "8")], [session("y")], 1), 0);
  assert.deepEqual(again.hits.map((h) => h.key), ["y"]);
});

test("the query goes to the server trimmed, and a blank one does not go", () => {
  assert.equal(searchQueryOf("  검색  "), "검색");
  assert.equal(searchQueryOf("   "), null);
  assert.equal(searchQueryOf(""), null);
});

test("hits of one item in one session still get their own keys, and a role reads as user or answer", () => {
  assert.notEqual(hitKey(hit("a", "1"), 0), hitKey(hit("a", "1"), 1));
  assert.equal(hitKey(hit("a", null, "t"), 0), "a:t:0");
  assert.equal(hitRoleLabel("user"), "User");
  assert.equal(hitRoleLabel("assistant"), "Answer");
  assert.equal(hitRoleLabel("notice"), "Answer");
});
