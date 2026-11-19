import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2TurnItem } from "@maru/shared";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../../web/src/session-logic.ts";
import { workEntryDisplayLabel } from "../../../web/src/components/chat/MessagesTimeline.logic.ts";
import { externalWebHref, isJsonDocumentText, workEntryCanOpen, workEntryDetail } from "./timelineDetail.ts";
import type { TimelineWorkEntry } from "./timeline.ts";

const base = (id: string) => ({
  id,
  threadId: "t",
  runId: "r",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  startedAt: "2026-11-16T01:00:00.000Z",
  completedAt: "2026-11-16T01:00:01.000Z",
  updatedAt: "2026-11-16T01:00:01.000Z",
});

/** The work entry the web derives for one item. */
function entryOf(item: OrchestrationV2TurnItem): TimelineWorkEntry {
  const row: OrchestrationV2ProjectedTurnItem = { position: 0, visibility: "local", sourceThreadId: "t", sourceItemId: item.id, item };
  const [entry] = deriveTimelineEntriesFromVisibleTurnItems({ visibleTurnItems: [row], optimisticMessages: [] });
  assert.ok(entry?.kind === "work");
  return entry.entry;
}

const root = "/Users/me/repo";

test("a failed command opens to its command, output and exit code", () => {
  const e = entryOf({ ...base("c"), type: "command_execution", status: "failed", input: "pnpm test", output: "1 failing", exitCode: 1 });
  const label = workEntryDisplayLabel(e, root);
  assert.ok(workEntryCanOpen(e, root, label));
  assert.deepEqual(workEntryDetail(e, root, label), [
    { kind: "command", text: "pnpm test" },
    { kind: "output", text: "1 failing", json: false },
    { kind: "failure", text: "exit 1" },
  ]);
});

test("a tool call lists its arguments and output; a read shows the file it read", () => {
  const grep = entryOf({ ...base("g"), type: "dynamic_tool", toolName: "Grep", input: { pattern: "TODO", path: "src" }, output: "src/a.ts:3" });
  const gl = workEntryDisplayLabel(grep, root);
  assert.deepEqual(workEntryDetail(grep, root, gl), [
    {
      kind: "args",
      items: [
        { key: "pattern", value: "TODO", json: false },
        { key: "path", value: "src", json: false },
      ],
    },
    { kind: "output", text: "src/a.ts:3", json: false },
  ]);
  const read = entryOf({ ...base("rd"), type: "dynamic_tool", toolName: "Read", input: { file_path: `${root}/src/a.ts` }, output: "content" });
  const rl = workEntryDisplayLabel(read, root);
  assert.deepEqual(workEntryDetail(read, root, rl), [{ kind: "plain", text: `${root}/src/a.ts` }]);
});

test("a file change shows its path from the folder's name (the web's rule), its counts and its diff", () => {
  const e = entryOf({
    ...base("f"),
    type: "file_change",
    fileName: `${root}/src/a.ts`,
    additions: 1,
    deletions: 1,
    diffStr: "@@ -1 +1 @@\n-old\n+new",
  } as OrchestrationV2TurnItem);
  const blocks = workEntryDetail(e, root, workEntryDisplayLabel(e, root));
  assert.deepEqual(blocks.slice(0, 2), [
    { kind: "path", text: "repo/src/a.ts", counts: { add: "+1", del: "-1" } },
    { kind: "diff", text: "@@ -1 +1 @@\n-old\n+new" },
  ]);
});

test("a thought opens to its text, and an empty one does not open", () => {
  const thought = entryOf({ ...base("t1"), type: "reasoning", text: "**Plan** first" } as OrchestrationV2TurnItem);
  assert.ok(workEntryCanOpen(thought, root, "Thought"));
  assert.deepEqual(workEntryDetail(thought, root, "Thought"), [{ kind: "markdown", text: "**Plan** first" }]);
  const empty = entryOf({ ...base("t2"), type: "reasoning", text: "" } as OrchestrationV2TurnItem);
  assert.equal(workEntryCanOpen(empty, root, "Thought"), false);
});

test("a file search lists its hits with path, line and column, and the matching line", () => {
  const e = entryOf({
    ...base("fs"),
    type: "file_search",
    pattern: "TODO",
    results: [{ fileName: `${root}/src/a.ts`, line: 3, column: 5, preview: "// TODO fix" }, { fileName: `${root}/src/b.ts` }],
  } as OrchestrationV2TurnItem);
  const label = workEntryDisplayLabel(e, root);
  assert.ok(workEntryCanOpen(e, root, label));
  assert.deepEqual(workEntryDetail(e, root, label), [
    { kind: "command", text: "TODO" },
    {
      kind: "files",
      items: [{ label: "repo/src/a.ts:3:5", preview: "// TODO fix" }, { label: "repo/src/b.ts" }],
    },
  ]);
});

test("a web search lists title, a link only for web addresses, and the snippet", () => {
  const e = entryOf({
    ...base("ws"),
    type: "web_search",
    patterns: ["react native sections"],
    results: [
      { title: "Docs", url: "https://example.com/a", snippet: "about sections" },
      { url: "javascript:alert(1)" },
      { title: "No link" },
    ],
  } as OrchestrationV2TurnItem);
  const label = workEntryDisplayLabel(e, root);
  assert.deepEqual(workEntryDetail(e, root, label), [
    { kind: "command", text: "react native sections" },
    {
      kind: "web",
      items: [
        { title: "Docs", href: "https://example.com/a", snippet: "about sections" },
        { title: "javascript:alert(1)", href: null },
        { title: "No link", href: null },
      ],
    },
  ]);
  assert.equal(externalWebHref("http://x.test/"), "http://x.test/");
  assert.equal(externalWebHref(undefined), null);
  assert.equal(externalWebHref("not a url"), null);
});

test("a JSON tool output is flagged, a bare number is just output, and notices read as output text", () => {
  const e = entryOf({ ...base("j"), type: "dynamic_tool", toolName: "Custom", input: { a: 1 }, output: '{"ok":true}' });
  const blocks = workEntryDetail(e, root, workEntryDisplayLabel(e, root));
  assert.deepEqual(blocks.at(-1), { kind: "output", text: '{\n  "ok": true\n}', json: true });
  assert.equal(isJsonDocumentText("14"), false);
  assert.equal(isJsonDocumentText("[1, 2]"), true);
  const notice = entryOf({ ...base("n"), type: "system_notice", message: "heads up" } as OrchestrationV2TurnItem);
  assert.deepEqual(workEntryDetail(notice, root, "heads up"), [{ kind: "output", text: "heads up", json: false }]);
});
