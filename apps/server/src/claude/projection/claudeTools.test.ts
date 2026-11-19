import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeCommandOutputText, claudeFileChangeText, claudeSubagentResultText, claudeToolTitle, classifyClaudeTool } from "./claudeTools.ts";
import { computeLanes } from "./lanes.ts";

test("diff text equals jsdiff 9 formatPatch(FILE_HEADERS_ONLY) output", () => {
  // Expected strings were produced by jsdiff 9.0.0 structuredPatch + formatPatch.
  assert.deepEqual(claudeFileChangeText({ content: "", structured: { type: "create", filePath: "b.txt", content: "l1\nl2\n", structuredPatch: [] } }), {
    diffStr: "--- /dev/null\n+++ b.txt\n@@ -0,0 +1,2 @@\n+l1\n+l2\n",
    additions: 2,
    deletions: 0,
  });
  assert.equal(
    claudeFileChangeText({ content: "", structured: { type: "create", filePath: "b.txt", content: "l1\nl2", structuredPatch: [] } }).diffStr,
    "--- /dev/null\n+++ b.txt\n@@ -0,0 +1,2 @@\n+l1\n+l2\n\\ No newline at end of file\n",
  );
  const update = claudeFileChangeText({
    content: "updated",
    structured: { type: "update", filePath: "a.txt", structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" x", "-y", "+z"] }] },
  });
  assert.deepEqual(update, { diffStr: "--- a.txt\n+++ a.txt\n@@ -1,2 +1,2 @@\n x\n-y\n+z\n", additions: 1, deletions: 1 });
  assert.equal(claudeFileChangeText({ content: "", structured: { type: "create", filePath: "e", content: "", structuredPatch: [] } }).diffStr, "");
  assert.equal(claudeFileChangeText({ content: "plain text", structured: undefined }).diffStr, "plain text");
});

test("titles and classification follow T3 ClaudeAdapterV2", () => {
  assert.equal(claudeToolTitle("Read", { file_path: " /a/b.ts " }), "Read /a/b.ts");
  assert.equal(claudeToolTitle("Grep", { pattern: "foo", path: "/x/src" }), "Searched foo in src");
  assert.equal(claudeToolTitle("Glob", { pattern: "**/*.ts" }), "Searched **/*.ts");
  assert.equal(claudeToolTitle("Skill", { skill: "tdd" }), "Skill: tdd");
  assert.equal(claudeToolTitle("Bash", { command: "ls" }), null);
  assert.equal(classifyClaudeTool("bash_placeholder"), "command_execution");
  assert.equal(classifyClaudeTool("WebFetch"), "web_search");
  assert.equal(classifyClaudeTool("mcp__burp__send_http1_request"), "dynamic_tool");
});

test("command output joins stdout and stderr; subagent result drops the tools-used note", () => {
  assert.equal(claudeCommandOutputText({ content: "x", structured: { stdout: "out", stderr: "err" } }), "out\nerr");
  assert.equal(
    claudeSubagentResultText({ content: [{ type: "text", text: "<tools-used-before-summary>Read x3</tools-used-before-summary>\nReport" }], structured: undefined }),
    "Report",
  );
});

test("lanes: a rewind makes the earlier opener an alternate; a tree without openers is all main", () => {
  const n = (uuid: string, parentUuid: string | null, opener: boolean) => ({ uuid, parentUuid, opener });
  const res = computeLanes([n("a", null, true), n("b", "a", false), n("c", "b", true), n("c1", "c", false), n("d", "b", true), n("x", null, false), n("y", "x", false)]);
  assert.deepEqual([...res.alt], [["c", "lane:c"], ["c1", "lane:c"]]);
  assert.deepEqual(res.forks, [{ forkPointUuid: "b", laneIds: ["lane:c"] }]);
  assert.equal(res.lastPStar, "d");
  const cyc = computeLanes([n("p", "q", true), n("q", "p", false)]);
  assert.equal(cyc.cycles, 1);
  assert.equal(cyc.alt.size, 0);
});
